# Step 004 — Server skeleton & ENet networking

Goal: stand up the headless amis server app and its ENet networking layer. End
state: a `spacesim-server` that boots amis headless, spins an ENet host on
`ENET_HOST_ANY:9002`, accepts connections, does the free-text `hello`→`welcome`
handshake, and runs the fixed-step tick loop draining inbound packets and
enqueuing outbound ones — with the simulation port (steps 005–007) plugged into
`sim_update()`.

This is the C++ replacement for `apps/server/src/index.ts` (Fastify + `ws`
transport, connection map, `setInterval(tick, HEARTBEAT_MS)`). We drop tower-d's
auth/DB stack entirely: identity is the free-text `playerId` from `hello`.

Prereqs: 000–003. Reference files:

- `tower-d/server/src/main.cpp` — headless `AppConfig`, thread lifecycle, net queue create.
- `tower-d/server/src/game_server/game_server.{cpp,h}` — ENet thread, host create, service loop, connection table, envelopes.
- `tower-d/server/src/sim/sim.cpp` — `drain_inbound_envelopes`, `sim_send`, `sim_update`.
- `tower-d/server/src/utils/net_types.{h,cpp}` — `ConnID`, `NetEnvelope`, `NetBuffer`, double-buffered `NetQueue`.
- `apps/server/src/index.ts` (transport being ported), `apps/server/src/engine.ts` (`tick()`).
- `shared/net_shared.h` (step 003: `MsgType`, `Channel`, `OutputStream`/`InputStream`).
- `shared/game_config.h` (step 002: `ss::cfg::HEARTBEAT_MS`, `ACTIVE_DT_MS`).

---

## 1. Threading model (locked)

