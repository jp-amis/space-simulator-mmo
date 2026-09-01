# 029 — Resource Gathering & Industrial Logistics (Design Reference)

- **Status:** Reference (living design doc for the resource/industrial epic)
- **Design refs:** [DESIGN.md](../DESIGN.md) §4 (economy), §6 (server time & sim); builds on [015](015_continuous_combat_model.md) (one shared sim) and [025](025_always_on_ship_sim_static_anchor.md) (always-on per-ship sim)
- **Implemented by:** phase plans [030](030_resource_fields_and_ship_cargo.md)–[034](034_storage_ships_stations_and_progression.md)
- **Depends on:** [025](025_always_on_ship_sim_static_anchor.md)

## Purpose
Define the target model for resource gathering as a **physical activity in the persistent world**.
Resources are not an abstract button or passive income — players build ships, travel to deposits,
extract, carry cargo, transport, and unload. This document anchors the phase plans; each links
back to the section numbers here.

> **Resources are only truly useful once the player can physically extract and move them to where
> they are needed.**

The economy produces the military; the military protects the economy. A resource network is
therefore something other players can observe, defend, disrupt, raid, or destroy.

## 1. Core model rules (invariants)
1. **One simulation.** Mining, hauling, escorting, scouting and combat all happen in the same
   persistent real-time sim — there is **no separate mining or combat mode** ([015](015_continuous_combat_model.md) §1).
2. **`ResourceBag` = physical commodities only**, keyed by an **extensible `ResourceType` enum**.
   v1 ships `metal` + `fuel`; future `titanium` / `rareMetals` / `volatiles` / `exotics` add
   without changing the mining architecture. `ResourceBag = Partial<Record<ResourceType, number>>`.
3. **Energy is a derived stat, never a commodity.** Energy is produced from fuel/reactors/solar
   and lives as `ShipEnergyState { generation; consumption; available }` (and a planet analogue) —
   it is **never** stored in `ResourceBag` or carried as cargo.
4. **Mining is a dedicated room kind.** A new `Mining` `RoomKind` owns mining power, supported
   deposit types, extraction efficiency, energy draw, crew effects and damage state. `storage`
   stays responsible only for cargo *capacity*. Specialized equipment (MiningLaser, GasHarvester,
   DeepCoreDrill) are variants/config **under** the Mining kind, not top-level modules.
5. **Cargo is physical.** Resources are associated with the ship carrying them; destroying a
   laden ship destroys or drops (as salvage) part of that cargo.
6. **Industrial ships use the same modular builder** as military ships — players design their own
   miners/haulers/escorts with real space/mass/energy/crew/cost tradeoffs.
7. **Automation over clicking.** The interesting decisions are *what/where/which ships/how designed/
   how protected/which route/when to retreat* — once decided, the sim executes automatically.

## 2. The core loop
```
Discover deposit → Build/assign industrial ships → Travel → Extract → Store in cargo
      → Transport → Unload at destination → Repeat
```
Early game a single miner does the whole loop (mine → full → home → unload → repeat). Later,
specialized ships split the loop (miners stay on-site; haulers ferry; storage ships buffer;
stations refine) into a real logistics network.

## 3. Resource locations & deposits
Resource locations need not be planets — asteroid fields, moons, gas giants, ice worlds, nebulae,
rings, ruins, anomalies. A location holds one or more **deposits**:
```ts
interface ResourceDeposit {
  resource: ResourceType;
  richness: number;      // extraction-rate multiplier (e.g. 0.6 / 1.0 / 1.5)
  reserves: number;      // remaining amount; deposits can exhaust
  accessibility: number; // difficulty: mining power / energy / equipment / efficiency
}
```
Richness, reserves and accessibility make locations meaningfully different: a rich deposit deep in
hostile space can be worth less than a mediocre one next to home.

## 4. Industrial ships & tradeoffs
No fixed "mining ship" class. A miner is any ship with mining equipment; designs differ (an
efficient bare miner vs. an armored miner that survives hostile territory). Every module consumes
space/mass/energy/crew/cost, so installing one thing sacrifices another. Players naturally
specialize: cheap miner, long-range miner, armored miner, heavy hauler, blockade runner.

