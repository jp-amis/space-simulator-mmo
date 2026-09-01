# Step 005 — Server sim port: world & ships (static/setup layers)

Goal: port the deterministic, I/O-free setup layers of `packages/simulation` to
C++20 under `server/src/sim`: the seeded RNG, procedural worldgen, blueprint →
ship instantiation + derived stats, cargo-bag helpers, mining-station extraction,
and the automated mining/hauling operation state machine. This is a **mechanical
1:1 port** — keep function names and field names identical to the TS for grep
parity. Behavior (per-tick physics, combat, fleet brain) is step 006.

Prereqs: 000, 001, 002. Reference files (read before porting):

- `packages/simulation/src/rng.ts` (mulberry32 — the real RNG; see §1 note)
- `packages/simulation/src/ids.ts` (`deterministicId`, `makeId`)
- `packages/simulation/src/worldgen.ts` (`generatePlanets`, `generateResourceLocations`, `makeHomePlanet`)
- `packages/simulation/src/ship.ts` (`computeDerived`, `roomsFromBlueprint`, `instantiateShip`, `validateBlueprint`, `starterBlueprint`)
- `packages/simulation/src/resources.ts` (`bagTotal`, `cloneBag`, `addToBag`, `transfer`)
- `packages/simulation/src/operations.ts` (`stepStations`, `stepOperations`, `startOperation`)
- `packages/config/src/index.ts` (`MODULES`, `COMBAT`, `WORLD`, `RESOURCE`, `STATION`, `WORLD_SEED`)

All types are `ss::` from step 002 (`ss::GameState`, `ss::ShipState`,
`ss::PlanetState`, `ss::ResourceLocation`, `ss::StationState`,
`ss::OperationState`, `ss::Vec2`). Maps are `std::unordered_map<std::string, T>`.
The RNG state is threaded through `game.rngState` (a `uint32_t`).

> Determinism note: float determinism only has to hold **within one server
> process** — the client never re-simulates (000 §3). So we do not need
> cross-platform bit-identical `double` math; we only need same-seed →
> same-worldgen on a single build. Integer RNG math **is** bit-exact.

---

## 1. `rng.cpp` / `rng.h` — bit-exact mulberry32

> ⚠️ The real source (`rng.ts`) is **mulberry32**, not the LCG
> (`state*1664525 + 1013904223`) named in 000 §3. Port the actual mulberry32
> below; it is the code the tests and worldgen run on. (000's LCG line is stale —
> flagged in Unresolved.) The key subtlety is `Math.imul`, a **32-bit** signed
> multiply; in C++ that is just `uint32_t * uint32_t` (wrap-around), then the
> `>>> 0` becomes storing back into `uint32_t`. `next()` divides by `2^32`.

```cpp
// server/src/sim/rng.h
#pragma once
#include <cstdint>
#include <vector>
#include <stdexcept>

namespace ss {

// Deterministic mulberry32. State is a plain uint32_t so it serializes into
// GameState.rngState (step 002). All ops are 32-bit; only next() touches double.
struct Rng {
  uint32_t state = 0;

  double next() {
    state = state + 0x6d2b79f5u;                 // (state + 0x6d2b79f5) >>> 0
    uint32_t t = state;
    t = (t ^ (t >> 15)) * (t | 1u);              // Math.imul(t^(t>>>15), t|1)
    t ^= t + (t ^ (t >> 7)) * (t | 61u);         // t ^= t + Math.imul(t^(t>>>7), t|61)
    return (double)(t ^ (t >> 14)) / 4294967296.0; // ((t^(t>>>14))>>>0) / 2^32
  }
  int int_(int maxExclusive) {                    // TS `int(maxExclusive)`
    return (int)(next() * (double)maxExclusive);  // Math.floor via truncation (value >= 0)
  }
  double range(double lo, double hi) { return lo + next() * (hi - lo); }
  template <class T> const T& pick(const std::vector<T>& a) {
    if (a.empty()) throw std::runtime_error("pick from empty array");
    return a[(size_t)int_((int)a.size())];
  }
};

inline Rng mulberry32(uint32_t seed) { return Rng{ seed }; }        // seed >>> 0 is implicit
inline Rng rngFromState(uint32_t state) { return Rng{ state }; }    // re-hydrate for a step

} // namespace ss
```

Notes:

- `t = (t ^ (t >> 15)) * (t | 1u)` — the unsigned `uint32_t` multiply wraps
  exactly like `Math.imul`. Do **not** promote to 64-bit.
