# Step 012 — Testing, parity & cutover

Goal: prove the C++ port behaves like the TS stack, then delete the TS stack.
Establish a C++ unit-test harness (doctest), port the vitest suites, add
determinism/golden tests, build a **cross-stack parity harness** (dump TS sim
state for a fixed seed+script, replay through the C++ sim, diff within epsilon),
replace Playwright with a headless ENet smoke test, document the `make server`/
`make client` dev loop, then — gated on parity green — remove `apps/`,
`packages/`, the pnpm workspace, vitest/playwright config, and rewrite the docs
for the C++/amis/ENet architecture.

Prereqs: 000–011 complete (server + client compile and run end-to-end).
Reference:

- `000_overview.md` §3 (authoritative server / thin client; determinism note),
  §5 step index, §6 (test-framework default = doctest).
- `001_build_system_and_repo_layout.md` (Makefile/mise targets, keep-old-TS
  strategy).
- `003_shared_binary_protocol.md` §10 (protocol round-trip done-criteria).
- TS suites being ported: `apps/server/src/engine.test.ts`,
  `apps/server/src/snapshot.test.ts`, `apps/client/src/store.test.ts`,
  `apps/client/e2e/game.spec.ts`, `apps/client/playwright.config.ts`, root
  `package.json` (`vitest run`).
- `tower-d/Makefile`, `tower-d/CMakeLists.txt` (project.conf parser, engine
  detection). tower-d ships **no** C++ tests — we add the first ones.

---

## 1. C++ unit-test harness (doctest)

Pick **doctest**: header-only, single include, fast compile, `TEST_CASE`/
`SUBCASE`/`CHECK`/`REQUIRE` macros, thread-safe. Fetch it like ENet (step 001).

### 1.1 Fetch via FetchContent

Add to the root `CMakeLists.txt`, guarded so it only builds when tests are on:

```cmake
option(SPACESIM_BUILD_TESTS "Build C++ unit tests" ON)

if(SPACESIM_BUILD_TESTS)
  include(FetchContent)
  FetchContent_Declare(doctest
    GIT_REPOSITORY https://github.com/doctest/doctest.git
    GIT_TAG        v2.4.11)
  FetchContent_MakeAvailable(doctest)   # target: doctest::doctest (INTERFACE)
  enable_testing()
  add_subdirectory(tests)
endif()
```

### 1.2 `tests/` target

The sim, visibility filter, and protocol codecs must be **linkable without
ENet/amis-window** — i.e. the server's simulation and `shared`'s codecs live in
libraries the test exe can link, not buried in the `spacesim-server`
executable's `main.cpp`. Refactor (step 004/007) so:

- `shared` (STATIC) already holds `net_shared.{h,cpp}` — link it directly.
- Split the server sim into a STATIC lib `spacesim_sim` (all of
  `server/src/sim/*.cpp` + the command handlers/visibility from step 007),
  leaving only ENet + `main.cpp` + the tick wiring in the `spacesim-server`
  executable. The test exe links `spacesim_sim` + `shared` + `amis` (for
  `MemArena`), **not** `enet`.

`tests/CMakeLists.txt`:

```cmake
file(GLOB_RECURSE TEST_SRC CONFIGURE_DEPENDS *.cpp)
add_executable(spacesim-tests ${TEST_SRC})
target_link_libraries(spacesim-tests PRIVATE
  doctest::doctest shared spacesim_sim amis)   # no enet, no window
target_compile_definitions(spacesim-tests PRIVATE AMIS_HEADLESS=1)

include(${doctest_SOURCE_DIR}/scripts/cmake/doctest.cmake)
doctest_discover_tests(spacesim-tests)          # registers each TEST_CASE with ctest
```

Exactly one `.cpp` defines the entry point:

```cpp
// tests/main.cpp
#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>
```

Every other `tests/*.cpp` just `#include <doctest/doctest.h>` and adds cases.

### 1.3 `make test`

Add to the `Makefile` (step 001):

```make
test: build            ## Build and run the C++ unit tests
	ctest --test-dir $(BUILD) --output-on-failure
```

