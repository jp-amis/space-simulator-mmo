# 015 — Continuous Fleet Combat Model (Design Reference)

- **Status:** Reference (living design doc for the combat refactor)
- **Design refs:** [DESIGN.md](../DESIGN.md) §5–§7; supersedes the discrete-battle model in [006](006_minimal_battle_simulation.md), [010](010_combat_presentation.md), [013](013_battle_lifecycle_and_exit.md)
- **Implemented by:** phase plans [016](016_per_ship_kinematics_and_active_clusters.md)–[023](023_combat_ui_and_tests.md)

## Purpose

Define the target combat model and how it maps onto this codebase. Combat happens
**continuously on the shared world map** — there is no separate combat state, arena,
or battle screen. The player commands **fleet movement and orders**; ships **perceive
and report**; a **fleet brain** decides engagement; ships **autonomously execute**.

> **Ships propose. The fleet decides. Ships execute.**

This document is the anchor for the phase plans. Each phase links back to the section
numbers here.

## 1. Core rules (invariants to preserve)

1. There is **no separate combat state** — ships live in the one shared simulation.
2. Individual ships remain part of that simulation and are **rendered on the map**.
3. The player strategically controls **fleets, not individual ships**.
4. Ships **perceive and report**; the **fleet** makes engagement decisions.
5. Ships **autonomously execute** fleet intent per their ship doctrine.
6. **Player movement orders take precedence** over autonomous aggression.
7. Formation positions are **soft objectives** (steering, not attachment).
8. A ship cannot drag the whole fleet into **unlimited pursuit** (leash).
9. Engagement decisions are **continuously reevaluated**.
10. **Movement remains available throughout combat** (kiting/retreat are physical).
11. Combat depth comes from movement, composition, positioning, and doctrine — not
    active skills.

## 2. Three-layer command (design §4)

```
PLAYER  ──strategic order──▶  FLEET BRAIN  ──tactical intent──▶  SHIP BRAINS  ──▶ steering + targeting + weapons
```

- **Player:** MoveTo / Follow / AttackMove / Pursue / Escort / Hold — never manual
  weapons/skills.
- **Fleet brain:** aggregates ship contact reports, scores engagement (weighted
  consensus), runs a continuous `FleetIntent` state machine, coordinates pursuit /
  disengage, sets fleet anchor course, influences target priorities.
- **Ship brain:** formation-keeping, range-keeping, target selection, firing,
  collision/threat avoidance, sensing, reporting.

## 3. Simulation architecture — active clusters (design §19)

The world stays continuous, but the server does **not** simulate every ship every
tick everywhere.

- **Analytical (far apart):** a fleet moves as a **fleet anchor** — reuse the existing
  `MovementPlan` + `positionAt`/`velocityOf` (`packages/simulation/src/movement.ts`).
  Idle/far fleets cost ~0 per-tick work (preserves DESIGN §5/§19).
- **Promotion:** when fleets' sensor/engagement regions overlap (broad phase via the
  existing `SpatialHash` on anchors + sensor radius), the involved fleets form an
  **active cluster**. Each ship's runtime state is materialized from
  `fleetAnchor + rotate(formationOffset, heading)`.
- **Active step (fixed `ACTIVE_DT`, seeded RNG per cluster):** perception → fleet brain
  (slower decision interval) → ship steering → weapons/projectiles/damage → integrate
  physics. Damage writes **live** to the persistent `ShipState`.
- **Demotion:** when no fleets in the cluster can still interact, discard the transient
  runtime; fleets resume analytical anchor movement.

This is an internal optimization only — there is never a player-visible "combat mode".

## 4. Data model (maps to `packages/simulation/src/types.ts`)

