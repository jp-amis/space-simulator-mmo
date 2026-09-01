# Step 008 — Client skeleton & ENet peer

Goal: stand up the native amis client app (`client/src/main.cpp`) and the ENet
client-peer wrapper (`client/src/net/`), so the window opens, connects to the
headless server (step 004) on `127.0.0.1:9002`, performs the `C_HELLO`/`S_WELCOME`
handshake, and buffers server packets into an inbox the state store (step 009)
drains each frame. This is the client twin of step 004 and the direct port of
`apps/client/src/net.ts` (`NetClient`) + the PixiJS bootstrap in
`apps/client/src/main.ts`.

Prereqs: 000, 001, 002, 003. Reference (read the real files):

- `tower-d/client/src/main.cpp` — `amis::MemArena`, `AppConfig`
  (`app_name`/`bundle_id`/`arena`/`design_*`/`fixed_fps`/`start`/`update`/`render`/`destroy`),
  `vfs_mount`, `spritesheet_load`, `font_load`, `scene_manager_init`, `scene_push`,
  `amis::app_run`.
- `tower-d/client/src/server/server.cpp` + `server.h` — the ENet client peer this
  step is modeled on: `enet_host_create(nullptr, 1, MAX_CHANNELS, 0, 0)`,
  `enet_host_connect`, non-blocking `enet_host_service(host, &e, 0)` polled each
  frame, `CONNECT`/`RECEIVE`/`DISCONNECT`, circular inbox, `server_send`,
  `server_poll_message`, `server_message_peek_type`, `GSConnStatus`.
- `tower-d/shared/src/net_shared.cpp` — `output_stream_*`, `enet_packet_create` +
  channel flag usage.
- `apps/client/src/net.ts` — `NetClient`: `connect(playerId)`, `hello` on open,
  `decodeServer`, listeners, `command()`+`requestId`, `ConnStatus`.
- `apps/client/src/main.ts` — bootstrap/ticker loop wiring net → store → scene/ui.

We keep the client thin (000 §3): it renders decoded server state, never
simulates. This step delivers only the app shell + transport; decoding lives in
step 009 (store) and rendering in step 010.

---

## 1. File layout

```
client/src/
├── main.cpp                 # amis AppConfig, start/update/render/destroy
├── net/
│   ├── client.h             # net::Client API (this step)
│   └── client.cpp           # ENet peer wrapper (port of tower-d server.cpp)
├── scenes/
│   ├── scene_login.{h,cpp}  # id-entry scene (port of ui.ts id form) — stub here
│   └── scene_game.{h,cpp}   # map/game scene — stub here, filled in 010/011
└── state/
    └── store.{h,cpp}        # step 009
```

`net/` is the client mirror of `tower-d/client/src/server/`. We rename
`server` → `net::Client` because in this repo the ENet **client** peer talks to a
game **server**; tower-d's `game::server_*` naming would be confusing here. The
structure (host, single peer, circular inbox, per-frame non-blocking service) is
copied 1:1.

## 2. ENet client peer — `client/src/net/client.h`

Port of `tower-d/client/src/server/server.h`. Uses step-003 `MsgType`/`Channel`
from `shared/net_shared.h` instead of tower-d's `NetMessageType`/`GameServerChannel`.

```cpp
#pragma once
#include "shared/net_shared.h"   // MsgType, Channel, InputStream/OutputStream (step 003)
#include <cstdint>

namespace net {

// Mirrors tower-d GSConnStatus (server.h). Same values as net.ts ConnStatus
// ("disconnected"/"connecting"/"connected") plus FAILED for host/connect errors.
enum class ConnStatus : uint8_t {
  DISCONNECTED,
  CONNECTING,
  CONNECTED,
  FAILED,
};

// One drained inbound packet. `data` points into the inbox's own buffer and is
// valid only until the next client_poll_message() call — decode it immediately.
struct InMessage {
  Channel channel = Channel::CONTROL;
  const uint8_t* data = nullptr;
  size_t len = 0;
};

// Lifecycle (call order mirrors tower-d server_init → server_connect).
bool client_init();                    // enet_initialize + host_create(nullptr,1,...)
bool client_connect(const std::string& player_id); // stores playerId, host_connect
void client_update();                  // poll enet_host_service(,,0) each frame
void client_disconnect();
void client_shutdown();                // enet_deinitialize (from destroy)

// Drain one buffered server packet FIFO. Returns false when the inbox is empty.
bool client_poll_message(InMessage& out);

// Send an already-built OutputStream on a channel (reliability from channel_flag).
void client_send(Channel channel, const OutputStream& out);

ConnStatus client_status();
bool client_just_disconnected();       // one-frame edge, like server_just_disconnected
const std::string& client_player_id();

// Peek MsgType of byte 0 without consuming (mirror server_message_peek_type).
MsgType peek_type(const uint8_t* data, size_t len);

} // namespace net
```