mise (`.mise.toml`, alongside the step-001 tasks):

```toml
[tasks.cpp-test] run = "make test"
```

### 1.4 Which TS tests port, and how

| TS suite | C++ file | What it asserts |
| --- | --- | --- |
| `engine.test.ts` | `tests/sim_step_test.cpp` | Deterministic sim steps: seed a `ss::GameState`, run N ticks, assert ship positions / combat resolution / registry / economy. |
| `snapshot.test.ts` | `tests/visibility_test.cpp` | Visibility filter: enemy internals never leak; own ships always stream; sensor range gates enemy ships + deposits. |
| `store.test.ts` | `tests/client_store_test.cpp` | Client `Store` apply + interpolation: fleet-marker centroid, `inCombat`, projectile dead-reckoning, client-side explosions. |
| `003 §10` | `tests/protocol_roundtrip_test.cpp` | Encode→decode equality for **every** `MsgType`. |

**sim_step_test.cpp** — port `engine.test.ts`. The TS `harness()` (fake clock +
inbox capture) becomes a small C++ fixture that drives the sim tick and captures
the messages the broadcast layer would emit. Keep NPC seeding off for
determinism (the TS harness passes `{ seedNpcs: false }`):

```cpp
// A headless driver mirroring engine.test.ts::harness().
struct SimHarness {
  ss::GameState game;
  uint64_t clock = 1'000'000;               // ms, matches the TS start clock
  std::unordered_map<std::string, std::vector<Msg>> inbox;

  SimHarness() { ss::create_game_state(&game, clock, /*seed_npcs=*/false); }
  ConnectResult connect(const std::string& id) { return sim_connect(&game, id, clock, sink()); }
  void advance(uint32_t ms) { clock += ms; sim_tick(&game, clock, sink()); }
  // sink() captures welcome/snapshot/activeRegion/ack/reject per player id.
};

TEST_CASE("fleet move: anchor jumps to click, ships fly there, then park idle") {
  SimHarness h;
  h.connect("alice");
  auto* fleet = own_fleet(&h.game, "alice");
  ss::Vec2 start = ss::fleet_centroid(&h.game, fleet);
  ss::Vec2 target{ start.x + 1200.0, start.y };
  sim_handle(&h.game, "alice", MoveFleetCmd{ .requestId="r1", .fleetId=fleet->id, .target=target }, h.clock, h.sink());
  CHECK(fleet->position.x == doctest::Approx(target.x));       // anchor teleports
  CHECK(fleet->status == ss::FleetStatus::Moving);
  bool arrived = false;
  for (int i = 0; i < 600 && !arrived; ++i) {
    h.advance(50);
    ss::Vec2 c = ss::fleet_centroid(&h.game, fleet);
    if (std::hypot(c.x - target.x, c.y - target.y) < 80.0) arrived = true;
  }
  CHECK(arrived);
  for (int i = 0; i < 40; ++i) h.advance(50);
  CHECK(own_fleet(&h.game, "alice")->status == ss::FleetStatus::Idle);
}
```

Port each `describe`/`it` from `engine.test.ts` 1:1: player registry (connect →
welcome+snapshot, reconnect same state, reject double-connect), fleet
ownership-reject-without-mutation, converging-hostiles combat resolution,
economy build-on-schedule, split/merge fleets, hold/pursue orders, mining/unload,
station build, operation cycling, formation set + reject. Reuse the exact
loop counts and thresholds from the TS test (they are already tuned to the sim
constants and are the parity spec).

**visibility_test.cpp** — port `snapshot.test.ts`. The key invariant is
structural (§7 of step 003 makes enemy internals unencodable), but assert it at
the sim layer too: `get_visible_state` / `build_sensed_ships` for a coarse enemy
fleet carry no `anchor`/`doctrine`; own + in-range enemy ships stream with
blueprint+rooms; out-of-range enemy ships vanish while own ships persist; near
deposits are revealed, far ones hidden.

