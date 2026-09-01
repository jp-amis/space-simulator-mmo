// Authoritative game engine (DESIGN §3, §5, §11; continuous combat plan 015).
// Decoupled from the network layer via an injected `emit` so it can be driven
// headlessly in tests. Combat is continuous: hostile fleets in sensor range are
// promoted into active clusters and simulated per-ship (see @space/simulation).

import { ACTIVE_DT_MS, COMBAT, RESOURCE, SHIP_BUILD_MS, SHIP_COST, STATION } from "@space/config";
import type { ClientMessage, DoctrinePreset, FormationShape, ServerMessage, ShipDoctrine } from "@space/protocol";
import {
  DOCTRINE_PRESETS,
  MinHeap,
  bagTotal,
  computeDerived,
  dist,
  fleetCentroid,
  instantiateShip,
  isValidBlueprint,
  makeId,
  materializePlanetResources,
  roomsFromBlueprint,
  startOperation,
  stepOperations,
  stepStations,
  stepWorld,
  sub,
  transfer,
  type FleetOrder,
  type FleetState,
  type GameState,
  type PlayerState,
  type ScheduledEvent,
  type ShipBlueprint,
  type Vec2,
} from "@space/simulation";
import {
  createFleet,
  createGameState,
  createShipFor,
  getOrCreatePlayer,
  seedNpcPlayers,
} from "./world.js";
import { buildSensedShips, getVisibleState } from "./snapshot.js";

export type Emit = (playerId: string, msg: ServerMessage) => void;

export class GameServer {
  readonly game: GameState;
  private scheduler = new MinHeap<ScheduledEvent>((e) => e.atMs);
  private connected = new Set<string>();
  private dirty = true;
  private lastTickMs: number;
  private accumulatorMs = 0;
  private snapshotAccumMs = 0;
  private hostileCounter = 0;

  counters = { activeFleets: 0, activeShips: 0, projectiles: 0 };

  constructor(
    private emit: Emit,
    private nowFn: () => number = () => Date.now(),
    opts: { seedNpcs?: boolean } = {},
  ) {
    this.game = createGameState(this.nowFn());
    this.lastTickMs = this.nowFn();
    if (opts.seedNpcs !== false) seedNpcPlayers(this.game, this.nowFn());
  }

  now(): number {
    return this.nowFn();
  }
  isConnected(playerId: string): boolean {
    return this.connected.has(playerId);
  }

  connect(playerId: string): { ok: true } | { ok: false; reason: string } {
    const id = playerId.trim().slice(0, 24);
    if (!id) return { ok: false, reason: "empty player id" };
    if (this.connected.has(id)) return { ok: false, reason: "player id already connected" };
    const now = this.nowFn();
    getOrCreatePlayer(this.game, id, now);
    this.connected.add(id);
    this.emit(id, { type: "welcome", playerId: id, serverTimeMs: now });
    this.emit(id, { type: "snapshot", world: getVisibleState(this.game, id, now) });
    return { ok: true };
  }

  disconnect(playerId: string): void {
    this.connected.delete(playerId);
  }

