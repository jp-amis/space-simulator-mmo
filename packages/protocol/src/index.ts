// Network DTOs, message IDs and Zod schemas shared by client and server.
// Protocol types stay separate from internal domain objects (DESIGN §16 rule 1,
// §10.2, §10.3). The server maps domain state → these DTOs in getVisibleState.

import { z } from "zod";

export const PROTOCOL_VERSION = 1;
export const MAX_PLAYER_ID_LEN = 24;

export const Vec2 = z.object({ x: z.number(), y: z.number() });
export type Vec2 = z.infer<typeof Vec2>;

// ---- Ship builder ----
export const Rotation = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);
export const ShipBlueprint = z.object({
  hullType: z.string(),
  width: z.number().int().min(1).max(8),
  height: z.number().int().min(1).max(8),
  blockedCells: z.array(z.string()),
  placements: z.array(
    z.object({
      moduleType: z.string(),
      x: z.number().int(),
      y: z.number().int(),
      rotation: Rotation,
    }),
  ),
});
export type ShipBlueprint = z.infer<typeof ShipBlueprint>;

// Continuous fleet doctrine (plan 015 §4, 020).
export const DoctrinePreset = z.enum([
  "hold_fire",
  "return_fire",
  "attack_on_sight",
  "pursue",
  "flee_if_attacked",
]);
export type DoctrinePreset = z.infer<typeof DoctrinePreset>;
export const FleetDoctrine = z.object({
  preset: DoctrinePreset,
  aggression: z.number(),
  pursuit: z.number(),
  cohesion: z.number(),
  survival: z.number(),
});
export type FleetDoctrine = z.infer<typeof FleetDoctrine>;

// Fleet formation shape (plan 027).
export const FormationShape = z.enum([
  "column",
  "line",
  "wedge",
  "echelon",
  "box",
  "screen",
  "protect",
  "loose",
]);
export type FormationShape = z.infer<typeof FormationShape>;

// Per-ship combat behavior (plan 015 §4, 018).
export const ShipDoctrine = z.object({
  formationRole: z.enum(["front", "middle", "rear"]),
  preferredRange: z.enum(["close", "medium", "long"]),
  targetPriority: z.enum(["nearest", "small_ships", "large_ships"]),
});
export type ShipDoctrine = z.infer<typeof ShipDoctrine>;

export const MovementPlanDto = z.object({
  from: Vec2,
  to: Vec2,
  startMs: z.number(),
  endMs: z.number(),
  speed: z.number(),
  revision: z.number(),
});
export type MovementPlanDto = z.infer<typeof MovementPlanDto>;

// ---- Resources (plan 030) ----
export const ResourceType = z.enum(["metal", "fuel"]);
export type ResourceType = z.infer<typeof ResourceType>;
export const ResourceBag = z.object({ metal: z.number().optional(), fuel: z.number().optional() });
export type ResourceBag = z.infer<typeof ResourceBag>;

export const ResourceDepositDto = z.object({
  resource: ResourceType,
  richness: z.number(),
  reserves: z.number(),
  accessibility: z.number(),
});
export type ResourceDepositDto = z.infer<typeof ResourceDepositDto>;

export const ResourceLocationDto = z.object({
  id: z.string(),
  name: z.string(),
  position: Vec2,
  radius: z.number(),
  deposits: z.array(ResourceDepositDto),
});
export type ResourceLocationDto = z.infer<typeof ResourceLocationDto>;

export const StationDto = z.object({
  id: z.string(),
  ownerId: z.string(),
  name: z.string(),
  position: Vec2,
  locationId: z.string(),
  hp: z.number(),
  maxHp: z.number(),
  storage: ResourceBag.optional(), // own stations only
  capacity: z.number().optional(),
});
export type StationDto = z.infer<typeof StationDto>;

export const DebrisDto = z.object({
  id: z.string(),
  position: Vec2,
  cargo: ResourceBag,
});
export type DebrisDto = z.infer<typeof DebrisDto>;

export const OperationDto = z.object({
  id: z.string(),
  fleetId: z.string(),
  locationId: z.string(),
  deliveryPlanetId: z.string(),
  state: z.enum(["mining", "returning", "unloading"]),
  paused: z.boolean(),
});
export type OperationDto = z.infer<typeof OperationDto>;

// ---- Snapshot DTOs ----
export const PlanetDto = z.object({
  id: z.string(),
  name: z.string(),
  position: Vec2,
  radius: z.number(),
  ownerId: z.string().optional(),
  storedResources: z.object({ metal: z.number(), fuel: z.number() }).optional(),
  resourceRates: z.object({ metalPerSec: z.number(), fuelPerSec: z.number() }).optional(),
  constructionQueue: z
    .array(z.object({ id: z.string(), name: z.string(), finishAtMs: z.number() }))
    .optional(),
});
export type PlanetDto = z.infer<typeof PlanetDto>;