```cpp
TEST_CASE("nearby enemy fleet revealed coarsely — no anchor/doctrine leak") {
  ss::GameState game; ss::create_game_state(&game, 1'000'000, false);
  auto* alice = ss::get_or_create_player(&game, "alice", 1'000'000);
  auto* bob   = ss::get_or_create_player(&game, "bob",   1'000'000);
  auto* home  = ss::planet(&game, alice->homePlanetId);
  auto* bf    = ss::first_fleet_of(&game, bob->id);
  place_fleet(&game, bf, home->position.x + 200, home->position.y, 1'000'000);
  VisibleState snap = ss::get_visible_state(&game, "alice", 1'000'000);
  const FleetDto* seen = find_fleet(snap, bf->id);
  REQUIRE(seen != nullptr);
  CHECK_FALSE(seen->anchor.has_value());     // coarse only
  CHECK_FALSE(seen->doctrine.has_value());
}
```

**client_store_test.cpp** — port `store.test.ts`. The client `Store` (step 009)
is pure state + interpolation with an injectable clock (the TS test mocks
`performance.now`). Drive it with a fake `now_ms` and feed it decoded
`S_SNAPSHOT` / `S_ACTIVE_REGION` DTOs:

- fleet marker = centroid of streamed ships; falls back to snapshot position;
  anchor exposed separately.
- `in_combat` true only when an **own** ship has a target.
- projectile dead-reckon by velocity, pruned when absent next delta.
- explosion at a destroyed ship's last position (and from the event position
  even if the ship was never streamed), expires after its lifetime.
- client-side death heuristics (mortally-wounded / lock-target vanish → explode;
  healthy vanish = left sensor → no explosion).

**protocol_roundtrip_test.cpp** — step 003 §10 done-criteria. For every
`MsgType`, build the DTO, `enc_*` into an `OutputStream` (child `MemArena`),
wrap the bytes in an `InputStream`, `dec_*`, assert field equality; assert
`in.error == false` on valid input and `true` on a truncated buffer.

```cpp
TEST_CASE("protocol round-trip: every MsgType encodes then decodes equal") {
  amis::MemArena a{}; amis::mem_arena_init(&a, MB(1));
  SUBCASE("C_MOVE_FLEET") {
    OutputStream out = enc_move_fleet(&a, "req-1", "fleet-7", ss::Vec2{ 12.5, -3.0 });
    InputStream in = is_create(out.buffer, out.pos);
    CHECK((MsgType)is_u8(&in) == MsgType::C_MOVE_FLEET);
    MoveFleetCmd c = dec_move_fleet(&in);
    CHECK(c.requestId == "req-1");
    CHECK(c.fleetId  == "fleet-7");
    CHECK(c.target.x == doctest::Approx(12.5));
    CHECK(c.target.y == doctest::Approx(-3.0));
    CHECK_FALSE(in.error);
  }
  SUBCASE("truncated input sets error") {
    OutputStream out = enc_move_fleet(&a, "req-1", "fleet-7", ss::Vec2{1,2});
    InputStream in = is_create(out.buffer, out.pos - 3);   // chop tail
    is_u8(&in); (void)dec_move_fleet(&in);
    CHECK(in.error);
  }
  // ... one SUBCASE per MsgType (S_WELCOME, S_SNAPSHOT, S_ACTIVE_REGION, S_ACK,
  // S_REJECT, and every C_* command from step 003 §4).
  amis::mem_arena_free(&a);
}
```

Do `S_SNAPSHOT` / `S_ACTIVE_REGION` round-trips against a small `ss::GameState`
so nested collection encoders (`enc_planet`, `enc_fleet`, `enc_ship`, …) are all
exercised.

---

## 2. Determinism / golden tests

The LCG (`state = state*1664525 + 1013904223`) ports bit-exact to `uint32_t`;
physics uses `double`. On a **single build/platform** the sim is deterministic:
same seed + same scripted command sequence ⇒ identical `destroyedShipIds` and
final ship positions across runs.