  // ---- Command routing ----
  handle(playerId: string, msg: ClientMessage): void {
    switch (msg.type) {
      case "hello":
        return;
      case "moveFleet":
        return this.orderMove(playerId, msg.requestId, msg.fleetId, { kind: "moveTo", target: msg.target });
      case "attackMove":
        return this.orderMove(playerId, msg.requestId, msg.fleetId, { kind: "attackMove", target: msg.target });
      case "holdFleet":
        return this.orderHold(playerId, msg.requestId, msg.fleetId);
      case "pursueFleet":
        return this.orderTargetFleet(playerId, msg.requestId, msg.fleetId, { kind: "pursue", fleetId: msg.targetFleetId });
      case "followFleet":
        return this.orderTargetFleet(playerId, msg.requestId, msg.fleetId, {
          kind: msg.escort ? "escort" : "follow",
          fleetId: msg.targetFleetId,
          distance: msg.distance,
        });
      case "createFleet":
        return this.handleCreateFleet(playerId, msg.requestId, msg.shipIds);
      case "addShipsToFleet":
        return this.handleAddShipsToFleet(playerId, msg.requestId, msg.fleetId, msg.shipIds);
      case "updateShipBlueprint":
        return this.handleUpdateBlueprint(playerId, msg.requestId, msg.shipId, msg.blueprint);
      case "buildShip":
        return this.handleBuildShip(playerId, msg.requestId, msg.planetId, msg.blueprint, msg.name);
      case "setDoctrine":
        return this.handleSetDoctrine(playerId, msg.requestId, msg.fleetId, msg.preset);
      case "setShipDoctrine":
        return this.handleSetShipDoctrine(playerId, msg.requestId, msg.shipId, msg.doctrine);
      case "setFormation":
        return this.handleSetFormation(playerId, msg.requestId, msg.fleetId, msg.formation);
      case "mineResource":
        return this.handleMine(playerId, msg.requestId, msg.fleetId, msg.locationId, msg.depositIndex);
      case "unloadCargo":
        return this.handleUnloadCargo(playerId, msg.requestId, msg.fleetId, msg.planetId);
      case "salvageWreck":
        return this.handleSalvageWreck(playerId, msg.requestId, msg.fleetId, msg.debrisId);
      case "transferCargo":
        return this.handleTransferCargo(playerId, msg.requestId, msg.fromShipId, msg.toShipId);
      case "createOperation":
        return this.handleCreateOperation(playerId, msg.requestId, msg.fleetId, msg.locationId, msg.deliveryPlanetId);
      case "cancelOperation":
        return this.handleCancelOperation(playerId, msg.requestId, msg.operationId);
      case "pauseOperation":
        return this.handlePauseOperation(playerId, msg.requestId, msg.operationId, msg.paused);
      case "buildStation":
        return this.handleBuildStation(playerId, msg.requestId, msg.locationId, msg.planetId);
      case "spawnHostile":
        return this.handleSpawnHostile(playerId, msg.requestId, msg.near);
    }
  }

  private reject(playerId: string, requestId: string | undefined, reason: string): void {
    this.emit(playerId, { type: "reject", ...(requestId ? { requestId } : {}), reason });
  }
  private ack(playerId: string, requestId: string): void {
    this.emit(playerId, { type: "ack", requestId });
  }

  private ownFleet(playerId: string, fleetId: string, requestId: string): FleetState | undefined {
    const fleet = this.game.fleets.get(fleetId);
    if (!fleet || fleet.ownerId !== playerId) {
      this.reject(playerId, requestId, "not your fleet");
      return undefined;
    }
    return fleet;
  }

  private orderMove(playerId: string, requestId: string, fleetId: string, order: FleetOrder & { target: Vec2 }): void {
    const fleet = this.ownFleet(playerId, fleetId, requestId);
    if (!fleet) return;
    // The anchor is a static goal: jump it to the clicked point; ships fly there.
    fleet.order = order;
    fleet.position = { ...order.target };
    fleet.status = "moving";
    this.dirty = true;
    this.ack(playerId, requestId);
  }

  private orderHold(playerId: string, requestId: string, fleetId: string): void {
    const fleet = this.ownFleet(playerId, fleetId, requestId);
    if (!fleet) return;
    // Hold at the fleet's current location (its ships' centroid).
    const here = fleetCentroid(this.game, fleet);
    fleet.position = { ...here };
    fleet.order = { kind: "hold", anchor: { ...here } };
    fleet.status = "idle";
    this.dirty = true;
    this.ack(playerId, requestId);
  }

  private orderTargetFleet(playerId: string, requestId: string, fleetId: string, order: FleetOrder): void {
    const fleet = this.ownFleet(playerId, fleetId, requestId);
    if (!fleet) return;
    fleet.order = order;
    this.dirty = true;
    this.ack(playerId, requestId);
  }

