# 019 — Fleet Brain: Weighted Consensus & Intent

- **Status:** Done
- **Design step:** Step 5 — continuous combat refactor (see [DESIGN.md](../DESIGN.md))
- **Design refs:** [015](015_continuous_combat_model.md) §2, §5, §6; DESIGN §7
- **Depends on:** [018](018_ship_brain_and_doctrine.md)

## Goal
Give each active-cluster fleet a **fleet brain** that turns its ships' perceptions into a single engagement decision. Aggregate per-ship `ContactReport`s into per-ship `engagementUtility`, weight each by `ship.combatWeight`, and reduce to a fleet **engagement score** via **weighted consensus** ([015](015_continuous_combat_model.md) §5) — explicitly *not* one-ship-one-vote. A `FleetIntent` state machine (`continue_order` | `observe` | `intercept` | `engage` | `pursue` | `disengage` | `flee`) is reevaluated on a **decision interval** slower than the physics tick ([015](015_continuous_combat_model.md) §5). Enforce the **engagement/pursuit leash** ([015](015_continuous_combat_model.md) §6): ships maneuver locally only within `engagementRadius`; only the fleet brain may move the fleet anchor to pursue, bounded by `pursuitRadius`. Respect the authority order ([015](015_continuous_combat_model.md) §6): an explicit player move order overrides autonomous aggression. This realizes "**Ships propose. The fleet decides. Ships execute.**"

## Scope
### In scope
- `ContactReport` aggregation from ship brains ([018](018_ship_brain_and_doctrine.md)) into a per-fleet report set.
- Per-ship `engagementUtility = targetSuitability * combatReadiness * rangeSuitability * sensorConfidence * doctrineAggression` and weighted `fleetScore += engagementUtility * ship.combatWeight` ([015](015_continuous_combat_model.md) §5).
- Doctrine score thresholds → intent transition (aggressive ≈ 0.40, normal ≈ 0.60, cautious ≈ 0.80) ([015](015_continuous_combat_model.md) §5).
- `FleetIntent` state machine, reevaluated on a decision interval (multiple of `ACTIVE_DT`) with seeded per-cluster RNG for tie-breaks ([015](015_continuous_combat_model.md) §10).
- Leash: only the fleet brain moves the anchor toward a pursuit target, clamped to `pursuitRadius`; ships beyond `engagementRadius` return to formation ([015](015_continuous_combat_model.md) §6).
- Player-order precedence: an explicit `FleetOrder` movement suppresses autonomous `intercept`/`engage`/`pursue` anchor moves ([015](015_continuous_combat_model.md) §6).

### Out of scope
- The concrete `FleetOrder` payloads / doctrine presets / command handlers — [020](020_fleet_orders_and_doctrine.md).
- Ship-side steering, target selection, firing and the emission of `ContactReport` — [018](018_ship_brain_and_doctrine.md).
- Active-cluster promote/demote lifecycle and `ACTIVE_DT` integration — [016](016_per_ship_kinematics_and_active_clusters.md), [017](017_continuous_combat_resolution.md).
- Any wire-protocol change (`FleetStatus:"engaging"`, deltas) — [021](021_protocol_and_networking.md).

## Tasks
- [ ] Add static consensus fields to `ShipState`: `combatWeight`, `role` ([015](015_continuous_combat_model.md) §4).
- [ ] Extend `FleetState` with `order`, `intent`, extended `doctrine` (`aggression`/`pursuit`/`cohesion`/`survival`), `engagementRadius`, `pursuitRadius`; replace `FleetStatus:"battle"` with `"engaging"`, drop `battleId` ([015](015_continuous_combat_model.md) §4).
- [ ] Implement `computeEngagementUtility(report, ship, doctrine)` in a shared `packages/simulation/src/combat.ts` ([015](015_continuous_combat_model.md) §11).
- [ ] Implement `scoreFleetEngagement(reports, ships, doctrine)` → weighted-consensus `{ score, bestTargetFleetId }`.
- [ ] Implement `stepFleetBrain(fleet, cluster, dtMs)` gated on the decision interval: score → threshold → `nextIntent`.
- [ ] Implement `applyLeash(fleet, cluster)` — move anchor only in `pursue`/`intercept`, clamp to `pursuitRadius`; mark ships outside `engagementRadius` as returning.
- [ ] Enforce player-order precedence: if `fleet.order` is an explicit movement order, block autonomous anchor moves (still allow fire/rotate/range-keep).
- [ ] Feed chosen `bestTargetFleetId` as a target-priority hint down to ship brains ([018](018_ship_brain_and_doctrine.md)).

