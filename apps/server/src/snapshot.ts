// Per-player visibility filter (DESIGN §10.3, §16 rule 9). Build snapshots through
// getVisibleState(playerId) rather than serializing the whole GameState so enemy
// room layouts, destinations and resources never leak.

import type {
  ActiveRegionDelta,
  ActiveShipDto,
  FleetDto,
  PlanetDto,
  PlayerVisibleSnapshot,
  ProjectileDto,
  RoomDto,
  ShipDto,
} from "@space/protocol";
import type { FleetState, GameState, RoomState, ShipState } from "@space/simulation";
import { PLANET_SENSOR_RANGE, STATION } from "@space/config";
import { dist, fleetCentroid } from "@space/simulation";
import { getFleetPosition, materializePlayerPlanets } from "./world.js";

function shipToDto(s: ShipState): ShipDto {
  return {
    id: s.id,
    ownerId: s.ownerId,
    name: s.name,
    hull: { ...s.hull },
    blueprint: s.blueprint,
    rooms: s.rooms.map((r) => ({
      id: r.id,
      kind: r.kind,
      moduleType: r.moduleType,
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      hp: r.hp,
      maxHp: r.maxHp,
      enabled: r.enabled,
    })),
    derived: {
      thrust: s.derived.thrust,
      turnRate: s.derived.turnRate,
      sensorRange: s.derived.sensorRange,
      shieldCapacity: s.derived.shieldCapacity,
      powerProduction: s.derived.powerProduction,
      powerDemand: s.derived.powerDemand,
      cargo: s.derived.cargo,
      underpowered: s.derived.underpowered,
      maxSpeed: s.derived.maxSpeed,
      accel: s.derived.accel,
    },
    doctrine: s.doctrine,
    cargo: { ...s.cargo },
  };
}

function ownFleetDto(game: GameState, f: FleetState): FleetDto {
  return {
    id: f.id,
    ownerId: f.ownerId,
    // Marker = ships' centroid; anchor = the static goal point (move-line endpoint).
    position: fleetCentroid(game, f),
    anchor: getFleetPosition(f),
    status: f.status,
    shipCount: f.shipIds.length,
    shipIds: [...f.shipIds],
    sensorRange: f.sensorRange,
    engagementRange: f.engagementRange,
    engaging: f.status === "engaging",
    intent: f.intent,
    order: f.order.kind,
    doctrine: f.doctrine,
    formation: f.formation,
  };
}

/** Enemy fleets reveal only coarse info (no doctrine, no anchor). Marker = centroid. */
function enemyFleetDto(game: GameState, f: FleetState): FleetDto {
  return {
    id: f.id,
    ownerId: f.ownerId,
    position: fleetCentroid(game, f),
    status: f.status === "engaging" ? "engaging" : f.status === "moving" ? "moving" : "idle",
    shipCount: f.shipIds.length,
  };
}

/** Points from which the player can sense: owned planets + own fleets (at centroid). */
function sensorSources(game: GameState, playerId: string): Array<{ x: number; y: number; r: number }> {
  const sources: Array<{ x: number; y: number; r: number }> = [];
  for (const p of game.planets.values()) {
    if (p.ownerId === playerId) sources.push({ x: p.position.x, y: p.position.y, r: PLANET_SENSOR_RANGE });
  }
  for (const f of game.fleets.values()) {
    if (f.ownerId === playerId) {
      const pos = fleetCentroid(game, f);
      sources.push({ x: pos.x, y: pos.y, r: f.sensorRange });
    }
  }
  for (const st of game.stations.values()) {
    if (st.ownerId === playerId) sources.push({ x: st.position.x, y: st.position.y, r: STATION.sensorRange });
  }
  return sources;
}

export function canSensePoint(
  sources: Array<{ x: number; y: number; r: number }>,
  point: { x: number; y: number },
): boolean {
  return sources.some((s) => dist(s, point) <= s.r);
}