Same split as tower-d: **ENet lives on its own thread; the sim lives on the amis
`update()` callback (the app's main thread).** They communicate only through two
double-buffered, mutex-guarded `NetQueue`s:

```
 ENet thread (game_server::run)          amis main thread (sim)
 ───────────────────────────────         ───────────────────────
 enet_host_service(15ms) ──┐             ┌── drain inbound  ← net_queue_swap(inbound)
   CONNECT/RECEIVE/DISCON  │  inbound     │   dispatch commands (step 007)
   push envelope ──────────┼──────────────┤   run tick() / stepWorld (step 006)
                           │  outbound    │   encode snapshot/activeRegion (step 007)
 drain outbound ←──────────┘◄─────────────┴── enqueue envelope → net_queue_add_envelope(outbound)
   enet_peer_send                         
```

The TS server had no threads — Fastify's event loop did both. Here the ENet
service loop must block up to 15 ms in `enet_host_service`, so it cannot share a
thread with the fixed-timestep sim. The queues are the only shared state; nothing
else crosses the boundary. This is `game_server.cpp` verbatim in structure, minus
auth.

Global handle struct (mirrors tower-d `GlobalState`), owned by `main.cpp`:

```cpp
// server/src/global.h
namespace srv {
  struct GlobalState {
    server::NetQueue* inbound  = nullptr;  // ENet → sim
    server::NetQueue* outbound = nullptr;  // sim → ENet
  };
  GlobalState* global_state();   // defined in main.cpp
}
```

## 2. `main.cpp` — headless amis app

Port of `index.ts` top-level: create the arena, configure amis **headless** with
a fixed tick, create the two net queues in `start`, boot the ENet thread and the
sim, drive `sim_update()` from `update`, no `render`. There is no HTTP server, no
`/health`, no `/debug/state` (a debug endpoint can come back later as a dev-only
ENet message; out of scope here).

```cpp
// server/src/main.cpp
#include "amis.h"
#include "global.h"
#include "game_server/game_server.h"
#include "sim/sim.h"
#include "utils/net_types.h"
#include "shared/net_shared.h"

namespace {
  amis::MemArena  s_arena{};
  srv::GlobalState s_global_state{};
}

srv::GlobalState* srv::global_state() { return &s_global_state; }

constexpr uint16_t GAME_SERVER_PORT = 9002;   // matches step 003 / step 001 smoke test

int main() {
  amis::mem_arena_init(&s_arena, MB(128));

  amis::AppConfig config{};
  config.app_name = AMIS_APP_NAME;      // "Space Simulator Server" (step 001)
  config.arena    = &s_arena;
  config.headless = true;               // no window, no GPU (step 001 AMIS_HEADLESS=1)
  // We do NOT rely on amis fixed_fps for the sim cadence — the sim owns its own
  // accumulator keyed on wall time (ss::cfg::HEARTBEAT_MS), exactly like the TS
  // GameServer.tick(). Set a modest callback rate so update() is polled often.
  config.fixed_fps = 60;

  config.start = []() {
    // Double-buffered queues. Sizes: inbound is many small commands; outbound is
    // fewer but large (snapshots). Byte caps generous — snapshot can be big.
    s_global_state.inbound  = server::net_queue_create(&s_arena, 1024, 256 * 1024, 1024);
    s_global_state.outbound = server::net_queue_create(&s_arena, 1024,   4 * 1024 * 1024, 8192);

    game::sim_init();                       // build GameState, seed NPCs (step 007)
    game_server::start(GAME_SERVER_PORT);   // spin the ENet thread
    LOG_INFO("ENet host listening on :%u", GAME_SERVER_PORT);
  };

  config.update  = []() {
    // Gate on the ENet thread being up, like tower-d gates on db/api/game_server.
    switch (game_server::status()) {
      case THREAD_STATUS_STARTING: return;
      case THREAD_STATUS_RUNNING:  break;
      case THREAD_STATUS_ERROR:
      case THREAD_STATUS_STOPPED:  amis::app_quit(); return;
    }
    game::sim_update();                     // drain inbound, tick, broadcast (§5, step 007)
  };

  config.render  = nullptr;                 // headless: no render callback
  config.destroy = []() { game_server::stop(); };

  amis::app_run(&config);
  return 0;
}
```

Notes vs `index.ts`:

- `SEED_NPCS` env flag → a build/config flag read in `sim_init` (default on).
- `LOG_LEVEL`/Fastify logger → amis `LOG_*` macros.
- `SIGINT`/`SIGTERM` shutdown → amis owns the signal handling; `destroy` stops the
  thread. `game_server::stop()` flips `s_running` and joins.

## 3. `net_types.{h,cpp}` — copy from tower-d, unchanged

Copy `tower-d/server/src/utils/net_types.{h,cpp}` **near-verbatim**. It is
transport-glue, not game logic:

- `ConnID = uint32_t`, `(generation << 16) | slot`, `0 = invalid`. The generation
  version makes a stale `ConnID` (slot reused after disconnect) fail
  `get_valid()`. This replaces the TS `Map<playerId, WebSocket>` — we address by
  `ConnID`, not by `playerId`, because a `ConnID` is a stable, cheap integer for
  the outbound recipient lists.
- `NetEnvelope { kind, channel, conn_id, offset, length, recipient_count, recipient_offset }`.
- `NetBuffer` = `envelopes[]` + `bytes[]` (payload arena) + `recipients[]`.
- `NetQueue` = two `NetBuffer`s + a `std::mutex`, with `net_queue_swap` (atomic
  front/back flip that resets the new back) and `net_queue_add_envelope`
  (bounds-checked append). See `net_types.cpp:35-64`.

One change: our `Channel` enum from step 003 replaces tower-d's
`net::GameServerChannel`. Retype `NetEnvelope::channel` to `ss::Channel` and the
`channel` params to `ss::Channel`. `NetEnvelopeKind` (CONNECT / DISCONNECT /
MESSAGE / SEND) stays as-is.

## 4. ENet thread — `game_server.cpp`

Port `tower-d/server/src/game_server/game_server.cpp` with the **auth/DB and
defer machinery removed**. What remains:

### 4.1 Connection table

Copy `ServerConnectionTable` and its helpers (`_create`, `_add`, `_remove`,
`_get_valid`) verbatim from `game_server.cpp:19-112`, dropping the auth fields
(`authenticated`, `user_id`, `user_session_id`). Keep `peer`, `generation`,
`used`. Slots come from a free-list; `MAX_CLIENTS = 64` (`net_types.h:15`).

```cpp
struct ServerConnection {
  ENetPeer* peer = nullptr;
  uint16_t  generation = 1;
  bool      used = false;
};
```

### 4.2 Host create + service loop

Directly from `game_server.cpp:199-256`, swapping in our channel count:

```cpp
void run(uint16_t port) {
  server_connection_table_create();

  ENetAddress addr;
  addr.host = ENET_HOST_ANY;
  addr.port = port;

  // MAX_CHANNELS = 2 (Channel::CONTROL=0, Channel::STREAM=1) — step 003.
  ENetHost* host = enet_host_create(&addr, server::MAX_CLIENTS, ss::MAX_CHANNELS, 0, 0);
  if (!host) { LOG_ERROR("Failed to create ENet host"); s_status = THREAD_STATUS_ERROR; return; }
  s_status = THREAD_STATUS_RUNNING;

  while (s_running.load(std::memory_order_acquire)) {
    drain_outbound(host);                       // §4.4

    ENetEvent e;
    while (enet_host_service(host, &e, 15) > 0) // 15 ms block, like tower-d
      handle_event(host, e);                    // §4.3
  }
}
```

### 4.3 CONNECT / RECEIVE / DISCONNECT

The big simplification vs tower-d: **no auth gate.** tower-d sends
`SERVER_AUTH_READY` on connect and only forwards messages once
`authenticated`. We forward everything immediately; the `hello`/`welcome`
handshake is an ordinary CONTROL message pair handled by the sim (§6), not a
network-layer concern.

```cpp
void handle_event(ENetHost* host, ENetEvent& e) {
  switch (e.type) {
    case ENET_EVENT_TYPE_CONNECT: {
      server::ConnID conn_id = server_connection_table_add(e.peer);
      e.peer->data = reinterpret_cast<void*>(static_cast<uintptr_t>(conn_id));
      if (conn_id == 0) {                        // table full
        enet_peer_disconnect(e.peer, /*reason*/ 1);
        break;
      }
      // Tell the sim a peer connected (it does NOT create a player yet — that
      // waits for C_HELLO, mirroring index.ts which registered the socket but
      // only connect()ed on hello). Payload: none.
      server::net_queue_add_envelope(srv::global_state()->inbound,
        server::NET_ENVELOPE_KIND_CONNECT, ss::Channel::CONTROL, conn_id,
        nullptr, 0, nullptr, 0);
      break;
    }
    case ENET_EVENT_TYPE_RECEIVE: {
      auto conn_id = static_cast<server::ConnID>(reinterpret_cast<uintptr_t>(e.peer->data));
      if (server_connection_table_get_valid(conn_id)) {
        // Hand the raw bytes to the sim as a MESSAGE envelope; the sim peeks the
        // MsgType byte and dispatches (step 007 §2). No parsing here.
        server::net_queue_add_envelope(srv::global_state()->inbound,
          server::NET_ENVELOPE_KIND_MESSAGE,
          static_cast<ss::Channel>(e.channelID), conn_id,
          e.packet->data, e.packet->dataLength, nullptr, 0);
      }
      enet_packet_destroy(e.packet);
      break;
    }
    case ENET_EVENT_TYPE_DISCONNECT: {
      auto conn_id = static_cast<server::ConnID>(reinterpret_cast<uintptr_t>(e.peer->data));
      if (conn_id != 0) {
        server::net_queue_add_envelope(srv::global_state()->inbound,
          server::NET_ENVELOPE_KIND_DISCONNECT, ss::Channel::CONTROL, conn_id,
          nullptr, 0, nullptr, 0);              // sim runs engine.disconnect()
        server_connection_table_remove(conn_id);
        e.peer->data = nullptr;
      }
      break;
    }
    default: break;
  }
}
```

The `ConnID` is stashed in `peer->data` on CONNECT and read back on
RECEIVE/DISCONNECT — exactly tower-d's trick (`game_server.cpp:260, 278, 302`).

### 4.4 Draining outbound

Copy `game_server.cpp:220-252`, dropping the CONNECT/MESSAGE cases (those only
ever appear inbound):

```cpp
void drain_outbound(ENetHost* host) {
  server::NetBuffer* out = server::net_queue_swap(srv::global_state()->outbound);
  for (int i = 0; i < out->n_envelopes; i++) {
    const server::NetEnvelope& env = out->envelopes[i];
    if (env.kind == server::NET_ENVELOPE_KIND_DISCONNECT) {
      if (auto* c = server_connection_table_get_valid(env.conn_id))
        enet_peer_disconnect(c->peer, /*reason*/ 0);
      continue;
    }
    // NET_ENVELOPE_KIND_SEND: one packet, fanned out to N recipients.
    ENetPacket* pkt = enet_packet_create(out->bytes + env.offset, env.length,
                                         ss::channel_flag(env.channel)); // RELIABLE on CONTROL
    int sent = 0;
    for (uint32_t k = 0; k < env.recipient_count; k++) {
      auto* c = server_connection_table_get_valid(out->recipients[env.recipient_offset + k]);
      if (!c || !c->peer || !c->used) continue;
      enet_peer_send(c->peer, static_cast<uint8_t>(env.channel), pkt);
      sent++;
    }
    if (sent == 0) enet_packet_destroy(pkt);  // ENet refcounts; free if unused
  }
}
```

`ss::channel_flag(Channel::CONTROL)` returns `ENET_PACKET_FLAG_RELIABLE`;
`STREAM` returns `0` (unreliable) — step 003 §3. Reliable CONTROL packets larger
than ENet's MTU are auto-fragmented (relevant for `S_SNAPSHOT`; see 000 §6 open
question).