## 3. ENet client peer — `client/src/net/client.cpp`

Direct adaptation of `tower-d/client/src/server/server.cpp`. Differences: our
`MAX_CHANNELS = 2` (step 003) vs tower-d's 3; on `CONNECT` we immediately send
`C_HELLO` with the stored `playerId` (net.ts sends `hello` in the WS `open`
handler); inbox stores `Channel` (step 003) instead of `GameServerChannel`.

```cpp
#include "net/client.h"
#include "amis.h"
#include "shared/net_shared.h"
#include <enet/enet.h>
#include <cstring>
#include <string>

namespace {

ENetHost* s_host = nullptr;
ENetPeer* s_peer = nullptr;

net::ConnStatus s_status = net::ConnStatus::DISCONNECTED;
bool            s_just_disconnected = false;
std::string     s_player_id;

// --- Circular inbox (copied from tower-d server.cpp Inbox) ---------------
struct InboxSlot {
  net::Channel channel = net::Channel::CONTROL;
  uint32_t     len = 0;
  uint8_t*     data = nullptr;   // arena-owned, PACKET_DATA_LIMIT bytes
};
struct Inbox {
  InboxSlot* slots = nullptr;
  int cap = 0, head = 0, tail = 0, count = 0;
};
Inbox s_inbox;

constexpr size_t PACKET_DATA_LIMIT = KB(8);   // tower-d net_shared.h value
constexpr int    INBOX_CAP        = 128;

void inbox_create() {
  if (s_inbox.slots) return;
  auto* arena = amis::app_config()->arena;
  s_inbox.cap = INBOX_CAP;
  s_inbox.head = s_inbox.tail = s_inbox.count = 0;
  s_inbox.slots = MEM_ARENA_ALLOC_ARRAY(arena, InboxSlot, s_inbox.cap);
  for (int i = 0; i < s_inbox.cap; i++) {
    s_inbox.slots[i].data    = MEM_ARENA_ALLOC_ARRAY(arena, uint8_t, PACKET_DATA_LIMIT);
    s_inbox.slots[i].len     = 0;
    s_inbox.slots[i].channel = net::Channel::CONTROL;
  }
}
void inbox_reset() { s_inbox.head = s_inbox.tail = s_inbox.count = 0; }

void inbox_push(net::Channel ch, const uint8_t* data, size_t len) {
  if (len > PACKET_DATA_LIMIT)  { LOG_WARN("packet over data limit, dropped"); return; }
  if (s_inbox.count == s_inbox.cap) { LOG_WARN("inbox full, packet dropped"); return; }
  InboxSlot& slot = s_inbox.slots[s_inbox.head];
  slot.channel = ch;
  slot.len     = static_cast<uint32_t>(len);
  std::memcpy(slot.data, data, len);
  s_inbox.head = (s_inbox.head + 1) % s_inbox.cap;
  s_inbox.count += 1;
}

// Build and send the hello handshake on CONNECT (port of net.ts open→hello).
void send_hello() {
  OutputStream s = os_create(amis::app_config()->arena);
  os_u8(&s, (uint8_t)MsgType::C_HELLO);
  os_str(&s, s_player_id);          // C_HELLO carries playerId, no requestId (step 003 §4)
  net::client_send(Channel::CONTROL, s);
  os_destroy(&s);
}

} // namespace

bool net::client_init() {
  inbox_create();
  if (enet_initialize() != 0) {
    LOG_ERROR("Failed to initialize ENet");
    s_status = ConnStatus::FAILED;
    return false;
  }
  // nullptr address => client host, exactly one outgoing connection, 2 channels.
  s_host = enet_host_create(nullptr, 1, MAX_CHANNELS, 0, 0);
  if (!s_host) {
    LOG_ERROR("Failed to create client host");
    s_status = ConnStatus::FAILED;
    return false;
  }
  return true;
}

bool net::client_connect(const std::string& player_id) {
  if (!s_host) return false;
  s_player_id = player_id;           // net.ts stores playerId before connecting
  inbox_reset();

  ENetAddress addr;
  enet_address_set_host(&addr, "127.0.0.1");   // step 003 / tower-d GAME_SERVER_HOST
  addr.port = 9002;                            // GAME_SERVER_PORT

  s_status = ConnStatus::CONNECTING;
  s_peer = enet_host_connect(s_host, &addr, MAX_CHANNELS, 0);
  if (!s_peer) {
    LOG_ERROR("Failed to start connection to game server");
    s_status = ConnStatus::FAILED;
    return false;
  }
  return true;
}

void net::client_update() {
  s_just_disconnected = false;
  if (!s_host) return;

  ENetEvent e;
  // Non-blocking poll (timeout 0) — drain everything queued this frame.
  while (enet_host_service(s_host, &e, 0) > 0) {
    switch (e.type) {
      case ENET_EVENT_TYPE_CONNECT: {
        s_status = ConnStatus::CONNECTED;
        LOG_INFO("Connected to game server; sending hello");
        send_hello();               // handshake step 1 (client → server)
        break;
      }
      case ENET_EVENT_TYPE_RECEIVE: {
        const MsgType t = peek_type(e.packet->data, e.packet->dataLength);
        if (t == MsgType::INVALID) { enet_packet_destroy(e.packet); break; }
        inbox_push(static_cast<Channel>(e.channelID),
                   e.packet->data, e.packet->dataLength);
        enet_packet_destroy(e.packet);
        break;
      }
      case ENET_EVENT_TYPE_DISCONNECT: {
        s_status = ConnStatus::DISCONNECTED;
        s_peer = nullptr;
        s_just_disconnected = true;
        LOG_INFO("Disconnected from game server");
        break;
      }
      default: break;
    }
  }
}

void net::client_disconnect() {
  if (!s_peer) return;
  enet_peer_disconnect(s_peer, 0);
  ENetEvent e;
  while (s_host && enet_host_service(s_host, &e, 100) > 0) {
    if (e.type == ENET_EVENT_TYPE_RECEIVE)      enet_packet_destroy(e.packet);
    else if (e.type == ENET_EVENT_TYPE_DISCONNECT) { s_peer = nullptr; break; }
  }
  if (s_peer) { enet_peer_reset(s_peer); s_peer = nullptr; }
  s_status = ConnStatus::DISCONNECTED;
  inbox_reset();
}

void net::client_shutdown() { enet_deinitialize(); }

bool net::client_poll_message(InMessage& out) {
  if (s_inbox.count == 0) return false;
  InboxSlot& slot = s_inbox.slots[s_inbox.tail];
  out.channel = slot.channel;
  out.data    = slot.data;
  out.len     = slot.len;
  s_inbox.tail = (s_inbox.tail + 1) % s_inbox.cap;
  s_inbox.count -= 1;
  return true;
}

void net::client_send(Channel channel, const OutputStream& out) {
  if (!s_peer) return;
  ENetPacket* pkt = enet_packet_create(out.buffer, os_tell(&out), channel_flag(channel));
  if (enet_peer_send(s_peer, (enet_uint8)channel, pkt) < 0) {
    LOG_ERROR("Failed to send message");
    enet_packet_destroy(pkt);
  }
}

net::ConnStatus  net::client_status()            { return s_status; }
bool             net::client_just_disconnected() { return s_just_disconnected; }
const std::string& net::client_player_id()       { return s_player_id; }

net::MsgType net::peek_type(const uint8_t* data, size_t len) {
  if (len == 0) return MsgType::INVALID;
  return static_cast<MsgType>(data[0]);
}
```

