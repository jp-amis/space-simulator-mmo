# 028 — Client Visual Polish

- **Status:** Done
- **Design step:** Post-025 client polish
- **Design refs:** [025](025_always_on_ship_sim_static_anchor.md); [022](022_client_rendering_and_lod.md); [024](024_smooth_enemy_fleet_visualization.md) (superseded smoothing pattern)
- **Depends on:** [025](025_always_on_ship_sim_static_anchor.md)

## Goal
Four presentation upgrades to the PixiJS client, all in the render layer with minimal protocol
additions:
1. **Smoother projectiles** (#4) — stop snapping; interpolate between server frames.
2. **Cannon vs. laser** (#5) — render weapon types distinctly.
3. **Fog of war** (#6) — visually darken space outside the player's sensor coverage.
4. **Explosion FX** (#8) — a burst when a ship is destroyed instead of a silent vanish.

## Scope
### In scope
- Client-side interpolation of projectiles by id, using server-provided velocity.
- A weapon-kind field flowing `WorldProjectile` → `ProjectileDto` → client visuals.
- A client fog overlay driven by the player's own sensor sources.
- A transient explosion particle/flash on `shipDestroyed`.

### Out of scope
- Server sensor/visibility logic (already correct — [025](025_always_on_ship_sim_static_anchor.md)); this is presentation only.
- New art assets — all effects stay procedural (DESIGN §9).
- Sound.

## Detailed design

### #4 Smoother projectiles
`store.projectiles` is replaced each `activeRegion` delta and redrawn at snapped positions
(`apps/client/src/scene.ts:244-247`). `WorldProjectile` has `velocity` (`types.ts:205`) but
`ProjectileDto` (`packages/protocol/src/index.ts:177`) omits it.
- Add `velocity: Vec2` to `ProjectileDto`; server writes it in `buildSensedShips`
  (`apps/server/src/snapshot.ts:224-227`).
- Client: keep a `Map<id, {shown, dto, atMs}>` (like `activeShips`); each frame **dead-reckon**
  `shown += velocity * dt` and ease toward the latest server position; drop stale ids. Render at
  `shown`, not the raw snapshot position.

### #5 Cannon vs. laser
No weapon-kind reaches the client. Weapons differ only in config ballistics
(`packages/config/src/index.ts:78-93`: `laser` fast/low-dmg, `cannon` slow/high-dmg).
- Add `kind`/`moduleType` (e.g. `"laser" | "cannon"`) to `WorldProjectile`; set it at the fire
  site (`worldSim.ts:280-289`, from `room.moduleType`).
- Carry it through `ProjectileDto` (`snapshot.ts:226`).
- Client renders **laser** as a thin, bright, fast streak (short trail along velocity) and
  **cannon** as a slower round tracer (larger dot, warmer color). Fall back to today's dot if
  `kind` is absent.

### #6 Fog of war
Today only sensor **rings** are drawn (`scene.ts:124-131`) when `showSensors` is on; unsensed
space looks identical to sensed space (enemies are simply absent — server filter
`snapshot.ts:192-222`).
- Add a **fog layer**: fill the viewport with a dark, semi-opaque veil, then **punch holes**
  (destination-out / mask) at each of the player's sensor sources — own fleet centroids
  (`fleet.sensorRange`) and owned planets (`PLANET_SENSOR_RANGE`) — with a soft edge.
- Result: space the player cannot sense reads as fogged; sensed bubbles are clear. Reuse the
  existing `showSensors` toggle (or a new `showFog`), and the same source geometry the server
  uses so the visual matches actual visibility.
- Keep it cheap: one Graphics with a handful of radial gradients, redrawn on camera/fleet move.

### #8 Explosion FX
`shipDestroyed` (`CombatEventDto`) currently just logs + deletes the ship
(`apps/client/src/store.ts:74-76`); a dead ship is a small dark dot (`scene.ts:254-256`).
- On `shipDestroyed`, before deleting, capture the ship's last `shown` position and push a
  transient effect (expanding ring + a few sparks / flash) into an `explosions` list with a
  start time.
- A new `renderEffects()` pass animates scale/opacity over ~300–400ms, then removes it.
- Purely client-side; no protocol change (event already carries the ship id, position comes from
  the tracked `activeShips` entry).

## Key changes (per file)
- `packages/simulation/src/types.ts` — `WorldProjectile.kind`.
- `packages/protocol/src/index.ts` — `ProjectileDto.velocity`, `ProjectileDto.kind`.
- `apps/server/src/snapshot.ts` — write `velocity` + `kind` in `buildSensedShips`.
- `packages/simulation/src/worldSim.ts` — set projectile `kind` at fire site.
- `apps/client/src/store.ts` — projectile interpolation map; `explosions` list on `shipDestroyed`.
- `apps/client/src/scene.ts` — interpolated projectile draw; laser vs. cannon visuals; fog layer; `renderEffects()`.
- `apps/client/src/main.ts` — advance projectile/explosion updates in the ticker; fog toggle.

## Acceptance criteria
- Projectiles move smoothly between server frames (no visible stepping at low frame delta).
- Lasers and cannon shots are distinguishable at a glance.
- Space outside the player's sensor coverage is visibly fogged; sensed bubbles are clear and
  track the fleet/planets.
- Destroying a ship shows a brief burst at its position before it disappears.

## Testing
- Unit (`@space/client`, vitest): projectile interpolation advances `shown` by velocity and
  eases toward server position; stale projectiles pruned. Explosion list adds on `shipDestroyed`
  and expires after its lifetime.
- E2E (`game.spec.ts`): spawn hostile → combat screenshot shows distinct laser/cannon tracers and
  fog outside sensor range; a `shipDestroyed` produces a short-lived effect (assert an entry
  appears then clears). Update combat screenshots.

## Unresolved questions
- Fog implementation: Pixi mask vs. destination-out blend vs. RenderTexture — pick the cheapest
  that looks good at all zooms.
- Exact laser/cannon visual language (trail length, colors) — tune in play.
