# Step 003 — Shared binary protocol

Goal: replace JSON+Zod (`packages/protocol`) with a custom little-endian binary
protocol over ENet, copied from tower-d's stream design. This defines the frozen
wire contract that both server (004–007) and client (008–011) implement.

Prereqs: 000, 002. Reference: `tower-d/shared/include/shared/net_shared.h`,
`tower-d/shared/src/net_shared.cpp`, `packages/protocol/src/index.ts`.

---

## 1. Streams (copy from tower-d, near-verbatim)

`shared/include/shared/net_shared.h` + `shared/src/net_shared.cpp`. The
`OutputStream`/`InputStream` with bounds checks are transport-agnostic and copy
directly. Primitives to include: `u8,u16,u32,i32,f32,f64,bool,str`. TS uses
doubles for positions — add `f64` (tower-d only had up to `i32`; extend it):

```cpp
struct OutputStream { uint8_t* buffer; size_t cap, pos; bool overflow; amis::MemArena* arena; };
struct InputStream  { const uint8_t* buffer; size_t len, pos; bool error; };

void  os_f64(OutputStream* s, double v);   // memcpy 8 bytes, little-endian
double is_f64(InputStream* s);
void  os_vec2(OutputStream* s, ss::Vec2 v){ os_f64(s,v.x); os_f64(s,v.y); }
ss::Vec2 is_vec2(InputStream* s){ double x=is_f64(s), y=is_f64(s); return {x,y}; }
void  os_str(OutputStream* s, const std::string& v); // u16 len + bytes
std::string is_str(InputStream* s);
// helpers for optionals: write a u8 present-flag then the value
void  os_opt_str(OutputStream* s, const std::optional<std::string>& v);
```

> Positions are `f64` to preserve TS parity. If wire size matters, downgrade
> stream positions to `f32` later — the client only renders them.

## 2. Message type enum

Replace the Zod discriminated unions. Server→client < 128, client→server ≥ 128
(tower-d convention). Pin values — they are the wire contract.

```cpp
enum class MsgType : uint8_t {
  INVALID = 0,
  // ---- server → client
  S_WELCOME       = 1,   // { playerId, serverTimeMs }
  S_SNAPSHOT      = 2,   // structural PlayerVisibleSnapshot
  S_ACTIVE_REGION = 3,   // high-rate ship/projectile/event delta
  S_ACK           = 4,   // { requestId }
  S_REJECT        = 5,   // { reason, requestId? }
  // ---- client → server
  C_HELLO             = 128, // { playerId }
  C_MOVE_FLEET        = 129,
  C_ATTACK_MOVE       = 130,
  C_HOLD_FLEET        = 131,
  C_PURSUE_FLEET      = 132,
  C_FOLLOW_FLEET      = 133,
  C_SET_DOCTRINE      = 134,
  C_SET_SHIP_DOCTRINE = 135,
  C_SET_FORMATION     = 136,
  C_UPDATE_BLUEPRINT  = 137,
  C_BUILD_SHIP        = 138,
  C_CREATE_FLEET      = 139,
  C_ADD_SHIPS_TO_FLEET= 140,
  C_MINE_RESOURCE     = 141,
  C_UNLOAD_CARGO      = 142,
  C_SALVAGE_WRECK     = 143,
  C_TRANSFER_CARGO    = 144,
  C_CREATE_OPERATION  = 145,
  C_CANCEL_OPERATION  = 146,
  C_PAUSE_OPERATION   = 147,
  C_BUILD_STATION     = 148,
  C_SPAWN_HOSTILE     = 149, // dev/test
};
constexpr uint32_t PROTOCOL_VERSION = 1;
```

Every packet begins with `os_u8(MsgType)`. `peek_type(data,len)` reads byte 0
without consuming (mirror tower-d `server_message_peek_type`).

## 3. Channels

```cpp
enum class Channel : uint8_t { CONTROL = 0, STREAM = 1 };
constexpr int MAX_CHANNELS = 2;
inline uint32_t channel_flag(Channel c){
  return c == Channel::CONTROL ? /*ENET_PACKET_FLAG_RELIABLE*/ (1u<<0) : 0u;
}
```