> `os_create`/`os_destroy`/`os_tell`/`channel_flag` are the step-003 stream
> helpers (short aliases of tower-d's `output_stream_create`/`_destroy`/`_tell`
> and `game_server_channel_flag`). Match whichever names step 003 froze.

## 4. Command send helpers (port of `net.command()` + `requestId`)

`net.ts` wraps every command with an auto-incrementing `requestId` (`req_1`,
`req_2`, …) so acks/rejects can be matched. Keep that exactly: a monotonic
counter owned by the client, one `enc_*` per `MsgType` (encoders defined in step
003 §4). Example wiring for a fleet move (input handling is step 011):

```cpp
namespace net {
static uint64_t s_req_counter = 0;

// Returns the requestId, like net.ts command().
std::string next_request_id() {
  return "req_" + std::to_string(++s_req_counter);
}

std::string cmd_move_fleet(const std::string& fleet_id, ss::Vec2 target) {
  std::string req = next_request_id();
  OutputStream s = enc_move_fleet(amis::app_config()->arena, req, fleet_id, target); // step 003
  client_send(Channel::CONTROL, s);   // all commands are reliable (step 003 §3)
  os_destroy(&s);
  return req;
}
} // namespace net
```

Only `S_ACTIVE_REGION` uses `Channel::STREAM`; every command and the handshake go
on `Channel::CONTROL` (step 003 §3).

