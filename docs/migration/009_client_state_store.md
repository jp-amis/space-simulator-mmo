# Step 009 — Client state store

Goal: port `apps/client/src/store.ts` (the `Store` class) to C++
(`client/src/state/store.{h,cpp}`). The store is the client-side mirror of
authoritative server state: it decodes `S_SNAPSHOT` / `S_ACTIVE_REGION` /
`S_WELCOME` / `S_ACK` / `S_REJECT` (step 003), keeps the interpolated
`activeShips` and `projectiles` maps, spawns client-only explosion FX, and
accumulates a combat log. It owns **nothing authoritative** and never simulates
(000 §3): it renders decoded server state.

Prereqs: 000, 002, 003, 008. Reference (read the real files):

- `apps/client/src/store.ts` — `Store`: `snapshot`, `activeShips`
  `Map<string, ClientActiveShip>`, `projectiles`, `explosions`, `combatLog`,
  `applyServer` switch, `updateActiveShips` (ease 0.3), `updateProjectiles`
  (dead-reckon + 0.2 correction), `EXPLOSION_MS = 550`.
- `docs/migration/003_shared_binary_protocol.md` — `MsgType`, `S_SNAPSHOT` §5,
  `S_ACTIVE_REGION` §6 (ActiveShip / Projectile / CombatEvent tags), blueprint
  decision §8, `InputStream`/`is_*` decoders.
- `docs/migration/002_shared_core_types_and_config.md` — `ss::Vec2`, DTO structs.
- `tower-d/client/src/server/server.h` — `InMessage`/inbox that feeds `apply_server`.

The transport (step 008) drains ENet into an inbox and hands each packet's
`(MsgType, InputStream&)` to `apply_server`. This step decodes and applies.

---

## 1. Decoded DTOs the store holds

Step 003 §5/§6 define the wire; the store keeps decoded C++ forms. The heavy
`S_SNAPSHOT` decodes into a `PlayerVisibleSnapshot` (structural, throttled ~500
ms); the high-rate `S_ACTIVE_REGION` decodes into per-ship `ActiveShipDto`
records. Blueprint+rooms arrive **only** in the snapshot (per-ship, own ships)
and are cached by `shipId` (step 003 §8); the stream never carries them.

```cpp
// client/src/state/dtos.h  (client-side decoded shapes; mirror packages/protocol)
#pragma once
#include "shared/math.h"
#include "shared/sim_types.h"      // ShipBlueprint, RoomState, enums (step 002)
#include <optional>
#include <string>
#include <vector>

namespace state {

// One streamed ship (S_ACTIVE_REGION §6) — kinematics + hp + target ids only.
struct ActiveShipDto {
  std::string id, fleetId, ownerId;
  ss::Vec2 position{};
  double heading = 0;
  double shield = 0, maxShield = 0, hullHp = 0, hullMaxHp = 0;
  bool alive = true;
  std::optional<std::string> targetShipId, miningLocationId, unloadLocationId;
};

struct ProjectileDto {
  std::string id, targetShipId;
  ss::Vec2 position{};
  std::optional<ss::Vec2> velocity;
  std::optional<std::string> kind;   // "laser" | "cannon"
};

// Combat events (S_ACTIVE_REGION §6, tag-discriminated). Only what the store uses.
enum class CombatEventKind : uint8_t { fire = 0, hit = 1, roomDisabled = 2, shipDestroyed = 3 };
struct CombatEvent {
  CombatEventKind kind{};
  std::string ship, from, to, projectileId;
  std::optional<std::string> roomId;
  ss::Vec2 position{};      // shipDestroyed
  double damage = 0; bool shield = false;   // hit
};

// Structural snapshot (S_SNAPSHOT §5). Field parity with PlayerVisibleSnapshot.
struct PlayerVisibleSnapshot {
  double serverTimeMs = 0;
  ss::PlayerState you;
  std::vector<ss::PlanetState>       planets;
  std::vector<ss::ResourceLocation>  resourceLocations;
  std::vector<ss::DebrisState>       debris;
  std::vector<ss::StationState>      stations;
  std::vector<ss::OperationState>    operations;
  std::vector<ss::FleetState>        fleets;   // own = full, enemy = coarse (003 §7)
  std::vector<ss::ShipState>         ships;     // own ships only; carry blueprint+rooms
};

} // namespace state
```

## 2. Store struct — `client/src/state/store.h`

