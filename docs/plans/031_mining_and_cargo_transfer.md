# 031 — Mining & Cargo Transfer

- **Status:** Done
- **Design step:** Resource epic — phase 2
- **Design refs:** [029](029_resource_and_industrial_logistics_design.md) §5, §8
- **Depends on:** [030](030_resource_fields_and_ship_cargo.md)

## Goal
Make mining and cargo movement **happen** in the sim: a ship at a deposit extracts into cargo
over time, and cargo can be **transferred** ship↔ship and **unloaded** ship↔planet. Still
manual/order-driven — the automation state machine is [032](032_resource_operations_and_industrial_roles.md).

## Scope
### In scope
- A `mine`/`harvest` fleet order targeting a resource deposit; extraction each step.
- Extraction-rate formula; fill cargo, decrement reserves; stop conditions.
- Cargo transfer between nearby ships; unload into a planet's stores.
- Wire commands + minimal UI to issue mine/transfer/unload.

### Out of scope
- Persistent operations / roles automation — [032](032_resource_operations_and_industrial_roles.md).
- Debris on death, salvage — [033](033_logistics_warfare_cargo_and_salvage.md).
- Storage ships / stations — [034](034_storage_ships_stations_and_progression.md).

## Detailed design

### Mine order
Add to `FleetOrder` (`packages/simulation/src/types.ts`):
```ts
| { kind: "mine"; locationId: EntityId; depositIndex?: number }
```
Handled like other move orders in `apps/server/src/engine.ts` (ownership guard, set order, anchor
= deposit position so ships fly there and hold). Server handler `handleMine` mirrors `orderMove`.

### Extraction (in the world step)
In `stepWorld`/`stepFleetBrain` (`packages/simulation/src/worldSim.ts`), for each ship whose
fleet order is `mine` and that is within range of the target deposit and has mining power and free
cargo:
```
rate = miningPower × deposit.richness × crewEfficiency × shipEfficiency   (× dt)
```
(accessibility reduces efficiency/raises energy draw). Move `min(rate, freeCargo, reserves)` from
the deposit into the ship's `cargo`; decrement `deposit.reserves`. Deterministic (integer/seeded).
Stop a ship mining when: cargo full, deposit exhausted, order changed, retreating, destroyed, or
mining equipment disabled ([029](029_resource_and_industrial_logistics_design.md) §5). Emit lightweight events for client feedback
(e.g. a "mining" pulse) if useful.

### Cargo transfer & unload
- **Transfer (ship↔ship):** when two owned ships are within transfer range, move cargo at a rate
  from cargo/transfer capability. Command `transferCargo { fromShipId, toShipId, resource?, amount? }`
  or an automatic behavior in 032; v1 exposes a manual command + a proximity check. Respect the
  receiver's free capacity.
- **Unload (ship↔planet):** when a laden ship is within range of an owned planet, move cargo into
  `planet.storedResources` (reuse the spend/stores path in `engine.ts`). Command `unloadCargo
  { shipId, planetId }`.

### Commands + UI
- Protocol: `mine`, `transferCargo`, `unloadCargo` `ClientMessage`s.
- UI: clicking a deposit with a fleet selected issues `mine` (like move issues `moveTo`); inspector
  buttons for unload when near an owned planet; transfer via roster selection (v1 minimal).

## Key changes (per file)
- `packages/simulation/src/types.ts` — `mine` order; transfer/unload payload types if modeled in sim.
- `packages/simulation/src/worldSim.ts` — extraction step; stop conditions; range checks.
- `packages/simulation/src/economy.ts`/`resources.ts` — transfer/unload bag math.
- `apps/server/src/engine.ts` — `handleMine`, `handleTransferCargo`, `handleUnloadCargo`.
- `packages/protocol/src/index.ts` — the three new commands.
- `apps/client/src/main.ts` — deposit click → mine; `apps/client/src/ui.ts` — unload/transfer controls.

## Acceptance criteria
- A miner ordered onto a deposit fills its cargo over time, then stops when full.
- Mining decrements `deposit.reserves`; an exhausted deposit stops production.
- Unloading a laden ship at an owned planet raises the planet's stored resources by the moved amount.
- Transferring cargo between two nearby owned ships conserves total cargo and respects capacity.
- All deterministic (same seed + inputs → same amounts).

## Testing
- Unit (`@space/simulation`): extraction-rate formula (richness/efficiency); fill-to-capacity and
  exhaust-reserves stop conditions; transfer/unload conserve totals and respect capacity.
- Server (`engine.test.ts`): `mine` order fills cargo across ticks; `unloadCargo` raises planet
  stores; ownership/range guards reject invalid transfers.
- E2E: select fleet → click deposit → cargo readout climbs; return + unload raises resources.

## Unresolved questions
- Transfer range + rate source (cargo modules? dedicated transfer module?) — spec in config.
- Does accessibility gate *whether* a ship can mine (equipment requirement) or only slow it?
- Partial-tick rounding: floats vs. integer accumulation for determinism.