## 5. App bootstrap — `client/src/main.cpp`

Port of `tower-d/client/src/main.cpp` structure and of the PixiJS bootstrap in
`apps/client/src/main.ts` (which created the app, wired net→store→scene/ui, and
ran a ticker calling `store.updateActiveShips()` / `store.updateProjectiles()` /
`scene.render()` each frame). Here we set up arena, `AppConfig`, load assets,
init the scene manager, push the login scene, and pump ENet + the store each
frame.

```cpp
#include "amis.h"
#include "net/client.h"
#include "state/store.h"          // step 009
#include "scenes/scene_login.h"

#include <enet/enet.h>

#ifndef AMIS_APP_NAME
#define AMIS_APP_NAME "Space Simulator"
#endif
#ifndef AMIS_BUNDLE_ID
#define AMIS_BUNDLE_ID "com.jp.spacesim"
#endif

namespace {
// Global client presentation state (the ported Store). Arena-allocated in start.
state::Store* s_store = nullptr;
}
state::Store* state::store() { return s_store; }   // global accessor, like game::global_state()

int main() {
  amis::MemArena arena{};
  amis::mem_arena_init(&arena, MB(64));   // ships/projectiles/FX maps live here + in store

  amis::AppConfig config{};
  config.app_name     = AMIS_APP_NAME;
  config.bundle_id    = AMIS_BUNDLE_ID;
  config.arena        = &arena;
  config.design_width  = 1280;            // strategic map (000 §4 uses 1280x720)
  config.design_height = 720;
  config.fixed_fps    = 60;               // render/interp cadence; server ticks itself

  config.start = []() {
    // 1) Transport up first, so the login scene can connect immediately.
    if (!net::client_init()) { amis::app_quit(); return; }

    // 2) Client presentation state.
    s_store = MEM_ARENA_NEW(amis::app_config()->arena, state::Store);

    // 3) Assets (mirror tower-d start: vfs_mount amispkg, spritesheet, fonts).
    amis::vfs_mount("/spacesim.amispkg", "/game");
    s_store->spritesheet_main = amis::spritesheet_load(
        "/game/assets/spritesheets/main.png",
        "/game/assets/spritesheets/main.json");
    s_store->font_ui = amis::font_load(
        amis::app_config()->arena,
        "/game/assets/fonts/ui_16_atlas.png",
        "/game/assets/fonts/ui_16_metrics.json");

    // 4) Scenes.
    amis::scene_manager_init();
    amis::scene_set_transition_filter(amis::TEXTURE_FILTER_NEAREST);
    amis::scene_push(scene_login_def);    // id-entry form → calls net::client_connect
  };

  config.update = []() {
    // Pump the network first: drain ENet events into the inbox...
    net::client_update();
    // ...then hand every buffered packet to the store (decode + apply, step 009).
    net::InMessage msg;
    while (net::client_poll_message(msg)) {
      InputStream in = is_create(msg.data, msg.len);
      MsgType type = (MsgType)is_u8(&in);
      state::store()->apply_server(type, in);   // step 009 dispatch
    }
    // Client-side interpolation each frame (ported from the Pixi ticker).
    state::store()->update_active_ships();
    state::store()->update_projectiles(amis::frame_delta_ms());

    amis::scene_manager_update();   // scenes read the store, emit commands via net::cmd_*
  };

  config.render = []() {
    amis::frame_buffer_clear_color(amis::back_buffer(), amis::color_hex(0x05070C)); // net.ts bg
    amis::scene_manager_render();
  };

  config.destroy = []() {
    net::client_disconnect();
    net::client_shutdown();          // enet_deinitialize, mirrors tower-d destroy
  };

  amis::app_run(&config);
  return 0;
}
```