Direct port of the `Store` class fields. `ClientActiveShip` holds the decoded
`ActiveShipDto` plus the interpolated `shown` `ss::Vec2` and `atMs` (last-update
time), exactly like the TS interface. `explosions` are client-only FX with a
550 ms lifetime. Maps keep the `std::string` ids (step 002 §2).

```cpp
#pragma once
#include "state/dtos.h"
#include "shared/net_shared.h"    // MsgType, InputStream (step 003)
#include "amis.h"                  // Spritesheet, Font handles owned here
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace state {

// A ship the player can currently sense (own + enemy), always streamed.
struct ClientActiveShip {
  ActiveShipDto dto;
  ss::Vec2 shown{};      // interpolated display position (eased toward dto.position)
  double atMs = 0;       // last time dto was refreshed (client clock)
};

// A projectile, smoothed between server frames (dead-reckon + gentle correction).
struct ClientProjectile {
  ProjectileDto dto;
  ss::Vec2 shown{};
  double atMs = 0;
};

// Transient client-only FX spawned when a ship dies.
struct Explosion {
  double x = 0, y = 0;
  double startMs = 0;
  bool mine = false;     // owned by the local player? (tint the FX)
};

struct Notification { std::string text; double atMs = 0; bool error = false; };

struct Store {
  // ---- authoritative mirror ----
  std::optional<PlayerVisibleSnapshot> snapshot;
  uint32_t snapshotVersion = 0;
  std::string playerId;

  // Blueprint+rooms cache by shipId, populated from S_SNAPSHOT own ships (003 §8).
  std::unordered_map<std::string, ss::ShipBlueprint> blueprintByShip;

  // ---- high-rate presentation ----
  std::unordered_map<std::string, ClientActiveShip> activeShips;
  std::unordered_map<std::string, ClientProjectile> projectiles;
  std::vector<Explosion> explosions;
  std::vector<std::string> combatLog;
  std::vector<Notification> notifications;

  // ---- selection (input, step 011) ----
  std::optional<std::string> selectedId;
  enum class SelKind { none, planet, fleet, ship, resource, wreck };
  SelKind selectedKind = SelKind::none;

  // ---- assets (loaded in main.start, step 008) ----
  amis::Spritesheet* spritesheet_main = nullptr;
  amis::Font*        font_ui = nullptr;

  static constexpr double EXPLOSION_MS = 550;   // Store.EXPLOSION_MS

  // Estimated serverTime - clientNow, set from welcome/snapshot serverTimeMs.
  double serverClockOffset = 0;
  double serverNow() const { return amis::time_ms() + serverClockOffset; }

  // Dispatch a decoded server packet (called from main.update, step 008).
  void apply_server(MsgType type, InputStream& in);

  // Per-frame interpolation (called each frame from main.update).
  void update_active_ships();          // ease shown toward dto.position by 0.3
  void update_projectiles(double dtMs); // dead-reckon by velocity + 0.2 correction

  void notify(const std::string& text, bool error = false);

  // Convenience (ported getters).
  bool in_combat() const;                                   // Store.inCombat
  std::vector<const ClientActiveShip*> ships_of_fleet(const std::string& fleetId) const;
  ss::Vec2 fleet_centroid(const std::string& fleetId, ss::Vec2 fallback) const;
};

Store* store();   // global accessor, defined in main.cpp (step 008)

} // namespace state
```

> `amis::time_ms()` is the client clock replacing `performance.now()`. Confirm the
> exact accessor against `../amis-engine/include/amis.h`; use it consistently for
> `atMs`, `startMs`, and `serverClockOffset` so all comparisons share one clock.

## 3. `apply_server` — dispatch — `client/src/state/store.cpp`

Port of the `applyServer(msg)` switch. The `InputStream&` has already had its
byte-0 `MsgType` consumed by `main.update` (step 008); `apply_server` decodes the
body per step 003. Always check `in.error` before mutating (003 §9/§10).