### 4.5 Thread lifecycle

Copy `game_server::{start,status,stop}` from `game_server.cpp:335-356`. `start`
allocates a child arena for the ENet thread's scratch and launches
`std::thread(run, port)`; `stop` flips the `s_running` atomic and joins.

## 5. Tick wiring — `sim_update()`

`sim_update()` is called every amis `update()`. It (a) drains the inbound queue,
running command handlers, then (b) advances the tick loop. It is the fusion of
`index.ts`'s `wss.on("message")` + `setInterval(tick, HEARTBEAT_MS)`.

The **outer cadence** is `HEARTBEAT_MS = 50` on wall time; the **inner physics**
is an `ACTIVE_DT_MS = 100` accumulator — identical to `GameServer.tick()`
(`engine.ts:486-520`). amis polls `update()` faster than 50 ms, so we gate on
wall time ourselves:

```cpp
// server/src/sim/sim.cpp
namespace {
  ss::GameState* s_game = nullptr;
  double s_last_heartbeat_ms = 0;

  void drain_inbound() {
    server::NetBuffer* in = server::net_queue_swap(srv::global_state()->inbound);
    for (int i = 0; i < in->n_envelopes; i++) {
      const server::NetEnvelope& env = in->envelopes[i];
      const uint8_t* data = in->bytes + env.offset;
      switch (env.kind) {
        case server::NET_ENVELOPE_KIND_CONNECT:    on_peer_connect(env.conn_id); break;
        case server::NET_ENVELOPE_KIND_DISCONNECT: on_peer_disconnect(env.conn_id); break;
        case server::NET_ENVELOPE_KIND_MESSAGE:    on_message(env, data); break;   // step 007 §2
        default: break;
      }
    }
  }
}

void game::sim_init() {
  s_game = create_game_state(now_ms());
  if (SEED_NPCS) seed_npc_players(*s_game, now_ms());   // world.ts port (step 007)
  s_last_heartbeat_ms = now_ms();
}

void game::sim_update() {
  drain_inbound();                       // handshake + commands mutate s_game
  double now = now_ms();
  if (now - s_last_heartbeat_ms < ss::cfg::HEARTBEAT_MS) return;  // 20 Hz gate
  s_last_heartbeat_ms = now;
  server_tick(*s_game, now);             // engine.ts tick() port (step 007 §1)
}
```