- `next()` returns `[0,1)`; `int_` truncates toward zero, matching
  `Math.floor(next()*n)` because the product is non-negative.
- Every world step does `Rng rng = rngFromState(game.rngState); … ;
  game.rngState = rng.state;` (see step 006).

## 2. `ids.cpp` / `ids.h` — deterministic + runtime ids

`deterministicId` uses base-36, zero-padded to width 4. `makeId` in TS mixes in
`performance.now()`; server-side we replace that with the authoritative
`game.idCounter` (step 002) to stay deterministic and collision-free.

```cpp
// server/src/sim/ids.h
#pragma once
#include <string>
#include <cstdint>
namespace ss {

std::string to_base36(uint64_t v);                 // "0","1",..,"z","10",...

// deterministicId("planet", 3) -> "planet_0003"  (base36, left-pad '0' to width 4)
inline std::string deterministicId(const char* prefix, uint64_t index) {
  std::string b = to_base36(index);
  while (b.size() < 4) b.insert(b.begin(), '0');
  return std::string(prefix) + "_" + b;
}

// Authoritative runtime id: prefix_<base36(counter)>. Replaces makeId()'s
// performance.now() suffix — the server owns the counter (deterministic).
inline std::string makeId(const char* prefix, uint64_t& counter) {
  return std::string(prefix) + "_" + to_base36(++counter);
}

} // namespace ss
```

```cpp
// server/src/sim/ids.cpp
#include "sim/ids.h"
namespace ss {
std::string to_base36(uint64_t v) {
  static const char* D = "0123456789abcdefghijklmnopqrstuvwxyz";
  if (v == 0) return "0";
  std::string s;
  while (v > 0) { s.insert(s.begin(), D[v % 36]); v /= 36; }
  return s;
}
}
```

> Grep parity caveat: `makeId` ids differ from TS (no `performance.now()` tail),
> but ids are opaque within one run and never compared across TS↔C++, so this is
> safe. `deterministicId` is byte-identical to TS.

## 3. `worldgen.cpp` — seeded planets & resource locations

Straight port of `generatePlanets` / `generateResourceLocations` /
`makeHomePlanet`. The syllable tables are `std::vector<std::string>` (order
matters — `rng.pick` indexes them). Same seed → same galaxy (the parity test).

```cpp
// server/src/sim/worldgen.h
#pragma once
#include <vector>
#include "shared/sim_types.h"
namespace ss {
std::vector<PlanetState>      generatePlanets(uint32_t seed, double nowMs);
std::vector<ResourceLocation> generateResourceLocations(uint32_t seed, const std::vector<PlanetState>& planets);
void makeHomePlanet(PlanetState& planet, const std::string& ownerId, double nowMs);
}
```

