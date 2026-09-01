# Step 002 — Shared core types & config

Goal: port the domain vocabulary that both wire and simulation depend on: math
(`Vec2`), id strings, balance constants (`packages/config`), and the plain-data
struct forms of `packages/simulation/types.ts`. No behavior yet — just types.

Prereqs: 000, 001. Reference: `packages/simulation/src/types.ts`,
`packages/config/src/index.ts`.

---

## 1. `shared/include/shared/math.h`

The sim uses `{ x: number, y: number }` everywhere. One struct + free functions
mirroring the TS helpers (`add`, `sub`, `scale`, `hypot`, `normalize`, `clampLength`).

```cpp
#pragma once
#include <cmath>
namespace ss {
struct Vec2 { double x = 0, y = 0; };
inline Vec2 operator+(Vec2 a, Vec2 b){ return {a.x+b.x, a.y+b.y}; }
inline Vec2 operator-(Vec2 a, Vec2 b){ return {a.x-b.x, a.y-b.y}; }
inline Vec2 operator*(Vec2 a, double s){ return {a.x*s, a.y*s}; }
inline double dot(Vec2 a, Vec2 b){ return a.x*b.x + a.y*b.y; }
inline double len(Vec2 a){ return std::sqrt(a.x*a.x + a.y*a.y); }
inline double dist(Vec2 a, Vec2 b){ return len(a - b); }
inline Vec2 norm(Vec2 a){ double l = len(a); return l > 1e-9 ? a * (1.0/l) : Vec2{}; }
inline Vec2 clamp_len(Vec2 a, double mx){ double l = len(a); return l > mx ? a * (mx/l) : a; }
}
```

> Note: amis has its own `Vec2f` (float) used by the renderer. Keep the sim in
> `ss::Vec2` (double) for parity with the TS doubles; convert to `amis::Vec2f`
> only at draw time (step 010). Do not leak `amis::Vec2f` into `shared`.

## 2. Ids

TS uses string ids (`"ship_12"`, `"fleet_3"`, `playerId` free text). Two options:

- **v1 (recommended): keep string ids.** Use `std::string`. Mechanical port,
  zero remapping risk, matches the free-text `playerId`. Wire cost handled by
  length-prefixed strings (step 003). Maps are `std::unordered_map<std::string, T>`.
- v2 (later optimization): intern to `uint32_t` handles. Out of scope now.

Define a tiny id maker to replace `makeId("proj")`:

```cpp
// server/src/sim/ids.h  (server-only; ids are generated authoritatively)
std::string make_id(const char* prefix, uint64_t& counter); // -> "proj_42"
```

## 3. `shared/include/shared/game_config.h`

Port `packages/config`. Straight `constexpr`. Include every constant the sim/wire
references. Representative subset (fill in the rest from the source):

```cpp
#pragma once
namespace ss::cfg {
constexpr int    HEARTBEAT_MS   = 50;   // 20 Hz outer loop
constexpr int    ACTIVE_DT_MS   = 100;  // 10 Hz fixed physics step
constexpr int    SNAPSHOT_MS    = 500;  // structural snapshot throttle

struct FleetCfg { double sensorRange = 650; double engagementRange = 240; };
constexpr FleetCfg FLEET{};

struct CombatCfg {
  double formationWeight = 1.0, rangeWeight = 1.3, avoidanceWeight = 1.6;
  double avoidanceRadius = /*from config*/;
  double shieldRegenPerSec = /*from config*/;
  double hitRadius = /*from config*/;
};
constexpr CombatCfg COMBAT{};

// Module specs: laser/cannon/shield/engine/... — port MODULES table.
struct ModuleSpec { const char* id; double damage; double cooldownMs; double range; /*...*/ };
constexpr ModuleSpec MODULES[] = { /* laser, cannon, shield, engine, sensor, cargo, mining */ };
}
```

> The MODULES table drives derived ship stats (thrust, shieldCapacity, weapon
> rooms). Port it exactly — balance parity is verified in step 012.

## 4. `shared/include/shared/sim_types.h`

The plain-data structs from `types.ts`. These are shared because the wire codec
(step 003) and the simulation (steps 005–006) both use them. Keep field names and
enums identical to TS for grep-ability.

