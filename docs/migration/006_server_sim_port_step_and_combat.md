# Step 006 — Server sim port: step & combat (per-tick physics)

Goal: port the deterministic per-tick simulation of `packages/simulation` to C++:
`stepWorld` (kinematics + steering + targeting + firing + projectile
integration + collision + damage + shield regen + fleet brain + logistics), plus
`combat.cpp` (steering desired-velocity, target selection, `applyDamage`) and
`fleet.cpp` (formation math + doctrine presets + fleet-brain intent). Mechanical
1:1 port — keep function/field names for grep parity. Types are `ss::` from step
002. RNG is threaded through `game.rngState` (step 005).

Prereqs: 000, 002, 005. Reference files (read before porting):

- `packages/simulation/src/worldSim.ts` (`stepWorld`, `desiredVelocity`, `pickDeposit`,
  `fleetCentroid`, `stepFleetBrain`, mining/unload/salvage/cull passes)
- `packages/simulation/src/combat.ts` (`applyDamage`, `chooseTarget`, `pickTargetRoom`,
  `preferredRangeUnits`, `segmentPointDistance`, `HIT_RADIUS`)
- `packages/simulation/src/fleet.ts` (`computeFormationOffsets`, `formationSlots`,
  `roleOrder`, `shipRole`, `DOCTRINE_PRESETS`, `calculateFleetStrategicSpeed`)
- `packages/config/src/index.ts` (`COMBAT`, `RESOURCE`, `SALVAGE`)

**Determinism contract:** same `game.rngState` + same command order into `game`
⇒ identical world evolution. The only RNG draw per step is the room-pick index in
`applyDamage`; everything else is pure `double` math. `stepWorld` returns the
list of `destroyedShipIds` for the caller (broadcast / cleanup, step 007).

---

## 1. `combat.cpp` — targeting, hit test, damage

`HIT_RADIUS = cfg::COMBAT.hitRadius`. `preferredRangeUnits`: close 160 / long 460
/ else 300. `segmentPointDistance` is the swept-projectile point-to-segment test.

```cpp
// server/src/sim/combat.h
#pragma once
#include "shared/sim_types.h"
namespace ss {
constexpr double HIT_RADIUS = cfg::COMBAT.hitRadius;

double segmentPointDistance(double ax,double ay,double bx,double by, Vec2 q);
double preferredRangeUnits(const std::string& range);       // "close"|"long"|else
ShipRuntime* chooseTarget(const ShipRuntime& self, std::vector<ShipRuntime*>& enemies,
                          const std::string& priority,
                          std::unordered_map<std::string,ShipState>& ships);
RoomState* pickTargetRoom(ShipState& ship, uint32_t pickIndex);
void applyDamage(ShipRuntime& target, ShipState& targetShip, double damage,
                 uint32_t pickIndex, std::vector<CombatEvent>& events);
}
```

`segmentPointDistance` + `preferredRangeUnits`:

```cpp
double segmentPointDistance(double ax,double ay,double bx,double by, Vec2 q) {
  double dx = bx - ax, dy = by - ay;
  double len2 = dx*dx + dy*dy;
  if (len2 == 0) return std::hypot(q.x - ax, q.y - ay);
  double t = ((q.x - ax)*dx + (q.y - ay)*dy) / len2;
  t = std::max(0.0, std::min(1.0, t));
  return std::hypot(q.x - (ax + t*dx), q.y - (ay + t*dy));
}
double preferredRangeUnits(const std::string& r) {
  return r == "close" ? 160.0 : r == "long" ? 460.0 : 300.0;
}
```

`applyDamage` — shields first, then a seeded-picked room, then hull overflow;
emits `hit` (shield), `hit` (room), `roomDisabled`, `shipDestroyed` events;
recomputes `derived` after a room loss (so power/thrust degrade live):

