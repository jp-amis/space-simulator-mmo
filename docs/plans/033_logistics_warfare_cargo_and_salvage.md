# 033 — Logistics Warfare, Cargo & Salvage

- **Status:** Done
- **Design step:** Resource epic — phase 4
- **Design refs:** [029](029_resource_and_industrial_logistics_design.md) §9; [020](020_fleet_orders_and_doctrine.md) (doctrine/flee)
- **Depends on:** [032](032_resource_operations_and_industrial_roles.md)

## Goal
Make the economy a **target**. Laden ships that die drop recoverable **debris/cargo**; industrial
fleets react to threats per role (retreat, call for help); and **commerce raiding** emerges from
the normal movement + combat systems — no special "raid" action.

## Scope
### In scope
- Cargo-as-physical-asset: a destroyed laden ship drops debris (a % of its cargo) into space.
- Salvage: salvage-capable ships recover debris into their cargo.
- Per-role **threat behavior** for industrial fleets (ignore / defend / retreat-if-attacked /
  retreat-on-detect / call-military / fight), with retreat thresholds.
- **Calling military**: an industrial fleet broadcasts a threat; nearby friendly fleets may respond.

### Out of scope
- Storage ships / stations — [034](034_storage_ships_stations_and_progression.md).
- New combat mechanics — reuse the [025](025_always_on_ship_sim_static_anchor.md) sim; raiding is just positioning + normal combat.

## Detailed design

### Debris & salvage
When a ship with cargo is destroyed (`shipDestroyed` in `combat.ts`/`worldSim.ts` cull step),
spawn a **debris entity** at its position carrying a fraction of the cargo (config
`SALVAGE.survivalFraction`, e.g. 0.35) plus optional ship components:
```ts
interface Debris { id: EntityId; position: Vec2; cargo: ResourceBag; ttlMs: number; }
```
Stored on `GameState.debris`; decays after `ttlMs`. A ship with **salvage capability** (a salvage
module or cargo capacity + proximity) within range recovers debris into its cargo over time
(reuse the transfer path from [031](031_mining_and_cargo_transfer.md)). Serialize debris sensor-filtered like ships.

### Threat behavior (per role)
Extend the doctrine/flee system ([020](020_fleet_orders_and_doctrine.md), `stepFleetBrain` in `worldSim.ts`) with an
industrial **threat response** on the fleet/operation:
```
ignore | defend_self | retreat_if_attacked | retreat_on_detect | call_military | fight_until_destroyed
```
plus thresholds (retreat hull %, "retreat if enemy strength > X% of ours"). Different roles in one
operation respond differently ([029](029_resource_and_industrial_logistics_design.md) §7): escorts engage/delay while miners + haulers flee
(their per-ship doctrine already supports flee/retreat). Retreat sends industrial ships toward the
delivery planet / home (reuse the flee-home anchor rule from [026](026_movement_and_order_fixes.md)/[025](025_always_on_ship_sim_static_anchor.md)).

### Calling military
On `retreat_on_detect`/`call_military`, the operation emits a **threat report** (location, enemy
strength estimate, cargo at risk). Nearby friendly fleets evaluate it via the fleet decision system
and may divert to respond (integrates with intent/doctrine; a fleet only responds if it fits its
current behavior). v1 can be a simple radius broadcast + auto-assist for idle friendly fleets.

### Commerce raiding (emergent — no new action)
No special code: a player positions a fleet on a logistics route; when a hauler enters engagement
range, the existing combat resolves it. This phase just ensures industrial fleets **flee/kite**
correctly and drop salvage, which is what makes raiding worthwhile.

## Key changes (per file)
- `packages/simulation/src/types.ts` — `Debris`, `GameState.debris`, industrial threat-response enum + thresholds, salvage derived stat.
- `packages/simulation/src/worldSim.ts` — spawn debris on laden-ship death; salvage recovery step; role-aware retreat.
- `packages/simulation/src/combat.ts` — hook the destroy path to carry cargo into debris.
- `apps/server/src/engine.ts` — threat-report broadcast + friendly-fleet response; debris cull/TTL.
- `packages/protocol/src/index.ts` — `DebrisDto`; threat-response setting; optional threat-report event.
- `apps/client/src/scene.ts` — render debris (salvage motes) within sensor range.
- `apps/client/src/ui.ts` — industrial threat-response controls + thresholds.

## Acceptance criteria
- A laden ship destroyed in combat drops debris carrying ~the configured fraction of its cargo.
- A salvage-capable ship recovers debris into its cargo; debris expires after its TTL.
- An industrial fleet set to `retreat_if_attacked` flees toward delivery/home on taking fire; its
  escorts stay to cover.
- `call_military` produces a threat report that an idle nearby friendly fleet responds to.
- A raider fleet positioned on a route intercepts a passing hauler using the normal combat path.

## Testing
- Unit (`@space/simulation`): debris spawns with the right cargo fraction on death; salvage recovery
  conserves totals; role-aware retreat sets flee anchor.
- Server (`engine.test.ts`): kill a laden hauler → debris exists; a salvager empties it; threat
  report reaches a nearby friendly fleet.
- E2E: raid a hauler → salvage motes appear and can be recovered; industrial fleet retreats while
  escort engages.

## Unresolved questions
- Salvage capability: dedicated module vs. any cargo ship in range.
- Threat-report response policy: auto-assist vs. player-confirm; how strength is estimated.
- Debris TTL + survival fraction values.
