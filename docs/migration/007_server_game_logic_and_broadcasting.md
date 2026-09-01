# Step 007 — Server game logic & broadcasting

Goal: port `engine.ts` (the `GameServer` command handlers + `tick()` sequence),
`world.ts` (player registry / starter setup / NPC seeding), and `snapshot.ts`
(the per-player visibility filter) to C++, and wire them to the step-003 encoders
and the step-004 outbound `NetQueue`. End state: a connected peer that sends
commands sees acks/rejects on CONTROL, structural `S_SNAPSHOT`s throttled to
~500 ms, and a high-rate `S_ACTIVE_REGION` stream of every ship it can sense.

This is where the authoritative game becomes *observable and controllable* over
the wire. The pure simulation (`stepWorld`/`combat`/`fleet`/`operations`) is
steps 005–006; this step is the glue: dispatch, mutate, filter, encode, address.

Prereqs: 002–006. Reference files:

- `apps/server/src/engine.ts` — `GameServer`: `handle()` dispatch, every command handler, `tick()`, broadcasts.
- `apps/server/src/world.ts` — `createGameState`, `getOrCreatePlayer`, `createShipFor`, `createFleet`, `seedNpcPlayers`.
- `apps/server/src/snapshot.ts` — `sensorSources`, `canSensePoint`, `getVisibleState`, `buildSensedShips`.
- `shared/net_shared.h` (step 003) — `MsgType`, `Channel`, encoders/decoders, `PROTOCOL_VERSION`.
- `shared/sim_types.h` / `game_state.h` (step 002) — `ss::GameState`, `ss::FleetState`, `ss::ShipState`, `ss::PlayerState`, `ss::Vec2`.
- `shared/game_config.h` (step 002) — `ss::cfg::{HEARTBEAT_MS, ACTIVE_DT_MS, SNAPSHOT_MS, STARTING_RESOURCES, SHIP_COST, STATION, ...}`.
- Step 004 — `sim_send`, `s_conn_to_player` / `s_player_to_conn`, `now_ms()`.
- tower-d `sim/sim.cpp` (`on_message` dispatch shape), `sim/world.cpp` (`world_snapshot` encode + `sim_send`).

---

## 1. The tick sequence — `server_tick`

Direct port of `GameServer.tick()` (`engine.ts:486-520`). Fixed-timestep
accumulator identical to today; the outer 20 Hz gate lives in `sim_update`
(step 004 §5), so `server_tick` receives `now` and does the inner work.

```cpp
// server/src/sim/sim.cpp
namespace {
  double s_last_tick_ms   = 0;   // engine.ts lastTickMs
  double s_accumulator_ms = 0;   // engine.ts accumulatorMs
  double s_snapshot_accum = 0;   // engine.ts snapshotAccumMs
  bool   s_dirty          = true;// engine.ts dirty (structural change → force snapshot)
  MinHeap<ScheduledEvent> s_scheduler;  // engine.ts scheduler (step 006 has ScheduledEvent)
}

void game::server_tick(ss::GameState& g, double now) {
  process_scheduled_events(g, now);      // construction-complete etc. (engine.ts:577)
  update_continuous_orders(g);           // pursue/follow/escort anchor tracking (engine.ts:548)

  s_accumulator_ms += now - s_last_tick_ms;
  s_last_tick_ms = now;
  bool stepped = false, any_destroyed = false;
  while (s_accumulator_ms >= ss::cfg::ACTIVE_DT_MS) {
    step_operations(g, ss::cfg::ACTIVE_DT_MS, now);  // step 006
    step_stations  (g, ss::cfg::ACTIVE_DT_MS);       // step 006
    StepResult r = step_world(g, ss::cfg::ACTIVE_DT_MS, now);  // step 006 (kinematics+combat)
    if (!r.destroyed_ship_ids.empty()) any_destroyed = true;
    s_accumulator_ms -= ss::cfg::ACTIVE_DT_MS;
    stepped = true;
  }

  if (stepped)       call_military_for_threatened_ops(g, now);  // engine.ts:455
  if (any_destroyed) prune_world(g);                            // engine.ts:228
  if (update_fleet_statuses(g)) s_dirty = true;                 // engine.ts:523
  if (stepped)       broadcast_active_regions(g, now);          // §5 — always stream
  if (any_destroyed) s_dirty = true;

  s_snapshot_accum += ss::cfg::ACTIVE_DT_MS;
  if (s_dirty || s_snapshot_accum >= ss::cfg::SNAPSHOT_MS) {    // ~500 ms throttle
    broadcast_snapshots(g, now);                                // §5
    s_dirty = false;
    s_snapshot_accum = 0;
  }
}
```