```cpp
RoomState* pickTargetRoom(ShipState& ship, uint32_t pickIndex) {
  std::vector<RoomState*> alive;
  for (auto& r : ship.rooms) if (r.hp > 0) alive.push_back(&r);
  if (alive.empty()) return nullptr;
  return alive[pickIndex % alive.size()];
}

void applyDamage(ShipRuntime& target, ShipState& targetShip, double damage,
                 uint32_t pickIndex, std::vector<CombatEvent>& events) {
  double remaining = damage;
  if (target.shield > 0) {
    double absorbed = std::min(target.shield, remaining);
    target.shield  -= absorbed;
    remaining      -= absorbed;
    events.push_back(CombatEvent::hit(target.shipId, std::nullopt, absorbed, /*shield=*/true));
    if (remaining <= 0) return;
  }
  RoomState* room = pickTargetRoom(targetShip, pickIndex);
  if (room) {
    double before = room->hp;
    room->hp = std::max(0.0, room->hp - remaining);
    double overflow = remaining - (before - room->hp);
    events.push_back(CombatEvent::hit(target.shipId, room->id, remaining, /*shield=*/false));
    if (before > 0 && room->hp == 0) {
      room->enabled = false;
      events.push_back(CombatEvent::roomDisabled(target.shipId, room->id));
    }
    if (overflow > 0) targetShip.hull.hp = std::max(0.0, targetShip.hull.hp - overflow);
    targetShip.derived = computeDerived(targetShip.rooms);   // degrade after room loss
  } else {
    targetShip.hull.hp = std::max(0.0, targetShip.hull.hp - remaining);
  }
  if (targetShip.hull.hp <= 0) {
    target.alive = false;
    events.push_back(CombatEvent::shipDestroyed(target.shipId, target.position));
  }
}
```

> `CombatEvent` (step 002/003) is a tagged union; the `::hit/::roomDisabled/
> ::shipDestroyed/::fire` static factories mirror the TS discriminant. `pickIndex`
> is `rng.int_(1<<20)` from the caller — the sole RNG consumer in a step, so
> event/room outcomes are deterministic given `rngState`.

`chooseTarget` (nearest / small_ships=min maxHp / large_ships=max maxHp) is used
by the fuller doctrine path; `stepWorld` itself uses the simpler
`nearestEnemyWithin` (below). Port both — `chooseTarget` keeps the reduce
semantics (first element seeds the reduce; ties keep the earlier element).

## 2. `fleet.cpp` — formation offsets, roles, doctrine presets

`computeFormationOffsets(ships, shape)` → `unordered_map<shipId, Vec2>` local-
frame offsets, re-centred so the shape balances on the anchor. Ships are ordered
by **role priority** for the shape (tie-break by id ascending), then slotted.

```cpp
// server/src/sim/fleet.h
#pragma once
#include "shared/sim_types.h"
namespace ss {
enum class ShipRole { heavy, line, light, support };
ShipRole shipRole(const ShipState& s);
std::unordered_map<std::string, Vec2> computeFormationOffsets(
    const std::vector<ShipState*>& ships, Formation shape);
double calculateFleetStrategicSpeed(const std::vector<ShipState*>& ships);
const FleetDoctrine& doctrinePreset(DoctrinePreset p);       // DOCTRINE_PRESETS table
}
```

`shipRole` + `roleOrder` + `formationSlots` are literal ports. `shipRole`:
weapons==0 && cargo>0 → support; area>=16 → heavy; area<=6 → light; else line.

```cpp
static std::vector<Vec2> formationSlots(Formation shape, int n, double spacing) {
  std::vector<Vec2> out;
  switch (shape) {
    case Formation::column:
      for (int i=0;i<n;i++) out.push_back({ -i*spacing, 0 }); break;
    case Formation::line:
      for (int i=0;i<n;i++) out.push_back({ 0, (i - (n-1)/2.0)*spacing }); break;
    case Formation::loose: {
      double s = spacing * 2.2;
      for (int i=0;i<n;i++) out.push_back({ 0, (i - (n-1)/2.0)*s }); break; }
    case Formation::echelon:
      for (int i=0;i<n;i++) out.push_back({ -i*spacing, i*spacing }); break;
    case Formation::wedge: {
      int placed=0, d=0;
      while (placed < n) {
        int inRow = std::min(d+1, n-placed);
        for (int k=0;k<inRow;k++) out.push_back({ -d*spacing, (k-(inRow-1)/2.0)*spacing });
        placed += inRow; d++;
      } break; }
    case Formation::box: {
      int cols = std::max(1, (int)std::ceil(std::sqrt((double)n)));
      for (int i=0;i<n;i++){ int row=i/cols, col=i%cols;
        out.push_back({ -row*spacing, (col-(cols-1)/2.0)*spacing }); } break; }
    case Formation::screen: {
      int front = (int)std::ceil(n/2.0);
      for (int i=0;i<front;i++) out.push_back({ spacing, (i-(front-1)/2.0)*spacing*1.4 });
      int rear = n - front;
      for (int i=0;i<rear;i++) out.push_back({ -spacing, (i-(rear-1)/2.0)*spacing }); break; }
    case Formation::protect: {
      out.push_back({ 0, 0 });
      int ring = n - 1; double r = spacing * 1.3;
      for (int k=0;k<ring;k++){ double a = (2*M_PI*k)/ring;
        out.push_back({ std::cos(a)*r, std::sin(a)*r }); } break; }
  }
  return out;
}

std::unordered_map<std::string, Vec2> computeFormationOffsets(
    const std::vector<ShipState*>& ships, Formation shape) {
  std::unordered_map<std::string, Vec2> out;
  if (ships.empty()) return out;
  double spacing = cfg::COMBAT.formationSpacing;
  std::vector<ShipRole> order = roleOrder(shape);
  std::vector<ShipState*> ordered(ships.begin(), ships.end());
  std::sort(ordered.begin(), ordered.end(), [&](ShipState* a, ShipState* b){
    int ra = (int)(std::find(order.begin(),order.end(),shipRole(*a)) - order.begin());
    int rb = (int)(std::find(order.begin(),order.end(),shipRole(*b)) - order.begin());
    if (ra != rb) return ra < rb;
    return a->id < b->id;                                    // stable tie-break by id
  });
  std::vector<Vec2> slots = formationSlots(shape, (int)ordered.size(), spacing);
  double mx=0, my=0;
  for (auto& s : slots) { mx += s.x; my += s.y; }
  mx /= slots.size(); my /= slots.size();                    // re-centre on anchor
  for (size_t i=0;i<ordered.size();++i) {
    Vec2 s = i < slots.size() ? slots[i] : Vec2{0,0};
    out[ordered[i]->id] = { s.x - mx, s.y - my };
  }
  return out;
}
```