export const FleetDto = z.object({
  id: z.string(),
  ownerId: z.string(),
  // Fleet marker position = the ships' CENTROID (its real location).
  position: Vec2,
  // Static goal/rally point (own fleets only) — endpoint of the on-screen move line.
  anchor: Vec2.optional(),
  status: z.enum(["idle", "moving", "engaging", "destroyed"]),
  shipCount: z.number(),
  shipIds: z.array(z.string()).optional(),
  sensorRange: z.number().optional(),
  engagementRange: z.number().optional(),
  engaging: z.boolean().optional(),
  intent: z.string().optional(),
  order: z.string().optional(), // order kind, for own fleets
  doctrine: FleetDoctrine.optional(),
  formation: FormationShape.optional(), // own fleets (plan 027)
});
export type FleetDto = z.infer<typeof FleetDto>;

export const RoomDto = z.object({
  id: z.string(),
  kind: z.enum(["bridge", "engine", "reactor", "weapon", "shield", "storage", "mining"]),
  moduleType: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  hp: z.number(),
  maxHp: z.number(),
  enabled: z.boolean(),
});
export type RoomDto = z.infer<typeof RoomDto>;

export const ShipDto = z.object({
  id: z.string(),
  ownerId: z.string(),
  name: z.string(),
  hull: z.object({ hp: z.number(), maxHp: z.number(), width: z.number(), height: z.number() }),
  blueprint: ShipBlueprint,
  rooms: z.array(RoomDto),
  derived: z.object({
    thrust: z.number(),
    turnRate: z.number(),
    sensorRange: z.number(),
    shieldCapacity: z.number(),
    powerProduction: z.number(),
    powerDemand: z.number(),
    cargo: z.number(),
    underpowered: z.boolean(),
    maxSpeed: z.number(),
    accel: z.number(),
  }),
  doctrine: ShipDoctrine.optional(),
  cargo: ResourceBag.optional(), // physical cargo contents (plan 030)
});
export type ShipDto = z.infer<typeof ShipDto>;

export const PlayerDto = z.object({
  id: z.string(),
  homePlanetId: z.string(),
  resources: z.object({ metal: z.number(), fuel: z.number() }),
  fleetIds: z.array(z.string()),
  shipIds: z.array(z.string()),
});
export type PlayerDto = z.infer<typeof PlayerDto>;

export const PlayerVisibleSnapshot = z.object({
  serverTimeMs: z.number(),
  you: PlayerDto,
  planets: z.array(PlanetDto),
  resourceLocations: z.array(ResourceLocationDto),
  operations: z.array(OperationDto),
  debris: z.array(DebrisDto),
  stations: z.array(StationDto),
  fleets: z.array(FleetDto),
  ships: z.array(ShipDto),
});
export type PlayerVisibleSnapshot = z.infer<typeof PlayerVisibleSnapshot>;

// ---- Continuous combat wire DTOs (plan 021) ----

/** World-space per-ship state for a ship the player can currently sense in combat. */
export const ActiveShipDto = z.object({
  shipId: z.string(),
  fleetId: z.string(),
  ownerId: z.string(),
  position: Vec2,
  heading: z.number(),
  shield: z.number(),
  maxShield: z.number(),
  hullHp: z.number(),
  hullMaxHp: z.number(),
  alive: z.boolean(),
  targetShipId: z.string().optional(), // who this ship is attacking (for lock lines)
  miningLocationId: z.string().optional(), // resource location being mined (for the mining beam)
  unloadLocationId: z.string().optional(), // planet being unloaded into (for the unload beam)
  // Sensed ships carry blueprint + rooms so the client can draw internals at high LOD.
  blueprint: ShipBlueprint.optional(),
  rooms: z.array(RoomDto).optional(),
});
export type ActiveShipDto = z.infer<typeof ActiveShipDto>;

export const ProjectileDto = z.object({
  id: z.string(),
  position: Vec2,
  targetShipId: z.string(),
  velocity: Vec2.optional(), // units/sec, for client-side smoothing (plan 028)
  kind: z.string().optional(), // firing weapon type (laser/cannon) — client visuals
});
export type ProjectileDto = z.infer<typeof ProjectileDto>;

export const CombatEventDto = z.discriminatedUnion("type", [
  z.object({ type: z.literal("fire"), from: z.string(), to: z.string(), projectileId: z.string() }),
  z.object({
    type: z.literal("hit"),
    ship: z.string(),
    roomId: z.string().optional(),
    damage: z.number(),
    shield: z.boolean(),
  }),
  z.object({ type: z.literal("roomDisabled"), ship: z.string(), roomId: z.string() }),
  z.object({ type: z.literal("shipDestroyed"), ship: z.string(), position: Vec2 }),
]);
export type CombatEventDto = z.infer<typeof CombatEventDto>;