`now_ms()` = a monotonic wall clock in `double` ms (the C++ analog of the
injected `nowFn`/`Date.now()`; use `amis::time_ms()` or
`std::chrono::steady_clock`). The accumulator, `stepWorld`/`stepStations`/
`stepOperations` calls, `pruneWorld`, `broadcastActiveRegions`, and the throttled
`broadcastSnapshots` all live inside `server_tick` — **their full bodies are step
007.** This step only guarantees the *plumbing*: envelopes flow in, `server_tick`
is called at 20 Hz, and whatever it enqueues on `outbound` reaches ENet.

### Outbound send helper

The sim never touches ENet or `ConnID` tables directly. It enqueues, mirroring
tower-d `sim_send` (`sim.cpp:148-154`):

```cpp
// Enqueue one already-encoded packet to a set of recipients.
void game::sim_send(ss::Channel ch, net::OutputStream& os,
                    const server::ConnID* recipients, uint32_t count) {
  if (count == 0) return;
  server::net_queue_add_envelope(srv::global_state()->outbound,
    server::NET_ENVELOPE_KIND_SEND, ch, /*conn_id*/ 0,
    os.buffer, net::output_stream_tell(&os), recipients, count);
}
```

## 6. Handshake: `hello` → `welcome` (no auth)

`C_HELLO` is a normal CONTROL message, dispatched in `on_message` (step 007 §2)
— but its effect is defined here because it establishes the `ConnID ↔ playerId`
binding that all later addressing depends on. It ports `index.ts:51-70` +
`engine.ts:connect()`.