  private handleCreateFleet(playerId: string, requestId: string, shipIds: string[]): void {
    const player = this.game.players.get(playerId);
    if (!player) return this.reject(playerId, requestId, "no player");
    const owned = shipIds.filter((id) => this.game.ships.get(id)?.ownerId === playerId);
    if (owned.length === 0) return this.reject(playerId, requestId, "no owned ships");
    for (const f of this.game.fleets.values()) {
      if (f.status === "engaging") continue;
      f.shipIds = f.shipIds.filter((id) => !owned.includes(id));
    }
    const fleet = createFleet(this.game, player, owned, this.nowFn());
    fleet.position = this.homePos(playerId);
    this.removeEmptyFleets(player);
    this.dirty = true;
    this.ack(playerId, requestId);
  }

  private handleAddShipsToFleet(playerId: string, requestId: string, fleetId: string, shipIds: string[]): void {
    const player = this.game.players.get(playerId);
    if (!player) return this.reject(playerId, requestId, "no player");
    const target = this.game.fleets.get(fleetId);
    if (!target || target.ownerId !== playerId) return this.reject(playerId, requestId, "not your fleet");
    if (target.status === "engaging") return this.reject(playerId, requestId, "fleet engaging");
    const owned = shipIds.filter(
      (id) => this.game.ships.get(id)?.ownerId === playerId && !target.shipIds.includes(id),
    );
    if (owned.length === 0) return this.reject(playerId, requestId, "no owned ships to add");
    for (const f of this.game.fleets.values()) {
      if (f.id === target.id || f.status === "engaging") continue;
      f.shipIds = f.shipIds.filter((id) => !owned.includes(id));
    }
    target.shipIds.push(...owned);
    this.removeEmptyFleets(player);
    this.dirty = true;
    this.ack(playerId, requestId);
  }

  /** Remove destroyed ships and empty/destroyed fleets from the world (plans: #5,#6,#7). */
  private pruneWorld(): void {
    for (const [id, ship] of this.game.ships) {
      if (ship.hull.hp > 0) continue;
      const player = this.game.players.get(ship.ownerId);
      if (player) player.shipIds = player.shipIds.filter((s) => s !== id);
      for (const f of this.game.fleets.values()) f.shipIds = f.shipIds.filter((s) => s !== id);
      this.game.ships.delete(id);
    }
    for (const [id, fleet] of this.game.fleets) {
      if (fleet.shipIds.length > 0 && fleet.status !== "destroyed") continue;
      const player = this.game.players.get(fleet.ownerId);
      if (player) player.fleetIds = player.fleetIds.filter((f) => f !== id);
      this.game.fleets.delete(id);
    }
  }

  private removeEmptyFleets(player: PlayerState): void {
    for (const id of [...player.fleetIds]) {
      const fleet = this.game.fleets.get(id);
      if (!fleet || fleet.status === "engaging") continue;
      if (fleet.shipIds.length === 0) {
        this.game.fleets.delete(id);
        player.fleetIds = player.fleetIds.filter((f) => f !== id);
      }
    }
  }

  private handleUpdateBlueprint(playerId: string, requestId: string, shipId: string, blueprint: ShipBlueprint): void {
    const ship = this.game.ships.get(shipId);
    if (!ship || ship.ownerId !== playerId) return this.reject(playerId, requestId, "not your ship");
    if (!isValidBlueprint(blueprint)) return this.reject(playerId, requestId, "invalid blueprint");
    ship.blueprint = blueprint;
    ship.rooms = roomsFromBlueprint(blueprint);
    ship.hull.maxHp = COMBAT.hullBaseHp + blueprint.width * blueprint.height * 4;
    ship.hull.hp = ship.hull.maxHp;
    ship.derived = computeDerived(ship.rooms);
    this.dirty = true;
    this.ack(playerId, requestId);
  }