```cpp
// server/src/sim/worldgen.cpp
#include "sim/worldgen.h"
#include "sim/rng.h"
#include "sim/ids.h"
#include "shared/game_config.h"

namespace ss {

static const std::vector<std::string> SYL_A =
  {"Ka","Zo","Vel","Tir","Nyx","Or","Ael","Bru","Cel","Dra"};
static const std::vector<std::string> SYL_B =
  {"ran","dus","mir","lox","phi","tex","vor","nul","ket","sar"};
static const std::vector<std::string> SYL_C =
  {"","-I","-II"," Prime"," Minor"," IX","-B"};

static std::string planetName(Rng& rng) {
  // NB: three pick() calls, left-to-right — RNG advance order must match TS exactly.
  const std::string& a = rng.pick(SYL_A);
  const std::string& b = rng.pick(SYL_B);
  const std::string& c = rng.pick(SYL_C);
  return a + b + c;
}

std::vector<PlanetState> generatePlanets(uint32_t seed, double nowMs) {
  Rng rng = mulberry32(seed);
  int count = (int)std::floor(rng.range(cfg::WORLD.planetCountMin,
                                        cfg::WORLD.planetCountMax + 1));
  std::vector<PlanetState> planets;
  int attempts = 0, maxAttempts = count * 200;
  while ((int)planets.size() < count && attempts < maxAttempts) {
    attempts++;
    double x = rng.range(-cfg::WORLD.width / 2.0, cfg::WORLD.width / 2.0);
    double y = rng.range(-cfg::WORLD.height / 2.0, cfg::WORLD.height / 2.0);
    double sep = cfg::WORLD.minPlanetSeparation;
    bool tooClose = false;
    for (auto& p : planets)
      if ((p.position.x - x)*(p.position.x - x) + (p.position.y - y)*(p.position.y - y) < sep*sep)
        { tooClose = true; break; }
    if (tooClose) continue;

    size_t idx = planets.size();
    PlanetState p{};
    p.id = deterministicId("planet", idx);
    p.name = planetName(rng);
    p.position = { x, y };
    p.radius = rng.range(50, 120);
    p.resourceRates.metalPerSec = rng.range(0.8, 3.5);
    p.resourceRates.fuelPerSec  = rng.range(0.4, 1.8);
    p.resourceUpdatedAtMs = nowMs;
    p.storedResources = { 0.0, 0.0 };
    // facilities / constructionQueue default-empty
    planets.push_back(std::move(p));
  }
  return planets;
}

static const std::vector<std::string> FIELD_KIND =
  {"Asteroid Field","Gas Cloud","Ice Belt","Ore Ring","Debris Field"};

std::vector<ResourceLocation> generateResourceLocations(uint32_t seed,
                                                        const std::vector<PlanetState>& planets) {
  Rng rng = mulberry32(seed ^ 0x9e3779b9u);
  int count = (int)std::floor(rng.range(8, 14));
  std::vector<ResourceLocation> locations;
  int attempts = 0;
  while ((int)locations.size() < count && attempts < count * 200) {
    attempts++;
    double x = rng.range(-cfg::WORLD.width / 2.0, cfg::WORLD.width / 2.0);
    double y = rng.range(-cfg::WORLD.height / 2.0, cfg::WORLD.height / 2.0);
    double sep = 700;
    auto near = [&](Vec2 pos){
      return (pos.x - x)*(pos.x - x) + (pos.y - y)*(pos.y - y) < sep*sep; };
    bool bad = false;
    for (auto& p : planets)   if (near(p.position)) { bad = true; break; }
    if (!bad) for (auto& l : locations) if (near(l.position)) { bad = true; break; }
    if (bad) continue;

    size_t idx = locations.size();
    ResourceType primary = rng.range(0, 1) < 0.6 ? ResourceType::metal : ResourceType::fuel;
    ResourceLocation loc{};
    loc.deposits.push_back({ primary,
        rng.range(0.6, 1.5),
        std::floor(rng.range(20000, 120000)),
        rng.range(0.4, 1.0) });
    if (rng.range(0, 1) < 0.4) {
      loc.deposits.push_back({ primary == ResourceType::metal ? ResourceType::fuel : ResourceType::metal,
          rng.range(0.6, 1.2),
          std::floor(rng.range(10000, 60000)),
          rng.range(0.4, 1.0) });
    }
    loc.id = deterministicId("field", idx);
    loc.name = rng.pick(FIELD_KIND) + " " + std::to_string(idx + 1);
    loc.position = { x, y };
    loc.radius = rng.range(60, 140);
    locations.push_back(std::move(loc));
  }
  return locations;
}

void makeHomePlanet(PlanetState& planet, const std::string& ownerId, double nowMs) {
  planet.ownerId = ownerId;
  planet.radius = cfg::HOME_PLANET.radius;
  planet.resourceRates = { cfg::HOME_PLANET.metalPerSec, cfg::HOME_PLANET.fuelPerSec };
  planet.resourceUpdatedAtMs = nowMs;
  planet.storedResources = { 0.0, 0.0 };
}

} // namespace ss
```