Rules preserved from the TS exactly:

- **`broadcastActiveRegions` runs every physics step** (ships always stream to
  whoever can see them). Unreliable, cheap, loss-tolerant → `Channel::STREAM`.
- **`broadcastSnapshots` is throttled**: sent when `s_dirty` (a command or a
  destruction changed structural state) *or* every `SNAPSHOT_MS`. Reliable →
  `Channel::CONTROL`.
- `update_fleet_statuses`, `update_continuous_orders`,
  `call_military_for_threatened_ops`, `prune_world` port field-for-field from
  `engine.ts` (they are pure `GameState` mutations, no I/O — mechanical).
- `s_dirty` is set by every command handler that mutates structural state
  (below), matching each `this.dirty = true` in the TS.

## 2. Command dispatch — `on_message`

Port of `GameServer.handle()` (`engine.ts:91-142`), shaped like tower-d's
`on_message` switch (`sim/sim.cpp:82-113`). First peek the `MsgType` byte
(step 003 §2, §9); enforce the handshake gate; decode with the step-003
decoder; **check `is.error` before mutating**; dispatch.

```cpp
void on_message(const server::NetEnvelope& env, const uint8_t* data) {
  net::InputStream in = net::input_stream_create(data, env.length);
  auto type = static_cast<MsgType>(net::input_stream_u8(&in));

  // C_HELLO is the only message allowed before binding (step 004 §6).
  if (type == MsgType::C_HELLO) { on_hello(env.conn_id, net::is_str(&in)); return; }

  auto pit = s_conn_to_player.find(env.conn_id);
  if (pit == s_conn_to_player.end()) { send_reject(env.conn_id, "", "say hello first"); return; }
  const std::string& player = pit->second;

  switch (type) {
    case MsgType::C_MOVE_FLEET:   { auto c = dec_move_fleet(&in);   if (in.error) return;
        order_move(player, c.requestId, c.fleetId, ss::OrderKind::moveTo, c.target); break; }
    case MsgType::C_ATTACK_MOVE:  { auto c = dec_move_fleet(&in);   if (in.error) return;
        order_move(player, c.requestId, c.fleetId, ss::OrderKind::attackMove, c.target); break; }
    case MsgType::C_HOLD_FLEET:   { auto c = dec_hold_fleet(&in);   if (in.error) return;
        order_hold(player, c.requestId, c.fleetId); break; }
    case MsgType::C_PURSUE_FLEET: { auto c = dec_pursue_fleet(&in); if (in.error) return;
        order_target_fleet(player, c.requestId, c.fleetId, ss::OrderKind::pursue, c.targetFleetId, 0, false); break; }
    case MsgType::C_FOLLOW_FLEET: { auto c = dec_follow_fleet(&in); if (in.error) return;
        order_target_fleet(player, c.requestId, c.fleetId,
            c.escort ? ss::OrderKind::escort : ss::OrderKind::follow, c.targetFleetId, c.distance, c.escort); break; }
    case MsgType::C_SET_DOCTRINE:       { auto c = dec_set_doctrine(&in);       if (in.error) return; handle_set_doctrine(player, c); break; }
    case MsgType::C_SET_SHIP_DOCTRINE:  { auto c = dec_set_ship_doctrine(&in);  if (in.error) return; handle_set_ship_doctrine(player, c); break; }
    case MsgType::C_SET_FORMATION:      { auto c = dec_set_formation(&in);      if (in.error) return; handle_set_formation(player, c); break; }
    case MsgType::C_UPDATE_BLUEPRINT:   { auto c = dec_update_blueprint(&in);   if (in.error) return; handle_update_blueprint(player, c); break; }
    case MsgType::C_BUILD_SHIP:         { auto c = dec_build_ship(&in);         if (in.error) return; handle_build_ship(player, c); break; }
    case MsgType::C_CREATE_FLEET:       { auto c = dec_create_fleet(&in);       if (in.error) return; handle_create_fleet(player, c); break; }
    case MsgType::C_ADD_SHIPS_TO_FLEET: { auto c = dec_add_ships(&in);          if (in.error) return; handle_add_ships(player, c); break; }
    case MsgType::C_MINE_RESOURCE:      { auto c = dec_mine(&in);               if (in.error) return; handle_mine(player, c); break; }
    case MsgType::C_UNLOAD_CARGO:       { auto c = dec_unload(&in);             if (in.error) return; handle_unload_cargo(player, c); break; }
    case MsgType::C_SALVAGE_WRECK:      { auto c = dec_salvage(&in);            if (in.error) return; handle_salvage(player, c); break; }
    case MsgType::C_TRANSFER_CARGO:     { auto c = dec_transfer(&in);           if (in.error) return; handle_transfer(player, c); break; }
    case MsgType::C_CREATE_OPERATION:   { auto c = dec_create_op(&in);          if (in.error) return; handle_create_operation(player, c); break; }
    case MsgType::C_CANCEL_OPERATION:   { auto c = dec_cancel_op(&in);          if (in.error) return; handle_cancel_operation(player, c); break; }
    case MsgType::C_PAUSE_OPERATION:    { auto c = dec_pause_op(&in);           if (in.error) return; handle_pause_operation(player, c); break; }
    case MsgType::C_BUILD_STATION:      { auto c = dec_build_station(&in);      if (in.error) return; handle_build_station(player, c); break; }
    case MsgType::C_SPAWN_HOSTILE:      { auto c = dec_spawn_hostile(&in);      if (in.error) return; handle_spawn_hostile(player, c); break; }
    default: LOG_WARN("[sim] unknown message type %u", (unsigned)type); break;
  }
}
```

