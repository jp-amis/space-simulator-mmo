# Migration to amis-engine + ENet — Overview

Goal: replace the TypeScript/PixiJS/WebSocket stack with a native C++20 build on
[`../amis-engine`](../../../amis-engine), networked over **ENet**, structured
after the reference game [`../tower-d`](../../../tower-d).

Read this file first. Every later step assumes the conventions defined here.

---

## 1. Why a full C++ port

The client "will be amis engine" (native C++, SDL-GPU). ENet is a C library.
The current server speaks JSON over `ws`; the current client is PixiJS. Neither
can talk ENet without a native layer. Bridging (Node ENet bindings + a wire
translator) would leave two languages, two protocols, and no code reuse. So we
port the whole thing to C++ and mirror tower-d's proven layout:

```
tower-d                     →  space-simulator-mmo (target)
  shared/  (binary proto)      shared/   binary protocol + shared enums/config
  server/  (headless amis)     server/   headless amis app + ENet thread + simulation
  client/  (amis app)          client/   amis app + ENet peer + render/input/UI
```

The current repo already separates I/O from logic (`packages/simulation` is pure,
deterministic, no I/O). That package is the crown jewel and ports almost 1:1 to
C++ — it becomes `server/src/sim`.

## 2. Source → target mapping

| Current (TS)                              | Target (C++)                                   | Step |
| ----------------------------------------- | ---------------------------------------------- | ---- |
| `apps/client/src` (PixiJS)                | `client/src` (amis render/input/UI)            | 008–011 |
| `apps/server/src/index.ts` (Fastify/ws)   | `server/src/game_server` (ENet thread)         | 004 |
| `apps/server/src/engine.ts` (tick loop)   | `server/src/sim/sim.cpp` (dispatch + tick)     | 004,007 |
| `apps/server/src/world.ts`                | `server/src/sim/world.cpp` (player registry)   | 007 |
| `apps/server/src/snapshot.ts` (visibility)| `server/src/sim/visibility.cpp`                | 007 |
| `packages/protocol` (Zod, JSON)           | `shared/net_shared.{h,cpp}` (binary streams)   | 003 |
| `packages/config` (constants)             | `shared/game_config.h`                         | 002 |
| `packages/simulation/types.ts`            | `shared/sim_types.h` + `server/src/sim/*`      | 002,005 |
| `packages/simulation/worldSim.ts`         | `server/src/sim/world_sim.cpp`                 | 006 |
| `packages/simulation/combat.ts`           | `server/src/sim/combat.cpp`                    | 006 |
| `packages/simulation/fleet.ts`            | `server/src/sim/fleet.cpp`                     | 006 |
| `packages/simulation/{operations,stations,resources,ship,worldgen,rng}.ts` | `server/src/sim/*.cpp` | 005 |
| `vitest` unit tests                       | C++ tests (doctest/Catch2)                     | 012 |
| Playwright e2e                            | headless client smoke + parity harness         | 012 |

## 3. Architecture decisions (locked)

- **Authoritative server, thin client.** Same as today: server owns all state.
  The client renders the `activeRegion` ship stream with interpolation and the
  throttled structural `snapshot`. The client does **not** run the simulation.
  → The simulation only needs to exist in C++ once (server side). This keeps the
  client port small. Client-side prediction is explicitly **out of scope**
  (see step 012 for the deferred note).
- **Wire format: custom little-endian binary** via bounds-checked
  `OutputStream`/`InputStream`, copied from tower-d (`shared/src/net_shared.cpp`).
  Replaces JSON+Zod. Every DTO gets an explicit `encode_*` / `decode_*`.
- **ENet channels** (mirror tower-d `GameServerChannel`):
  - `CHANNEL_CONTROL = 0` — reliable. Handshake (`hello`/`welcome`), commands
    (all `ClientMessage`), acks/rejects, structural `snapshot`.
  - `CHANNEL_STREAM  = 1` — unreliable. `activeRegion` deltas (ships,
    projectiles, combat events) — high rate, loss-tolerant.
  We do **not** copy tower-d's auth/DB stack. Player identity stays the current
  free-text `playerId` sent in `hello` (see step 003).
- **Tick rates unchanged.** `HEARTBEAT_MS = 50` (20 Hz outer), `ACTIVE_DT_MS =
  100` (10 Hz fixed physics step, accumulator). Server runs headless amis with
  `fixed_fps` and an accumulator, exactly like today's `GameServer.tick()`.
- **Determinism.** The PRNG in `rng.ts` is **mulberry32** (32-bit, uses
  `Math.imul`); it ports bit-exact to `uint32_t` wrap-multiply math (see step
  005). Physics uses `double`. Because the client does not re-simulate,
  cross-platform float determinism is **not required** for v1.
