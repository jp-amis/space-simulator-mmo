# 032 — Resource Operations & Industrial Roles

- **Status:** Done
- **Design step:** Resource epic — phase 3
- **Design refs:** [029](029_resource_and_industrial_logistics_design.md) §6, §7
- **Depends on:** [031](031_mining_and_cargo_transfer.md)

## Goal
Remove the clicking. Let players define a persistent **Resource Operation** that runs the mining
loop automatically (travel → mine → full → return → unload → repeat), and give ships **industrial
roles** so a mixed fleet (miners, haulers, escorts, scouts) behaves sensibly on its own.

## Scope
### In scope
- A `ResourceOperation` state machine that issues fleet/ship orders automatically.
- **Industrial roles** (miner/hauler/escort/scout/repair/support) driving per-ship behavior.
- Operation lifecycle: create, run, pause, cancel; terminate on exhaust/impossible/all-dead.
- Miner→hauler transfer flow so miners can stay on-site (uses [031](031_mining_and_cargo_transfer.md) transfer).

### Out of scope
- Threat responses / calling military / salvage — [033](033_logistics_warfare_cargo_and_salvage.md).
- Storage ships / stations — [034](034_storage_ships_stations_and_progression.md).

## Detailed design

### Ship role
Introduce an explicit `IndustrialRole` (also the shared taxonomy [027](027_fleet_formation_presets.md) wants):
```ts
type IndustrialRole = "miner" | "hauler" | "escort" | "scout" | "repair" | "support";
```
Stored per ship (on `ShipState` or in the operation's assignment). Role drives autonomous behavior:
miners mine + transfer + avoid combat; haulers collect + transport + unload; escorts guard + engage;
scouts watch + report + avoid combat.

### Resource operation
```ts
interface ResourceOperation {
  id: EntityId;
  ownerId: string;
  locationId: EntityId;         // where to mine
  resource: ResourceType;
  deliveryPlanetId: EntityId;   // where to unload
  fleetId: EntityId;            // the assigned fleet
  state: OpState;               // TRAVEL_TO_RESOURCE | MINING | CARGO_FULL | RETURN_TO_BASE | UNLOADING | RETURN_TO_RESOURCE
  // thresholds / policy (e.g. hauler collect-at storage level) filled per role
}
```
Stored on `GameState.operations`. A per-tick `stepOperations(game, nowMs)` (called from the engine
tick, beside `updateContinuousOrders`) advances each operation's state machine by issuing the
existing orders ([031](031_mining_and_cargo_transfer.md) `mine`, move, `unloadCargo`) to its fleet/ships based on state +
cargo levels. Reuses the scheduled-event + brain infra ([029](029_resource_and_industrial_logistics_design.md) §6). Transitions:
```
TRAVEL_TO_RESOURCE → (arrived) MINING → (cargo full) CARGO_FULL/RETURN_TO_BASE
   → (at base) UNLOADING → (empty) RETURN_TO_RESOURCE → MINING → …
```
Split-role operations: miners hold at the deposit and transfer to a hauler; the hauler runs the
return/unload legs (so miners never stop). Terminate on cancel / exhausted deposit / impossible /
all ships lost.

### Commands + UI
- Protocol: `createOperation`, `cancelOperation`, `pauseOperation` (+ assign role) messages.
- UI: an "operations" panel to create one (pick location, resource, delivery planet, fleet) and
  monitor state/progress; per-ship role selector.

## Key changes (per file)
- `packages/simulation/src/types.ts` — `IndustrialRole`, `ResourceOperation`, `OpState`, `GameState.operations`.
- `packages/simulation/src/operations.ts` (new) — `stepOperations`, transition logic (pure).
- `apps/server/src/engine.ts` — call `stepOperations` in the tick; op command handlers.
- `packages/protocol/src/index.ts` — operation commands + an `OperationDto` for the UI.
- `apps/server/src/snapshot.ts` — serialize the player's operations.
- `apps/client/src/ui.ts` — operations panel + role selector.

## Acceptance criteria
- One configured operation runs a miner + hauler round-trip **indefinitely** with no manual clicks:
  cargo fills, ships return, unload raises planet stores, ships go back out.
- Ships behave per role (escorts guard, scouts watch, miners avoid combat).
- Cancelling an operation returns its fleet to normal order control; an exhausted deposit ends it.
- Deterministic given seed + inputs.

## Testing
- Unit (`@space/simulation`): `stepOperations` transition table (each state → next given cargo/
  position); split miner/hauler flow keeps miners on-site.
- Server (`engine.test.ts`): create an operation; advance ticks; assert planet stores rise over
  repeated cycles without external commands; cancel restores manual control.
- E2E: create an operation from the panel; observe state cycling and resources climbing.

## Unresolved questions
- Role assignment: explicit field on `ShipState` vs. per-operation assignment map.
- How operations interact with player-issued orders on the same fleet (operation pauses? overrides?).
- Multiple operations per fleet vs. one-fleet-per-operation (v1: one).