### ack / reject (CONTROL replies)

Ports `GameServer.ack`/`reject` (`engine.ts:144-149`). These address the *one*
player who sent the command, via `s_player_to_conn`:

```cpp
void reply_to(const std::string& player, MsgType type,
              const std::function<void(net::OutputStream&)>& body) {
  auto it = s_player_to_conn.find(player);
  if (it == s_player_to_conn.end()) return;           // peer gone; drop
  net::OutputStream os = net::output_stream_create(s_frame_arena);
  net::output_stream_u8(&os, (uint8_t)type);
  body(os);
  game::sim_send(ss::Channel::CONTROL, os, &it->second, 1);   // step 004
  net::output_stream_destroy(&os);
}
void ack(const std::string& p, const std::string& reqId) {
  reply_to(p, MsgType::S_ACK, [&](auto& os){ net::os_str(&os, reqId); });
}
void send_reject(const std::string& p, const std::string& reqId, const std::string& reason) {
  reply_to(p, MsgType::S_REJECT, [&](auto& os){ net::os_str(&os, reqId); net::os_str(&os, reason); });
}
// send_reject(conn, ...) overload exists for pre-hello rejects (step 004 §6).
```

Every handler ends with `ack(player, requestId)` on success or `send_reject(...)`
on failure, and sets `s_dirty = true` on structural mutation — one-to-one with
the TS. `send_reject` addressed by `ConnID` is used only pre-bind; all post-bind
replies address by `playerId`.

## 3. One command end-to-end — `handle_build_ship`

Chosen because it exercises ownership check, resource spend, the scheduler, and a
deferred structural change. Direct port of `engine.ts:268-285` +
`completeConstruction` (`engine.ts:589-602`).