```cpp
struct ScriptEvent { uint32_t at_ms; Command cmd; };   // decoded command + issue time

RunResult run_script(uint32_t seed, const std::vector<ScriptEvent>& script, uint32_t total_ms) {
  ss::GameState game; ss::create_game_state_seeded(&game, seed, /*seed_npcs=*/false);
  uint64_t clock = 1'000'000; size_t si = 0;
  for (uint32_t t = 0; t <= total_ms; t += 50) {
    clock += 50;
    while (si < script.size() && script[si].at_ms <= t)
      sim_handle(&game, script[si].cmd, clock, null_sink()), ++si;
    sim_tick(&game, clock, null_sink());
  }
  return { destroyed_ship_ids(&game), final_positions(&game) };   // sorted, deterministic order
}

TEST_CASE("determinism: same seed + script → identical outcome across runs") {
  auto script = converging_hostiles_script();
  RunResult a = run_script(1337, script, 300'000);
  RunResult b = run_script(1337, script, 300'000);
  CHECK(a.destroyed == b.destroyed);
  for (auto& [id, pos] : a.positions) {
    CHECK(pos.x == doctest::Approx(b.positions.at(id).x));   // exact same build → bit-equal, Approx is belt-and-suspenders
    CHECK(pos.y == doctest::Approx(b.positions.at(id).y));
  }
}
```

**Recorded golden.** Freeze one canonical (seed, script) run's result to a
committed JSON fixture (`tests/golden/converging_hostiles.json`: sorted
`destroyedShipIds` + final positions). The test loads it and compares — catches
accidental sim-logic changes. Regenerate deliberately with a
`--update-golden` flag (env var `SPACESIM_UPDATE_GOLDEN=1`) when a rules change
is intended, and review the diff. Keep golden compares **exact** for
`destroyedShipIds` (ids/set), and epsilon for positions.

