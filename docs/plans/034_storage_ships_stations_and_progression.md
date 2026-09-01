# 034 — Storage Ships, Stations & Infrastructure Progression

- **Status:** Done
- **Design step:** Resource epic — phase 5
- **Design refs:** [029](029_resource_and_industrial_logistics_design.md) §8, §11, §13, §14
- **Depends on:** [032](032_resource_operations_and_industrial_roles.md), [033](033_logistics_warfare_cargo_and_salvage.md)

## Goal
Top of the industrial progression: **storage ships** (mobile logistics hubs so miners never stop),
**mining stations** (semi-permanent extraction/refinery/storage), and the staged progression that
ties the whole epic together into a real network.

## Scope
### In scope
- Storage ships: large-capacity vessels that buffer cargo on-site; haulers batch-collect from them.
- Mining stations: deployable/constructed structures at a resource location with extraction +
  storage (+ optional refinery/repair) that boost throughput and become strategic assets.
- Progression wiring so operations ([032](032_resource_operations_and_industrial_roles.md)) can target a storage ship/station as the
  intermediate delivery hub.

### Out of scope
- New combat mechanics (stations/storage ships are defended with normal fleets + [033](033_logistics_warfare_cargo_and_salvage.md)).
- Refinery resource-conversion depth (v1 station refinery optional/simple).

## Detailed design

### Storage ships
A storage ship is just a ship design with huge cargo capacity and a `support`/storage role
([032](032_resource_operations_and_industrial_roles.md)). Behavior: hold position near miners, **accept** transferred cargo (reuse
[031](031_mining_and_cargo_transfer.md) transfer), and act as the collect-from target for haulers. Operation policy gains a
`bufferShipId` so miners transfer to the storage ship and haulers collect when it passes a
threshold ([029](029_resource_and_industrial_logistics_design.md) §13). No new entity type — a role + capacity + operation wiring.

### Mining stations
A **station** is a new persistent structure (not a ship) at a resource location:
```ts
interface Station {
  id: EntityId; ownerId: string; position: Vec2; locationId: EntityId;
  storage: ResourceBag; capacity: number;
  systems: { extraction: number; refinery?: boolean; repair?: boolean };
  hp: number; maxHp: number;
}
```
Stored on `GameState.stations`. Built via the construction system (a new build type alongside
ships in `engine.ts`), or deployed from a builder ship. A station auto-extracts from its location's
deposits (like a stationary miner, using its `extraction` rate), stores output, optionally refines
and repairs nearby friendly ships. Haulers deliver from the station to planets. Stations are
sensor sources and **defendable strategic targets** (they take damage / can be destroyed via the
normal combat path; destruction drops salvage per [033](033_logistics_warfare_cargo_and_salvage.md)).

### Progression
Document + support the staged path ([029](029_resource_and_industrial_logistics_design.md) §11): individual miner → mining fleet → miner +
hauler → storage ship → mining station → industrial network feeding the shipyard. Each stage is an
operation policy the player selects; the sim executes it.

## Key changes (per file)
- `packages/simulation/src/types.ts` — `Station`, `GameState.stations`; operation `bufferShipId`/`hubStationId`.
- `packages/simulation/src/worldSim.ts` (or `operations.ts`) — station auto-extraction + storage;
  storage-ship buffering flow; hauler collect-from-hub.
- `apps/server/src/engine.ts` — station construction/deploy; station tick; station in sensor sources.
- `packages/protocol/src/index.ts` — `StationDto`; build/deploy station command.
- `apps/server/src/snapshot.ts` — serialize stations (sensor-filtered) + owner detail.
- `apps/client/src/scene.ts` + `ui.ts` — render stations/storage hubs; build/deploy + monitor UI.

## Acceptance criteria
- Miners transfer to a storage ship that stays on-site; a hauler batch-collects from it and delivers
  to a planet — miners never stop mining.
- A mining station auto-extracts and stores at its location, boosting throughput vs. bare miners;
  haulers deliver from it.
- A station is a sensor source and can be damaged/destroyed via normal combat, dropping salvage.
- Operations can target a storage ship / station as the intermediate hub.

## Testing
- Unit (`@space/simulation`): station auto-extraction fills its storage and decrements reserves;
  storage-ship buffering + hauler collect-from-hub conserves totals.
- Server (`engine.test.ts`): build/deploy a station; advance ticks; station storage rises and
  haulers deliver to a planet; destroying a station drops salvage.
- E2E: stand up a storage-ship + hauler operation; observe miners never idling and resources
  flowing to the home planet.

## Unresolved questions
- Station build path: construct at a planet then deploy, vs. built in-place by a builder ship.
- Refinery conversion rules (which resources upgrade into which) — keep out of v1 or minimal.
- Station HP/defense tuning and whether it can be captured vs. only destroyed.