- **Engine consumption.** CMake, tower-d's detection order: `AMIS_SDK_PATH` →
  `vendor/amis-sdk/` → `AMIS_ENGINE_PATH` → relative `../amis-engine`. See step 001.
- **Memory.** amis arena allocator (`amis::MemArena`, `MEM_ARENA_NEW`). Per-frame
  scratch for encoding uses a child arena, freed/reset each tick. Long-lived
  simulation state (maps of ships/fleets) uses STL containers with arena
  allocators or plain heap — decided per step, default plain `std::` on the heap
  for the sim to keep the port mechanical (tower-d does this for its worlds).

## 4. API reference points (verify against real files)

All amis calls below are taken from tower-d's actual usage. When in doubt, the
source of truth is `../amis-engine/README.md`, `../amis-engine/CREATING_A_GAME.md`,
`../amis-engine/examples/`, and tower-d's files cited per step. Confirm exact
signatures before compiling — the engine header is `../amis-engine/include/amis.h`.

Core loop (from `tower-d/client/src/main.cpp`):

```cpp
amis::MemArena arena{};
amis::mem_arena_init(&arena, MB(50));
amis::AppConfig config{};
config.app_name = AMIS_APP_NAME;
config.arena = &arena;
config.design_width = 1280; config.design_height = 720;
config.fixed_fps = 60;              // server sets its own tick via accumulator
config.start   = []() { /* ... */ };
config.update  = []() { /* ... */ };
config.render  = []() { /* ... */ }; // omit/no-op when headless
config.destroy = []() { /* ... */ };
amis::app_run(&config);
```

## 5. Step index

| Step | File | Deliverable |
| ---- | ---- | ----------- |
| 000 | this file | conventions + mapping |
| 001 | `001_build_system_and_repo_layout.md` | CMake root, `project.conf`, engine detection, `shared/client/server` skeleton, mise tasks, keep-old-TS strategy |
| 002 | `002_shared_core_types_and_config.md` | `shared/math.h` (Vec2…), id types, `shared/game_config.h`, `shared/sim_types.h` |
| 003 | `003_shared_binary_protocol.md` | `net_shared.{h,cpp}`: message enums, channels, streams, every DTO codec |
| 004 | `004_server_skeleton_and_enet.md` | headless amis server, ENet thread, connection table, net queues, tick wiring |
| 005 | `005_server_sim_port_world_and_ships.md` | worldgen, world/player registry, ship/blueprint, resources, stations |
| 006 | `006_server_sim_port_step_and_combat.md` | `stepWorld` kinematics/steering, combat, fleet brain, operations, rng |
| 007 | `007_server_game_logic_and_broadcasting.md` | command handlers, visibility filter, snapshot + activeRegion broadcast |
| 008 | `008_client_skeleton_and_enet.md` | amis app, scene manager, ENet client peer, handshake, inbox |
| 009 | `009_client_state_store.md` | port `store.ts`: snapshot, activeShips, projectiles, interpolation, FX |
| 010 | `010_client_rendering_and_camera.md` | port `scene.ts`+`camera.ts`: background, map, ship LOD, combat FX, fog |
| 011 | `011_client_input_and_ui.md` | port `main.ts` input + `ui.ts`/`shipBuilder.ts`/`roster.ts` via Clay UI |
| 012 | `012_testing_parity_and_cutover.md` | C++ tests, parity vs TS, run scripts, delete old stack, deferred work |

Work top-to-bottom. 002/003 unblock everything; 004–007 (server) and 008–011
(client) can proceed in parallel once the protocol is frozen.

## 6. Unresolved questions

- SDK vs source: vendor a prebuilt `amis-sdk/` or `add_subdirectory(../amis-engine)`? Default = source, per tower-d.
- Keep monorepo pnpm workspace during transition, or hard cut? Default = keep TS running until 012 parity passes.
- Client UI: reuse tower-d's Clay bindings wholesale, or minimal custom immediate-mode UI? Affects step 011 scope.
- ENet packet cap: tower-d uses 8 KB. Our `snapshot` with many planets/ships/blueprints may exceed it — need fragmentation or reliable-fragmented packets (ENet supports `ENET_PACKET_FLAG_RELIABLE` fragmentation automatically). Confirm max snapshot size.
- Blueprint/rooms in `activeRegion` (for LOD detail) is heavy per-ship. Keep, or send blueprint once via `snapshot` and reference by id in the stream? Default = send once, reference by id (step 003).
- Test framework choice: doctest vs Catch2 vs GoogleTest. Default = doctest (header-only, fast).
- Determinism guarantee for a future client-prediction feature — do we commit to fixed-point now? Default = no, defer.