  private handleBuildShip(playerId: string, requestId: string, planetId: string, blueprint: ShipBlueprint, name: string): void {
    const planet = this.game.planets.get(planetId);
    if (!planet || planet.ownerId !== playerId) return this.reject(playerId, requestId, "not your planet");
    if (!isValidBlueprint(blueprint)) return this.reject(playerId, requestId, "invalid blueprint");
    const now = this.nowFn();
    materializePlanetResources(planet, now);
    if (planet.storedResources.metal < SHIP_COST.metal || planet.storedResources.fuel < SHIP_COST.fuel) {
      return this.reject(playerId, requestId, "insufficient resources");
    }
    planet.storedResources.metal -= SHIP_COST.metal;
    planet.storedResources.fuel -= SHIP_COST.fuel;
    const jobId = makeId("job");
    const finishAtMs = now + SHIP_BUILD_MS;
    planet.constructionQueue.push({ id: jobId, kind: "ship", startedAtMs: now, finishAtMs, blueprint, name });
    this.scheduler.push({ atMs: finishAtMs, type: "construction-complete", planetId, jobId });
    this.dirty = true;
    this.ack(playerId, requestId);
  }

  private handleSetDoctrine(playerId: string, requestId: string, fleetId: string, preset: DoctrinePreset): void {
    const fleet = this.ownFleet(playerId, fleetId, requestId);
    if (!fleet) return;
    fleet.doctrine = { ...DOCTRINE_PRESETS[preset] };
    this.dirty = true;
    this.ack(playerId, requestId);
  }

  private handleBuildStation(playerId: string, requestId: string, locationId: string, planetId: string): void {
    const loc = this.game.resourceLocations.get(locationId);
    if (!loc) return this.reject(playerId, requestId, "no such resource location");
    const planet = this.game.planets.get(planetId);
    if (!planet || planet.ownerId !== playerId) return this.reject(playerId, requestId, "not your planet");
    materializePlanetResources(planet, this.nowFn());
    if ((planet.storedResources.metal ?? 0) < STATION.cost.metal! || (planet.storedResources.fuel ?? 0) < STATION.cost.fuel!) {
      return this.reject(playerId, requestId, "insufficient resources");
    }
    // One station per location.
    for (const st of this.game.stations.values()) {
      if (st.locationId === locationId) return this.reject(playerId, requestId, "location already has a station");
    }
    planet.storedResources.metal -= STATION.cost.metal!;
    planet.storedResources.fuel -= STATION.cost.fuel!;
    const id = makeId("station");
    this.game.stations.set(id, {
      id,
      ownerId: playerId,
      name: `${loc.name} Station`,
      position: { ...loc.position },
      locationId,
      storage: {},
      capacity: STATION.capacity,
      extraction: STATION.extraction,
      hp: STATION.hp,
      maxHp: STATION.hp,
    });
    this.dirty = true;
    this.ack(playerId, requestId);
  }

  private handleCreateOperation(playerId: string, requestId: string, fleetId: string, locationId: string, deliveryPlanetId: string): void {
    const fleet = this.ownFleet(playerId, fleetId, requestId);
    if (!fleet) return;
    if (!this.game.resourceLocations.get(locationId)) return this.reject(playerId, requestId, "no such resource location");
    const planet = this.game.planets.get(deliveryPlanetId);
    if (!planet || planet.ownerId !== playerId) return this.reject(playerId, requestId, "not your planet");
    // One operation per fleet — replace any existing.
    for (const [id, op] of this.game.operations) if (op.fleetId === fleetId) this.game.operations.delete(id);
    startOperation(this.game, { id: makeId("op"), ownerId: playerId, fleetId, locationId, deliveryPlanetId });
    this.dirty = true;
    this.ack(playerId, requestId);
  }

  private handleCancelOperation(playerId: string, requestId: string, operationId: string): void {
    const op = this.game.operations.get(operationId);
    if (!op || op.ownerId !== playerId) return this.reject(playerId, requestId, "not your operation");
    this.game.operations.delete(operationId);
    this.dirty = true;
    this.ack(playerId, requestId);
  }

  private handlePauseOperation(playerId: string, requestId: string, operationId: string, paused: boolean): void {
    const op = this.game.operations.get(operationId);
    if (!op || op.ownerId !== playerId) return this.reject(playerId, requestId, "not your operation");
    op.paused = paused;
    this.dirty = true;
    this.ack(playerId, requestId);
  }

