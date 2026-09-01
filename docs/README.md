# Docs & Plan Tracker

Living index for the Space Strategy MMO prototype. Every feature is planned as a
numbered doc in [`plans/`](plans/) that maps 1:1 to a Step in
[DESIGN.md §13](DESIGN.md). Update the **Status** column as work progresses.

- [DESIGN.md](DESIGN.md) — full design doc (source of truth, extracted from `design_doc.docx`)
- [plans/000_overview.md](plans/000_overview.md) — scope, stack, architectural rules, definition of done

## Status legend

`Not started` · `In progress` · `In review` · `Done` · `Blocked` · `Superseded`

## Plans

| #   | Plan | Design step | Status | Notes |
| --- | --- | --- | --- | --- |
| 000 | [Overview & Architecture](plans/000_overview.md) | §1–3, 16, 19 | Reference | Living anchor doc |
| 001 | [Monorepo & Dev Loop](plans/001_monorepo_and_dev_loop.md) | Step 0 | Done | pnpm dev runs both; /health + connection indicator |
| 002 | [ID Entry & Player Registry](plans/002_id_entry_and_player_registry.md) | Step 1 | Done | free-text id; reject while connected; reconnect reuses state |
| 003 | [Strategic Map & Procedural Universe](plans/003_strategic_map_and_procedural_universe.md) | Step 2 | Done | Pixi map, camera, selection, inspector (e2e) |
| 004 | [Fleet Domain & Free Movement](plans/004_fleet_domain_and_movement.md) | Step 3 | Done | analytical movement, arrival heap, redirect, interpolation |
| 005 | [Encounter Detection](plans/005_encounter_detection.md) | Step 4 | Done | spatial hash + closest-approach scheduling |
| 006 | [Minimal Battle Simulation](plans/006_minimal_battle_simulation.md) | Step 5 | Superseded | discrete-battle model replaced by [015](plans/015_continuous_combat_model.md) |
| 007 | [FTL-like Modular Ships](plans/007_ftl_modular_ships.md) | Step 6 | Done | hull grids, rooms, derived stats, room-targeted damage |
| 008 | [Ship Builder UI](plans/008_ship_builder_ui.md) | Step 7 | Done | grid editor, validation, live derived stats (e2e) |
| 009 | [Economy & Construction](plans/009_economy_and_construction.md) | Step 8 | Done | lazy resources, scheduled construction completion |
| 010 | [Combat Presentation](plans/010_combat_presentation.md) | Step 9 | Superseded | separate battle view replaced by on-map combat ([015](plans/015_continuous_combat_model.md)) |
| 011 | [Visibility, Sensors & Polish](plans/011_visibility_sensors_and_polish.md) | Step 10 | Done | getVisibleState filter, sensor/ETA overlays, debug layer |
| 012 | [Fleet & Ship Management](plans/012_fleet_and_ship_management.md) | Post-proto | Done | roster panel; docked ships; create/add/split/merge (e2e) |
| 013 | [Battle Lifecycle & Exit](plans/013_battle_lifecycle_and_exit.md) | Post-proto | Superseded | battle-view lifecycle replaced by continuous combat ([015](plans/015_continuous_combat_model.md)) |
| 014 | [Navigation & Camera](plans/014_navigation_and_camera.md) | Post-proto | Done | center-on-home button + H; fleet list center-on-fleet (e2e) |
| 015 | [Continuous Combat Model](plans/015_continuous_combat_model.md) | Refactor | Reference | design reference for continuous shared-world fleet combat |
| 016 | [Per-ship Kinematics & Active Clusters](plans/016_per_ship_kinematics_and_active_clusters.md) | Refactor | Done | active-cluster promote/step/demote; transient ActiveShip runtime |
| 017 | [Continuous Combat Resolution](plans/017_continuous_combat_resolution.md) | Refactor | Done | shared combat.ts; world-space projectiles; live damage writeback |
| 018 | [Ship Brain & Doctrine](plans/018_ship_brain_and_doctrine.md) | Refactor | Done | perception, steering forces, soft formation, ship doctrine |
| 019 | [Fleet Brain: Consensus & Intent](plans/019_fleet_brain_consensus_and_intent.md) | Refactor | Done | weighted consensus, FleetIntent, leash, player authority |
| 020 | [Fleet Orders & Doctrine](plans/020_fleet_orders_and_doctrine.md) | Refactor | Done | MoveTo/Follow/AttackMove/Pursue/Escort/Hold; doctrine presets |
| 021 | [Protocol & Networking](plans/021_protocol_and_networking.md) | Refactor | Done | remove battle DTOs; active-region delta; sensor-filtered visibility |
| 022 | [Client Rendering & LOD](plans/022_client_rendering_and_lod.md) | Refactor | Done | ships on map; zoom LOD; removes separate battle view |
| 023 | [Combat UI & Tests](plans/023_combat_ui_and_tests.md) | Refactor | Done | orders/doctrine UI; spawn-hostile tool; determinism + e2e rewrite |
| 024 | [Smooth Enemy-Fleet Visualization](plans/024_smooth_enemy_fleet_visualization.md) | Map polish | Superseded | fog-safe velocity hint (replaced by always-on ship interpolation in 025) |
| 025 | [Always-On Per-Ship Sim + Static Anchor](plans/025_always_on_ship_sim_static_anchor.md) | Refactor | Done | ships always simulated around a static goal anchor; centroid marker; tight sensors; always-stream sensed ships |
| 026 | [Movement & Order Fixes](plans/026_movement_and_order_fixes.md) | Post-025 fixes | Done | static anchor (no drift); slowest-ship fleet speed cap; pursue standoff distance |
| 027 | [Fleet Formation Presets](plans/027_fleet_formation_presets.md) | Post-025 feature | Done | 8 role-aware presets (column/line/wedge/echelon/box/screen/protect/loose); setFormation cmd+UI |
| 028 | [Client Visual Polish](plans/028_client_visual_polish.md) | Post-025 polish | Done | projectile interpolation; cannon vs laser visuals; fog-of-war overlay; explosion FX |
| 029 | [Resource & Industrial Logistics — Design](plans/029_resource_and_industrial_logistics_design.md) | Resource epic | Reference | anchor doc: physical mining/logistics; ResourceType enum; energy derived; Mining room kind |
| 030 | [Resource Fields & Ship Cargo](plans/030_resource_fields_and_ship_cargo.md) | Resource epic P1 | Done | ResourceType/ResourceBag; EnergyState; deposits; physical cargo; Mining room kind |
| 031 | [Mining & Cargo Transfer](plans/031_mining_and_cargo_transfer.md) | Resource epic P2 | Done | mine order + extraction rate; ship↔ship transfer; ship↔planet unload |
| 032 | [Resource Operations & Industrial Roles](plans/032_resource_operations_and_industrial_roles.md) | Resource epic P3 | Done | operation state machine (mine→return→unload→repeat); IndustrialRole; auto-mine op |
| 033 | [Logistics Warfare, Cargo & Salvage](plans/033_logistics_warfare_cargo_and_salvage.md) | Resource epic P4 | Done | debris/salvage on death; call-military-on-threat; emergent commerce raiding |
| 034 | [Storage Ships, Stations & Progression](plans/034_storage_ships_stations_and_progression.md) | Resource epic P5 | Done | mining stations (auto-extract/sensor/build); storage-ship transfer; progression |
| 035 | [Mining Fills Cargo to Full](plans/035_mining_fills_to_full.md) | Resource fix | Done | auto-mine op stopped at 95% (FULL_FRACTION) — now fills fully (miners-full check) |
| 036 | [Mining Ring + Face the Deposit](plans/036_mining_ring_and_heading.md) | Resource behavior | Done | miners ring the field (not the core) and point inward while mining |
| 037 | [Escort Screen Protects Miners](plans/037_escort_screen_protects_miners.md) | Resource behavior | Done | non-mining ships form a protective outer ring around miners |
| 038 | [Timed Unload with Transfer Beam](plans/038_timed_unload_with_beam.md) | Resource presentation | Done | unloadAt order streams cargo over time with a ship→planet beam (auto + manual) |
| 039 | [Floating Wreck Effect](plans/039_floating_wreck_effect.md) | Client polish | Done | dropped wrecks gently float/drift + slow spin (client-only) |
| 040 | [Ship Explosion on Death](plans/040_client_side_death_explosion.md) | Client fix | Done | client-side death detection (mortal/targeted ship vanishes → explode); no server change |

## First playable milestone

See [DESIGN.md §18](DESIGN.md). Target: free-text ID, procedural map (10–30
planets), two configurable ships each, simple ship builder, continuous fleet
movement with mid-flight redirect, intentional trajectory crossing, fully
automatic seeded room-damage battle, survivors return to the map with damage
preserved. Roughly plans **001–008 + 010**.

## Conventions

- Filename: `{NNN}_{snake_case_name}.md`, `NNN` zero-padded, matching this table.
- One plan = one Step. Keep plans small; split if a step grows.
- Each plan links back to `DESIGN.md` sections and to its dependency plans.
- When you finish a plan, flip its Status to `Done` here and in the plan header.