```cpp
// decode (step 003): C_BUILD_SHIP = planetId:str, blueprint:Blueprint, name:str, +requestId
struct BuildShipCmd { std::string requestId, planetId, name; ss::ShipBlueprint blueprint; };

void handle_build_ship(const std::string& player, const BuildShipCmd& c) {
  auto pit = s_game->planets.find(c.planetId);
  if (pit == s_game->planets.end() || pit->second.ownerId != std::optional{player})
    return send_reject(player, c.requestId, "not your planet");
  if (!is_valid_blueprint(c.blueprint))                    // step 005
    return send_reject(player, c.requestId, "invalid blueprint");

  ss::PlanetState& planet = pit->second;
  double now = now_ms();
  materialize_planet_resources(planet, now);               // step 005 (lazy accrual)
  if (planet.storedResources.metal < ss::cfg::SHIP_COST.metal ||
      planet.storedResources.fuel  < ss::cfg::SHIP_COST.fuel)
    return send_reject(player, c.requestId, "insufficient resources");

  planet.storedResources.metal -= ss::cfg::SHIP_COST.metal;
  planet.storedResources.fuel  -= ss::cfg::SHIP_COST.fuel;

  std::string jobId = make_id("job", s_game->idCounter);
  double finishAt = now + ss::cfg::SHIP_BUILD_MS;
  planet.constructionQueue.push_back({ jobId, "ship", now, finishAt, c.blueprint, c.name });
  s_scheduler.push({ finishAt, ScheduledEvent::ConstructionComplete, c.planetId, jobId });

  s_dirty = true;                                          // engine.ts this.dirty = true
  ack(player, c.requestId);
}

// fired by process_scheduled_events when finishAt arrives (engine.ts:589)
void complete_construction(const std::string& planetId, const std::string& jobId) {
  auto pit = s_game->planets.find(planetId);
  if (pit == s_game->planets.end() || !pit->second.ownerId) return;
  auto& q = pit->second.constructionQueue;
  auto jit = std::find_if(q.begin(), q.end(), [&](auto& j){ return j.id == jobId; });
  if (jit == q.end()) return;
  auto job = *jit; q.erase(jit);
  auto plit = s_game->players.find(*pit->second.ownerId);
  if (plit == s_game->players.end()) return;
  ss::ShipState ship = instantiate_ship(plit->first, job.name, job.blueprint);  // step 005
  s_game->ships.emplace(ship.id, ship);
  plit->second.shipIds.push_back(ship.id);
  s_dirty = true;
}
```

The remaining handlers (`order_move`, `order_hold`, `order_target_fleet`,
`handle_create_fleet`, `handle_add_ships`, `handle_update_blueprint`,
`handle_set_doctrine`, `handle_set_ship_doctrine`, `handle_set_formation`,
`handle_mine`, `handle_unload_cargo`, `handle_salvage`, `handle_transfer`,
`handle_create_operation`, `handle_cancel_operation`, `handle_pause_operation`,
`handle_build_station`, `handle_spawn_hostile`) port the same way — each is a
short `GameState` mutation guarded by an ownership/validity check, ending in
`ack`/`send_reject`. The shared `own_fleet(player, fleetId, requestId)` helper
(`engine.ts:151`) returns the fleet or rejects "not your fleet". No new logic;
copy the bodies.

## 4. Player registry — `world.ts` port

Port `world.ts` to `server/src/sim/world.cpp`. `getOrCreatePlayer` is called from
`on_hello` (step 004 §6) and from `seedNpcPlayers`.

```cpp
// world.cpp — getOrCreatePlayer (world.ts:62)
ss::PlayerState& get_or_create_player(ss::GameState& g, const std::string& id, double now) {
  if (auto it = g.players.find(id); it != g.players.end()) return it->second;

  std::string homeId = first_unowned_planet_id(g);        // world.ts:46
  if (homeId.empty()) throw std::runtime_error("no unowned planet for new player");
  ss::PlanetState& home = g.planets.at(homeId);
  make_home_planet(home, id, now);                        // step 005
  // Home stored-resources double as the player's spendable pool (world.ts:71).
  home.storedResources = { ss::cfg::STARTING_RESOURCES.metal,   // 400 metal
                           ss::cfg::STARTING_RESOURCES.fuel };  // 200 fuel

  ss::PlayerState player;
  player.id = id; player.homePlanetId = homeId;
  player.metal = ss::cfg::STARTING_RESOURCES.metal;
  player.fuel  = ss::cfg::STARTING_RESOURCES.fuel;
  auto& p = g.players.emplace(id, std::move(player)).first->second;

  // Two starter ships + a fleet near home (world.ts:83, DESIGN §18).
  auto& s1 = create_ship_for(g, p, "Vanguard");
  auto& s2 = create_ship_for(g, p, "Harrier");
  ss::FleetState& fleet = create_fleet(g, p, { s1.id, s2.id }, now);
  fleet.position = { home.position.x + 160, home.position.y + 160 };
  return p;
}

// seedNpcPlayers (world.ts:139) — called once in sim_init when SEED_NPCS.
void seed_npc_players(ss::GameState& g, double now) {
  for (const char* npc : { "npc-red", "npc-blue" })
    if (!g.players.count(npc)) get_or_create_player(g, npc, now);
}
```