- CONTROL (reliable, ordered): `C_HELLO`, all commands, `S_WELCOME`, `S_SNAPSHOT`,
  `S_ACK`, `S_REJECT`.
- STREAM (unreliable): `S_ACTIVE_REGION` only.

## 4. Client → server: command encoders/decoders

Every command carries a `requestId` (string) for acks, matching today's
`net.command()`. Pattern (one representative; replicate for all):

```cpp
// encode (client)
OutputStream enc_move_fleet(amis::MemArena* a, const std::string& reqId,
                            const std::string& fleetId, ss::Vec2 target){
  OutputStream s = os_create(a);
  os_u8(&s, (uint8_t)MsgType::C_MOVE_FLEET);
  os_str(&s, reqId);
  os_str(&s, fleetId);
  os_vec2(&s, target);
  return s;
}
// decode (server) — after peek_type dispatched here
struct MoveFleetCmd { std::string requestId, fleetId; ss::Vec2 target; };
MoveFleetCmd dec_move_fleet(InputStream* s){
  MoveFleetCmd c; c.requestId = is_str(s); c.fleetId = is_str(s); c.target = is_vec2(s);
  return c;
}
```

Command field lists (from `packages/protocol`):

| Msg | Fields after requestId |
| --- | --- |
| `C_HELLO` | `playerId:str` (no requestId) |
| `C_MOVE_FLEET` / `C_ATTACK_MOVE` | `fleetId:str, target:vec2` |
| `C_HOLD_FLEET` | `fleetId:str` |
| `C_PURSUE_FLEET` | `fleetId:str, targetFleetId:str` |
| `C_FOLLOW_FLEET` | `fleetId:str, targetFleetId:str, distance:f64, escort:bool` |
| `C_SET_DOCTRINE` | `fleetId:str, preset:u8` |
| `C_SET_SHIP_DOCTRINE` | `shipId:str, formationRole:str, preferredRange:str, targetPriority:str` |
| `C_SET_FORMATION` | `fleetId:str, formation:u8` |
| `C_UPDATE_BLUEPRINT` | `shipId:str, blueprint:Blueprint` |
| `C_BUILD_SHIP` | `planetId:str, blueprint:Blueprint, name:str` |
| `C_CREATE_FLEET` | `shipIds:str[]` |
| `C_ADD_SHIPS_TO_FLEET` | `fleetId:str, shipIds:str[]` |
| `C_MINE_RESOURCE` | `fleetId:str, locationId:str, depositIndex:opt<u16>` |
| `C_UNLOAD_CARGO` | `fleetId:str, planetId:str` |
| `C_SALVAGE_WRECK` | `fleetId:str, debrisId:str` |
| `C_TRANSFER_CARGO` | `fromShipId:str, toShipId:str` |
| `C_CREATE_OPERATION` | `fleetId:str, locationId:str, deliveryPlanetId:str` |
| `C_CANCEL_OPERATION` | `operationId:str` |
| `C_PAUSE_OPERATION` | `operationId:str, paused:bool` |
| `C_BUILD_STATION` | `locationId:str, planetId:str` |
| `C_SPAWN_HOSTILE` | `near:vec2` |

Array helper: `os_u16(count)` then each element.

## 5. Server → client: snapshot (`S_SNAPSHOT`)

Structural, throttled ~500 ms. Encodes `PlayerVisibleSnapshot` (from
`snapshot.ts` / step 007). One nested encoder per collection. Layout:

```
u8   S_SNAPSHOT
f64  serverTimeMs
-- you --
str  id
str  homePlanetId
f64  metal   f64 fuel
str[] fleetIds   str[] shipIds
-- collections (each: u16 count, then N encoded records) --
Planet[]           (enc_planet)
ResourceLocation[] (enc_resource_location)
Debris[]
Station[]
Operation[]
Fleet[]            (enc_fleet — own = full, enemy = coarse; see §7)
Ship[]             (enc_ship — own ships only; includes blueprint+rooms)
```

`enc_ship` is the heavy one (blueprint + rooms + derived). Encode blueprint once
here; the `activeRegion` stream references ships by id (see §6, §8 decision).