> Order of `rng.*` calls is load-bearing: each advances shared state. Keep the
> exact sequence (`range x`, `range y`, then `range radius`, `range metal`,
> `range fuel`, then `planetName`'s three `pick`s in TS order). In `planetName`,
> bind `a`,`b`,`c` to locals **before** concatenating so C++'s unspecified
> argument-evaluation order can't reorder the `pick()` side effects.

## 4. `ship.cpp` — blueprint → derived stats → ShipState

The `MODULES`-driven derivation is the heart of this file. `computeDerived`
walks the (possibly damaged) rooms; reactors add generation scaled by hp
fraction; active non-reactor rooms add thrust/turnRate/sensor/shield/cargo/mining
and, if `kind==weapon`, push their room id. `maxSpeed`/`accel` clamp off thrust.

```cpp
// server/src/sim/ship.h
#pragma once
#include <vector>
#include <string>
#include "shared/sim_types.h"
namespace ss {

std::vector<RoomState> occupiedCells(const std::string& moduleType, int x, int y, int rotation);
std::vector<ValidationError> validateBlueprint(const ShipBlueprint& bp);
inline bool isValidBlueprint(const ShipBlueprint& bp){ return validateBlueprint(bp).empty(); }

DerivedStats computeDerived(const std::vector<RoomState>& rooms);
std::vector<RoomState> roomsFromBlueprint(const ShipBlueprint& bp, uint64_t idIndexBase = 0);
double shipCombatWeight(const ShipState& ship);              // 1 + maxHp/100 + weapons*0.5
ShipState instantiateShip(const std::string& ownerId, const std::string& name,
                          const ShipBlueprint& bp, std::string id /*=makeId caller-supplied*/);
ShipBlueprint starterBlueprint();

extern const ShipDoctrine DEFAULT_SHIP_DOCTRINE;             // {"middle","medium","nearest"}
} // namespace ss
```

`computeDerived` — direct port (uses `cfg::MODULES` lookup + `cfg::COMBAT`):

```cpp
// server/src/sim/ship.cpp  (excerpt)
DerivedStats computeDerived(const std::vector<RoomState>& rooms) {
  double thrust = 0, turnRate = 0, sensorRange = 0, shieldCapacity = 0;
  double powerProduction = 0, powerDemand = 0, cargo = 0, miningPower = 0;
  std::vector<ResourceType> miningSet;                 // insertion-ordered, deduped
  std::vector<std::string> weaponRoomIds;

  for (const RoomState& r : rooms) {
    const cfg::ModuleSpec* spec = cfg::moduleSpec(r.moduleType);   // nullptr if unknown
    if (!spec) continue;
    bool active = r.enabled && r.hp > 0;
    if (spec->power < 0) {                              // reactor: scale by hp fraction
      powerProduction += -spec->power * (r.hp / r.maxHp);
      continue;
    }
    if (!active) continue;
    powerDemand    += spec->power;
    thrust         += spec->thrust;
    turnRate       += spec->turnRate;
    sensorRange     = std::max(sensorRange, spec->sensorRange);
    shieldCapacity += spec->shieldCapacity;
    cargo          += spec->cargo;
    if (spec->hasMining) {
      miningPower += spec->miningPower;
      for (auto t : spec->miningResources)
        if (std::find(miningSet.begin(), miningSet.end(), t) == miningSet.end())
          miningSet.push_back(t);
    }
    if (spec->kind == cfg::ModuleKind::weapon) weaponRoomIds.push_back(r.id);
  }

  double maxSpeed = std::max(cfg::COMBAT.minMaxSpeed,
                    std::min(cfg::COMBAT.maxMaxSpeed, thrust * cfg::COMBAT.speedPerThrust));
  DerivedStats d{};
  d.thrust = thrust; d.turnRate = turnRate; d.sensorRange = sensorRange;
  d.shieldCapacity = shieldCapacity;
  d.powerProduction = powerProduction; d.powerDemand = powerDemand; d.cargo = cargo;
  d.weaponRoomIds = std::move(weaponRoomIds);
  d.underpowered = powerDemand > powerProduction;
  d.maxSpeed = maxSpeed;
  d.accel = std::max(20.0, thrust * cfg::COMBAT.accelPerThrust);
  d.miningPower = miningPower; d.miningResources = std::move(miningSet);
  d.energy = { powerProduction, powerDemand, powerProduction - powerDemand };
  return d;
}
```

`roomsFromBlueprint` — rotation swaps `w`/`h`; hp = spec.hp; `powerDemand` only
if `spec.power > 0`; copy the `weapon` sub-struct if present; ids via
`deterministicId("room", idIndexBase + i)`:

```cpp
std::vector<RoomState> roomsFromBlueprint(const ShipBlueprint& bp, uint64_t idIndexBase) {
  std::vector<RoomState> out;
  out.reserve(bp.placements.size());
  for (size_t i = 0; i < bp.placements.size(); ++i) {
    const auto& p = bp.placements[i];
    const cfg::ModuleSpec* spec = cfg::moduleSpec(p.moduleType);   // assumed valid (validated)
    bool rot = (p.rotation == 90 || p.rotation == 270);
    RoomState r{};
    r.id = deterministicId("room", idIndexBase + i);
    r.kind = spec->kind;
    r.moduleType = p.moduleType;
    r.x = p.x; r.y = p.y;
    r.w = rot ? spec->h : spec->w;
    r.h = rot ? spec->w : spec->h;
    r.hp = spec->hp; r.maxHp = spec->hp;
    r.powerDemand = spec->power > 0 ? spec->power : 0;
    r.enabled = true;
    if (spec->hasWeapon) r.weapon = spec->weapon;                  // std::optional copy
    out.push_back(std::move(r));
  }
  return out;
}
```

`instantiateShip` — hull hp = `cfg::COMBAT.hullBaseHp + width*height*4`:

```cpp
ShipState instantiateShip(const std::string& ownerId, const std::string& name,
                          const ShipBlueprint& bp, std::string id) {
  ShipState s{};
  s.id = std::move(id); s.ownerId = ownerId; s.name = name;
  s.rooms = roomsFromBlueprint(bp);
  double hullHp = cfg::COMBAT.hullBaseHp + bp.width * bp.height * 4;
  s.hull = { hullHp, hullHp, (double)bp.width, (double)bp.height };
  s.blueprint = bp;
  s.derived = computeDerived(s.rooms);
  s.doctrine = DEFAULT_SHIP_DOCTRINE;
  s.combatWeight = shipCombatWeight(s);
  // crew empty, cargo empty
  return s;
}
```

`validateBlueprint` ports the same checks (outside-hull, overlap, no/multiple
bridge, unknown-module, on-blocked-cell) — a rectangular occupancy scan over
`occupiedCells` using a `std::unordered_map<std::string,int>` cell counter and a
`std::unordered_set<std::string>` of blocked cells. `starterBlueprint` returns
the fixed 3×3 bridge/reactor/engine/shield/laser/cannon placement verbatim.

> `cfg::moduleSpec(id)` is a helper over the `cfg::MODULES` table (step 002).
> Add it there returning `const ModuleSpec*` (nullptr on miss). `ModuleSpec`
> carries `hasWeapon`/`hasMining` flags (C++ has no optional-field structs like
> TS) plus a `std::optional<WeaponSpec> weapon` for the copy above.

## 5. `resources.cpp` — commodity-bag helpers

`ResourceBag` in C++ = `std::unordered_map<std::string,double>` (keys `"metal"`,
`"fuel"`), or a fixed `{double metal, fuel;}` — either works; use the map to keep
the port literal and future resource types cheap. Iterate `RESOURCE_TYPES` for
totals so absent keys read as 0.

```cpp
// server/src/sim/resources.h
#pragma once
#include <unordered_map>
#include <string>
namespace ss {
using ResourceBag = std::unordered_map<std::string, double>;
inline const std::vector<std::string>& RESOURCE_TYPES() {
  static const std::vector<std::string> v{ "metal", "fuel" }; return v;
}
double bagTotal(const ResourceBag& bag);
ResourceBag cloneBag(const ResourceBag& bag);
void   addToBag(ResourceBag& bag, const std::string& resource, double amount);
double transfer(ResourceBag& src, ResourceBag& dst, const std::string& resource,
                double amount, double capacityLeft = std::numeric_limits<double>::infinity());
}
```

```cpp
// server/src/sim/resources.cpp
double bagTotal(const ResourceBag& bag) {
  double n = 0; for (auto& t : RESOURCE_TYPES()) { auto it = bag.find(t); if (it != bag.end()) n += it->second; }
  return n;
}
void addToBag(ResourceBag& bag, const std::string& resource, double amount) {
  double cur = 0; auto it = bag.find(resource); if (it != bag.end()) cur = it->second;
  bag[resource] = std::max(0.0, cur + amount);
}
double transfer(ResourceBag& src, ResourceBag& dst, const std::string& resource,
                double amount, double capacityLeft) {
  double have = 0; auto it = src.find(resource); if (it != src.end()) have = it->second;
  double moved = std::max(0.0, std::min({ amount, have, capacityLeft }));
  if (moved <= 0) return 0;
  src[resource] = have - moved;
  dst[resource] = (dst.count(resource) ? dst[resource] : 0.0) + moved;
  return moved;
}
```

## 6. `stations.cpp` — `stepStations` auto-extract

> NB: In TS `stepStations` lives in `operations.ts`, but the mapping (000) and
> this step file split it into `stations.cpp`. Keep the name `stepStations`.

Each station auto-mines its location's richest deposit into its storage, bounded
by free capacity and remaining reserves; depletes the deposit.

```cpp
// server/src/sim/stations.cpp
#include "sim/stations.h"
#include "sim/resources.h"
#include "sim/world_sim.h"          // pickDeposit (defined in world_sim.cpp, step 006)
namespace ss {
void stepStations(GameState& game, double dtMs) {
  double dt = dtMs / 1000.0;
  for (auto& [sid, station] : game.stations) {
    auto locIt = game.resourceLocations.find(station.locationId);
    if (locIt == game.resourceLocations.end()) continue;
    ResourceLocation& loc = locIt->second;
    ResourceDeposit* deposit = pickDeposit(loc, std::nullopt);   // richest with reserves
    if (!deposit || deposit->reserves <= 0) continue;
    double free = station.capacity - bagTotal(station.storage);
    if (free <= 0) continue;
    double rate = station.extraction * deposit->richness * deposit->accessibility * dt;
    double moved = std::max(0.0, std::min({ rate, free, deposit->reserves }));
    if (moved <= 0) continue;
    addToBag(station.storage, resourceKey(deposit->resource), moved);
    deposit->reserves -= moved;
  }
}
}
```

> `pickDeposit(ResourceLocation&, std::optional<int>)` returns a mutable
> `ResourceDeposit*` (so callers can decrement `reserves`) and is shared with
> world_sim/operations. Define it once in `world_sim.cpp` (step 006) and declare
> it in `world_sim.h`. `resourceKey(ResourceType)` maps the enum → `"metal"`/`"fuel"`.

## 7. `operations.cpp` — `stepOperations` state machine

Automated mining loop: `mining → returning → unloading → mining`. It only issues
fleet **orders** and moves the anchor; the actual cargo transfer is done by the
world step's mining/unload passes (step 006). Guards drop the operation if the
fleet/location/planet vanished; `paused` skips.

```cpp
// server/src/sim/operations.cpp
#include "sim/operations.h"
#include "sim/world_sim.h"     // fleetCentroid, pickDeposit
#include "sim/resources.h"
#include "sim/economy.h"       // materializePlanetResources
#include "shared/game_config.h"

namespace ss {

// True once every mining-capable ship in the fleet has filled its cargo.
static bool minersFull(GameState& game, const std::string& fleetId) {
  auto fit = game.fleets.find(fleetId);
  if (fit == game.fleets.end()) return true;
  bool anyMiner = false;
  for (auto& id : fit->second.shipIds) {
    auto s = game.ships.find(id);
    if (s == game.ships.end() || s->second.derived.miningPower <= 0) continue;
    anyMiner = true;
    if (s->second.derived.cargo - bagTotal(s->second.cargo) > 0.5) return false;
  }
  return anyMiner;
}

static void fleetCargo(GameState& game, const std::string& fleetId,
                       double& carried, double& capacity) {
  carried = 0; capacity = 0;
  auto fit = game.fleets.find(fleetId);
  if (fit == game.fleets.end()) return;
  for (auto& id : fit->second.shipIds) {
    auto s = game.ships.find(id);
    if (s == game.ships.end()) continue;
    carried  += bagTotal(s->second.cargo);
    capacity += s->second.derived.cargo;
  }
}

void stepOperations(GameState& game, double /*dtMs*/, double nowMs) {
  std::vector<std::string> toDelete;
  for (auto& [id, op] : game.operations) {
    auto fit = game.fleets.find(op.fleetId);
    if (fit == game.fleets.end() || fit->second.status == FleetStatus::destroyed
        || fit->second.shipIds.empty()) { toDelete.push_back(id); continue; }
    FleetState& fleet = fit->second;
    auto locIt    = game.resourceLocations.find(op.locationId);
    auto planetIt = game.planets.find(op.deliveryPlanetId);
    if (locIt == game.resourceLocations.end() || planetIt == game.planets.end())
      { toDelete.push_back(id); continue; }
    ResourceLocation& loc = locIt->second;
    PlanetState& planet   = planetIt->second;
    if (op.paused) continue;

    switch (op.state) {
      case OpState::mining: {
        if (fleet.order.kind != OrderKind::mine || fleet.order.locationId != op.locationId) {
          fleet.order = FleetOrder{}; fleet.order.kind = OrderKind::mine;
          fleet.order.locationId = op.locationId;
          fleet.position = loc.position;
        }
        bool depleted = (pickDeposit(loc, std::nullopt) == nullptr);
        if (minersFull(game, op.fleetId) || depleted) {
          op.state = OpState::returning;
          fleet.order = FleetOrder{}; fleet.order.kind = OrderKind::moveTo;
          fleet.order.target = planet.position;
          fleet.position = planet.position;
        }
        break;
      }
      case OpState::returning: {
        Vec2 c = fleetCentroid(game, fleet);
        if (dist(c, planet.position) <= cfg::RESOURCE.transferRange) {
          op.state = OpState::unloading;
          fleet.order = FleetOrder{}; fleet.order.kind = OrderKind::unloadAt;
          fleet.order.planetId = op.deliveryPlanetId;
          fleet.position = planet.position;
        }
        break;
      }
      case OpState::unloading: {
        materializePlanetResources(planet, nowMs);
        double carried, capacity; fleetCargo(game, op.fleetId, carried, capacity);
        if (carried <= 0.5) {
          op.state = OpState::mining;
          fleet.order = FleetOrder{}; fleet.order.kind = OrderKind::mine;
          fleet.order.locationId = op.locationId;
          fleet.position = loc.position;
        }
        break;
      }
    }
  }
  for (auto& id : toDelete) game.operations.erase(id);
}

// Register + kick the fleet straight into mining.
OperationState startOperation(GameState& game, OperationState op) {
  op.state = OpState::mining; op.paused = false;
  game.operations[op.id] = op;
  auto fit = game.fleets.find(op.fleetId);
  auto lit = game.resourceLocations.find(op.locationId);
  if (fit != game.fleets.end() && lit != game.resourceLocations.end()) {
    fit->second.order = FleetOrder{}; fit->second.order.kind = OrderKind::mine;
    fit->second.order.locationId = op.locationId;
    fit->second.position = lit->second.position;
  }
  return op;
}

} // namespace ss
```

> Mutating a map while iterating: collect ids in `toDelete` and `erase` after the
> loop (TS `Map.delete` mid-iteration is legal; C++ `unordered_map::erase`
> during range-for is not).
> `materializePlanetResources` (from `economy.ts`) is a small dependency — port
> it alongside (accrues planet passive rates over elapsed ms). It is not on this
> step's headline list but `stepOperations` calls it; include it in `economy.cpp`.

## 8. Done when

- `rng.cpp`, `ids.cpp`, `worldgen.cpp`, `ship.cpp`, `resources.cpp`,
  `stations.cpp`, `operations.cpp` (+ minimal `economy.cpp`) compile and link
  into `server`.
- **Worldgen parity test:** with `seed = cfg::WORLD_SEED` (0x5eedc0de),
  `generatePlanets` produces the same count, ids, names, positions, radii, and
  rates as the TS `generatePlanets` (dump both to CSV, diff). Same for
  `generateResourceLocations`. This proves the mulberry32 + `range`/`pick` call
  order is bit-/value-exact within the build.
- **RNG unit test:** `mulberry32(1).next()` × N matches the TS sequence exactly
  (integer state check is exact; `next()` double values match to full precision
  on the same build).
- **Derived-stats test:** `instantiateShip(starterBlueprint())` yields the same
  `thrust/turnRate/sensorRange/shieldCapacity/power*/cargo/maxSpeed/accel/
  miningPower/weaponRoomIds/underpowered` as TS `computeDerived`.
- `transfer`/`addToBag`/`bagTotal` round-trip test matches TS.
- `stepStations` depletes a deposit into storage at the same rate as the TS
  `stations.test.ts` expectations.

## 9. Unresolved questions

- 000 §3 says LCG (`*1664525+1013904223`); real `rng.ts` is mulberry32. Port
  mulberry32 (done here) + fix 000, or actually switch the sim to an LCG? Default: port mulberry32, correct 000.
- `next()` double parity across compilers/optimizers — only single-build
  determinism required, so `-ffast-math` OFF for `rng.cpp`/sim TU. Confirm.
- `ResourceBag` = map vs fixed `{metal,fuel}` struct. Default map (literal port,
  extensible); revisit if hot in profiling.
- `makeId` drops `performance.now()` suffix for `idCounter`. OK since ids never
  cross the TS↔C++ boundary? Assumed yes.
- `pickDeposit` ownership: return mutable `ResourceDeposit*` into the location's
  vector — fine as long as the vector isn't resized mid-step (it isn't). Confirm.
- `economy.ts::materializePlanetResources` pulled in early by `stepOperations`.
  Port here (partial economy) or stub until step 007? Default: port the one function.
```