`create_ship_for` (`world.ts:92`), `create_fleet` (`world.ts:100` — fleet defaults
`FLEET.sensorRange`/`engagementRange`, `order = hold @ home`, `formation = line`),
and `create_game_state` (`world.ts:26` — `generatePlanets`/`generateResourceLocations`
from `WORLD_SEED`) port mechanically from steps 005/006. Starter economy is
locked at **400 metal / 200 fuel** (`STARTING_RESOURCES`), **2 ships**, **1
fleet** — do not drift from the TS.

## 5. Visibility filter + broadcasting — `snapshot.ts` port

Port `snapshot.ts` to `server/src/sim/visibility.cpp`. The filter is the security
boundary: **enemy ship internals never enter a snapshot; only own ships are
serialized structurally; enemy fleets are coarse.** The step-003 `enc_fleet(owned)`
/ `enc_ship` shapes make leakage structurally hard, but the filter is what decides
*which* records get encoded at all.

### 5.1 Sensor sources + canSensePoint (`snapshot.ts:88, 105`)

```cpp
struct Sensor { ss::Vec2 p; double r; };

std::vector<Sensor> sensor_sources(const ss::GameState& g, const std::string& player) {
  std::vector<Sensor> s;
  for (auto& [id, pl] : g.planets)
    if (pl.ownerId == std::optional{player})
      s.push_back({ pl.position, ss::cfg::PLANET_SENSOR_RANGE });
  for (auto& [id, f] : g.fleets)
    if (f.ownerId == player)
      s.push_back({ fleet_centroid(g, f), f.sensorRange });   // own fleets sense at centroid
  for (auto& [id, st] : g.stations)
    if (st.ownerId == player)
      s.push_back({ st.position, ss::cfg::STATION.sensorRange });
  return s;
}

bool can_sense_point(const std::vector<Sensor>& src, ss::Vec2 pt) {
  for (auto& s : src) if (ss::dist(s.p, pt) <= s.r) return true;
  return false;
}
```

### 5.2 `S_SNAPSHOT` — structural, per-player (`getVisibleState`, `snapshot.ts:112`)

Build + encode in one pass (no intermediate DTO structs needed; encode straight
to the stream). Layout is step 003 §5.