Representative nested encoder:

```cpp
void enc_planet(OutputStream* s, const ss::PlanetState& p, bool owned){
  os_str(s, p.id);
  os_opt_str(s, p.ownerId);
  os_vec2(s, p.position);
  os_f64(s, p.radius);
  os_bool(s, owned);        // only owned planets carry queue/rates below
  if (owned) { /* enc constructionQueue[], resourceRates */ }
}
```

## 6. Server → client: active region (`S_ACTIVE_REGION`)

High-rate, unreliable, every physics step with activity. Mirrors
`ActiveRegionDelta` (`buildSensedShips`). Layout:

```
u8   S_ACTIVE_REGION
f64  serverTimeMs
ActiveShip[]  : u16 count, then per ship:
   str shipId, str fleetId, str ownerId
   vec2 position, f64 heading
   f64 shield, f64 maxShield, f64 hullHp, f64 hullMaxHp
   bool alive
   opt<str> targetShipId, opt<str> miningLocationId, opt<str> unloadLocationId
   (NO blueprint/rooms — see decision §8)
Projectile[]  : u16 count, then per projectile:
   str id, vec2 position, opt<vec2> velocity, str targetShipId, opt<str> kind
CombatEvent[] : u16 count, then per event (discriminated by u8 tag):
   0 fire         : str from, str to, str projectileId
   1 hit          : str ship, opt<str> roomId, f64 damage, bool shield
   2 roomDisabled : str ship, str roomId
   3 shipDestroyed: str ship, vec2 position
```

## 7. Fleet encoding (visibility-aware)

`enc_fleet` takes an `owned` flag. Owned → full (`order`, `doctrine`, `anchor
position`, `shipIds`, `formation`, `intent`). Enemy (sensed) → coarse (`id`,
`ownerId`, `position`, `shipCount:u16`, `status:u8`, `intent:u8` coarse only).
Never encode enemy ship internals — enforced by the visibility filter (step 007),
but the encoder shape makes leakage structurally impossible.

## 8. Decision: blueprint delivery

`activeRegion` used to carry `blueprint?`+`rooms?` per ship for LOD detail. That's
huge at 10 Hz. **Decision: send blueprint+rooms only in `S_SNAPSHOT` (own ships)
and cache client-side by `shipId`.** The stream carries only kinematics + hp +
target ids. The client's detailed LOD (step 010) looks up the cached blueprint.
Enemy ships never had internals anyway, so enemy LOD detail is unaffected (it was
already silhouette-only when unsensed internals). Record this in the frozen spec.

## 9. Dispatch skeleton

```cpp
// server: on packet
InputStream in = is_create(pkt->data, pkt->dataLength);
switch ((MsgType)is_u8(&in)) {
  case MsgType::C_HELLO:       on_hello(conn, is_str(&in)); break;
  case MsgType::C_MOVE_FLEET:  handle_move(conn, dec_move_fleet(&in)); break;
  /* ... */
  default: /* reject */;
}
// always check in.error after decoding before mutating state
```

## 10. Done when

- `net_shared.{h,cpp}` compiles into `shared`.
- A host round-trip unit test (no network): encode each `ClientMessage` into an
  `OutputStream`, wrap its bytes in an `InputStream`, decode, assert field
  equality. Same for `S_SNAPSHOT`/`S_ACTIVE_REGION` with a small `GameState`.
- `in.error` never set on valid input; set on truncated input.

## 11. Unresolved questions

- Positions `f64` vs `f32` on the wire — default `f64` for parity; revisit if
  snapshot exceeds ENet's practical MTU.
- Snapshot size vs ENet 8 KB packet norm: rely on ENet reliable fragmentation for
  large snapshots, or delta-encode structural state? Default fragmentation for v1.
- Do we need `PROTOCOL_VERSION` handshake check in `hello`/`welcome`? Default yes,
  reject on mismatch.
- Keep `requestId` as string, or switch to `u32` counter? Default keep string
  (matches current client; trivial).
- Enum wire values frozen here — any reordering later is a breaking change.