## Key types & signatures
```ts
// packages/simulation/src/types.ts
type FleetIntent = "continue_order" | "observe" | "intercept" | "engage" | "pursue" | "disengage" | "flee";

interface ContactReport {
  reporterShipId: EntityId;
  targetFleetId: EntityId;
  confidence: number;      // sensorConfidence 0..1
  distance: number;
  estimatedThreat: number;
  engagementUtility: number;
}

interface FleetDoctrineContinuous {
  preset: DoctrinePreset;  // see 020
  aggression: number;      // 0..1, scales engagementUtility
  pursuit: number;         // 0..1, scales pursuitRadius willingness
  cohesion: number;        // formation-keeping weight
  survival: number;        // flee threshold bias
}

// packages/simulation/src/combat.ts
function computeEngagementUtility(r: ContactReport, ship: ShipState, d: FleetDoctrineContinuous): number;
// = targetSuitability * combatReadiness * rangeSuitability * sensorConfidence * doctrineAggression

function scoreFleetEngagement(
  reports: ContactReport[], ships: ShipState[], d: FleetDoctrineContinuous,
): { score: number; bestTargetFleetId?: EntityId }; // fleetScore += engagementUtility * ship.combatWeight

function stepFleetBrain(fleet: FleetState, cluster: ActiveCluster, dtMs: number): FleetIntent;
function applyLeash(fleet: FleetState, cluster: ActiveCluster): void;

// doctrine score → action (015 §5)
const THRESHOLDS = { aggressive: 0.40, normal: 0.60, cautious: 0.80 } as const;
```

## Acceptance criteria
> Acceptance: two identical fleets behave differently purely by doctrine threshold; an explicit player move order overrides autonomous aggression; a single eager ship cannot drag the fleet into unlimited pursuit; runs are deterministic.

- [ ] Two structurally identical fleets with different `doctrine` thresholds reach different intents on the same contact set.
- [ ] Consensus is weighted: a high-`combatWeight` ship shifts `fleetScore` more than a low-weight one (not one-ship-one-vote).
- [ ] An explicit player movement `FleetOrder` prevents autonomous `intercept`/`engage`/`pursue` anchor moves while ships still fire/keep range.
- [ ] Anchor pursuit never exceeds `pursuitRadius` from the leash origin; ships beyond `engagementRadius` return to formation.
- [ ] Intent is reevaluated on the decision interval, not every physics tick.
- [ ] `seed + reports → identical intent sequence` across repeated runs.

## Testing
- Unit (`@space/simulation`): `computeEngagementUtility` monotonic in each factor; `scoreFleetEngagement` weighting; threshold → intent table.
- Unit: leash clamp (anchor never past `pursuitRadius`; ship past `engagementRadius` flagged returning).
- Unit: player-order precedence blocks autonomous anchor move but not firing.
- Determinism: same seed + `ContactReport[]` → identical `FleetIntent` sequence over N decision intervals.
- Headless scenario: identical fleets, doctrines aggressive vs cautious → divergent intents at the same tick.

## Unresolved questions
- Decision interval: fixed ms or multiple of `ACTIVE_DT`? tunable in `@space/config`.
- `combatReadiness`/`targetSuitability` exact formulas — from hull%/weapon count/role?
- Leash origin: fleet anchor at intent-entry, or player-order target?
- Hysteresis on intent transitions to avoid flapping near a threshold?