> `std::sort` is not stable; the TS `Array.sort` comparator is total (id
> tie-break), so ordering is deterministic regardless. Use `std::sort` — the id
> tie-break removes any need for `stable_sort`.

`DOCTRINE_PRESETS` is a fixed table (`doctrinePreset(DoctrinePreset)` returns the
`{aggression,pursuit,cohesion,survival}` for each preset — values verbatim from
`fleet.ts`). `calculateFleetStrategicSpeed` = `max(40, min over ships of
shipStrategicSpeed)`, empty → `cfg::FLEET.baseSpeed`.

## 3. `world_sim.cpp` — helpers

`pickDeposit`, `fleetCentroid`, `isMiner`, `nearestEnemyWithin`, `fleetHeading`,
`homePos`, `makeRuntime`, `fleetFires`, `fleetHealth`, `awarenessOf`,
`stepFleetBrain`, `desiredVelocity`, `miningRingSlots` — all direct ports.
Representative ones:

```cpp
ResourceDeposit* pickDeposit(ResourceLocation& loc, std::optional<int> index) {
  if (index && *index >= 0 && *index < (int)loc.deposits.size()
      && loc.deposits[*index].reserves > 0) return &loc.deposits[*index];
  ResourceDeposit* best = nullptr;
  for (auto& d : loc.deposits) {
    if (d.reserves <= 0) continue;
    if (!best || d.richness > best->richness) best = &d;
  }
  return best;
}

Vec2 fleetCentroid(GameState& game, const FleetState& fleet) {
  double x=0, y=0; int n=0;
  for (auto& id : fleet.shipIds) {
    auto it = game.shipRuntime.find(id);
    if (it != game.shipRuntime.end() && it->second.alive) {
      x += it->second.position.x; y += it->second.position.y; n++;
    }
  }
  return n > 0 ? Vec2{ x/n, y/n } : fleet.position;
}

static bool isMiner(const ShipState& s) { return s.derived.miningPower > 0; }

static ShipRuntime* nearestEnemyWithin(const ShipRuntime& rt, GameState& game, double range) {
  ShipRuntime* best = nullptr; double bestD = range;
  for (auto& [id, o] : game.shipRuntime) {
    if (!o.alive || o.ownerId == rt.ownerId) continue;
    double d = dist(rt.position, o.position);
    if (d < bestD) { bestD = d; best = &o; }
  }
  return best;
}

static double awarenessOf(const FleetState& f) { return std::max(f.sensorRange, 800.0); }
```

`fleetFires` (doctrine gate): `hold_fire`→false; `return_fire`/`flee_if_attacked`
→ under-attack only; else true. `stepFleetBrain` sets `fleet.intent`
(engage/continue_order/flee), and on flee (`flee_if_attacked` under attack, or
health<0.3 && survival>0.6) retargets the anchor toward home / away from enemies.