/** High-rate delta of everything the player can sense in active combat (plan 021). */
export const ActiveRegionDelta = z.object({
  serverTimeMs: z.number(),
  ships: z.array(ActiveShipDto),
  projectiles: z.array(ProjectileDto),
  events: z.array(CombatEventDto),
});
export type ActiveRegionDelta = z.infer<typeof ActiveRegionDelta>;

// ---- Client → Server ----
export const ClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), playerId: z.string() }),
  z.object({ type: z.literal("moveFleet"), requestId: z.string(), fleetId: z.string(), target: Vec2 }),
  z.object({ type: z.literal("createFleet"), requestId: z.string(), shipIds: z.array(z.string()) }),
  z.object({
    type: z.literal("addShipsToFleet"),
    requestId: z.string(),
    fleetId: z.string(),
    shipIds: z.array(z.string()),
  }),
  z.object({
    type: z.literal("updateShipBlueprint"),
    requestId: z.string(),
    shipId: z.string(),
    blueprint: ShipBlueprint,
  }),
  z.object({
    type: z.literal("buildShip"),
    requestId: z.string(),
    planetId: z.string(),
    blueprint: ShipBlueprint,
    name: z.string(),
  }),
  // Set doctrine by preset (plan 020); the server expands presets to parameters.
  z.object({ type: z.literal("setDoctrine"), requestId: z.string(), fleetId: z.string(), preset: DoctrinePreset }),
  z.object({ type: z.literal("setShipDoctrine"), requestId: z.string(), shipId: z.string(), doctrine: ShipDoctrine }),
  // Fleet orders (plan 020). moveFleet above is the MoveTo order.
  z.object({ type: z.literal("attackMove"), requestId: z.string(), fleetId: z.string(), target: Vec2 }),
  z.object({ type: z.literal("holdFleet"), requestId: z.string(), fleetId: z.string() }),
  z.object({ type: z.literal("pursueFleet"), requestId: z.string(), fleetId: z.string(), targetFleetId: z.string() }),
  z.object({
    type: z.literal("followFleet"),
    requestId: z.string(),
    fleetId: z.string(),
    targetFleetId: z.string(),
    distance: z.number(),
    escort: z.boolean().optional(),
  }),
  // Set the fleet formation shape (plan 027).
  z.object({ type: z.literal("setFormation"), requestId: z.string(), fleetId: z.string(), formation: FormationShape }),
  // Resource logistics (plan 031).
  z.object({ type: z.literal("mineResource"), requestId: z.string(), fleetId: z.string(), locationId: z.string(), depositIndex: z.number().optional() }),
  z.object({ type: z.literal("unloadCargo"), requestId: z.string(), fleetId: z.string(), planetId: z.string() }),
  z.object({ type: z.literal("salvageWreck"), requestId: z.string(), fleetId: z.string(), debrisId: z.string() }),
  z.object({ type: z.literal("transferCargo"), requestId: z.string(), fromShipId: z.string(), toShipId: z.string() }),
  // Automated resource operations (plan 032).
  z.object({ type: z.literal("createOperation"), requestId: z.string(), fleetId: z.string(), locationId: z.string(), deliveryPlanetId: z.string() }),
  z.object({ type: z.literal("cancelOperation"), requestId: z.string(), operationId: z.string() }),
  z.object({ type: z.literal("pauseOperation"), requestId: z.string(), operationId: z.string(), paused: z.boolean() }),
  // Build a mining station at a resource location (plan 034), paid from a planet's stores.
  z.object({ type: z.literal("buildStation"), requestId: z.string(), locationId: z.string(), planetId: z.string() }),
  // Dev/test only: spawn a hostile fleet near a point (plan 023).
  z.object({ type: z.literal("spawnHostile"), requestId: z.string(), near: Vec2 }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---- Server → Client ----
export const ServerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), playerId: z.string(), serverTimeMs: z.number() }),
  z.object({ type: z.literal("snapshot"), world: PlayerVisibleSnapshot }),
  z.object({ type: z.literal("ack"), requestId: z.string() }),
  z.object({ type: z.literal("reject"), requestId: z.string().optional(), reason: z.string() }),
  // High-rate stream of every ship the player can currently sense (always on).
  z.object({ type: z.literal("activeRegion"), delta: ActiveRegionDelta }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

// ---- Codec (JSON for the prototype; DESIGN §10) ----
export function encode(msg: ServerMessage | ClientMessage): string {
  return JSON.stringify(msg);
}

export function decodeClient(raw: string): ClientMessage {
  return ClientMessage.parse(JSON.parse(raw));
}

export function decodeServer(raw: string): ServerMessage {
  return ServerMessage.parse(JSON.parse(raw));
}

export function safeDecodeClient(raw: string): { ok: true; msg: ClientMessage } | { ok: false; error: string } {
  try {
    return { ok: true, msg: ClientMessage.parse(JSON.parse(raw)) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "parse error" };
  }
}