```cpp
void send_snapshot(server::ConnID conn, const std::string& player, double now) {
  materialize_player_planets(*s_game, player, now);          // snapshot.ts:113
  auto& pl = s_game->players.at(player);
  auto src = sensor_sources(*s_game, player);

  net::OutputStream os = net::output_stream_create(s_frame_arena);
  net::output_stream_u8(&os, (uint8_t)MsgType::S_SNAPSHOT);
  net::os_f64(&os, now);

  // -- you -- (own totals summed from owned planets, snapshot.ts:154)
  double ownMetal = 0, ownFuel = 0;
  for (auto& [id, p] : s_game->planets)
    if (p.ownerId == std::optional{player}) { ownMetal += p.storedResources.metal; ownFuel += p.storedResources.fuel; }
  net::os_str(&os, pl.id); net::os_str(&os, pl.homePlanetId);
  net::os_f64(&os, ownMetal); net::os_f64(&os, ownFuel);
  net::os_str_vec(&os, pl.fleetIds); net::os_str_vec(&os, pl.shipIds);

  // -- planets -- (owned carry queue/rates; others coarse; snapshot.ts:117)
  net::os_u16(&os, (uint16_t)s_game->planets.size());
  for (auto& [id, p] : s_game->planets)
    enc_planet(&os, p, /*owned=*/ p.ownerId == std::optional{player});   // step 003 §5

  // -- resource locations sensed -- (snapshot.ts:162)
  { std::vector<const ss::ResourceLocation*> vis;
    for (auto& [id, loc] : s_game->resourceLocations)
      if (can_sense_point(src, loc.position)) vis.push_back(&loc);
    net::os_u16(&os, (uint16_t)vis.size());
    for (auto* loc : vis) enc_resource_location(&os, *loc); }

  // -- debris sensed / stations owned-or-sensed / operations owned -- (snapshot.ts:190,193,208)
  enc_filtered(&os, s_game->debris,   [&](auto& d){ return can_sense_point(src, d.position); }, enc_debris);
  enc_stations(&os, s_game->stations, player, src);          // owned=full, sensed=coarse
  enc_operations(&os, s_game->operations, player);           // owned only

  // -- fleets -- own = full, enemy sensed = coarse (snapshot.ts:140)
  { std::vector<const ss::FleetState*> vis;
    for (auto& [id, f] : s_game->fleets) {
      if (f.status == ss::FleetStatus::destroyed) continue;
      bool own = f.ownerId == player;
      if (own || can_sense_point(src, fleet_centroid(*s_game, f))) vis.push_back(&f);
    }
    net::os_u16(&os, (uint16_t)vis.size());
    for (auto* f : vis) enc_fleet(&os, *s_game, *f, /*owned=*/ f->ownerId == player); }

  // -- ships -- OWN ONLY, with blueprint+rooms (snapshot.ts:148, step 003 §8)
  net::os_u16(&os, (uint16_t)pl.shipIds.size());
  for (auto& id : pl.shipIds)
    if (auto it = s_game->ships.find(id); it != s_game->ships.end()) enc_ship(&os, it->second);

  game::sim_send(ss::Channel::CONTROL, os, &conn, 1);
  net::output_stream_destroy(&os);
}
```

Key invariants carried from the TS, do not relax:

- **Ships loop is `player.shipIds` only** — enemy `ShipState` is never touched
  here (`snapshot.ts:148-152`). Enemy ship *kinematics* ride the activeRegion
  stream (§5.3), never the structural snapshot.
- Enemy fleets → `enc_fleet(owned=false)` = coarse (id, ownerId, centroid,
  shipCount, status). No doctrine/anchor/shipIds (`enemyFleetDto`, `snapshot.ts:77`).
- Non-owned planets omit stored resources / queue / rates (`enc_planet(owned=false)`).

### 5.3 `S_ACTIVE_REGION` — high-rate stream (`buildSensedShips`, `snapshot.ts:244`)

Every sensed ship — own *or* enemy — streams kinematics + hp + target ids.
Per step 003 §8 the stream carries **no blueprint/rooms** (client caches them from
the snapshot by `shipId`); this diverges intentionally from the current TS, which
still packs blueprint+rooms per ship — that is the whole point of the split.

```cpp
void send_active_region(server::ConnID conn, const std::string& player, double now) {
  auto src = sensor_sources(*s_game, player);
  std::vector<const ss::ShipRuntime*> ships;
  std::unordered_set<std::string> sensed;              // shipIds we can see (for projectile/event gating)

  for (auto& [id, rt] : s_game->shipRuntime) {
    bool mine = rt.ownerId == player;
    if (!mine && !can_sense_point(src, rt.position)) continue;   // fog of war (snapshot.ts:253)
    sensed.insert(rt.shipId);
    ships.push_back(&rt);
  }
  std::vector<const ss::WorldProjectile*> projs;
  for (auto& p : s_game->projectiles)
    if (sensed.count(p.targetShipId) || can_sense_point(src, p.position)) projs.push_back(&p);
  std::vector<const ss::CombatEvent*> evts;
  for (auto& e : s_game->combatEvents)
    if (auto t = combat_event_target(e); t && sensed.count(*t)) evts.push_back(&e);  // snapshot.ts:289

  if (ships.empty() && projs.empty() && evts.empty()) return;    // engine.ts:607 — skip empties

  net::OutputStream os = net::output_stream_create(s_frame_arena);
  net::output_stream_u8(&os, (uint8_t)MsgType::S_ACTIVE_REGION);
  net::os_f64(&os, now);
  net::os_u16(&os, (uint16_t)ships.size());
  for (auto* rt : ships) {
    auto sit = s_game->ships.find(rt->shipId);
    double hp = sit != s_game->ships.end() ? sit->second.hull.hp : 0;
    double maxHp = sit != s_game->ships.end() ? sit->second.hull.maxHp : 1;
    enc_active_ship(&os, *rt, hp, maxHp);              // step 003 §6 (kinematics+hp+target ids)
  }
  net::os_u16(&os, (uint16_t)projs.size()); for (auto* p : projs) enc_projectile(&os, *p);
  net::os_u16(&os, (uint16_t)evts.size());  for (auto* e : evts)  enc_combat_event(&os, *e);

  game::sim_send(ss::Channel::STREAM, os, &conn, 1);   // unreliable
  net::output_stream_destroy(&os);
}
```

