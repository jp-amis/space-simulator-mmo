# 018 — Ship Brain & Ship Doctrine

- **Status:** Done
- **Design step:** Step 5 (combat refactor) — see [DESIGN.md](../DESIGN.md)
- **Design refs:** [015](015_continuous_combat_model.md) §2, §7, §8; DESIGN §7.4
- **Depends on:** [016](016_per_ship_kinematics_and_active_clusters.md), [017](017_continuous_combat_resolution.md)

## Goal
Give each active ship a **brain** that perceives, steers, and holds formation per its **ship doctrine** ([015](015_continuous_combat_model.md) §2 "ships propose", §7, §8). Each `ActiveShip` senses contacts within `sensorRange` and emits a `ContactReport`; it computes a **desired velocity** by blending weighted steering forces (formation attraction + range-keeping + pursuit + avoidance), bounded by `maxSpeed`/`turnRate` from [016](016_per_ship_kinematics_and_active_clusters.md); and it derives its **formation offset** from its `formationRole`. Formation slots are **soft** — they deform under combat forces and reform afterward ([015](015_continuous_combat_model.md) §7). A static `ShipDoctrine` on the persistent `ShipState` (`@space/simulation`) parameterizes role, preferred range band, and target priority. The brain writes `ActiveShip.desiredVelocity` and `currentTargetId`; [016](016_per_ship_kinematics_and_active_clusters.md) integrates it and [017](017_continuous_combat_resolution.md) fires the weapons.