```cpp
static void stepFleetBrain(GameState& game, FleetState& fleet, double nowMs) {
  bool underAttack = nowMs < fleet.underAttackUntil.value_or(0.0);
  const FleetDoctrine& d = fleet.doctrine;
  bool losing = fleetHealth(game, fleet) < 0.3 && d.survival > 0.6;
  bool wantsFlee = (d.preset == DoctrinePreset::flee_if_attacked && underAttack) || losing;
  if (wantsFlee) {
    std::optional<Vec2> home = homePos(game, fleet.ownerId);
    if (!home) home = awayFromEnemy(game, fleet);
    if (home) { fleet.order = FleetOrder{}; fleet.order.kind = OrderKind::moveTo; fleet.order.target = *home; }
    if (home) fleet.position = *home;
    fleet.intent = FleetIntent::flee;
    return;
  }
  Vec2 centroid = fleetCentroid(game, fleet);
  bool enemyNear = false;
  for (auto& [id, o] : game.shipRuntime)
    if (o.alive && o.ownerId != fleet.ownerId && dist(centroid, o.position) <= awarenessOf(fleet))
      { enemyNear = true; break; }
  fleet.intent = (enemyNear && fleetFires(fleet, nowMs)) ? FleetIntent::engage
                                                         : FleetIntent::continue_order;
}
```

## 4. `computeSteering` / `desiredVelocity` — soft-body steering

The steering (`desiredVelocity` in TS) sums: arrival toward the formation slot
(scaled 0.3 when approaching), combat range-keeping toward `preferredRange`, and
friendly collision avoidance; then clamps to ship top speed (fighting) or the
fleet's slowest-ship cap (travel).

```cpp
static Vec2 desiredVelocity(ShipRuntime& rt, const ShipState& ship, Vec2 slot,
                            ShipRuntime* target, bool approach,
                            GameState& game, double fleetMaxSpeed) {
  double shipMax  = ship.derived.maxSpeed;
  double travelMax = std::min(shipMax, fleetMaxSpeed);   // slowest-ship cap
  double vx = 0, vy = 0;
  // Arrival toward slot (ships PARK — arrival slows to a stop).
  Vec2 toSlot = slot - rt.position;
  double dSlot = std::hypot(toSlot.x, toSlot.y);
  double formScale = approach ? 0.3 : 1.0;
  if (dSlot > cfg::COMBAT.slotArriveDist) {
    double sp = std::min(travelMax, dSlot * 3) * formScale;
    Vec2 dir = norm(toSlot);
    vx += dir.x * sp; vy += dir.y * sp;
  }
  // Combat range-keeping (only when breaking formation to fight).
  if (approach && target) {
    Vec2 to = target->position - rt.position;
    double d = std::hypot(to.x, to.y); if (d == 0) d = 1;
    double want = preferredRangeUnits(ship.doctrine.preferredRange);
    Vec2 dir = norm(to);
    double sign = d > want + 40 ? 1 : d < want - 60 ? -1 : 0;
    vx += dir.x * sign * shipMax; vy += dir.y * sign * shipMax;
  }
  // Friendly collision avoidance.
  for (auto& [id, o] : game.shipRuntime) {
    if (&o == &rt || !o.alive || o.ownerId != rt.ownerId) continue;
    Vec2 away = rt.position - o.position;
    double dd = std::hypot(away.x, away.y);
    if (dd > 0 && dd < cfg::COMBAT.avoidanceRadius) {
      double w = (shipMax * (cfg::COMBAT.avoidanceRadius - dd)) / cfg::COMBAT.avoidanceRadius;
      vx += (away.x / dd) * w; vy += (away.y / dd) * w;
    }
  }
  return clamp_len({ vx, vy }, approach ? shipMax : travelMax);
}
```

> The friendly-avoidance loop iterates `game.shipRuntime` in map order. TS
> `Map.values()` is insertion-ordered; `std::unordered_map` is not. Because the
> avoidance term is a **commutative sum** over neighbours and target/arrival are
> order-independent, the resulting `Vec2` is identical regardless of iteration
> order — so `unordered_map` is safe here. (Same argument for `nearestEnemyWithin`
> ties: distances are strict `<`, so the first-seen-at-min-distance wins;
> exact-tie order differs from TS but is astronomically rare with doubles — noted
> in Unresolved.)

## 5. `stepWorld` — the ordered per-tick pipeline