### 5.4 Broadcast fan-out (`engine.ts:604-617`)

The broadcasts iterate connected players (`s_conn_to_player`), building a *filtered*
stream per player and addressing it to that player's `ConnID`. Unlike a global
broadcast, every packet is player-specific because the visibility filter differs
per player — so each is a 1-recipient `sim_send`:

```cpp
void broadcast_snapshots(ss::GameState& g, double now) {
  for (auto& [conn, player] : s_conn_to_player) send_snapshot(conn, player, now);
}
void broadcast_active_regions(ss::GameState& g, double now) {
  for (auto& [conn, player] : s_conn_to_player) send_active_region(conn, player, now);
}
```

NPCs (`npc-red`/`npc-blue`) are in `s_game->players` but never in
`s_conn_to_player`, so they are simulated but never sent to — same as the TS
(only `this.connected` gets broadcasts).

### 5.5 Per-frame scratch arena

Each encode uses `s_frame_arena`, a child arena reset at the top of `server_tick`
(000 §3 memory rule) so snapshot/stream encoding never leaks. `output_stream_create`
allocates from it; `output_stream_destroy` returns the block. All of the above runs
on the sim thread; only the finished bytes cross to ENet via `outbound`.

## 6. Done when

- A peer sending each `C_*` command gets an `S_ACK{requestId}` on success or
  `S_REJECT{requestId,reason}` on failure, matching the TS reject strings.
- On `C_HELLO`, `get_or_create_player` assigns a home planet, 400 metal / 200 fuel,
  2 starter ships, and 1 fleet; the immediate `S_SNAPSHOT` reflects them.
- `broadcast_active_regions` fires every physics step; `broadcast_snapshots` fires
  on structural change or every ~500 ms — verified by counting sends.
- **Visibility parity**: a second player sees another player's fleet only as coarse
  data and never receives that player's `ShipState` (blueprint/rooms) in any
  snapshot; enemy ships appear in the activeRegion stream only within sensor range.
- Parity harness (step 012): drive identical command sequences through the TS
  `GameServer` and the C++ sim; assert decoded snapshot/activeRegion fields match
  (positions `f64`-exact, ids equal) for a fixed seed and NPC set.

## 7. Unresolved questions

- current TS activeRegion still ships blueprint+rooms per ship; step 003 §8 drops it — confirm client (step 010) can render enemy LOD purely from cached-by-id blueprints, else enemies have no cached blueprint (never in snapshot) → enemy internals invisible. acceptable? (TS showed them.)
- snapshot is per-player + full every ~500 ms × N players — CPU/bandwidth at scale; delta-encode structural state later? default full for v1.
- `combat_event_target` discriminates hit/fire/roomDisabled/shipDestroyed → target ship (snapshot.ts:290); pin the tag→field mapping against step 003 §6 event codes.
- `dirty` currently forces a *global* snapshot to all; could scope to only players whose visible set changed — defer, keep global.
- NPC fleets never broadcast but do run fleet-brain/combat every step — fine, but confirm no encoder is invoked for a player not in `s_conn_to_player`.
- string ids on the wire per ship every activeRegion frame is heavy at 10 Hz × many ships — revisit interning (step 002 v2) if stream exceeds MTU.
- `own_fleet`/ownership checks compare `ownerId == player`; NPC-owned entities have real ids — ensure spawn-hostile ids (`hostile_N`) can't collide with a real free-text playerId.
