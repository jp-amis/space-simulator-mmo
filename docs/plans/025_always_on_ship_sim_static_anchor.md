# 025 — Always-On Per-Ship Simulation + Static Goal Anchor

- **Status:** Done
- **Design step:** Movement/combat model refactor (playtest fixes)
- **Design refs:** [DESIGN.md](../DESIGN.md) §4, §5, §9.3, §10.3, §11; [015](015_continuous_combat_model.md)
- **Depends on:** [020](020_fleet_orders_and_doctrine.md), [021](021_protocol_and_networking.md), [022](022_client_rendering_and_lod.md)
- **Supersedes:** the active-cluster model (`activeSim.ts`) and the traveling-anchor `MovementPlan`; the plan-024 enemy-fleet dead-reckoning (ship interpolation now carries motion).

## Goal
Playtesting exposed a model mismatch: ships only had positions inside a combat cluster,
the fleet anchor crawled along a `MovementPlan`, sensor range was huge, and enemy ships
were invisible outside combat. This refactor makes **every ship always simulated** around
a **static goal anchor**, tightens sensors, and streams every sensed ship (own + enemy) in
full detail, in or out of combat.

## Target model
- **Persistent per-ship runtime** (`GameState.shipRuntime: Map<shipId, ShipRuntime>`):
  position, velocity, heading, shield, cooldowns, target, alive. Spawned when a ship joins
  a fleet, culled on death.
- **One world step every `ACTIVE_DT_MS`** (`worldSim.ts stepWorld`): each ship steers to
  its formation slot around the fleet's static anchor and **parks** (no idle drift); combat
  is an overlay — fire at enemies in weapon range, world-space projectiles, live damage,
  deterministic via `GameState.rngState`.
- **Anchor = last commanded point (static).** `moveTo`/`attackMove` set `fleet.position =
  target` immediately; `pursue`/`follow`/`escort` retarget it to the tracked fleet's
  centroid each tick; `hold` freezes it at the current centroid.
- **Fleet location = ships' centroid** (`fleetCentroid`) for sensors, detection, labels and
  picking. The anchor is only the goal marker + endpoint of the on-screen move line.
- **Orders shape maneuvering:** a plain `moveTo` keeps formation and fires opportunistically
  (retreat/kite → move-while-shooting-away); aggressive orders may break formation to reach
  preferred range. `flee_if_attacked` (and badly-losing fleets) set the order to move home,
  jumping the anchor away.
- **Tight sensors:** `FLEET.sensorRange 2600 → 650`, planet sensor `1600 → 900`
  (`PLANET_SENSOR_RANGE`). Faster ship travel to compensate (`COMBAT.maxMaxSpeed 320`).

## Key changes
- **config:** tight sensor ranges; `PLANET_SENSOR_RANGE`; faster kinematics; `slotArriveDist`;
  removed `clusterRange`/`pursuitRadius`.
- **simulation:** `ShipRuntime`/`WorldProjectile`/`rngState`/`shipRuntime` in `types.ts`;
  `combat.ts` retyped to `ShipRuntime`; `activeSim.ts` → **`worldSim.ts`** (`stepWorld`,
  `fleetCentroid`).
- **server:** anchor orders (`orderMove` teleports the anchor); `stepWorld` in the heartbeat
  with throttled structural snapshots + always-on `buildSensedShips` stream; `getFleetPosition`
  = static anchor, `getFleetLocation`/`fleetCentroid` = real location; `/debug/state` reports
  runtime/projectile counts.
- **protocol:** `FleetDto` marker = centroid, adds `anchor?`; drops the 024 velocity hint and
  the `fleetMovement` message.
- **client:** `store` centroid API (`fleetCentroid`/`fleetPosition`/`fleetAnchor`), always-on
  `activeShips`; `scene` draws the fleet marker at the centroid, an anchor crosshair, a
  centroid→anchor move line, and every sensed ship (LOD) always; `renderFleetShips` deleted.

## Verification
- **Unit** (`worldSim.test.ts`): ships always get runtime + park at slots; a move relocates
  the anchor and ships fly to it; combat resolves + culls; determinism (same seed → same
  positions). ✅
- **Server** (`snapshot.test.ts`, `engine.test.ts`): sensed-ship stream includes own + enemy
  in full detail within the tight range, excludes them outside it; anchor orders; pursue/hold. ✅
- **E2E** (`game.spec.ts`): move relocates the anchor + reports moving; on-map combat resolves
  to a single surviving owner; own ships always stream. ✅
- `pnpm -r typecheck`, `pnpm test` (58), `pnpm --filter @space/client e2e` (8) — all green.