State kept in the sim (not the ENet thread), the C++ analog of index.ts's
`sockets: Map<playerId, WebSocket>` and engine's `connected: Set<playerId>`:

```cpp
std::unordered_map<server::ConnID, std::string> s_conn_to_player;  // who is this peer
std::unordered_map<std::string, server::ConnID> s_player_to_conn;  // reverse, for addressing
```

```cpp
void on_hello(server::ConnID conn, const std::string& raw_player_id) {
  if (s_conn_to_player.count(conn)) return;                 // already said hello
  std::string id = trim(raw_player_id).substr(0, 24);       // index.ts:53 rules
  if (id.empty())                 return send_reject(conn, "", "empty player id");
  if (s_player_to_conn.count(id)) {                          // index.ts:54 dup guard
    send_reject(conn, "", "player id already connected");
    enqueue_disconnect(conn);                                // ws.close(4001)
    return;
  }
  s_conn_to_player[conn] = id;
  s_player_to_conn[id]   = conn;
  double now = now_ms();
  get_or_create_player(*s_game, id, now);                    // world.ts (step 007)

  send_welcome(conn, id, now);                               // S_WELCOME
  send_snapshot(conn, id, now);                              // S_SNAPSHOT (step 007 §4)
}

void on_peer_disconnect(server::ConnID conn) {
  auto it = s_conn_to_player.find(conn);
  if (it == s_conn_to_player.end()) return;
  s_player_to_conn.erase(it->second);   // engine.disconnect(): free the id for reuse
  s_conn_to_player.erase(it);
}
```

`send_welcome` encodes `S_WELCOME { playerId, serverTimeMs }` via the step-003
encoder and calls `sim_send(Channel::CONTROL, os, &conn, 1)`. `PROTOCOL_VERSION`
check (000 §6 open question): if `hello` carries a version, reject on mismatch
before binding. Non-`hello` messages from an unbound `ConnID` get
`send_reject(conn, "", "say hello first")` (index.ts:71-74) — enforced at the top
of `on_message`.

Any `ConnID`→player lookup that fails (peer vanished mid-command) is a silent
drop; the generation-versioned `ConnID` in the outbound path already discards
sends to dead slots.

## 7. Done when

- `spacesim-server` boots headless, logs `ENet host listening on :9002`, and stays
  up (the step 001 smoke test now has a real body).
- A raw ENet test peer connecting + sending `C_HELLO{playerId:"tester"}` on
  CONTROL receives `S_WELCOME` then `S_SNAPSHOT` back on CONTROL; a second peer
  with the same id gets `S_REJECT "player id already connected"` and a disconnect.
- Killing a peer fires `ENET_EVENT_TYPE_DISCONNECT`; the sim drops the binding and
  the id becomes reusable.
- The tick loop calls `server_tick` at ~20 Hz measured (log a heartbeat counter);
  no packets are sent from the sim thread directly (all go through `outbound`).
- No data races: only `net_queue_*` cross the thread boundary; ThreadSanitizer
  clean on a connect/hello/spam-commands/disconnect run.

## 8. Unresolved questions

- amis `time_ms()` monotonic? if not, use `steady_clock` for the accumulator — wall-clock jumps must not stall/burst the sim.
- outbound byte cap 4 MB enough for N players × full snapshot in one swap window? size after step 007 encoder lands; grow or split snapshot sends across ticks.
- `enqueue_disconnect` path: send `S_REJECT` then disconnect — does ENet flush the reliable reject before the disconnect envelope is processed next swap? may need `enet_peer_disconnect_later`.
- keep `peer->data = ConnID` trick, or hold `ENetPeer*` in the table only? default tower-d trick (self-documenting, O(1)).
- CONNECT envelope carries no payload (we bind on hello, not connect) — confirm sim never needs the raw peer addr before hello.
- MAX_CLIENTS 64 vs expected concurrent players — bump table + queue caps together if raised.
- do we want a dev `/debug/state` equivalent as a CONTROL message, or drop it for v1? default drop, revisit in step 012.