Notes:

- **Decode-then-dispatch stays in `main.update`**, not in `client_update`. The
  transport layer only buffers bytes (peeks `MsgType` to drop invalids); the
  store owns decoding (step 009 `apply_server`). This matches net.ts, where the
  WS layer only `decodeServer`s and fans out to `store.applyServer`.
- `amis::frame_delta_ms()` supplies the `dtMs` that `updateProjectiles` used from
  the Pixi `ticker.deltaMS`. Confirm the exact amis accessor name against
  `../amis-engine/include/amis.h` before compiling.
- The **login scene** (`scene_login`) ports the id-entry form from `ui.ts`
  (`onConnect`): it reads a text field and calls `net::client_connect(playerId)`,
  then pushes/transitions to the game scene. Full UI is step 011; a minimal
  connect-on-enter stub is enough for this step's DoD.

## 6. Handshake & status flow

```
login scene: user enters playerId → net::client_connect(playerId)
  status: DISCONNECTED → CONNECTING
ENet CONNECT event (client_update)
  status: CONNECTING → CONNECTED, send C_HELLO{playerId}
server validates hello → replies S_WELCOME{playerId, serverTimeMs} on CONTROL,
  then S_SNAPSHOT (structural) on CONTROL
client_update RECEIVE → inbox_push → main.update drains → store.apply_server:
  S_WELCOME: store playerId + serverTime offset (step 009)
  S_SNAPSHOT: cache structural world; scene_login transitions to scene_game
```

Scenes read `net::client_status()` to show a "connecting…" indicator, exactly as
`ui.setConnected()` reacted to `net.onStatus("connected")` in the old client.
`client_just_disconnected()` gives a one-frame edge to show a "lost connection"
toast (net.ts surfaced this via the WS `close`/`error` handlers → `disconnected`).

## 7. Done when

- `make client` builds the `spacesim` target against the real engine + ENet.
- Running it with the step-004 server up: the window opens filled with
  `color_hex(0x05070C)`, the login scene connects to `127.0.0.1:9002`, the peer
  reaches `CONnStatus::CONNECTED`, sends `C_HELLO`, and the inbox receives at
  least `S_WELCOME` (verify via a log in the `S_WELCOME` branch of step 009).
- `client_poll_message` returns packets FIFO; `peek_type` drops a byte-0-`INVALID`
  packet without pushing it.
- Killing the server flips status to `DISCONNECTED` and sets
  `client_just_disconnected()` for exactly one frame.

## 8. Unresolved questions

- `net::Client` as free functions + file-static singleton (tower-d style) vs a
  struct owned by `main`? Default free functions to match tower-d 1:1.
- Auto-reconnect on `DISCONNECT` (net.ts did not; user re-entered id). Default no.
- Where does the decode-dispatch loop live — `main.update` (chosen) vs inside a
  `store.pump(net)` helper? Default `main.update` for symmetry with net.ts.
- `PROTOCOL_VERSION` check: send it in `C_HELLO` and let the server reject on
  mismatch (000/003 default "yes"), or defer? Default send it; wire field TBD in
  step 003 if not already frozen.
- Inbox `PACKET_DATA_LIMIT = 8 KB` vs large `S_SNAPSHOT`: ENet reliable
  fragmentation reassembles before `RECEIVE`, but our inbox slot must hold the
  reassembled size — confirm max snapshot fits 8 KB or bump the slot size
  (ties into 003 §11 fragmentation question).
- Exact amis accessors: `amis::frame_delta_ms()`, `amis::app_quit()`,
  `amis::back_buffer()` — verify names against `../amis-engine/include/amis.h`.