> Cross-platform float determinism is **not** required for v1 (000 §3: the
> client doesn't re-simulate). The golden is per-build; if CI runs a different
> compiler/arch, widen the position epsilon or pin the golden to one CI image.

---

## 3. Cross-stack parity harness (the confidence gate)

The one test that lets us delete TS with confidence: **the C++ sim reproduces
the TS sim** for a fixed seed + scripted command sequence. Because both stacks
share the LCG and the same double arithmetic, results match within a float
epsilon.

### 3.1 TS side — dump reference states

Add a throwaway script under the existing TS tree (it dies with the cutover):

```ts
// apps/server/src/parity-dump.ts  (run with tsx; deleted in §6)
import { createGameStateSeeded, stepWorld } from "@space/simulation";
import { readScript } from "./parity-script.js";  // shared JSON script format

const seed = Number(process.env.SEED ?? 1337);
const script = readScript(process.env.SCRIPT!);        // [{ atMs, cmd }]
const game = createGameStateSeeded(seed, { seedNpcs: false });
let clock = 1_000_000, si = 0;
const frames: unknown[] = [];
for (let t = 0; t <= 300_000; t += 50) {
  clock += 50;
  while (si < script.length && script[si]!.atMs <= t) handle(game, script[si++]!.cmd, clock);
  stepWorld(game, 50, clock);
  if (t % 5000 === 0) frames.push(sampleState(game));   // checkpoint every 5s
}
frames.push(sampleState(game));                          // final
process.stdout.write(JSON.stringify({ seed, frames }));  // → tests/parity/<name>.ts.json
```

`sampleState` emits a canonical, order-stable projection: sorted ship list
`{ id, x, y, heading, hullHp, shield, alive }`, sorted `destroyedShipIds`,
per-player `{ metal, fuel }`. **Same fields, same sort, same units** on both
sides — that projection is the parity contract.

The **script JSON** is the single shared input for both stacks (one file, e.g.
`tests/parity/scripts/converging_hostiles.json`): a list of `{ atMs, cmd }`
where `cmd` matches the step-003 command field lists. Both the TS dumper and the
C++ harness read it, so the exact same commands hit both sims.

### 3.2 C++ side — replay and diff

```cpp
TEST_CASE("parity: C++ sim matches TS reference within epsilon") {
  ParityRef ref = load_ref("tests/parity/converging_hostiles.ts.json");  // seed + checkpoint frames
  ss::GameState game; ss::create_game_state_seeded(&game, ref.seed, false);
  auto script = load_script("tests/parity/scripts/converging_hostiles.json");
  uint64_t clock = 1'000'000; size_t si = 0, fi = 0;
  for (uint32_t t = 0; t <= 300'000; t += 50) {
    clock += 50;
    while (si < script.size() && script[si].at_ms <= t)
      sim_handle(&game, script[si++].cmd, clock, null_sink());
    ss::step_world(&game, 50, clock);
    if (t % 5000 == 0) check_frame(sample_state(&game), ref.frames[fi++]);
  }
  check_frame(sample_state(&game), ref.frames.back());
}

static void check_frame(const StateSample& got, const StateSample& want) {
  CHECK(got.destroyed == want.destroyed);                // exact set equality
  REQUIRE(got.ships.size() == want.ships.size());
  for (size_t i = 0; i < got.ships.size(); ++i) {        // both sorted by id
    CHECK(got.ships[i].id == want.ships[i].id);
    CHECK(got.ships[i].x       == doctest::Approx(want.ships[i].x).epsilon(PARITY_EPS));
    CHECK(got.ships[i].y       == doctest::Approx(want.ships[i].y).epsilon(PARITY_EPS));
    CHECK(got.ships[i].heading == doctest::Approx(want.ships[i].heading).epsilon(PARITY_EPS));
    CHECK(got.ships[i].hullHp  == doctest::Approx(want.ships[i].hullHp).epsilon(PARITY_EPS));
  }
}
```

Float-nondeterminism tolerance: `PARITY_EPS` starts tight (`1e-6` relative) —
JS `number` is IEEE-754 double, same as C++ `double`, so with identical
operation order they should agree to near machine epsilon. If ordering diffs
(e.g. `Map` iteration vs `std::unordered_map`) creep in, **fix the ordering**
(iterate sorted ids) rather than widen the epsilon; only widen for genuine
transcendental/`Math.hypot`-rounding drift. Diverging `destroyedShipIds` is a
hard fail — that's a logic bug, not float drift.

Checkpoint every 5 s (not every tick) so a divergence surfaces early with a
coarse timestamp, then re-run with per-tick sampling to bisect.

### 3.3 Make target

```make
parity: build          ## Regenerate TS refs, then run the C++ parity suite
	pnpm --filter @space/server exec tsx src/parity-dump.ts \
	  > tests/parity/converging_hostiles.ts.json   # SEED/SCRIPT via env
	ctest --test-dir $(BUILD) -R parity --output-on-failure
```

Parity green (all scripts, all checkpoints) is the **cutover gate** in §6. Keep
the refs committed so the C++ suite runs even after the TS dumper is gone —
until we're confident, then delete them with the rest.

---

## 4. Integration / e2e (replaces Playwright)

Playwright drove a real browser over the DOM. The C++ client is a native amis
window with no DOM, so the browser e2e can't survive. Replace `game.spec.ts`
with a **headless ENet smoke test**: a scripted client that connects over real
ENet to a real `spacesim-server`, sends commands, and asserts the server→client
protocol.

Two flavors:

1. **In-process** (fast, default in `ctest`): start the ENet server host on a
   thread (`127.0.0.1:0`, ephemeral port), connect an ENet peer in the same
   process, run the handshake + a couple of commands. No amis window, no render.

2. **Two-process smoke** (`make e2e`): spawn `spacesim-server`, run a tiny
   `spacesim-smoke` client (a headless build of the client's net + store layer,
   no window) that connects to `127.0.0.1:9002`.

Scripted flow (mirrors `game.spec.ts`'s combat test):

```cpp
TEST_CASE("e2e smoke: connect → welcome/snapshot, spawn hostile → activeRegion") {
  TestServer srv;                       // starts ENet host on an ephemeral port
  EnetTestClient cli(srv.port());
  cli.send(Channel::CONTROL, enc_hello(cli.arena(), "smoke"));
  Msg welcome = cli.recv_until(MsgType::S_WELCOME, /*timeout_ms=*/2000);
  CHECK(welcome.as_welcome().playerId == "smoke");
  Msg snap = cli.recv_until(MsgType::S_SNAPSHOT, 2000);
  CHECK(snap.as_snapshot().planets.size() > 10);       // procedural map arrived
  CHECK(snap.as_snapshot().ships.size() == 2);          // starter ships

  auto* fleet = own_fleet_from(snap);
  cli.send(Channel::CONTROL, enc_set_doctrine(cli.arena(), "d", fleet->id, DoctrinePreset::AttackOnSight));
  cli.send(Channel::CONTROL, enc_spawn_hostile(cli.arena(), "s", fleet_centroid_from(snap)));

  bool got_enemy = false;
  for (int i = 0; i < 400 && !got_enemy; ++i) {          // stream is unreliable — poll
    Msg d = cli.recv_until(MsgType::S_ACTIVE_REGION, 200, /*optional=*/true);
    if (d && d.as_active_region().ships_have_owner_other_than("smoke")) got_enemy = true;
  }
  CHECK(got_enemy);                                      // enemy ship entered the stream
}
```

This covers the load-bearing bits of `game.spec.ts` that don't depend on
rendering: handshake, snapshot contents (planet/ship counts), command
round-trip, and combat presence on the `activeRegion` stream. Rendering/camera/
UI assertions (screenshots, `#inspector`, `worldToScreen`) are **dropped** —
they were DOM/PixiJS-specific; amis UI verification is manual for v1 (see
deferred, §7). amis exposes `AppConfig.headless` (see `amis.h`), so a
window-less client build is supported if we want flavor 2 to reuse the real
client code paths.

`make e2e`:

```make
e2e: build             ## Run the ENet integration smoke test
	ctest --test-dir $(BUILD) -R e2e --output-on-failure
```

---

## 5. Run scripts / dev loop

From step 001's `Makefile`; two terminals:

```bash
make server     # builds, then runs build/bin/spacesim-server → "ENet host listening on :9002"
make client     # builds, then runs build/bin/spacesim → opens the amis window, connects to 127.0.0.1:9002
```

The client's server address defaults to `127.0.0.1:9002` (override via env/arg,
mirroring the old `VITE_SERVER_URL`). mise wraps both (step 001):

```toml
[tasks.cpp-server] run = "make server"
[tasks.cpp-client] run = "make client"
[tasks.cpp-build]  run = "make build"
[tasks.cpp-test]   run = "make test"
```

Typical loop: `mise run cpp-server` in one pane, `mise run cpp-client` in
another. Tests: `make test`; parity gate: `make parity`; smoke: `make e2e`.

---

## 6. Cutover checklist (gated on parity green)

Do **not** start until `make test`, `make parity`, and `make e2e` are all green
on every parity script. Git Flow: do this on a `feature/cpp-cutover` branch off
`develop`. **Do not commit** — the user commits (per project rules); just stage
the deletions in the working tree and hand off.

Delete the TS stack:

- [ ] `apps/client/` (PixiJS client)
- [ ] `apps/server/` (Fastify/ws server) — **including** `parity-dump.ts` /
      `parity-script.ts` once refs are frozen and trusted.
- [ ] `packages/protocol/` (Zod)
- [ ] `packages/simulation/` (crown-jewel sim — now `server/src/sim`)
- [ ] `packages/config/` (constants — now `shared/game_config.h`)
- [ ] pnpm workspace files: `pnpm-workspace.yaml`, root `package.json`,
      `pnpm-lock.yaml`, every package's `package.json`/`tsconfig.json`
- [ ] vitest config + `test`/`test:watch` scripts (gone with `package.json`)
- [ ] `apps/client/playwright.config.ts` + `apps/client/e2e/`
- [ ] `.npmrc`, `vite.config.ts`, any TS-only `eslint`/`prettier` wiring that
      only served the TS tree (keep prettier for docs if desired)

Rewrite docs for the C++/amis/ENet architecture:

- [ ] `README.md` — new build/run: `make build`, `make server`, `make client`,
      `make test`; drop pnpm/Node/PixiJS instructions.
- [ ] `docs/README.md` — point at `docs/migration/*` as the current
      architecture; describe shared/server/client C++ layout.
- [ ] `docs/DESIGN.md` — replace transport/impl mentions (ws/JSON/Zod/PixiJS)
      with ENet binary protocol + amis; keep the game design intact.
- [ ] Keep `docs/plans/*` **as-is** (historical record of the TS prototype); add
      a one-line note at the top of `docs/plans/000_overview.md` that they
      describe the original TS build, superseded by `docs/migration/`.

Player guide:

- [ ] The in-app guide moved from `apps/client/src/guide.ts` to a ported C++
      guide (amis UI, step 011). Delete `guide.ts` + `apps/client/public/guide/`
      screenshot assets, and confirm the ported guide renders. Per the memory
      note, **keep it synced** with gameplay on future changes.

Update the step index (`000_overview.md` §5) — mark 012 Done once cutover lands.

---

## 7. Deferred / out-of-scope work

Explicitly **not** done here; recorded so they aren't lost:

- **Client-side prediction & reconciliation.** Requires the sim to run on the
  client too (shared C++ sim lib linked into `client/`) *and* cross-platform
  fixed-point determinism so predicted state matches the server. 000 §3 locks
  thin-client for v1; today's interpolation-only client stays. Big feature.
- **Fixed-point / cross-platform determinism.** Not committed (000 §3, §6). v1
  parity is single-build. Needed before prediction or any client re-sim.
- **Interned `uint32` ids.** Wire + maps currently use string ids (step 003 kept
  `requestId`/entity ids as strings for a mechanical port). Interning to
  `uint32` shrinks packets and speeds map lookups — later optimization.
- **Snapshot delta-compression.** `S_SNAPSHOT` is full structural state,
  throttled + ENet-fragmented (003 §11). Delta-encoding structural state (send
  only changed records) is deferred; revisit if snapshots blow the MTU.
- **Auth / DB.** tower-d has an auth/DB stack; we deliberately dropped it (000
  §3). Identity stays free-text `playerId` in `hello`. Persistence/accounts
  deferred.
- **Windows / iOS platform targets.** Desktop-first (macOS + Linux), per step
  001 §4. Copy tower-d's `platform/` dirs when a target is actually needed.
- **Spectating / multi-world / sharding.** Single authoritative world for v1.

---

## Done when

- `make test` builds `spacesim-tests` (doctest, no ENet/window) and passes:
  ported `engine`, `snapshot`, `store` suites + protocol round-trips (every
  `MsgType`, truncated-input error case).
- Determinism test passes (same seed+script → identical `destroyedShipIds` +
  positions) and a committed golden compares clean.
- `make parity` is green: C++ sim matches the TS reference dump within
  `PARITY_EPS` for every checkpoint of every parity script; `destroyedShipIds`
  match exactly.
- `make e2e` passes the ENet smoke test (welcome/snapshot/activeRegion over real
  channels).
- `make server` + `make client` run the two-process game against
  `127.0.0.1:9002`.
- Cutover done on `feature/cpp-cutover` (staged, not committed): TS tree
  deleted, `README`/`docs/README`/`docs/DESIGN` rewritten, `docs/plans` kept
  historical, in-app guide ported.

---

## Unresolved questions

- doctest vs Catch2 final — default doctest (000 §6). Confirm before wiring
  `tests/`.
- Refactor server sim into `spacesim_sim` STATIC lib now (needed so tests link
  without ENet/window) — do it in 004/007 or retro here? Default: 004/007.
- Parity epsilon `1e-6` too tight? Depends on `Math.hypot`/`atan2` vs C++ std
  agreement — measure on first run, tighten ordering before widening eps.
- Golden per-build only — pin CI to one image, or store multiple goldens? Default
  single image.
- Two-process `make e2e` needs a headless `spacesim-smoke` client build — reuse
  real client net+store via `AppConfig.headless`, or a minimal standalone? Default
  minimal standalone; revisit if we want prediction later.
- Keep parity TS dumper around post-cutover for a while, or delete immediately?
  Default: delete once refs trusted (they're committed).
- CI runner for C++ tests (GitHub Actions macOS+Linux matrix) — out of this
  step's scope? Default yes, separate task.