Full skeleton. Phases mirror `worldSim.ts` exactly: (1) sync runtime + formation
slots, (2) fleet brains, (3) movement + firing, (3b) mining, (3c) unloading,
(4) projectile integration + collision + damage, (4b) salvage, (5) cull dead +
drop debris. Returns `destroyedShipIds`.

```cpp
// server/src/sim/world_sim.h
struct WorldStepResult { std::vector<std::string> destroyedShipIds; };
WorldStepResult stepWorld(GameState& game, double dtMs, double nowMs);
```

```cpp
// server/src/sim/world_sim.cpp  (skeleton — bodies of helpers above)
WorldStepResult stepWorld(GameState& game, double dtMs, double nowMs) {
  double dt = dtMs / 1000.0;
  Rng rng = rngFromState(game.rngState);        // step 005
  game.combatEvents.clear();
  auto& events = game.combatEvents;
  static const double UNDER_ATTACK_MS = 3000;

  // 1. Sync runtime with fleet membership + compute formation slots.
  std::unordered_map<std::string, Vec2> slots;
  std::unordered_set<std::string>       fleeted;
  std::unordered_map<std::string, double> fleetSpeedCap;
  for (auto& [fid, fleet] : game.fleets) {
    if (fleet.status == FleetStatus::destroyed) continue;
    std::vector<ShipState*> ships;
    for (auto& id : fleet.shipIds) { auto it = game.ships.find(id); if (it != game.ships.end()) ships.push_back(&it->second); }
    double cap = std::numeric_limits<double>::infinity();
    for (auto* s : ships) cap = std::min(cap, s->derived.maxSpeed);
    fleetSpeedCap[fid] = std::isfinite(cap) ? cap : cfg::COMBAT.minMaxSpeed;

    std::optional<std::unordered_map<std::string,Vec2>> miningSlots;
    if (fleet.order.kind == OrderKind::mine) miningSlots = miningRingSlots(fleet, ships);
    std::unordered_map<std::string,Vec2> offsets;
    if (!miningSlots) offsets = computeFormationOffsets(ships, fleet.formation);
    double heading = fleetHeading(game, fleet);
    double c = std::cos(heading), s = std::sin(heading);
    for (auto* ship : ships) {
      fleeted.insert(ship->id);
      Vec2 slot;
      if (miningSlots) {
        auto it = miningSlots->find(ship->id);
        slot = it != miningSlots->end() ? it->second : fleet.position;
      } else {
        Vec2 off = offsets.count(ship->id) ? offsets[ship->id] : Vec2{0,0};
        slot = { fleet.position.x + off.x*c - off.y*s, fleet.position.y + off.x*s + off.y*c };
      }
      slots[ship->id] = slot;
      if (!game.shipRuntime.count(ship->id))
        game.shipRuntime[ship->id] = makeRuntime(*ship, fleet, slot);
    }
  }
  // Drop runtimes for ships no longer in any fleet.
  for (auto it = game.shipRuntime.begin(); it != game.shipRuntime.end(); )
    it = fleeted.count(it->first) ? std::next(it) : game.shipRuntime.erase(it);

  // 2. Fleet brains.
  for (auto& [fid, fleet] : game.fleets)
    if (fleet.status != FleetStatus::destroyed) stepFleetBrain(game, fleet, nowMs);

  // 3. Ship movement + firing.
  for (auto& [id, rt] : game.shipRuntime) {
    if (!rt.alive) continue;
    rt.miningLocationId.reset(); rt.unloadLocationId.reset();   // re-set by 3b/3c
    auto sit = game.ships.find(rt.shipId);
    auto fit = game.fleets.find(rt.fleetId);
    if (sit == game.ships.end() || fit == game.fleets.end() || sit->second.hull.hp <= 0) {
      rt.alive = false; continue;
    }
    ShipState& ship = sit->second; FleetState& fleet = fit->second;
    Vec2 slot = slots.count(rt.shipId) ? slots[rt.shipId] : fleet.position;
    bool fires = fleetFires(fleet, nowMs);
    ShipRuntime* target = fires ? nearestEnemyWithin(rt, game, awarenessOf(fleet)) : nullptr;
    rt.targetShipId = target ? std::optional<std::string>(target->shipId) : std::nullopt;
    bool retreating = fleet.order.kind == OrderKind::moveTo;
    bool approach = target && !retreating && fleet.order.kind != OrderKind::hold;

    Vec2 dv = desiredVelocity(rt, ship, slot, target, approach, game,
                              fleetSpeedCap.count(rt.fleetId) ? fleetSpeedCap[rt.fleetId] : ship.derived.maxSpeed);
    double maxDv = ship.derived.accel * dt;
    double ddx = dv.x - rt.velocity.x, ddy = dv.y - rt.velocity.y;
    double dvLen = std::hypot(ddx, ddy);
    if (dvLen > maxDv && dvLen > 0) {                 // accel-limit toward desired velocity
      rt.velocity.x += (ddx / dvLen) * maxDv;
      rt.velocity.y += (ddy / dvLen) * maxDv;
    } else { rt.velocity = dv; }
    rt.position.x += rt.velocity.x * dt;              // p += v*dt
    rt.position.y += rt.velocity.y * dt;
    // heading: face target when firing; face deposit/outward when mining; else velocity.
    if (target && fires)
      rt.heading = std::atan2(target->position.y - rt.position.y, target->position.x - rt.position.x);
    else if (fleet.order.kind == OrderKind::mine) {
      Vec2 cc = fleet.position;
      rt.heading = isMiner(ship)
        ? std::atan2(cc.y - rt.position.y, cc.x - rt.position.x)
        : std::atan2(rt.position.y - cc.y, rt.position.x - cc.x);
    } else if (rt.velocity.x != 0 || rt.velocity.y != 0)
      rt.heading = std::atan2(rt.velocity.y, rt.velocity.x);

    if (rt.shield < rt.maxShield)                     // shield regen
      rt.shield = std::min(rt.maxShield, rt.shield + cfg::COMBAT.shieldRegenPerSec * dt);

    // Firing: per weapon room, decay cooldown, range-gate, spawn projectile + fire event.
    if (fires && target) {
      for (auto& room : ship.rooms) {
        if (room.kind != ModuleKind::weapon || room.hp <= 0 || !room.enabled || !room.weapon) continue;
        double cd = (rt.weaponCooldowns.count(room.id) ? rt.weaponCooldowns[room.id] : 0.0) - dtMs;
        if (cd > 0) { rt.weaponCooldowns[room.id] = cd; continue; }
        if (dist(rt.position, target->position) > room.weapon->range) { rt.weaponCooldowns[room.id] = 0; continue; }
        rt.weaponCooldowns[room.id] = room.weapon->cooldownMs;
        Vec2 dir = norm(target->position - rt.position);
        std::string pid = makeId("proj", game.idCounter);
        WorldProjectile p{};
        p.id = pid; p.ownerShipId = rt.shipId; p.ownerFleetId = rt.fleetId;
        p.targetShipId = target->shipId; p.kind = room.moduleType;
        p.position = rt.position;
        p.velocity = { dir.x * room.weapon->projectileSpeed, dir.y * room.weapon->projectileSpeed };
        p.damage = room.weapon->damage;
        p.ttlMs = (room.weapon->range / room.weapon->projectileSpeed) * 1000 + 500;
        game.projectiles.push_back(std::move(p));
        events.push_back(CombatEvent::fire(rt.shipId, target->shipId, pid));
      }
    }
  }

  // 3b. Mining pass — extract into ship cargo while in range.
  for (auto& [fid, fleet] : game.fleets) {
    if (fleet.status == FleetStatus::destroyed || fleet.order.kind != OrderKind::mine) continue;
    auto lit = game.resourceLocations.find(fleet.order.locationId.value_or(""));
    if (lit == game.resourceLocations.end()) continue;
    ResourceLocation& loc = lit->second;
    ResourceDeposit* deposit = pickDeposit(loc, fleet.order.depositIndex);
    if (!deposit || deposit->reserves <= 0) continue;
    for (auto& id : fleet.shipIds) {
      auto sit = game.ships.find(id); auto rit = game.shipRuntime.find(id);
      if (sit == game.ships.end() || rit == game.shipRuntime.end() || !rit->second.alive) continue;
      ShipState& ship = sit->second; ShipRuntime& rt = rit->second;
      if (ship.derived.miningPower <= 0) continue;
      if (std::find(ship.derived.miningResources.begin(), ship.derived.miningResources.end(),
                    deposit->resource) == ship.derived.miningResources.end()) continue;
      if (dist(rt.position, loc.position) > cfg::RESOURCE.mineRange) continue;
      double free = ship.derived.cargo - bagTotal(ship.cargo);
      if (free <= 0) continue;
      double rate = ship.derived.miningPower * deposit->richness * deposit->accessibility * dt;
      double moved = std::max(0.0, std::min({ rate, free, deposit->reserves }));
      if (moved <= 0) continue;
      addToBag(ship.cargo, resourceKey(deposit->resource), moved);
      deposit->reserves -= moved;
      rt.miningLocationId = loc.id;                  // draws a mining beam client-side
    }
  }

  // 3c. Unloading pass — stream cargo into an owned planet while in range.
  for (auto& [fid, fleet] : game.fleets) {
    if (fleet.status == FleetStatus::destroyed || fleet.order.kind != OrderKind::unloadAt) continue;
    auto pit = game.planets.find(fleet.order.planetId.value_or(""));
    if (pit == game.planets.end() || pit->second.ownerId != std::optional<std::string>(fleet.ownerId)) continue;
    PlanetState& planet = pit->second;
    double budget = cfg::RESOURCE.transferPerSec * dt;
    for (auto& id : fleet.shipIds) {
      auto sit = game.ships.find(id); auto rit = game.shipRuntime.find(id);
      if (sit == game.ships.end() || rit == game.shipRuntime.end() || !rit->second.alive) continue;
      ShipState& ship = sit->second; ShipRuntime& rt = rit->second;
      if (dist(rt.position, planet.position) > cfg::RESOURCE.transferRange) continue;
      if (bagTotal(ship.cargo) <= 0) continue;
      double moved = transfer(ship.cargo, planet.storedResources, "metal", budget)
                   + transfer(ship.cargo, planet.storedResources, "fuel",  budget);
      if (moved > 0) rt.unloadLocationId = planet.id;
    }
  }

  // 4. Projectiles: home toward target, sweep-collide, apply damage.
  std::vector<WorldProjectile> surviving;
  for (auto& p : game.projectiles) {
    auto tit = game.shipRuntime.find(p.targetShipId);
    p.ttlMs -= dtMs;
    if (tit == game.shipRuntime.end() || !tit->second.alive || p.ttlMs <= 0) continue;
    ShipRuntime& tgt = tit->second;
    Vec2 dir = norm(tgt.position - p.position);
    double spd = std::hypot(p.velocity.x, p.velocity.y);
    p.velocity = { dir.x * spd, dir.y * spd };
    double px = p.position.x, py = p.position.y;
    p.position.x += p.velocity.x * dt; p.position.y += p.velocity.y * dt;
    if (segmentPointDistance(px, py, p.position.x, p.position.y, tgt.position) <= HIT_RADIUS) {
      auto tsit = game.ships.find(tgt.shipId);
      if (tsit != game.ships.end()) {
        applyDamage(tgt, tsit->second, p.damage, (uint32_t)rng.int_(1 << 20), events);
        auto tf = game.fleets.find(tgt.fleetId);
        if (tf != game.fleets.end()) tf->second.underAttackUntil = nowMs + UNDER_ATTACK_MS;
      }
      continue;                                       // consumed on hit
    }
    surviving.push_back(std::move(p));
  }
  game.projectiles = std::move(surviving);

  // 4b. Salvage: ships with free cargo recover nearby debris; debris decays.
  std::vector<DebrisState> survivingDebris;
  for (auto& d : game.debris) {
    d.ttlMs -= dtMs;
    if (d.ttlMs <= 0 || bagTotal(d.cargo) <= 0.5) continue;
    for (auto& [id, rt] : game.shipRuntime) {
      if (!rt.alive) continue;
      auto sit = game.ships.find(rt.shipId); if (sit == game.ships.end()) continue;
      ShipState& ship = sit->second;
      double free = ship.derived.cargo - bagTotal(ship.cargo);
      if (free <= 0) continue;
      if (dist(rt.position, d.position) > cfg::SALVAGE.range) continue;
      double capacityLeft = free;
      for (auto& res : RESOURCE_TYPES()) {
        if (!d.cargo.count(res)) continue;
        double moved = transfer(d.cargo, ship.cargo, res, cfg::SALVAGE.recoverPerSec * dt, capacityLeft);
        capacityLeft -= moved;
      }
    }
    if (bagTotal(d.cargo) > 0.5) survivingDebris.push_back(std::move(d));
  }
  game.debris = std::move(survivingDebris);

  // 5. Cull dead ships; every wreck drops salvage (scrap + surviving-cargo fraction).
  std::vector<std::string> destroyedShipIds;
  for (auto it = game.shipRuntime.begin(); it != game.shipRuntime.end(); ) {
    ShipRuntime& rt = it->second;
    auto sit = game.ships.find(it->first);
    bool aliveShip = rt.alive && sit != game.ships.end() && sit->second.hull.hp > 0;
    if (aliveShip) { ++it; continue; }
    if (sit != game.ships.end()) {
      ShipState& ship = sit->second;
      ResourceBag cargo;
      for (auto& res : RESOURCE_TYPES()) {
        double amt = (ship.cargo.count(res) ? ship.cargo[res] : 0.0) * cfg::SALVAGE.survivalFraction;
        if (amt > 0) cargo[res] = amt;
      }
      double scrap = cfg::SALVAGE.scrapPerCell * ship.hull.width * ship.hull.height;
      cargo["metal"] = (cargo.count("metal") ? cargo["metal"] : 0.0) + scrap;
      DebrisState dz{}; dz.id = makeId("debris", game.idCounter);
      dz.position = rt.position; dz.cargo = std::move(cargo); dz.ttlMs = cfg::SALVAGE.ttlMs;
      game.debris.push_back(std::move(dz));
    }
    std::string id = it->first;
    std::string fleetId = rt.fleetId; std::string ownerId;
    if (sit != game.ships.end()) ownerId = sit->second.ownerId;
    it = game.shipRuntime.erase(it);
    if (sit != game.ships.end()) {
      auto pit = game.players.find(ownerId);
      if (pit != game.players.end()) {
        auto& v = pit->second.shipIds;
        v.erase(std::remove(v.begin(), v.end(), id), v.end());
      }
      game.ships.erase(sit);
    }
    auto fit = game.fleets.find(fleetId);
    if (fit != game.fleets.end()) {
      auto& v = fit->second.shipIds;
      v.erase(std::remove(v.begin(), v.end(), id), v.end());
    }
    destroyedShipIds.push_back(id);
  }

  game.rngState = rng.state;                          // persist advanced RNG
  return { std::move(destroyedShipIds) };
}
```