  private handleMine(playerId: string, requestId: string, fleetId: string, locationId: string, depositIndex?: number): void {
    const fleet = this.ownFleet(playerId, fleetId, requestId);
    if (!fleet) return;
    const loc = this.game.resourceLocations.get(locationId);
    if (!loc) return this.reject(playerId, requestId, "no such resource location");
    fleet.order = { kind: "mine", locationId, ...(depositIndex !== undefined ? { depositIndex } : {}) };
    fleet.position = { ...loc.position }; // fly the fleet to the deposit and hold there
    fleet.status = "moving";
    this.dirty = true;
    this.ack(playerId, requestId);
  }

  private handleSalvageWreck(playerId: string, requestId: string, fleetId: string, debrisId: string): void {
    const fleet = this.ownFleet(playerId, fleetId, requestId);
    if (!fleet) return;
    const wreck = this.game.debris.find((d) => d.id === debrisId);
    if (!wreck) return this.reject(playerId, requestId, "no such wreck");
    // Fly the fleet to the wreck; the world step's proximity salvage recovers it on arrival.
    fleet.order = { kind: "moveTo", target: { ...wreck.position } };
    fleet.position = { ...wreck.position };
    fleet.status = "moving";
    this.dirty = true;
    this.ack(playerId, requestId);
  }

  private handleUnloadCargo(playerId: string, requestId: string, fleetId: string, planetId: string): void {
    const fleet = this.ownFleet(playerId, fleetId, requestId);
    if (!fleet) return;
    const planet = this.game.planets.get(planetId);
    if (!planet || planet.ownerId !== playerId) return this.reject(playerId, requestId, "not your planet");
    materializePlanetResources(planet, this.nowFn());
    // Fly to the planet and stream cargo over time (the world step's unload pass does the
    // transfer + drives the client beam) — plan 038.
    fleet.order = { kind: "unloadAt", planetId };
    fleet.position = { ...planet.position };
    fleet.status = "moving";
    this.dirty = true;
    this.ack(playerId, requestId);
  }

  private handleTransferCargo(playerId: string, requestId: string, fromShipId: string, toShipId: string): void {
    const from = this.game.ships.get(fromShipId);
    const to = this.game.ships.get(toShipId);
    if (!from || !to || from.ownerId !== playerId || to.ownerId !== playerId) {
      return this.reject(playerId, requestId, "not your ships");
    }
    const rf = this.game.shipRuntime.get(fromShipId);
    const rt = this.game.shipRuntime.get(toShipId);
    if (!rf || !rt || dist(rf.position, rt.position) > RESOURCE.transferRange) {
      return this.reject(playerId, requestId, "ships not in transfer range");
    }
    let capacityLeft = to.derived.cargo - bagTotal(to.cargo);
    for (const res of ["metal", "fuel"] as const) {
      const moved = transfer(from.cargo, to.cargo, res, capacityLeft, capacityLeft);
      capacityLeft -= moved;
    }
    this.dirty = true;
    this.ack(playerId, requestId);
  }

  private handleSetFormation(playerId: string, requestId: string, fleetId: string, formation: FormationShape): void {
    const fleet = this.ownFleet(playerId, fleetId, requestId);
    if (!fleet) return;
    fleet.formation = formation;
    this.dirty = true;
    this.ack(playerId, requestId);
  }

  private handleSetShipDoctrine(playerId: string, requestId: string, shipId: string, doctrine: ShipDoctrine): void {
    const ship = this.game.ships.get(shipId);
    if (!ship || ship.ownerId !== playerId) return this.reject(playerId, requestId, "not your ship");
    ship.doctrine = doctrine;
    this.dirty = true;
    this.ack(playerId, requestId);
  }