**Persistent (serializable) — `ShipState`** keeps strategic data and gains only
*static* fields:
- `doctrine: ShipDoctrine` — `{ formationRole, preferredRange {min,pref,max}, targetPriority }`
- `combatWeight`, `role` — for weighted consensus
- derived **kinematic caps** in `ShipDerivedStats`: `maxSpeed`, `accel`, `turnRate`
  (computed from modules; thrust→speed/accel, engines/bridge→turn).

**Transient — `ActiveShip` runtime** (NOT on `ShipState`): a `Map<shipId, ActiveShip>`
owned by the active cluster/manager, created on promote and **discarded on demote**:
```ts
interface ActiveShip {
  shipId: string;
  fleetId: string;
  position: Vec2;
  velocity: Vec2;
  heading: number;
  shield: number;
  currentTargetId?: string;
  weaponCooldowns: Record<string, number>;
  engaging: boolean;
}
```

**`FleetState`** gains: `anchor` (reuse `position` + `MovementPlan`), `order:
FleetOrder`, `intent: FleetIntent`, extended `doctrine: FleetDoctrine`
(`aggression`, `pursuit`, `cohesion`, `survival` + `preset`), `engagementRadius` /
`pursuitRadius` (leash), and per-ship formation assignments. `FleetStatus` replaces
`"battle"` with `"engaging"`; `battleId` is removed.

**Removed:** `BattleState`, arena `BattleShipState` (kinematics move to `ActiveShip`),
arena-relative `ProjectileState` (projectiles become **world-space**, owned by the
cluster).

### Intents & orders

```ts
type FleetIntent = "continue_order" | "observe" | "intercept" | "engage" | "pursue" | "disengage" | "flee";
type FleetOrder  = "moveTo" | "follow" | "attackMove" | "pursue" | "escort" | "hold"; // + payload
```

## 5. Ships perceive; fleet decides (design §5–§9)

- Each ship detects contacts within **sensor range** and emits a `ContactReport`
  (`{ reporterShipId, targetFleetId, confidence, distance, estimatedThreat,
  engagementUtility }`).
- The fleet brain aggregates reports into a fleet **engagement score** using
  **weighted consensus** (not one-ship-one-vote):
  ```ts
  engagementUtility = targetSuitability * combatReadiness * rangeSuitability * sensorConfidence * doctrineAggression;
  fleetScore += engagementUtility * ship.combatWeight;
  ```
- Doctrine thresholds convert score → action (aggressive ≈ 0.40, normal ≈ 0.60,
  cautious ≈ 0.80). Different ship types legitimately disagree; doctrine resolves it.
- **Continuous reevaluation:** the fleet re-scores on a **decision interval** (slower
  than the physics tick), so intent flows naturally (observe → intercept → engage →
  disengage → flee) with no combat-entry event.

## 6. Player authority & leash (design §10, §14)

Priority order:
```
1. Explicit player strategic movement/order
2. Fleet tactical intent
3. Ship doctrine
4. Local steering/avoidance
```
An explicit player move order overrides autonomous aggression (essential for kiting /
retreat / feints). Ships may still fire, rotate, keep range, and screen while obeying
the order — but they never reverse it.

**Leash:** ships maneuver locally only within the fleet's `engagementRadius`; beyond
it they return toward their formation slot. Only the **fleet brain** may change the
anchor's course to pursue (bounded by `pursuitRadius`).

## 7. Formation as soft objectives (design §13)

Desired ship steering blends competing objectives (weights are tunable):
```
steering = formationForce*wF + rangeForce*wR + pursuitForce*wP + avoidanceForce*wA
```
Result: formations **deform** during battle and **reform** afterward. Implementation
need not use literal physics forces, but must produce that behavior, bounded by each
ship's `maxSpeed`/`turnRate`.

## 8. Sensors / engagement / weapon range are separate (design §15)

```
Sensor range     — enemy can be detected
Engagement range — fleet/ship begins considering engagement
Weapon range     — a weapon can fire
Preferred range  — ideal combat distance (ship doctrine)
Minimum range    — ship tries to open distance
```
Different roles react differently to the same contact. Reuse `preferredRangeUnits`
and per-weapon `range` from `MODULES`.