> `makeId("proj"/"debris", game.idCounter)` replaces TS's module-static
> `projCounter` base-36 wrap. Threading `game.idCounter` keeps ids deterministic
> and unique across steps (the TS wrap-at-`0xffffff` was a collision risk we drop).
> `resourceKey(ResourceType)` → `"metal"`/`"fuel"` (step 005). The two erase-
> during-iteration loops (phase 1 cleanup, phase 5 cull) use the
> `it = map.erase(it)` idiom — required in C++ (unlike TS `Map.delete`).

## 6. Done when

- `combat.cpp`, `fleet.cpp`, `world_sim.cpp` compile and link into `server`.
- **Determinism test:** seed a `GameState` (two small fleets in sensor range),
  run N `stepWorld` steps twice from the same `rngState` + identical setup;
  assert identical `rngState`, ship positions/shields/hull, projectile count, and
  `destroyedShipIds` after each step. Byte-identical within one build.
- **Combat parity test:** a fixed two-ship duel (seeded) reaches
  `shipDestroyed` at the same step index and with the same intermediate
  `hit`/`roomDisabled` event stream as TS `worldSim.test.ts` / `combat` tests.
- **Formation test:** `computeFormationOffsets` for each `Formation` value yields
  the same offset map (per-ship, after re-centring + role ordering) as
  `fleet.test.ts`.
