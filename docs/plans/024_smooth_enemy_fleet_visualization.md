# 024 — Smooth Enemy-Fleet Visualization on the Strategic Map

- **Status:** Done
- **Design step:** Map polish — fixes a current visual bug (independent of the combat refactor)
- **Design refs:** [DESIGN.md](../DESIGN.md) §5.1, §9.2, §10.3; [015](015_continuous_combat_model.md) §9 (LOD, related)
- **Depends on:** [003](003_strategic_map_and_procedural_universe.md), [004](004_fleet_domain_and_movement.md)

## Goal
Make **sensed enemy (and neutral) fleets** move smoothly on the strategic map instead
of stuttering/jumping between snapshots. This is a standalone fix — it does not require
the continuous-combat refactor and can ship first. The aim is *visually smooth*, not
lag-proof: this is a strategy game, not a precision shooter, so light interpolation +
dead-reckoning is enough.

## Root cause
Own fleets already interpolate smoothly: `ownFleetDto` includes the `movement` plan, so
`store.fleetPosition` (`apps/client/src/store.ts`) interpolates via `positionAt`-style
math every frame. **Enemy fleets do not** — `enemyFleetDto` in
`apps/server/src/snapshot.ts` deliberately omits `movement` (to avoid leaking the
destination), so the client has only a static `position` that updates a few times/sec
(on dirty snapshot broadcasts). `store.fleetPosition` therefore returns that stale
point, producing visible stepping/teleport jumps as new snapshots arrive.

## Scope
### In scope
- Server: give sensed non-owned fleets a **motion hint** (current velocity/heading)
  sufficient for short-horizon client prediction — **without** revealing the
  destination (preserve fog of war, DESIGN §10.3).
- Client: **dead-reckoning extrapolation** + **smoothing** (buffer recent samples,
  small render delay and/or critically-damped follow toward the latest snapshot) so
  enemy markers glide instead of jumping.
- Graceful handling when a fleet **enters/leaves sensor range** (fade in/out; no snap).

### Out of scope
- Per-ship rendering / LOD and combat visuals — [015](015_continuous_combat_model.md),
  [022](022_client_rendering_and_lod.md).
- Revealing enemy destinations or exact movement plans.
- Network lag compensation / rollback (not needed for strategic pacing).

## Approach
1. **Server (`apps/server/src/snapshot.ts`).** Extend `enemyFleetDto` with a
   fog-safe hint: the fleet's current `velocity` (units/sec, derived from its
   `MovementPlan` via `velocityOf`) and `heading`, plus the authoritative `position`
   and `serverTimeMs`. Do **not** send `to`/destination or `endMs`. Optionally include a
   short `predictionHorizonMs` after which the client should stop extrapolating (e.g.,
   the fleet may stop/turn), so a stopped fleet doesn't drift forever.
2. **Protocol (`packages/protocol/src/index.ts`).** Add optional `velocity: Vec2`,
   `heading?: number` to `FleetDto` (only populated for sensed non-owned fleets;
   own fleets keep using `movement`). Reuse the existing `Vec2` schema.
3. **Client (`apps/client/src/store.ts`).** In `fleetPosition`, for a fleet without a
   `movement` plan but with a `velocity` hint: **extrapolate**
   `position + velocity * (serverNow − sampleTime)` up to `predictionHorizonMs`, then
   **smooth** toward each new authoritative sample (per-fleet buffer of the last 1–2
   samples; lerp / critically-damped follow) to avoid a hard correction when snapshots
   land. Keep a per-fleet render state map (last shown position + target).
4. **Client render (`apps/client/src/scene.ts`).** Fade enemy markers in/out on
   sensor enter/leave using the render state's age, instead of popping.

Reuse: `velocityOf` (`packages/simulation/src/movement.ts`), the own-fleet
interpolation pattern in `store.fleetPosition`, and the existing sensor-visibility gate
in `getVisibleState`.

## Key types & signatures
```ts
// protocol FleetDto additions (only set for sensed, non-owned fleets)
velocity?: Vec2;        // units/sec, fog-safe motion hint
heading?: number;       // radians
predictionHorizonMs?: number; // stop extrapolating after this (relative to serverTime)

// client per-fleet render smoothing state
interface FleetRenderState {
  shownPos: Vec2;       // currently displayed (smoothed) position
  lastSample: { pos: Vec2; velocity?: Vec2; atMs: number };
  alpha: number;        // 0..1 fade for sensor enter/leave
}
```

## Acceptance criteria
> A moving enemy fleet observed by another player renders as smooth continuous motion,
> not stepped jumps between snapshots — while its destination stays hidden.

- [ ] A second player watching a moving enemy fleet sees smooth motion (no visible
      per-snapshot teleport steps).
- [ ] The enemy's **destination is never sent** (snapshot contains position + velocity
      hint only; no `to`/`endMs`).
- [ ] A fleet that stops (or leaves sensor range) does not keep sliding indefinitely
      (bounded by `predictionHorizonMs` / fade-out).
- [ ] Own-fleet interpolation is unchanged.

## Testing
- **Unit** (client): given a `velocity` hint + advancing `serverNow`, `fleetPosition`
  extrapolates then converges to a new sample without a discontinuity; no extrapolation
  past `predictionHorizonMs`.
- **Unit/integration** (server): `enemyFleetDto` includes `velocity` but omits any
  destination field (fog-of-war assertion).
- **E2E** (`apps/client/e2e/game.spec.ts`): two browser contexts (a mover + an
  observer whose sensor covers the path); sample the observer's rendered enemy-fleet
  position across frames and assert monotonic, small per-frame deltas (smooth) rather
  than large snapshot-aligned jumps. Screenshot/trace of the smoothed path.

## Unresolved questions
- Smoothing method: fixed render-delay interpolation vs. dead-reckoning + damped
  correction — default to **dead-reckoning + damped follow** (simpler, no added latency).
- Should neutral/unowned-but-visible fleets use the same hint? (assume yes — same code
  path for any non-owned sensed fleet.)