```cpp
#pragma once
#include <string>
#include <vector>
#include <unordered_map>
#include <optional>
#include "shared/math.h"

namespace ss {

enum class FleetStatus  { idle, moving, engaging, destroyed };
enum class FleetIntent  { continue_order, observe, intercept, engage, pursue, disengage, flee };
enum class OrderKind    { moveTo, attackMove, hold, pursue, follow, escort, mine, unloadAt };
enum class Formation    { column, line, wedge, echelon, box, screen, protect, loose };
enum class DoctrinePreset { hold_fire, return_fire, attack_on_sight, pursue, flee_if_attacked };

struct FleetOrder {
  OrderKind kind = OrderKind::hold;
  Vec2 target{};
  std::optional<std::string> targetFleetId;
  std::optional<std::string> locationId;
  std::optional<std::string> planetId;
  double distance = 0; bool escort = false;
  std::optional<int> depositIndex;
};

struct FleetDoctrine {
  DoctrinePreset preset = DoctrinePreset::return_fire;
  double aggression = 0.5, pursuit = 0.5, cohesion = 0.5, survival = 0.5;
};

struct ShipDoctrine {
  std::string formationRole;   // e.g. "line","screen"
  std::string preferredRange;  // "short"|"medium"|"long"
  std::string targetPriority;  // "nearest"|"weakest"|...
};

// Blueprint + rooms (ship builder). Port ShipBlueprint / RoomState.
struct RoomState { std::string id; std::string moduleId; int x, y, w, h; bool disabled = false; /*...*/ };
struct ShipBlueprint { int width, height; std::vector<RoomState> rooms; /* module placement */ };

struct DerivedStats {
  double thrust, turnRate, sensorRange, shieldCapacity;
  double powerProduction, powerDemand, cargo, maxSpeed, accel;
  double miningPower; std::vector<std::string> miningResources;
  std::vector<std::string> weaponRoomIds; bool underpowered;
};

struct ShipState {
  std::string id, ownerId, name;
  ShipBlueprint blueprint;
  std::vector<RoomState> rooms;
  struct { double hp, maxHp, width, height; } hull;
  DerivedStats derived;
  ShipDoctrine doctrine;
  std::unordered_map<std::string,double> cargo; // "metal"/"fuel" -> qty
};

struct FleetState {
  std::string id, ownerId;
  std::vector<std::string> shipIds;
  FleetStatus status = FleetStatus::idle;
  Vec2 position{};              // anchor (rally point), NOT centroid
  FleetOrder order;
  FleetIntent intent = FleetIntent::continue_order;
  FleetDoctrine doctrine;
  Formation formation = Formation::loose;
  std::optional<double> underAttackUntil;
};

struct PlayerState {
  std::string id, homePlanetId;
  double metal = 0, fuel = 0;
  std::vector<std::string> fleetIds, shipIds;
};

// Runtime kinematics (server-only mutation, but struct is shared for encoding).
struct ShipRuntime {
  std::string shipId, fleetId, ownerId;
  Vec2 position{}, velocity{};
  double heading = 0;
  double shield = 0, maxShield = 0;
  bool alive = true;
  std::optional<std::string> targetShipId, miningLocationId, unloadLocationId;
  std::unordered_map<std::string,double> weaponCooldowns; // roomId -> ms
};

struct WorldProjectile {
  std::string id, ownerShipId, ownerFleetId, targetShipId;
  Vec2 position{}, velocity{};
  double damage = 0; double ttlMs = 0; std::string kind; // "laser"|"cannon"
};

// Planets, resource locations, stations, operations, debris — port their DTO
// shapes here too (used by both visibility filter and wire). Keep field parity.
struct PlanetState { std::string id; std::optional<std::string> ownerId; Vec2 position; double radius; /* queue, rates */ };
struct ResourceLocation { std::string id; Vec2 position; /* deposits[] */ };
struct StationState { std::string id, ownerId, locationId; /* storage, rates */ };
struct OperationState { std::string id, fleetId, locationId, deliveryPlanetId; bool paused; /* phase */ };
struct DebrisState { std::string id; Vec2 position; /* salvage bag */ };
}
```

## 5. `GameState` container

The top-level authoritative state (server-owned, but the struct lives in shared so
the visibility filter and encoders can take it by const-ref):

```cpp
struct GameState {
  std::unordered_map<std::string, PlayerState>     players;
  std::unordered_map<std::string, FleetState>      fleets;
  std::unordered_map<std::string, ShipState>       ships;
  std::unordered_map<std::string, ShipRuntime>     shipRuntime;
  std::unordered_map<std::string, PlanetState>     planets;
  std::unordered_map<std::string, ResourceLocation> resourceLocations;
  std::unordered_map<std::string, StationState>    stations;
  std::unordered_map<std::string, OperationState>  operations;
  std::unordered_map<std::string, DebrisState>     debris;
  std::vector<WorldProjectile>                     projectiles;
  std::vector<CombatEvent>                         combatEvents; // cleared each broadcast
  uint32_t rngState = 0x5eedc0de;
  uint64_t idCounter = 0;
};
```

## 6. Done when

- Everything compiles as headers in `shared` + links into `server`.
- A throwaway `static_assert`/round-trip test constructs a `GameState`, adds a
  ship+fleet+player, and reads fields back. No behavior asserted yet.

## 7. Unresolved questions

- String ids vs interned `uint32` handles for v1? Default strings (mechanical port).
- `double` vs fixed-point for sim — locked to `double` (see 000 §3). Confirm OK.
- Should `GameState` live in `shared` or `server`? It references only shared types;
  put the struct in `shared/include/shared/game_state.h`, mutate only server-side.
- Enum wire values: pin explicit integer values now (step 003 depends on them).