```cpp
#include "state/store.h"
#include "shared/net_shared.h"    // is_* decoders (step 003)
#include "amis.h"

namespace state {

void Store::apply_server(MsgType type, InputStream& in) {
  const double now = amis::time_ms();
  switch (type) {

    // ---- welcome: playerId + server clock (net.ts "welcome") -------------
    case MsgType::S_WELCOME: {
      std::string pid    = is_str(&in);
      double serverTime  = is_f64(&in);
      if (in.error) return;
      playerId = pid;
      serverClockOffset = serverTime - now;   // serverTimeMs - performance.now()
      LOG_INFO("Welcome as %s", playerId.c_str());
      break;
    }

    // ---- structural snapshot (net.ts "snapshot") -------------------------
    case MsgType::S_SNAPSHOT: {
      PlayerVisibleSnapshot snap = dec_snapshot(&in);   // decoder from step 003 §5
      if (in.error) return;
      serverClockOffset = snap.serverTimeMs - now;
      // Cache blueprint+rooms by shipId (own ships only carry them; 003 §8).
      blueprintByShip.clear();
      for (const ss::ShipState& s : snap.ships) blueprintByShip[s.id] = s.blueprint;
      snapshot = std::move(snap);
      snapshotVersion++;
      break;
    }

    // ---- high-rate active region (net.ts "activeRegion") -----------------
    case MsgType::S_ACTIVE_REGION: {
      apply_active_region(in, now);
      break;
    }

    // ---- ack / reject ----------------------------------------------------
    case MsgType::S_REJECT: {
      std::string reason = is_str(&in);
      // requestId is optional in reject (003 §2); read if present per its codec.
      if (in.error) return;
      notify("Rejected: " + reason, /*error=*/true);
      break;
    }
    case MsgType::S_ACK: {
      // requestId acked; nothing to do (net.ts "ack" was a no-op). Decode to
      // advance the stream / could resolve pending-command UI later.
      (void)is_str(&in);
      break;
    }

    default: break;
  }
}
```

## 4. `apply_active_region` — reconcile ships, projectiles, FX

This is the body of the `case "activeRegion"` block in store.ts, translated. It
(1) client-side death-detects tracked ships that vanish while mortally wounded or
targeted, spawning explosions; (2) upserts streamed ships (update `dto` + `atMs`,
or insert with `shown = position`); (3) reconciles projectiles and prunes unseen
ones; (4) applies combat events (spawn explosions for `shipDestroyed`, append to
the combat log); (5) trims the log to 30 lines.