## Scope
### In scope
- `ShipDoctrine` on `ShipState` (`packages/simulation/src/types.ts`, [015](015_continuous_combat_model.md) §4): `formationRole`, `preferredRange`, `targetPriority`.
- Preferred-range band → `{ min, pref, max }` units (reuse/extend `preferredRangeUnits` from [017](017_continuous_combat_resolution.md)'s `combat.ts`).
- Perception: `perceive(activeShip, cluster, ships)` → `ContactReport[]` for contacts within `sensorRange` ([015](015_continuous_combat_model.md) §5, §8).
- Steering as weighted forces → desired velocity, bounded by `maxSpeed`/`turnRate` ([015](015_continuous_combat_model.md) §7): `formation`, `range-keeping`, `pursuit`, `avoidance`.
- Formation offset per `formationRole` (front/middle/rear) relative to the fleet anchor + heading.
- Wire the ship brain into `ActiveClusterManager.step` **before** integration ([016](016_per_ship_kinematics_and_active_clusters.md)) and target selection ([017](017_continuous_combat_resolution.md)).
- Steering-weight tunables in `@space/config`.

### Out of scope
- Cluster promote/demote, integration, `maxSpeed`/`accel`/`turnRate` derivation — [016](016_per_ship_kinematics_and_active_clusters.md).
- Weapons/projectiles/damage — [017](017_continuous_combat_resolution.md).
- **Fleet-level** consensus that aggregates `ContactReport`s into a fleet engagement score/intent and sets anchor course/pursuit — [019](019_fleet_brain_consensus_and_intent.md) ([015](015_continuous_combat_model.md) §5). This phase only produces the reports and per-ship steering.
- Player orders / leash precedence — [020](020_fleet_orders_and_doctrine.md) ([015](015_continuous_combat_model.md) §6).
- Doctrine editing UI — [023](023_combat_ui_and_tests.md).

## Tasks
- [ ] Add `ShipDoctrine` to `ShipState` (`types.ts`) with a default in `fleet.ts` alongside `DEFAULT_DOCTRINE`.
- [ ] Map `preferredRange` (`close`/`medium`/`long`) → `{ min, pref, max }` units, consistent with `preferredRangeUnits`.
- [ ] Create `packages/simulation/src/shipBrain.ts` exporting `perceive`, `computeFormationOffset`, and `steerShip`.
- [ ] `perceive`: iterate hostile `ActiveShip`s within `sensorRange`, build `ContactReport { reporterShipId, targetFleetId, confidence, distance, estimatedThreat, engagementUtility }` ([015](015_continuous_combat_model.md) §5).
- [ ] `computeFormationOffset(role, slotIndex)` → local offset; world slot = `fleetAnchor + rotate(offset, heading)` (matches materialize in [016](016_per_ship_kinematics_and_active_clusters.md)).
- [ ] `steerShip`: blend `formationForce*wF + rangeForce*wR + pursuitForce*wP + avoidanceForce*wA` → `desiredVelocity`, clamp to `maxSpeed`; heading turn bounded by `turnRate` at integration time ([016](016_per_ship_kinematics_and_active_clusters.md)).
- [ ] Range-keeping force: push out below `min`, hold near `pref`, close above `max` (reuse the band).
- [ ] Target-priority selection wired through `chooseTarget` ([017](017_continuous_combat_resolution.md)): `nearest` | `small_ships` | `large_ships`.
- [ ] Invoke `perceive` + `steerShip` in `ActiveClusterManager.step` before integration; write `desiredVelocity`/`currentTargetId` onto `ActiveShip`.
- [ ] Add `STEERING_WEIGHTS` (`wF/wR/wP/wA`) to `@space/config`.

## Key types & signatures
Static doctrine on the persistent ship ([015](015_continuous_combat_model.md) §4, §8):
```ts
// packages/simulation/src/types.ts
export interface ShipDoctrine {
  formationRole: "front" | "middle" | "rear";
  preferredRange: "close" | "medium" | "long"; // → { min, pref, max } units
  targetPriority: "nearest" | "small_ships" | "large_ships";
}
// added to ShipState:
//   doctrine: ShipDoctrine;

export interface ContactReport {
  reporterShipId: EntityId;
  targetFleetId: EntityId;
  confidence: number;      // 0..1 (sensor)
  distance: number;
  estimatedThreat: number;
  engagementUtility: number; // 015 §5
}
```
Brain surface (`packages/simulation/src/shipBrain.ts`, [015](015_continuous_combat_model.md) §7, §8):
```ts
export function rangeBand(pr: ShipDoctrine["preferredRange"]): { min: number; pref: number; max: number };
export function perceive(self: ActiveShip, cluster: ActiveCluster, ships: Map<EntityId, ShipState>): ContactReport[];
export function computeFormationOffset(role: ShipDoctrine["formationRole"], slotIndex: number): Vec2;
export function steerShip(
  self: ActiveShip,
  target: ActiveShip | undefined,
  neighbors: ActiveShip[],
  formationSlot: Vec2,
  doctrine: ShipDoctrine,
  maxSpeed: number,
): Vec2; // desiredVelocity, clamped to maxSpeed
```
Blend (weights from `@space/config`, [015](015_continuous_combat_model.md) §7): `steering = formationForce*wF + rangeForce*wR + pursuitForce*wP + avoidanceForce*wA`, bounded by `maxSpeed`/`turnRate`.

## Acceptance criteria
> Acceptance: ships hold a soft formation while idle, keep their doctrine's preferred range in combat, deform under fire and reform after the disturbance passes, and behave identically for a fixed seed.

- [ ] Idle/observing ships converge on their formation slots (`front`/`middle`/`rear` offsets) and hold them softly.
- [ ] In combat, ships keep their `preferredRange` band (`min`/`pref`/`max`) against their target ([015](015_continuous_combat_model.md) §8).
- [ ] Formation **deforms** when combat/avoidance forces dominate and **reforms** to slots once they subside ([015](015_continuous_combat_model.md) §7) — slots are steering targets, never rigid attachment.
- [ ] `targetPriority` selects nearest / smaller / larger targets accordingly via `chooseTarget` ([017](017_continuous_combat_resolution.md)).
- [ ] `perceive` reports only contacts within `sensorRange`, with monotonically decreasing `confidence` by distance.
- [ ] Deterministic: identical seed + inputs → identical `desiredVelocity`/formation trajectories ([015](015_continuous_combat_model.md) §10).

## Testing
- Unit (`packages/simulation`): `rangeBand` mapping; `computeFormationOffset` distinct per role; `steerShip` clamps to `maxSpeed`; range force sign flips across `min`/`pref`/`max`.
- Formation hold: single fleet, no enemies → ships settle at slots within tolerance after N steps.
- Reform: promote a cluster ([016](016_per_ship_kinematics_and_active_clusters.md)), inject a displacement, run steps → ships return toward slots once the disturbance clears (soft, not snapped).
- Range-keeping: `close` vs `long` doctrine ships stabilize at different distances from the same target.
- Perception: contact just inside vs just outside `sensorRange`; assert inclusion/exclusion and `confidence` ordering.
- Determinism: same seed → identical steering output stream (mirrors [016](016_per_ship_kinematics_and_active_clusters.md)/[017](017_continuous_combat_resolution.md) determinism tests).

## Unresolved questions
- Formation slot assignment: stable per `shipIds` index, or reassigned by role each promote (affects determinism)?
- Avoidance neighbor set — friendly-only, or include enemies for collision spreading?
- `estimatedThreat`/`engagementUtility` formula here vs deferred entirely to the fleet brain [019](019_fleet_brain_consensus_and_intent.md) ([015](015_continuous_combat_model.md) §5)?
- Should `steerShip` also consult a fleet `pursuitRadius` leash now, or leave leash to [020](020_fleet_orders_and_doctrine.md) ([015](015_continuous_combat_model.md) §6)?
