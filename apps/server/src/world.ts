// Authoritative world: GameState construction, player registry and starter setup.
// In-memory only; resets on restart (DESIGN §1, §12).

import {
  FLEET,
  STARTING_RESOURCES,
  WORLD_SEED,
} from "@space/config";
import {
  DEFAULT_DOCTRINE,
  computeDerived,
  fleetCentroid,
  generatePlanets,
  generateResourceLocations,
  instantiateShip,
  makeHomePlanet,
  makeId,
  materializePlanetResources,
  starterBlueprint,
  type FleetState,
  type GameState,
  type PlayerState,
  type ShipState,
} from "@space/simulation";

export function createGameState(nowMs: number): GameState {
  const planets = generatePlanets(WORLD_SEED, nowMs);
  const resourceLocations = generateResourceLocations(WORLD_SEED, planets);
  const game: GameState = {
    players: new Map(),
    planets: new Map(planets.map((p) => [p.id, p])),
    resourceLocations: new Map(resourceLocations.map((l) => [l.id, l])),
    operations: new Map(),
    debris: [],
    stations: new Map(),
    ships: new Map(),
    fleets: new Map(),
    shipRuntime: new Map(),
    projectiles: [],
    rngState: WORLD_SEED >>> 0,
    combatEvents: [],
  };
  return game;
}

function firstUnownedPlanetId(game: GameState): string | undefined {
  for (const p of game.planets.values()) if (!p.ownerId) return p.id;
  return undefined;
}

/** A fleet's anchor (its static rally/goal point). */
export function getFleetPosition(fleet: FleetState): { x: number; y: number } {
  return { x: fleet.position.x, y: fleet.position.y };
}

/** A fleet's real location — the centroid of its ships (or the anchor if none yet). */
export function getFleetLocation(game: GameState, fleet: FleetState): { x: number; y: number } {
  return fleetCentroid(game, fleet);
}

/** Get or create a player by free-text ID (DESIGN §10.1). */
export function getOrCreatePlayer(game: GameState, rawId: string, nowMs: number): PlayerState {
  const id = rawId;
  const existing = game.players.get(id);
  if (existing) return existing;

  const homeId = firstUnownedPlanetId(game);
  if (!homeId) throw new Error("no unowned planet available for new player");
  const home = game.planets.get(homeId)!;
  makeHomePlanet(home, id, nowMs);
  // Home planet stored-resources double as the player's spendable economy pool.
  home.storedResources = { metal: STARTING_RESOURCES.metal, fuel: STARTING_RESOURCES.fuel };

  const player: PlayerState = {
    id,
    homePlanetId: homeId,
    resources: { ...STARTING_RESOURCES },
    fleetIds: [],
    shipIds: [],
  };
  game.players.set(id, player);

  // Two starter ships near the home planet (DESIGN §18).
  const s1 = createShipFor(game, player, "Vanguard");
  const s2 = createShipFor(game, player, "Harrier");
  const fleet = createFleet(game, player, [s1.id, s2.id], nowMs);
  fleet.position = { x: home.position.x + 160, y: home.position.y + 160 };

  return player;
}

export function createShipFor(game: GameState, player: PlayerState, name: string): ShipState {
  const ship = instantiateShip(player.id, name, starterBlueprint());
  ship.derived = computeDerived(ship.rooms);
  game.ships.set(ship.id, ship);
  player.shipIds.push(ship.id);
  return ship;
}

export function createFleet(
  game: GameState,
  player: PlayerState,
  shipIds: string[],
  nowMs: number,
): FleetState {
  const home = game.planets.get(player.homePlanetId);
  const pos = home ? { x: home.position.x, y: home.position.y } : { x: 0, y: 0 };
  const fleet: FleetState = {
    id: makeId("fleet"),
    ownerId: player.id,
    shipIds: [...shipIds],
    status: "idle",
    position: pos,
    sensorRange: FLEET.sensorRange,
    engagementRange: FLEET.engagementRange,
    order: { kind: "hold", anchor: { ...pos } },
    intent: "continue_order",
    doctrine: { ...DEFAULT_DOCTRINE },
    formation: "line",
  };
  game.fleets.set(fleet.id, fleet);
  player.fleetIds.push(fleet.id);
  return fleet;
}

/** Fetch the ShipStates belonging to a fleet. */
export function fleetShips(game: GameState, fleet: FleetState): ShipState[] {
  return fleet.shipIds.map((id) => game.ships.get(id)).filter((s): s is ShipState => !!s);
}

/** Materialize all owned-planet resources for a player (called on read/spend). */
export function materializePlayerPlanets(game: GameState, playerId: string, nowMs: number): void {
  for (const p of game.planets.values()) {
    if (p.ownerId === playerId) materializePlanetResources(p, nowMs);
  }
}

/** Seed a couple of NPC players so encounters are easy to trigger (DESIGN §12.1). */
export function seedNpcPlayers(game: GameState, nowMs: number): void {
  for (const npc of ["npc-red", "npc-blue"]) {
    if (!game.players.has(npc)) getOrCreatePlayer(game, npc, nowMs);
  }
}