```cpp
void Store::apply_active_region(InputStream& in, double now) {
  double serverTime = is_f64(&in);   // S_ACTIVE_REGION §6 header
  (void)serverTime;

  // -- decode ships --
  std::vector<ActiveShipDto> ships;
  uint16_t shipCount = is_u16(&in);
  ships.reserve(shipCount);
  for (uint16_t i = 0; i < shipCount; i++) ships.push_back(dec_active_ship(&in)); // 003 §6
  // -- decode projectiles --
  std::vector<ProjectileDto> projs;
  uint16_t projCount = is_u16(&in);
  projs.reserve(projCount);
  for (uint16_t i = 0; i < projCount; i++) projs.push_back(dec_projectile(&in));
  // -- decode combat events --
  std::vector<CombatEvent> events;
  uint16_t evCount = is_u16(&in);
  events.reserve(evCount);
  for (uint16_t i = 0; i < evCount; i++) events.push_back(dec_combat_event(&in));

  if (in.error) return;   // never mutate on a truncated packet

  // (1) Client-side death detection (store.ts plan-040 logic).
  //     Build the "seen" set and the set of ids currently being targeted.
  std::unordered_set<std::string> seen;
  seen.reserve(ships.size());
  for (const auto& s : ships) seen.insert(s.id);
  std::unordered_set<std::string> targeted;
  for (const auto& [id, t] : activeShips)
    if (t.dto.targetShipId) targeted.insert(*t.dto.targetShipId);

  for (auto it = activeShips.begin(); it != activeShips.end(); ) {
    const std::string& id = it->first;
    ClientActiveShip& s   = it->second;
    if (seen.count(id)) { ++it; continue; }
    double frac = s.dto.hullMaxHp > 0 ? s.dto.hullHp / s.dto.hullMaxHp : 1.0;
    if (s.dto.alive && (frac < 0.2 || targeted.count(id))) {
      explosions.push_back({ s.shown.x, s.shown.y, now, s.dto.ownerId == playerId });
      combatLog.push_back("Ship " + id.substr(id.size() >= 4 ? id.size() - 4 : 0) + " destroyed");
      it = activeShips.erase(it);
    } else {
      ++it;   // healthy vanish => assumed left sensor range; keep until stale-prune
    }
  }

  // (2) Upsert streamed ships.
  for (auto& s : ships) {
    auto it = activeShips.find(s.id);
    if (it != activeShips.end()) {
      it->second.dto  = std::move(s);
      it->second.atMs = now;
    } else {
      ClientActiveShip cas;
      cas.shown = s.position;   // spawn shown at server position (no snap-in ease)
      cas.atMs  = now;
      cas.dto   = std::move(s);
      activeShips.emplace(cas.dto.id, std::move(cas));
    }
  }

  // (3) Reconcile projectiles; keep `shown` for continuity, prune unseen.
  std::unordered_set<std::string> pseen;
  pseen.reserve(projs.size());
  for (auto& p : projs) {
    pseen.insert(p.id);
    auto it = projectiles.find(p.id);
    if (it != projectiles.end()) {
      it->second.dto  = std::move(p);
      it->second.atMs = now;
    } else {
      ClientProjectile cp;
      cp.shown = p.position;
      cp.atMs  = now;
      cp.dto   = std::move(p);
      projectiles.emplace(cp.dto.id, std::move(cp));
    }
  }
  for (auto it = projectiles.begin(); it != projectiles.end(); ) {
    if (!pseen.count(it->first)) it = projectiles.erase(it);
    else ++it;
  }

  // (4) Combat events.
  for (const CombatEvent& e : events) {
    if (e.kind == CombatEventKind::shipDestroyed) {
      combatLog.push_back("Ship " + e.ship.substr(e.ship.size() >= 4 ? e.ship.size()-4 : 0) + " destroyed");
      // Prefer the server death position so FX always fires; fall back to shown.
      auto it = activeShips.find(e.ship);
      ss::Vec2 pos = e.position;               // server always sends it (003 §6 tag 3)
      bool mine = false;
      if (it != activeShips.end()) { mine = it->second.dto.ownerId == playerId; }
      explosions.push_back({ pos.x, pos.y, now, mine });
      if (it != activeShips.end()) activeShips.erase(it);
    } else if (e.kind == CombatEventKind::roomDisabled) {
      combatLog.push_back("Room disabled on " + e.ship.substr(e.ship.size() >= 4 ? e.ship.size()-4 : 0));
    }
    // fire/hit events drive step-010 render FX; not logged here.
  }

  // (5) Trim log to last 30 lines (store.ts).
  if (combatLog.size() > 30)
    combatLog.erase(combatLog.begin(), combatLog.end() - 30);
}
```

> Declare `apply_active_region(InputStream&, double now)` as a private method on
> `Store` in the header. `dec_active_ship`/`dec_projectile`/`dec_combat_event`/
> `dec_snapshot` are the step-003 decoders (client half of the §5/§6 codecs).
> Include `<unordered_set>` and `<algorithm>`.

## 5. Interpolation — `update_active_ships` / `update_projectiles`

Bit-for-bit port of the TS easing. `update_active_ships` prunes ships not
refreshed for 2000 ms, then eases `shown` toward `dto.position` by 0.3 each
frame. `update_projectiles` prunes after 1200 ms, dead-reckons by velocity over
`dt` seconds, then corrects toward the authoritative position by 0.2, and finally
expires explosions past `EXPLOSION_MS`.

```cpp
void Store::update_active_ships() {
  const double now = amis::time_ms();
  for (auto it = activeShips.begin(); it != activeShips.end(); ) {
    ClientActiveShip& s = it->second;
    if (now - s.atMs > 2000) { it = activeShips.erase(it); continue; }
    s.shown.x += (s.dto.position.x - s.shown.x) * 0.3;   // ease 0.3 (store.ts)
    s.shown.y += (s.dto.position.y - s.shown.y) * 0.3;
    ++it;
  }
}

void Store::update_projectiles(double dtMs) {
  const double now = amis::time_ms();
  const double dt  = dtMs / 1000.0;
  for (auto it = projectiles.begin(); it != projectiles.end(); ) {
    ClientProjectile& p = it->second;
    if (now - p.atMs > 1200) { it = projectiles.erase(it); continue; }
    if (p.dto.velocity) {
      p.shown.x += p.dto.velocity->x * dt;               // dead-reckon
      p.shown.y += p.dto.velocity->y * dt;
    }
    p.shown.x += (p.dto.position.x - p.shown.x) * 0.2;   // gentle correction 0.2
    p.shown.y += (p.dto.position.y - p.shown.y) * 0.2;
    ++it;
  }
  // Expire finished explosions (Store.EXPLOSION_MS = 550).
  if (!explosions.empty()) {
    explosions.erase(
      std::remove_if(explosions.begin(), explosions.end(),
        [now](const Explosion& e){ return now - e.startMs >= EXPLOSION_MS; }),
      explosions.end());
  }
}
```

