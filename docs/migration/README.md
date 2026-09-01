# amis-engine + ENet migration plan

Step-by-step, code-level plan to port space-simulator-mmo from the TypeScript
(Fastify+ws / PixiJS) stack to native C++20 on [`../amis-engine`](../../../amis-engine),
networked over **ENet**, structured after [`../tower-d`](../../../tower-d).

Read [`000_overview.md`](000_overview.md) first — it defines the target layout,
the TS→C++ mapping, and the conventions every other file assumes.

## Steps

| # | File | Layer |
| - | ---- | ----- |
| 000 | [overview](000_overview.md) | conventions, mapping, decisions |
| 001 | [build system & repo layout](001_build_system_and_repo_layout.md) | CMake, ENet fetch, `shared/server/client` skeleton |
| 002 | [shared core types & config](002_shared_core_types_and_config.md) | `math.h`, `game_config.h`, `sim_types.h`, `GameState` |
| 003 | [shared binary protocol](003_shared_binary_protocol.md) | `net_shared.{h,cpp}`, MsgType/Channel, DTO codecs |
| 004 | [server skeleton & ENet](004_server_skeleton_and_enet.md) | headless amis app, ENet thread, conn table, net queues |
| 005 | [server sim: world & ships](005_server_sim_port_world_and_ships.md) | rng, worldgen, ship/blueprint, resources, stations, operations |
| 006 | [server sim: step & combat](006_server_sim_port_step_and_combat.md) | `stepWorld`, steering, combat, fleet brain |
| 007 | [server game logic & broadcasting](007_server_game_logic_and_broadcasting.md) | command handlers, visibility filter, snapshot/activeRegion |
| 008 | [client skeleton & ENet](008_client_skeleton_and_enet.md) | amis app, scenes, ENet peer, handshake |
| 009 | [client state store](009_client_state_store.md) | port `store.ts`: snapshot, activeShips, interpolation, FX |
| 010 | [client rendering & camera](010_client_rendering_and_camera.md) | port `scene.ts`+`camera.ts` to amis immediate-mode, fog |
| 011 | [client input & UI](011_client_input_and_ui.md) | polled input, Clay UI, ship builder, roster, guide |
| 012 | [testing, parity & cutover](012_testing_parity_and_cutover.md) | C++ tests, TS↔C++ parity harness, delete old stack |

## Ordering

002 + 003 unblock everything and freeze the wire contract. After that, server
(004→007) and client (008→011) proceed in parallel. 012 is the gate before
deleting the TS stack. Keep the pnpm/TS stack running until 012 parity is green.

## Cross-cutting open issues surfaced during drafting

- **RNG**: `rng.ts` is **mulberry32**, not an LCG — ported bit-exact in step 005.
  000 §3 corrected.
- **`stepStations`** lives in `operations.ts` (there is no `stations.ts`); step
  005 keeps the `stepStations` name in a `stations.cpp` per the 000 mapping.
- **Doctrine sliders vs wire**: `C_SET_DOCTRINE` carries only `preset:u8` (frozen
  in 003, matching current TS where the server expands preset→axes). The UI's
  aggression/pursuit/cohesion/survival sliders are therefore preset-driven in v1;
  direct per-axis control needs a protocol extension. Flagged in 003 & 011.
- **amis semantics to confirm before coding** (not invented in the docs):
  `Camera2D` handedness / Y-flip vs PixiJS top-left, `MaskParams.inverted`
  coverage direction for fog, `mouse_wheel()`/`mouse_delta()` polarity. Lock
  these before the step-012 screenshot diff. Source of truth: `../amis-engine/include/amis.h`.
- **Snapshot size vs ENet MTU**: rely on ENet reliable fragmentation for large
  structural snapshots in v1; delta-compression deferred (012).
