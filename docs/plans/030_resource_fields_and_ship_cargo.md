# 030 — Resource Fields & Ship Cargo

- **Status:** Done
- **Design step:** Resource epic — phase 1
- **Design refs:** [029](029_resource_and_industrial_logistics_design.md) §1–§5, §12
- **Depends on:** [029](029_resource_and_industrial_logistics_design.md), [025](025_always_on_ship_sim_static_anchor.md)

## Goal
Lay the data foundation for the resource epic: an extensible resource-type model, an energy-as-
derived-stat split, world **resource deposits**, **physical ship cargo**, and a dedicated
**`Mining` room kind** with equipment. No mining/transfer behavior yet (that is [031](031_mining_and_cargo_transfer.md)) —
this phase makes the state exist, serialize, and render.

## Scope
### In scope
- `ResourceType` enum + `ResourceBag = Partial<Record<ResourceType, number>>` (start metal/fuel).
- `ShipEnergyState` (derived) replacing the ad-hoc power fields; energy off cargo.
- `ResourceDeposit`/resource-location world entities; worldgen seeding; sensor-filtered DTO.
- Physical cargo contents (`ResourceBag`) on `ShipState`; cargo DTO; roster/inspector display.
- New `Mining` `RoomKind` + mining module specs (buildable, validated).

### Out of scope
- Mining extraction, cargo transfer, unload — [031](031_mining_and_cargo_transfer.md).
- Operations/roles automation — [032](032_resource_operations_and_industrial_roles.md).
- Debris/salvage, stations — [033](033_logistics_warfare_cargo_and_salvage.md)/[034](034_storage_ships_stations_and_progression.md).

## Detailed design

### Resource types & bag
Today `ResourceBag = { metal; fuel; energy }` (`packages/simulation/src/types.ts:7`).
Replace with:
```ts
type ResourceType = "metal" | "fuel";        // extend later: titanium | rareMetals | volatiles | exotics
type ResourceBag = Partial<Record<ResourceType, number>>;
```
Update planet `storedResources`, `STARTING_RESOURCES`, and construction cost math to the new
shape. Provide helpers (`addBag`, `subBag`, `bagTotal`, `bagFits(capacity)`) in a small
`resources.ts` (or `economy.ts`).

### Energy split (derived, not a commodity)
`energy` leaves `ResourceBag`. Introduce:
```ts
interface ShipEnergyState { generation: number; consumption: number; available: number; }
```
Fold the existing `powerProduction` / `powerDemand` / `underpowered` in `ShipDerivedStats`
(`ship.ts computeDerived`, `types.ts:72-85`) into `ShipEnergyState` (or keep the numbers but
expose them via this shape). Planets get an analogous derived energy figure if needed. No cargo/
bag ever holds energy.

### Resource deposits (world entities)
```ts
interface ResourceLocation {         // may coincide with a PlanetState or be standalone
  id: EntityId;
  name: string;
  position: Vec2;
  radius: number;
  deposits: ResourceDeposit[];
}
interface ResourceDeposit {
  resource: ResourceType;
  richness: number;      // rate multiplier
  reserves: number;      // remaining; can exhaust
  accessibility: number; // extraction difficulty
}
```
Seed a handful in `packages/simulation/src/worldgen.ts` alongside planets (seeded, deterministic;
some deposits attached to planets, some as standalone fields). Store on `GameState`
(`resourceLocations: Map<EntityId, ResourceLocation>`). Serialize via a **sensor-filtered** DTO in
`apps/server/src/snapshot.ts` (reuse `sensorSources`/`canSensePoint`): reveal a location's coarse
info when in range; deposit detail (richness/reserves) can be gated behind proximity/scan later.

### Physical ship cargo
Ships gain **cargo contents** (not just the derived `cargo` capacity that already sums `storage`
rooms — `ship.ts:76-122`, `types.ts:79`):
```ts
interface ShipState { /* … */ cargo: ResourceBag; /* current contents; capacity stays derived */ }
```
Serialize contents + capacity in `shipToDto` (`snapshot.ts`); show current/max in the roster and
ship inspector (`apps/client/src/ui.ts`). `storage` room stays **capacity-only**.

### Mining room kind + modules
- Add `"mining"` to `RoomKind` (`types.ts:45`).
- New `MODULES` entries under the mining kind (reusing `ModuleSpec`, `config:55-94`), each with a
  `mining` block: `{ miningPower, supportedResources: ResourceType[], efficiency, energyDraw }`.
  v1: a basic **MiningLaser**. (GasHarvester / DeepCoreDrill are future variants.)
- `computeDerived` aggregates mining power / supported resources from enabled mining rooms into
  `ShipDerivedStats` (e.g. `miningPower`, `miningResources`).
- Blueprint validation (`ship.ts:35-65`) accepts mining modules like any other.

## Key changes (per file)
- `packages/simulation/src/types.ts` — `ResourceType`, `ResourceBag`, `ShipEnergyState`,
  `ResourceLocation`/`ResourceDeposit`, `ShipState.cargo`, `RoomKind += "mining"`, mining derived fields.
- `packages/simulation/src/economy.ts` (or new `resources.ts`) — bag helpers; energy derivation.
- `packages/simulation/src/ship.ts` — `computeDerived` mining aggregation + energy shape.
- `packages/simulation/src/worldgen.ts` — seed resource locations/deposits.
- `packages/config/src/index.ts` — `ResourceType`-keyed constants; MiningLaser module spec.
- `apps/server/src/world.ts` — init `game.resourceLocations`; ship `cargo` init empty.
- `apps/server/src/snapshot.ts` — deposit DTO (sensor-filtered); cargo in `shipToDto`.
- `packages/protocol/src/index.ts` — `ResourceLocationDto`/`ResourceDepositDto`; `ShipDto.cargo`.
- `apps/client/src/scene.ts` — draw resource locations/deposits on the map.
- `apps/client/src/ui.ts` — cargo readout in roster/inspector.

## Acceptance criteria
- `ResourceBag` is a partial record; metal/fuel work end-to-end; adding a new `ResourceType`
  needs no architecture change.
- Energy never appears in a cargo/bag; it reads as a derived ship stat.
- Resource deposits are seeded deterministically and render on the map when within sensor range.
- A ship shows current/max cargo; an empty ship shows 0/capacity.
- A Mining module is placeable and passes blueprint validation; `computeDerived` reports mining power.

## Testing
- Unit (`@space/simulation`): bag helpers (add/sub/fits/total); `computeDerived` mining
  aggregation + energy shape; worldgen seeds deterministic deposits.
- Server (`snapshot.test.ts`): deposits appear in the snapshot only within sensor range; ship DTO
  carries cargo contents + capacity.
- E2E: a seeded deposit renders on the map; a ship with a storage room shows capacity, empty contents.

## Unresolved questions
- Should some deposits attach to existing planets vs. all standalone fields? (worldgen mix.)
- Deposit-detail fog: reveal richness/reserves at what range / after a scan?
- Keep `powerProduction`/`powerDemand` names or fully rename to `ShipEnergyState` fields?