## 6. Ported getters

```cpp
void Store::notify(const std::string& text, bool error) {
  notifications.push_back({ text, amis::time_ms(), error });
  if (notifications.size() > 6) notifications.erase(notifications.begin());
}

bool Store::in_combat() const {
  for (const auto& [id, s] : activeShips)
    if (s.dto.ownerId == playerId && s.dto.targetShipId) return true;
  return false;
}

std::vector<const ClientActiveShip*> Store::ships_of_fleet(const std::string& fleetId) const {
  std::vector<const ClientActiveShip*> out;
  for (const auto& [id, s] : activeShips)
    if (s.dto.fleetId == fleetId && s.dto.alive) out.push_back(&s);
  return out;
}

// Fleet on-screen location = centroid of sensed ships; fallback to snapshot pos.
ss::Vec2 Store::fleet_centroid(const std::string& fleetId, ss::Vec2 fallback) const {
  auto ships = ships_of_fleet(fleetId);
  if (ships.empty()) return fallback;
  ss::Vec2 c{};
  for (const auto* s : ships) { c.x += s->shown.x; c.y += s->shown.y; }
  return { c.x / ships.size(), c.y / ships.size() };
}
```

`fleetPosition`/`fleetAnchor`/`myShips`/`ship` from store.ts are thin readers over
`snapshot` + `fleet_centroid`; add them alongside as the render/UI steps
(010/011) need them.

## 7. Interaction with the transport (step 008)

- `main.update` calls `net::client_update()`, then loops
  `net::client_poll_message` → `is_create` → `is_u8` (MsgType) →
  `store()->apply_server(type, in)`.
- Then `main.update` calls `store()->update_active_ships()` and
  `store()->update_projectiles(amis::frame_delta_ms())` — the per-frame
  interpolation, replacing the Pixi ticker's `store.updateActiveShips()` /
  `store.updateProjectiles(ticker.deltaMS)`.
- The store never touches ENet and never sends: commands go out via `net::cmd_*`
  from scenes (step 011). The store is read-only from the network's perspective.

## 8. Done when

- `store.{h,cpp}` compiles into `client` and links against `shared` (decoders).
- With the step-004 server up and step-008 transport wired: after handshake,
  `apply_server` populates `snapshot` (S_SNAPSHOT), and `activeShips` grows as
  `S_ACTIVE_REGION` arrives; `blueprintByShip` is non-empty for own ships.
- `update_active_ships` visibly interpolates ship positions between the 10 Hz
  stream frames (ships glide, not teleport); stale ships prune after 2 s.
- Destroying a ship (server `shipDestroyed` event, or a wounded ship vanishing)
  spawns an `Explosion` that clears after 550 ms and appends one combat-log line.
- A truncated packet sets `in.error` and leaves store state unmodified (no
  partial apply).

## 9. Unresolved questions

- Client clock: is `amis::time_ms()` monotonic and shared with `frame_delta_ms`?
  All easing/pruning assumes one clock (store.ts used `performance.now()`
  throughout). Confirm the accessor.
- Death-detection heuristic (`frac < 0.2 || targeted`) is a client guess that can
  false-positive when a healthy ship leaves sensor range mid-combat. Keep as-is
  for parity, or lean harder on server `shipDestroyed` now that the wire carries
  it reliably? Default keep (matches TS).
- `S_REJECT` requestId is optional (003 §2) — needs an `is_opt_str` in its
  decoder; confirm the codec so the stream stays aligned.
- Pending-command tracking: net.ts returned `requestId` but the store ignored
  `ack`. Do we want a `pendingByReq` map for optimistic UI, or keep acks no-op?
  Default no-op (defer to step 011 UI).
- Explosion cap: store.ts never bounded `explosions`; a huge battle could grow it
  for 550 ms. Add a hard cap? Default no (short lifetime self-limits).
- Container churn: `activeShips`/`projectiles` use heap `unordered_map` (000 §3
  default). Revisit arena/pooled storage if per-frame allocation shows up in a
  profile.