- **applyDamage test:** shield-first → room → hull-overflow → destroy sequence
  and emitted events match TS given the same `pickIndex`.
- `stepWorld` returns `destroyedShipIds` and clears `game.combatEvents` at the
  top of each step (caller drains events after).

## 7. Unresolved questions

- `unordered_map` iteration order ≠ TS `Map` insertion order. Safe where the
  fold is commutative (avoidance sum) or strict-min (targeting); the only
  exact-tie divergence is two enemies at identical `double` distance (≈never).
  Accept, or switch sim maps to an insertion-ordered container for strict TS
  parity? Default: accept (single-server determinism holds regardless).
- Projectiles home onto the target every step (TS re-aims velocity toward target
  each tick) — perfect tracking, no lead. Keep as-is (it's the current design).
- `makeId` id scheme diverges from TS strings; fine since ids are opaque per run.
- `applyDamage` recomputes `computeDerived` on every room loss — O(rooms) per
  hit. Fine at prototype scale; revisit if profiling flags it.
- `heading` when parked (zero velocity, no target, not mining): retains last
  heading (TS falls through). Confirm that's intended for the client visuals.
- Fleet-brain here is the trimmed `worldSim.ts` version (intent + flee-home).
  The richer contact-report/consensus brain (fleet.ts §19/020, `ContactReport`)
  is not wired into `stepWorld` today — port later or leave dormant? Default: mirror current wiring (dormant).
```