  /** Dev/test only: spawn a hostile fleet near a point (plan 023). */
  private handleSpawnHostile(playerId: string, requestId: string, near: Vec2): void {
    const id = `hostile_${++this.hostileCounter}`;
    const player: PlayerState = { id, homePlanetId: "", resources: { metal: 0, fuel: 0 }, fleetIds: [], shipIds: [] };
    this.game.players.set(id, player);
    const s1 = createShipFor(this.game, player, "Raider");
    const s2 = createShipFor(this.game, player, "Marauder");
    const fleet = createFleet(this.game, player, [s1.id, s2.id], this.nowFn());
    fleet.position = { x: near.x, y: near.y };
    fleet.order = { kind: "hold", anchor: { ...near } };
    fleet.doctrine = { ...DOCTRINE_PRESETS.attack_on_sight };
    this.dirty = true;
    this.ack(playerId, requestId);
  }

  private homePos(playerId: string): Vec2 {
    const player = this.game.players.get(playerId);
    const planet = player && this.game.planets.get(player.homePlanetId);
    return planet ? { x: planet.position.x + 160, y: planet.position.y + 160 } : { x: 0, y: 0 };
  }

  /** When an operation's fleet is under attack, send the owner's nearest idle armed fleet
   *  to help (plan 033 — "call military"). */
  private callMilitaryForThreatenedOps(nowMs: number): void {
    for (const op of this.game.operations.values()) {
      const opFleet = this.game.fleets.get(op.fleetId);
      if (!opFleet || nowMs >= (opFleet.underAttackUntil ?? 0)) continue;
      const threat = fleetCentroid(this.game, opFleet);
      // Find the owner's nearest other armed fleet not already responding here.
      let best: FleetState | undefined;
      let bestD = Infinity;
      for (const f of this.game.fleets.values()) {
        if (f.ownerId !== op.ownerId || f.id === op.fleetId) continue;
        if ([...this.game.operations.values()].some((o) => o.fleetId === f.id)) continue; // not another op fleet
        const armed = f.shipIds.some((id) => (this.game.ships.get(id)?.derived.weaponRoomIds.length ?? 0) > 0);
        if (!armed) continue;
        if (f.order.kind === "attackMove") continue; // already advancing
        const c = fleetCentroid(this.game, f);
        const d = Math.hypot(c.x - threat.x, c.y - threat.y);
        if (d < bestD) {
          bestD = d;
          best = f;
        }
      }
      if (best) {
        best.order = { kind: "attackMove", target: { ...threat } };
        best.position = { ...threat };
        best.doctrine = { ...DOCTRINE_PRESETS.attack_on_sight };
        this.dirty = true;
      }
    }
  }

  // ---- Heartbeat ----
  tick(nowMs = this.nowFn()): void {
    this.processScheduledEvents(nowMs);
    this.updateContinuousOrders();

    this.accumulatorMs += nowMs - this.lastTickMs;
    this.lastTickMs = nowMs;
    let stepped = false;
    let anyDestroyed = false;
    while (this.accumulatorMs >= ACTIVE_DT_MS) {
      stepOperations(this.game, ACTIVE_DT_MS, nowMs); // advance automated resource ops
      stepStations(this.game, ACTIVE_DT_MS); // stations auto-extract into storage
      const result = stepWorld(this.game, ACTIVE_DT_MS, nowMs);
      if (result.destroyedShipIds.length) anyDestroyed = true;
      this.accumulatorMs -= ACTIVE_DT_MS;
      stepped = true;
    }

    if (stepped) this.callMilitaryForThreatenedOps(nowMs);
    if (anyDestroyed) this.pruneWorld();
    if (this.updateFleetStatuses()) this.dirty = true;
    if (stepped) this.broadcastActiveRegions(nowMs); // ships always stream to who can see them
    if (anyDestroyed) this.dirty = true;

    this.counters.activeFleets = [...this.game.fleets.values()].filter((f) => f.status !== "idle").length;
    this.counters.activeShips = this.game.shipRuntime.size;
    this.counters.projectiles = this.game.projectiles.length;

    // Full snapshots are structural (throttled); ship motion rides the activeRegion stream.
    this.snapshotAccumMs += ACTIVE_DT_MS;
    if (this.dirty || this.snapshotAccumMs >= 500) {
      this.broadcastSnapshots(nowMs);
      this.dirty = false;
      this.snapshotAccumMs = 0;
    }
  }