export function getVisibleState(game: GameState, playerId: string, nowMs: number): PlayerVisibleSnapshot {
  materializePlayerPlanets(game, playerId, nowMs);
  const player = game.players.get(playerId)!;
  const sources = sensorSources(game, playerId);

  const planets: PlanetDto[] = [];
  for (const p of game.planets.values()) {
    const mine = p.ownerId === playerId;
    planets.push({
      id: p.id,
      name: p.name,
      position: { ...p.position },
      radius: p.radius,
      ...(p.ownerId ? { ownerId: p.ownerId } : {}),
      ...(mine
        ? {
            storedResources: { metal: p.storedResources.metal, fuel: p.storedResources.fuel },
            resourceRates: { ...p.resourceRates },
            constructionQueue: p.constructionQueue.map((j) => ({
              id: j.id,
              name: j.name,
              finishAtMs: j.finishAtMs,
            })),
          }
        : {}),
    });
  }

  const fleets: FleetDto[] = [];
  for (const f of game.fleets.values()) {
    if (f.status === "destroyed") continue;
    if (f.ownerId === playerId) fleets.push(ownFleetDto(game, f));
    else if (canSensePoint(sources, fleetCentroid(game, f))) fleets.push(enemyFleetDto(game, f));
  }

  // Only own ship internals are ever serialized (DESIGN §10.3).
  const ships: ShipDto[] = [];
  for (const id of player.shipIds) {
    const s = game.ships.get(id);
    if (s) ships.push(shipToDto(s));
  }

  const ownMetal = planets
    .filter((p) => p.ownerId === playerId)
    .reduce((sum, p) => sum + (p.storedResources?.metal ?? 0), 0);
  const ownFuel = planets
    .filter((p) => p.ownerId === playerId)
    .reduce((sum, p) => sum + (p.storedResources?.fuel ?? 0), 0);

  // Resource locations sensed by the player (coarse deposits — plan 030).
  const resourceLocations = [];
  for (const loc of game.resourceLocations.values()) {
    if (!canSensePoint(sources, loc.position)) continue;
    resourceLocations.push({
      id: loc.id,
      name: loc.name,
      position: { ...loc.position },
      radius: loc.radius,
      deposits: loc.deposits.map((d) => ({
        resource: d.resource,
        richness: d.richness,
        reserves: d.reserves,
        accessibility: d.accessibility,
      })),
    });
  }

  return {
    serverTimeMs: nowMs,
    you: {
      id: player.id,
      homePlanetId: player.homePlanetId,
      resources: { metal: ownMetal, fuel: ownFuel },
      fleetIds: player.fleetIds,
      shipIds: player.shipIds,
    },
    planets,
    resourceLocations,
    debris: game.debris
      .filter((d) => canSensePoint(sources, d.position))
      .map((d) => ({ id: d.id, position: { ...d.position }, cargo: { ...d.cargo } })),
    stations: [...game.stations.values()]
      .filter((st) => st.ownerId === playerId || canSensePoint(sources, st.position))
      .map((st) => {
        const mine = st.ownerId === playerId;
        return {
          id: st.id,
          ownerId: st.ownerId,
          name: st.name,
          position: { ...st.position },
          locationId: st.locationId,
          hp: st.hp,
          maxHp: st.maxHp,
          ...(mine ? { storage: { ...st.storage }, capacity: st.capacity } : {}),
        };
      }),
    operations: [...game.operations.values()]
      .filter((o) => o.ownerId === playerId)
      .map((o) => ({
        id: o.id,
        fleetId: o.fleetId,
        locationId: o.locationId,
        deliveryPlanetId: o.deliveryPlanetId,
        state: o.state,
        paused: o.paused,
      })),
    fleets,
    ships,
  };
}

function roomsDto(rooms: RoomState[]): RoomDto[] {
  return rooms.map((r) => ({
    id: r.id,
    kind: r.kind,
    moduleType: r.moduleType,
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
    hp: r.hp,
    maxHp: r.maxHp,
    enabled: r.enabled,
  }));
}

/**
 * High-rate stream of every ship the player can currently sense (always on, not just in
 * combat). Every sensed ship — own OR enemy — carries full detail (blueprint + rooms) so
 * the client can render internals at high zoom, in or out of combat. Fog of war is the
 * sensor-range filter: enemy ships outside range simply aren't included.
 */
export function buildSensedShips(game: GameState, playerId: string, nowMs: number): ActiveRegionDelta {
  const sources = sensorSources(game, playerId);
  const ships: ActiveShipDto[] = [];
  const projectiles: ProjectileDto[] = [];
  const events: ActiveRegionDelta["events"] = [];
  const sensedShipIds = new Set<string>();

  for (const rt of game.shipRuntime.values()) {
    const mine = rt.ownerId === playerId;
    if (!mine && !canSensePoint(sources, rt.position)) continue;
    sensedShipIds.add(rt.shipId);
    const ship = game.ships.get(rt.shipId);
    const dto: ActiveShipDto = {
      shipId: rt.shipId,
      fleetId: rt.fleetId,
      ownerId: rt.ownerId,
      position: { x: rt.position.x, y: rt.position.y },
      heading: rt.heading,
      shield: rt.shield,
      maxShield: rt.maxShield,
      hullHp: ship?.hull.hp ?? 0,
      hullMaxHp: ship?.hull.maxHp ?? 1,
      alive: rt.alive,
      ...(rt.targetShipId ? { targetShipId: rt.targetShipId } : {}),
      ...(rt.miningLocationId ? { miningLocationId: rt.miningLocationId } : {}),
      ...(rt.unloadLocationId ? { unloadLocationId: rt.unloadLocationId } : {}),
    };
    if (ship) {
      dto.blueprint = ship.blueprint;
      dto.rooms = roomsDto(ship.rooms);
    }
    ships.push(dto);
  }

  for (const p of game.projectiles) {
    if (sensedShipIds.has(p.targetShipId) || canSensePoint(sources, p.position)) {
      projectiles.push({
        id: p.id,
        position: { x: p.position.x, y: p.position.y },
        targetShipId: p.targetShipId,
        velocity: { x: p.velocity.x, y: p.velocity.y },
        kind: p.kind,
      });
    }
  }
  for (const e of game.combatEvents) {
    const target = "ship" in e ? e.ship : "to" in e ? e.to : undefined;
    if (target && sensedShipIds.has(target)) events.push({ ...e });
  }

  return { serverTimeMs: nowMs, ships, projectiles, events };
}

export { shipToDto };
