# 026 — Movement & Order Fixes

- **Status:** Done
- **Design step:** Post-025 playtest fixes
- **Design refs:** [025](025_always_on_ship_sim_static_anchor.md); [020](020_fleet_orders_and_doctrine.md); [015](015_continuous_combat_model.md) §2, §6, §7
- **Depends on:** [025](025_always_on_ship_sim_static_anchor.md)

## Goal
Fix three movement/order regressions surfaced by playtesting the always-on-ship build:
1. **Anchors still move** — the static goal anchor drifts every tick under pursue/follow/escort.
2. **Slowest ship not respected** — mixed-speed fleets spread out; there is no fleet-wide speed cap.
3. **Pursue has no standoff** — pursuing ships pile onto the target's centroid and overlap.

These are localized fixes in the order/steering layer; no model change.

## Scope
### In scope
- Keep `fleet.position` (the anchor) **static** after a click; derive pursue/follow/escort tracking without mutating it every tick.
- Apply a per-fleet **slowest-ship speed cap** in steering so the fleet advances coherently.
- Give `pursue` a **standoff distance** so pursuers hold a ring around the target.

### Out of scope
- Formation shape/presets — [027](027_fleet_formation_presets.md).
- Any client rendering change beyond what already reads `fleet.position`/centroid.
- Reworking the doctrine/brain intent machine ([019](019_fleet_brain_consensus_and_intent.md)).

## Detailed design

### #1 — Anchor stays static
`updateContinuousOrders()` (`apps/server/src/engine.ts:354-371`) currently overwrites
`fleet.position` **every tick** for `pursue`/`follow`/`escort`, so the "static" anchor
tracks the target in real time. `orderMove`/`orderHold` set it correctly (once).

Fix: stop treating the tracked point as the anchor.
- For `pursue`/`follow`/`escort`, compute the **desired anchor** from the target centroid
  (+offset, see #3) but only **re-assign `fleet.position` when it has drifted beyond a
  threshold** (e.g. `> COMBAT.anchorRetargetDist`, ~half engagementRange). This keeps the
  anchor stable while the target loiters, and re-snaps only on meaningful target movement.
- Audit the flee reassignment in `worldSim.ts stepFleetBrain` (`:117`): a one-shot flee
  sets `fleet.order = moveTo(home)` **and** `fleet.position = home`. Ensure it sets the
  anchor **once** on the transition into flee, not every tick, so it doesn't fight a
  player order or jitter.

### #2 — Respect the slowest ship
`calculateFleetStrategicSpeed()` exists (`packages/simulation/src/fleet.ts:13`) but is
**never called**; `desiredVelocity()` (`worldSim.ts:158`) clamps each ship to its own
`derived.maxSpeed`, so a faster ship outruns the formation.

Fix: compute a **fleet speed cap** once per step in `stepWorld` (min of members'
strategic speeds, floored) and thread it into steering:
- In the per-fleet setup loop (`worldSim.ts:207-224`), compute `fleetMaxSpeed` alongside
  the formation slots.
- Pass `fleetMaxSpeed` into `desiredVelocity()`; use `Math.min(ship.derived.maxSpeed,
  fleetMaxSpeed)` for the **formation-arrival** term so travel stays coherent. Combat
  range-keeping may still use the ship's own max (a ship breaking formation to fight is
  expected to be quicker), or also be capped — pick per playtest.
- Reuse `calculateFleetStrategicSpeed` (or an inline min over `ship.derived.maxSpeed`).

### #3 — Pursue standoff distance
`FleetOrder` `pursue` has no `distance` (`types.ts:143`); `engine.ts:362-363` snaps the
anchor onto the target centroid, so pursuers overlap the target. `follow`/`escort` already
apply an offset (`engine.ts:365-368`).

Fix:
- Add an optional `distance` to the `pursue` order: `{ kind: "pursue"; fleetId; distance }`.
- Default it (on issue in `orderTargetFleet`/the pursue handler) to ~`fleet.engagementRange`
  so pursuers settle just inside weapon range.
- In `updateContinuousOrders`, use the same offset math as follow/escort (place the anchor
  `distance` back from the target centroid along the pursuer→target axis).

## Key changes (per file)
- `packages/simulation/src/types.ts` — add `distance` to the `pursue` `FleetOrder`.
- `packages/simulation/src/fleet.ts` — export/confirm the fleet-speed helper used by steering.
- `packages/simulation/src/worldSim.ts` — compute `fleetMaxSpeed` per fleet; pass to
  `desiredVelocity`; make flee set the anchor once on transition.
- `apps/server/src/engine.ts` — `updateContinuousOrders`: anchor-drift threshold for
  pursue/follow/escort; pursue standoff offset; default pursue `distance` on issue.
- `packages/config/src/index.ts` — `COMBAT.anchorRetargetDist` (new); confirm speed knobs.

## Acceptance criteria
- After a move/pursue click, `fleet.position` does not change every tick — it holds until
  the tracked target moves past the retarget threshold.
- A fleet mixing a fast and a slow ship advances together at ~the slow ship's pace; the fast
  ship does not pull ahead of formation during travel.
- A pursuing fleet closes to a standoff ring (~engagementRange) around the target instead of
  overlapping its centroid.

## Testing
- Unit (`@space/simulation`): `stepWorld` — a two-ship fleet (different `maxSpeed`) keeps its
  centroid-to-slow-ship gap bounded while moving to a distant anchor; flee sets the anchor once.
- Integration (`engine.test.ts`): issue `pursue`; assert `fleet.position` is stable while the
  target holds, and the pursuer's centroid settles at ~`distance` from the target centroid
  (not ~0). Confirm the anchor doesn't drift tick-to-tick when the target is stationary.
- E2E (optional): visual — pursue no longer overlaps; mixed fleet stays tight.

## Unresolved questions
- Cap combat range-keeping to `fleetMaxSpeed` too, or only formation travel? (Playtest.)
- Exact `anchorRetargetDist` and pursue default `distance` values — start ~half/full
  `engagementRange`, tune in play.