  /** Derive each fleet's display status from its ships; returns true if any changed. */
  private updateFleetStatuses(): boolean {
    let changed = false;
    for (const fleet of this.game.fleets.values()) {
      const prev = fleet.status;
      let next: FleetState["status"];
      if (fleet.shipIds.length === 0) next = "destroyed";
      else if (fleet.intent === "engage" || fleet.intent === "flee") next = "engaging";
      else {
        const c = fleetCentroid(this.game, fleet);
        next = Math.hypot(c.x - fleet.position.x, c.y - fleet.position.y) > 30 ? "moving" : "idle";
      }
      if (next !== prev) {
        fleet.status = next;
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Track pursue/follow/escort targets. The anchor is still a STATIC goal — we only
   * re-snap it once the desired point has drifted past `COMBAT.anchorRetargetDist`, so
   * a loitering target doesn't make the anchor jitter every tick. Pursue keeps a standoff
   * distance (default ~engagementRange) so pursuers form a ring instead of overlapping.
   */
  private updateContinuousOrders(): void {
    for (const fleet of this.game.fleets.values()) {
      const o = fleet.order;
      if (o.kind !== "pursue" && o.kind !== "follow" && o.kind !== "escort") continue;
      const target = this.game.fleets.get(o.fleetId);
      if (!target || target.status === "destroyed") continue;
      const tp = fleetCentroid(this.game, target);

      let desired: { x: number; y: number };
      if (o.kind === "pursue") {
        // Stand off from the target along the pursuer→target axis (not on top of it).
        const standoff = o.distance ?? fleet.engagementRange;
        const here = fleetCentroid(this.game, fleet);
        const away = sub(here, tp);
        const d = Math.hypot(away.x, away.y) || 1;
        desired = { x: tp.x + (away.x / d) * standoff, y: tp.y + (away.y / d) * standoff };
      } else {
        const here = fleetCentroid(this.game, fleet);
        const away = sub(here, tp);
        const d = Math.hypot(away.x, away.y) || 1;
        desired = { x: tp.x + (away.x / d) * o.distance, y: tp.y + (away.y / d) * o.distance };
      }

      if (Math.hypot(desired.x - fleet.position.x, desired.y - fleet.position.y) > COMBAT.anchorRetargetDist) {
        fleet.position = desired;
      }
    }
  }

  private processScheduledEvents(nowMs: number): void {
    for (const ev of this.scheduler.popDue(nowMs)) {
      switch (ev.type) {
        case "construction-complete":
          this.completeConstruction(ev.planetId, ev.jobId);
          break;
        case "scan-refresh":
          break;
      }
    }
  }

  private completeConstruction(planetId: string, jobId: string): void {
    const planet = this.game.planets.get(planetId);
    if (!planet || !planet.ownerId) return;
    const idx = planet.constructionQueue.findIndex((j) => j.id === jobId);
    if (idx < 0) return;
    const job = planet.constructionQueue[idx]!;
    planet.constructionQueue.splice(idx, 1);
    const player = this.game.players.get(planet.ownerId);
    if (!player) return;
    const ship = instantiateShip(player.id, job.name, job.blueprint);
    this.game.ships.set(ship.id, ship);
    player.shipIds.push(ship.id);
    this.dirty = true;
  }

  private broadcastActiveRegions(nowMs: number): void {
    for (const pid of this.connected) {
      const delta = buildSensedShips(this.game, pid, nowMs);
      if (delta.ships.length > 0 || delta.projectiles.length > 0 || delta.events.length > 0) {
        this.emit(pid, { type: "activeRegion", delta });
      }
    }
  }

  private broadcastSnapshots(nowMs: number): void {
    for (const pid of this.connected) {
      this.emit(pid, { type: "snapshot", world: getVisibleState(this.game, pid, nowMs) });
    }
  }

  snapshotFor(playerId: string): ReturnType<typeof getVisibleState> {
    return getVisibleState(this.game, playerId, this.nowFn());
  }
}
