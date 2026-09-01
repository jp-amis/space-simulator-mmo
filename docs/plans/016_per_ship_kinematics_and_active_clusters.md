# 016 — Per-ship Kinematics & Active-Cluster Simulation (server foundation)

- **Status:** Done
- **Design step:** Step 5 (combat refactor) — see [DESIGN.md](../DESIGN.md)
- **Design refs:** [015](015_continuous_combat_model.md) §3, §4, §10; DESIGN §5, §19
- **Depends on:** [004](004_fleet_domain_and_movement.md), [015](015_continuous_combat_model.md)

## Goal
Replace the discrete "battle arena" driver with **continuous, active-cluster simulation** of the one shared world ([015](015_continuous_combat_model.md) §3). Far/idle fleets keep costing ~zero per-tick work by moving analytically as a fleet anchor (reuse `positionAt`/`velocityOf` from `packages/simulation/src/movement.ts`); when fleets' sensor/engagement regions overlap they are **promoted** into an active cluster whose member ships get a **transient** per-ship runtime (`ActiveShip`) materialized from `fleetAnchor + rotate(formationOffset, heading)`, stepped at a fixed `ACTIVE_DT` with a **seeded RNG per cluster**, and **demoted** (runtime discarded) when no member fleets can still interact. This lays the physics/lifecycle foundation that [017](017_continuous_combat_resolution.md) (weapons/damage) and [018](018_ship_brain_and_doctrine.md) (steering/perception) build on. It deletes the `BATTLE_DT_MS` accumulator loop and the encounter→battle transition in `apps/server/src/engine.ts` (`@space/server`).

## Scope
### In scope
- Transient `ActiveShip` runtime (`packages/simulation/src/types.ts`, `@space/simulation`), owned by a per-cluster `Map<shipId, ActiveShip>` — **never** stored on the persistent `ShipState` ([015](015_continuous_combat_model.md) §4).
- `ActiveCluster` value object + an `ActiveClusterManager` that owns promotion, stepping, and demotion.
- Broad-phase cluster detection reusing the existing `SpatialHash` (`packages/simulation/src/spatialHash.ts`) on fleet anchors padded by `sensorRange` — **replaces** `schedulePotentialEncounters` in `engine.ts`.
- Materialize `ActiveShip` runtime on promote from `fleetAnchor + rotate(formationOffset, heading)`; discard on demote.
- Fixed-step integration at `ACTIVE_DT` with a cluster-seeded RNG (reuse `mulberry32`/`rngFromState`, `packages/simulation/src/rng.ts`) — **replaces** the `BATTLE_DT_MS` accumulator loop in `tick()`.
- Derived kinematic caps `maxSpeed`, `accel`, `turnRate` on `ShipDerivedStats` (computed in `computeDerived`, `packages/simulation/src/ship.ts`).
- New tunables in `@space/config`: `ACTIVE_DT_MS`, `PROMOTE_PAD`, cluster demotion hysteresis.
- Analytical-when-far anchor movement preserved for non-clustered fleets.

### Out of scope
- Weapons, projectiles, damage, target selection running inside the step — [017](017_continuous_combat_resolution.md) (§10, §11). This phase steps kinematics with a **no-op combat hook**.
- Perception, steering forces, formation offsets from doctrine, `ShipDoctrine` — [018](018_ship_brain_and_doctrine.md) (§2, §7, §8). This phase uses a **placeholder heading + zero formation offset**.
- Fleet brain / weighted consensus / `FleetIntent` — [019](019_fleet_brain_consensus_and_intent.md) (§5).
- Protocol/networking (`@space/protocol`) for active-region ship state — [021](021_protocol_and_networking.md) (§9).
- Client rendering/LOD — [022](022_client_rendering_and_lod.md).

## Tasks
- [ ] Add `maxSpeed`, `accel`, `turnRate` to `ShipDerivedStats` (`types.ts`) and compute them in `computeDerived` (`ship.ts`): thrust→`maxSpeed`/`accel`, engines/bridge→`turnRate`. Keep existing `thrust`/`turnRate` semantics or fold them in.
- [ ] Define `ActiveShip` and `ActiveCluster` interfaces in `types.ts` ([015](015_continuous_combat_model.md) §4). `ActiveShip` is transient and never serialized into `ShipState`.
- [ ] Add `FleetStatus` `"engaging"` usage and remove `"battle"`/`battleId` reliance (coordinate with [017](017_continuous_combat_resolution.md), which removes `BattleState`).
- [ ] Create `packages/simulation/src/cluster.ts` exporting `ActiveClusterManager` with `broadPhase`, `promote`, `step(dtSec, ships)`, `demote`, and `materializeActiveShip`.
- [ ] `broadPhase`: reuse `SpatialHash` on fleet anchors padded by `sensorRange + PROMOTE_PAD`; group overlapping **hostile** (different-owner) fleets into candidate clusters via union-find/flood fill.
- [ ] `promote(fleetIds, seed, nowMs)`: build `Map<shipId, ActiveShip>` from `fleetAnchor + rotate(formationOffset, heading)`; seed RNG per cluster with `rngFromState(hashSeed(...clusterFleetIds, nowMs))` for determinism ([015](015_continuous_combat_model.md) §10).
- [ ] `step`: fixed `ACTIVE_DT` — call combat hook (no-op here; [017](017_continuous_combat_resolution.md) fills it) then integrate `velocity`→`position`, clamp to `maxSpeed`, rotate `heading` toward desired by `turnRate*dtSec`; advance cluster RNG in a fixed order.
- [ ] `demote(cluster)`: when no two member fleets remain within `engagementRadius`, write anchors back (`fleet.position`/`movement`), discard the `Map<shipId, ActiveShip>`, resume analytical movement.
- [ ] In `engine.ts`: delete the `BATTLE_DT_MS` accumulator `while` loop in `tick()`; call `clusterMgr.broadPhase()` + `clusterMgr.step()` on the heartbeat instead.
- [ ] In `engine.ts`: replace `schedulePotentialEncounters`/`encounter-check`/`tryStartBattle` with cluster promotion. Keep `scheduleArrival`/`fleet-arrival` (still analytical) intact.
- [ ] Add profiling counters: `activeClusters`, `activeShips` (replace `activeBattles`, `candidatePairs`).