## 9. Networking & LOD (design §20)

- **Protocol:** remove all battle-arena DTOs/messages. Extend the existing
  **per-player sensor-filtered** `getVisibleState` to include per-ship **world state**
  for sensed active-cluster ships, plus world-space projectiles/combat events. A
  higher-rate **active-region delta** channel (keyed by visibility, not a battle
  subscription) carries fast-changing ship state — the map equivalent of the old
  `battleFrame`.
- **Client LOD by zoom:** far = fleet markers (`drawChevron`); medium = ship
  silhouettes; close = full ship detail + fire/projectiles/shields (reuse
  `drawBattleShip`). LOD is a rendering change only — never a gameplay-state change.

## 10. Determinism

Keep the active sim **fixed-step** with a **seeded RNG per cluster** (reuse
`mulberry32`/`rngFromState`). All random draws (any residual placement jitter, room
selection on hit via `pickTargetRoom`, tie-breaks) consume the cluster RNG in a fixed
order, so `seed + inputs → identical outcome`. This keeps headless combat unit tests
(“seed X → ship B destroyed by tick N”) possible.

## 11. Reuse map (do not rewrite)

Lift the following into a shared `combat.ts` and reuse **unchanged**: `chooseTarget`,
`pickTargetRoom`, `applyDamage`, `segmentPointDistance`, `HIT_RADIUS`,
`preferredRangeUnits` (from `battle.ts`); `mulberry32`/`rngFromState`;
`positionAt`/`velocityOf`/`closestApproach`/`sweptBounds`; `SpatialHash`;
`calculateFleetStrategicSpeed`/`shipStrategicSpeed`; `getFleetPosition`/`fleetShips`;
`MODULES`, `shieldRegenPerSec`, `hullBaseHp`. **Remove:** `setupBattle`,
`runBattleToEnd`, arena placement, `startBattle`/`endBattle`/`broadcastBattles`, the
`BATTLE_DT_MS` accumulator, and `BATTLE.arenaWidth/arenaHeight/separation/maxDurationMs`.

## 12. V1 scope & exclusions (design §22)

**In V1:** fleet orders MoveTo/Follow/AttackMove/Pursue/Hold; doctrine presets Hold
Fire / Return Fire / Attack on Sight / Pursue / Flee-if-attacked; ship config
formation role (front/middle/rear), preferred range (close/medium/long), target
priority (nearest/small/large); per-ship sim with position/velocity/max speed/accel/
turn/hull/weapons/cooldowns/range/sensors/target; weighted-consensus fleet brain +
intents; active-cluster promote/demote; client LOD rendering.

**Excluded from V1:** active combat skills, rage systems, manual weapon activation,
separate combat screens, complex crew abilities, electronic warfare, warp disruption,
detailed ammunition logistics, advanced command hierarchy (design §21 is future).

## 13. Tunables (finalize during implementation)

`ACTIVE_DT`, decision-interval period, LOD zoom thresholds, active-region delta rate,
formation steering weights, `engagementRadius`/`pursuitRadius`, doctrine score
thresholds, sensor/engagement/weapon ranges per module/role. Name them in `@space/config`.

## Phase index

[016](016_per_ship_kinematics_and_active_clusters.md) kinematics+clusters ·
[017](017_continuous_combat_resolution.md) combat resolution ·
[018](018_ship_brain_and_doctrine.md) ship brain ·
[019](019_fleet_brain_consensus_and_intent.md) fleet brain ·
[020](020_fleet_orders_and_doctrine.md) orders+doctrine ·
[021](021_protocol_and_networking.md) protocol/networking ·
[022](022_client_rendering_and_lod.md) client render+LOD ·
[023](023_combat_ui_and_tests.md) UI+tests. Related: [024](024_smooth_enemy_fleet_visualization.md).