## 5. Mining
When a mining-capable ship reaches a deposit it extracts continuously:
```
extractionRate = miningPower × richness × crewEfficiency × shipEfficiency
```
Output fills **physical cargo**. Mining stops when cargo is full, the deposit is exhausted, the
ship gets another order, retreats, is destroyed, or loses its mining equipment.

## 6. Automated resource operations
Players create persistent **Resource Operations** — a state machine that issues orders
automatically:
```
TRAVEL_TO_RESOURCE → MINING → CARGO_FULL → RETURN_TO_BASE → UNLOADING → RETURN_TO_RESOURCE → …
```
It runs until cancelled, exhausted, made impossible, or its ships die. This rides the existing
order/intent/brain + scheduled-event infrastructure.

## 7. Industrial roles
Ships in an operation take roles that drive behavior:
`MINER` (extract, transfer, avoid combat), `HAULER` (collect, transport, unload),
`ESCORT` (guard, engage attackers, cover retreat), `SCOUT` (watch, report, avoid combat),
`REPAIR` and `SUPPORT`. Different ships in the same operation respond differently to threats
(escorts delay while miners flee).

## 8. Advanced logistics
Miners need not return home: haulers ferry accumulated cargo; **storage ships** act as mobile
hubs so miners never stop; **mining stations** add semi-permanent extraction/refinery/storage.
Because ships physically travel, transport creates **logistics routes** other players can observe.

## 9. Cargo, warfare & intelligence
- **Commerce raiding** emerges from normal movement + combat: position a fleet on a route; when a
  hauler passes, combat happens via the standard system. No special "raid" action.
- **Cargo as a physical asset:** destroying a laden ship destroys/drops cargo. A percentage
  survives as **debris/salvage** that salvage-capable ships can recover.
- **Threat behavior:** industrial fleets integrate with the doctrine/flee system (ignore / defend /
  retreat-if-attacked / retreat-on-detect / call-military / fight-until-destroyed), with retreat
  thresholds; they can **call nearby military** via the fleet decision system.
- **Scouting/intel:** repeated hauler traffic reveals operations, colonies, stations, and
  production centers; following a hauler can reveal a base.

## 10. Crew
Industrial ships use the same crew system as military. A Mining Engineer can affect mining speed,
rare-resource discovery, equipment wear, energy efficiency and deposit analysis, so a veteran
industrial ship is worth more than its hull.

## 11. Infrastructure progression
Individual miner → mining fleet → miner + hauler → storage infrastructure → mining station →
full industrial network feeding a shipyard that builds war fleets. Every connection is real ships
moving through space.

## 12. Mapping to the codebase (what exists vs. new)
**Reuse:** modular ship builder & validation (`ship.ts`), `storage` room + derived `cargo`
capacity, planet resource stores + lazy materialization (`economy.ts`), fleet order/intent/doctrine
+ `stepFleetBrain` (`worldSim.ts`), scheduled events (`engine.ts`), per-ship kinematics
(ShipRuntime), seeded determinism.
**New (phases 030–034):** `ResourceType` enum + `Partial` `ResourceBag`, `ShipEnergyState`,
`ResourceDeposit` world entities, physical ship cargo, `Mining` room kind + equipment, mining &
transfer logic, Resource Operation state machine + roles, logistics warfare + salvage/debris,
storage ships + stations + progression.

## Phase index
- **[030](030_resource_fields_and_ship_cargo.md)** — resource types/energy split, deposits, physical cargo, Mining room kind.
- **[031](031_mining_and_cargo_transfer.md)** — mining order + rate, ship↔ship / ship↔planet transfer & unload.
- **[032](032_resource_operations_and_industrial_roles.md)** — operation state machine + industrial roles.
- **[033](033_logistics_warfare_cargo_and_salvage.md)** — threat behavior, calling military, commerce raiding, debris/salvage.
- **[034](034_storage_ships_stations_and_progression.md)** — storage ships, mining stations, infrastructure progression.