## Key types & signatures
Transient runtime — owned by a cluster, keyed by `shipId`, **not** on `ShipState` ([015](015_continuous_combat_model.md) §4):
```ts
// packages/simulation/src/types.ts
export interface ActiveShip {
  shipId: EntityId;
  fleetId: EntityId;
  position: Vec2;
  velocity: Vec2;
  heading: number; // radians
  desiredVelocity: Vec2; // written by ship brain (018); integrated here
  shield: number;
  maxShield: number;
  currentTargetId?: EntityId;
  weaponCooldowns: Record<EntityId, number>;
  engaging: boolean;
}

export interface ActiveCluster {
  id: EntityId;
  fleetIds: EntityId[];
  rngState: number; // seeded per cluster (015 §10)
  ships: Map<EntityId, ActiveShip>; // discarded on demote
  createdAtMs: number;
}

// added to ShipDerivedStats (015 §4)
export interface ShipDerivedStats {
  // ...existing: thrust, turnRate, sensorRange, shieldCapacity, ...
  maxSpeed: number; // units/sec, from thrust
  accel: number; // units/sec^2, from thrust
  // turnRate reused as rad/sec cap
}
```
Manager surface (`packages/simulation/src/cluster.ts`):
```ts
export class ActiveClusterManager {
  broadPhase(fleets: Iterable<FleetState>, spatial: SpatialHash, nowMs: number): void; // promote/demote
  promote(fleetIds: EntityId[], seed: number, ships: Map<EntityId, ShipState>, fleets: Map<EntityId, FleetState>, nowMs: number): ActiveCluster;
  step(cluster: ActiveCluster, dtSec: number, ships: Map<EntityId, ShipState>): void; // integrate; combat hook is no-op until 017
  demote(cluster: ActiveCluster, fleets: Map<EntityId, FleetState>, nowMs: number): void;
  materializeActiveShip(ship: ShipState, fleet: FleetState, offset: Vec2, heading: number): ActiveShip;
  readonly clusters: Map<EntityId, ActiveCluster>;
}
```
Integration is bounded per ship: `speed ≤ derived.maxSpeed`, `Δvelocity ≤ derived.accel*dtSec`, `Δheading ≤ derived.turnRate*dtSec` ([015](015_continuous_combat_model.md) §7).

## Acceptance criteria
> Acceptance: two converging fleets promote into a cluster with per-ship positions materialized from formation offsets; the cluster demotes when the fleets separate; idle/far fleets do zero per-ship work; identical seed → identical per-ship trajectories.

- [ ] Two hostile fleets converging within `sensorRange + PROMOTE_PAD` **promote** into one `ActiveCluster` with an `ActiveShip` per member ship.
- [ ] A promoted cluster **demotes** (runtime `Map` discarded, anchors resumed) once member fleets separate beyond the demotion threshold.
- [ ] Idle/far fleets run **only** analytical anchor movement — no `ActiveShip` allocated, `activeShips` counter stays 0 ([015](015_continuous_combat_model.md) §3; DESIGN §19).
- [ ] `ShipState` is never mutated to carry `ActiveShip` fields; the runtime lives solely in `ActiveCluster.ships`.
- [ ] Deterministic: same seed + same inputs → byte-identical `ActiveShip` positions/velocities after N steps ([015](015_continuous_combat_model.md) §10).
- [ ] The `BATTLE_DT_MS` accumulator loop and `schedulePotentialEncounters` are removed from `engine.ts`.

## Testing
- Unit (`packages/simulation`): `promote` materializes correct count and positions from `fleetAnchor + rotate(offset, heading)`; `step` respects `maxSpeed`/`accel`/`turnRate` caps; `demote` clears the map and restores anchors.
- Determinism: run the same 2-fleet convergence twice with a fixed seed; assert identical `ActiveShip` snapshots each step ([015](015_continuous_combat_model.md) §10) — mirrors the existing `runBattleToEnd` determinism tests in `battle.test.ts`.
- Broad phase: idle fleets far apart never promote (`clusters.size === 0`); overlapping ones cluster once (no duplicate clusters, no self-clustering same-owner fleets).
- Integration (`apps/server`): start server in-process, move two hostile fleets to converge, tick, assert `counters.activeClusters === 1` then `=== 0` after separation.
- `ActiveClusterManager`, `positionAt`/`velocityOf`, `SpatialHash`, and the RNG all live in `@space/simulation`, callable headlessly (DESIGN §19).

## Unresolved questions
- `ACTIVE_DT_MS` value — reuse 100ms (old `BATTLE_DT_MS`) or finer for smoother kinematics?
- Cluster id stability across ticks — reuse a canonical sorted-fleetIds key, or fresh `makeId` each promote (affects RNG seed determinism)?
- Demotion hysteresis: separation distance + min dwell ticks to avoid promote/demote thrashing?
- `maxSpeed`/`accel` formula from `thrust` — same 0.4–1.6 factor band as `shipStrategicSpeed`?
