// Core in-memory domain model (DESIGN §4). Plain serializable data — no classes.
// Shared by the server (authoritative state) and simulation functions.

export type EntityId = string;
export type Vec2 = { x: number; y: number };

/** Physical, mineable/haulable commodities. Extensible — add types without touching the
 *  mining architecture (plan 029 §1, 030). Energy is NOT here — it is a derived stat. */
export type ResourceType = "metal" | "fuel"; // future: "titanium" | "rareMetals" | "volatiles" | "exotics"
export const RESOURCE_TYPES: ResourceType[] = ["metal", "fuel"];

/** A bag of physical commodities (partial — absent = 0). */
export type ResourceBag = Partial<Record<ResourceType, number>>;

/** Derived energy budget for a ship/structure (never a commodity — plan 029 §1, 030). */
export interface EnergyState {
  generation: number;
  consumption: number;
  available: number;
}

export interface PlayerState {
  id: string; // free-text account key for the prototype
  homePlanetId: EntityId;
  resources: ResourceBag;
  fleetIds: EntityId[];
  shipIds: EntityId[];
}

export interface FacilityState {
  id: EntityId;
  kind: string;
  level: number;
}

export interface ConstructionJob {
  id: EntityId;
  kind: "ship";
  startedAtMs: number;
  finishAtMs: number;
  blueprint: ShipBlueprint;
  name: string;
}

export interface PlanetState {
  id: EntityId;
  ownerId?: string;
  name: string;
  position: Vec2;
  radius: number;
  resourceRates: { metalPerSec: number; fuelPerSec: number };
  resourceUpdatedAtMs: number;
  storedResources: { metal: number; fuel: number };
  facilities: FacilityState[];
  constructionQueue: ConstructionJob[];
}

/** A mineable deposit at a resource location (plan 029 §3, 030). */
export interface ResourceDeposit {
  resource: ResourceType;
  richness: number; // extraction-rate multiplier (~0.6..1.5)
  reserves: number; // remaining amount; can exhaust
  accessibility: number; // 0..1 difficulty (lower = harder / slower)
}

/** A physical place ships fly to and mine — asteroid field, gas giant, etc. (plan 030). */
export interface ResourceLocation {
  id: EntityId;
  name: string;
  position: Vec2;
  radius: number;
  deposits: ResourceDeposit[];
}

export type RoomKind = "bridge" | "engine" | "reactor" | "weapon" | "shield" | "storage" | "mining";

export interface RoomState {
  id: EntityId;
  kind: RoomKind;
  moduleType: string; // key into config MODULES
  x: number;
  y: number;
  w: number;
  h: number;
  hp: number;
  maxHp: number;
  powerDemand: number;
  enabled: boolean;
  weapon?: { damage: number; cooldownMs: number; range: number; projectileSpeed: number };
}

export type CrewRole = "captain" | "engineer" | "gunner" | "marine";

export interface CrewState {
  id: EntityId;
  role: CrewRole;
  roomId?: EntityId;
  hp: number;
  bonuses: Record<string, number>;
}

export interface ShipDerivedStats {
  thrust: number;
  turnRate: number;
  sensorRange: number;
  shieldCapacity: number;
  powerProduction: number;
  powerDemand: number;
  cargo: number;
  weaponRoomIds: EntityId[];
  underpowered: boolean;
  // Kinematic caps for continuous combat (plan 015 §4, 016).
  maxSpeed: number;
  accel: number;
  // Industrial capability (plan 030). 0 for non-mining ships.
  miningPower: number;
  miningResources: ResourceType[];
  // Derived energy budget (plan 030) — mirrors powerProduction/powerDemand.
  energy: EnergyState;
}

// Per-ship combat behavior within a fleet (plan 015 §4, 018).
export type FormationRole = "front" | "middle" | "rear";
export type ShipPreferredRange = "close" | "medium" | "long";
export type ShipTargetPriority = "nearest" | "small_ships" | "large_ships";
export interface ShipDoctrine {
  formationRole: FormationRole;
  preferredRange: ShipPreferredRange;
  targetPriority: ShipTargetPriority;
}

export interface ShipState {
  id: EntityId;
  ownerId: string;
  name: string;
  hull: { hp: number; maxHp: number; width: number; height: number };
  blueprint: ShipBlueprint;
  rooms: RoomState[];
  crew: CrewState[];
  derived: ShipDerivedStats;
  doctrine: ShipDoctrine;
  combatWeight: number; // weighting for fleet consensus (plan 015 §5, 019)
  /** Physical cargo contents (plan 030). Capacity is `derived.cargo`. */
  cargo: ResourceBag;
  /** Industrial role within an operation (plan 032); undefined = combat/general. */
  role?: IndustrialRole;
}

export type FleetStatus = "idle" | "moving" | "engaging" | "destroyed";

/** Player-selectable fleet formation shape (plan 027). */
export type FormationShape =
  | "column"
  | "line"
  | "wedge"
  | "echelon"
  | "box"
  | "screen"
  | "protect"
  | "loose";

export interface MovementPlan {
  from: Vec2;
  to: Vec2;
  startMs: number;
  endMs: number;
  speed: number;
  revision: number;
}

// Continuous fleet doctrine (plan 015 §4, 020). Presets map to these parameters.
export type DoctrinePreset =
  | "hold_fire"
  | "return_fire"
  | "attack_on_sight"
  | "pursue"
  | "flee_if_attacked";
export interface FleetDoctrine {
  preset: DoctrinePreset;
  aggression: number; // 0..1 — how favorable an engagement must look before committing
  pursuit: number; // 0..1 — willingness to leave the route to chase
  cohesion: number; // 0..1 — how tightly ships hold formation
  survival: number; // 0..1 — how quickly a losing fight triggers disengage/flee
}

// Player strategic orders (plan 015 §4, 020).
export type FleetOrder =
  | { kind: "moveTo"; target: Vec2 }
  | { kind: "attackMove"; target: Vec2 }
  | { kind: "hold"; anchor: Vec2 }
  | { kind: "follow"; fleetId: EntityId; distance: number }
  | { kind: "escort"; fleetId: EntityId; distance: number }
  | { kind: "pursue"; fleetId: EntityId; distance?: number }
  | { kind: "mine"; locationId: EntityId; depositIndex?: number }
  | { kind: "unloadAt"; planetId: EntityId };

// Fleet tactical intent, chosen by the fleet brain (plan 015 §4, 019).
export type FleetIntent =
  | "continue_order"
  | "observe"
  | "intercept"
  | "engage"
  | "pursue"
  | "disengage"
  | "flee";

export interface FleetState {
  id: EntityId;
  ownerId: string;
  shipIds: EntityId[];
  status: FleetStatus;
  /** The fleet ANCHOR — a static rally/goal point (the last commanded point). Ships fly
   *  toward their formation slots around it. The fleet's real location is its ships'
   *  centroid, not this anchor. */
  position: Vec2;
  sensorRange: number;
  engagementRange: number;
  order: FleetOrder;
  intent: FleetIntent;
  doctrine: FleetDoctrine;
  /** Selected formation shape (plan 027). */
  formation: FormationShape;
  /** Tick until which the fleet counts as "under attack" (return/flee doctrines). */
  underAttackUntil?: number;
}

// ---- Ship builder blueprint (DESIGN §8.1) ----
export interface ShipBlueprint {
  hullType: string;
  width: number;
  height: number;
  blockedCells: string[]; // e.g. "3,4"
  placements: Array<{
    moduleType: string;
    x: number;
    y: number;
    rotation: 0 | 90 | 180 | 270;
  }>;
}

// ---- Always-on per-ship simulation runtime (plan: always-simulated ships) ----

/** Persistent per-ship kinematics. Every ship in every fleet always has one. */
export interface ShipRuntime {
  shipId: EntityId;
  fleetId: EntityId;
  ownerId: string;
  position: Vec2;
  velocity: Vec2;
  heading: number;
  shield: number;
  maxShield: number;
  targetShipId?: EntityId | undefined;
  /** Resource location this ship is actively extracting from this step (plan: mining FX). */
  miningLocationId?: EntityId | undefined;
  /** Planet this ship is actively unloading cargo into this step (plan 038 — unload beam). */
  unloadLocationId?: EntityId | undefined;
  weaponCooldowns: Record<EntityId, number>;
  alive: boolean;
}

/** World-space projectile. */
export interface WorldProjectile {
  id: EntityId;
  ownerShipId: EntityId;
  ownerFleetId: EntityId;
  targetShipId: EntityId;
  /** Firing weapon module type (e.g. "laser" / "cannon") — drives client visuals. */
  kind: string;
  position: Vec2;
  velocity: Vec2;
  damage: number;
  ttlMs: number;
}

export type CombatEvent =
  | { type: "fire"; from: EntityId; to: EntityId; projectileId: EntityId }
  | { type: "hit"; ship: EntityId; roomId?: EntityId; damage: number; shield: boolean }
  | { type: "roomDisabled"; ship: EntityId; roomId: EntityId }
  | { type: "shipDestroyed"; ship: EntityId; position: Vec2 };

/** A single-ship contact report, aggregated by the fleet brain (plan 015 §5). */
export interface ContactReport {
  reporterShipId: EntityId;
  targetFleetId: EntityId;
  confidence: number;
  distance: number;
  estimatedThreat: number;
  engagementUtility: number;
}

// ---- Mining stations (plan 034) ----

/** A semi-permanent structure at a resource location: auto-extracts + stores (plan 034). */
export interface Station {
  id: EntityId;
  ownerId: string;
  name: string;
  position: Vec2;
  locationId: EntityId; // the resource location it sits on
  storage: ResourceBag;
  capacity: number;
  extraction: number; // auto-mining power
  hp: number;
  maxHp: number;
}

// ---- Logistics warfare: debris & salvage (plan 033) ----

/** Floating wreckage/cargo dropped when a laden ship is destroyed. */
export interface Debris {
  id: EntityId;
  position: Vec2;
  cargo: ResourceBag;
  ttlMs: number;
}

// ---- Resource operations & industrial roles (plan 032) ----

export type IndustrialRole = "miner" | "hauler" | "escort" | "scout" | "repair" | "support";

/** Automation state for a persistent mining operation. */
export type OpState = "mining" | "returning" | "unloading";

export interface ResourceOperation {
  id: EntityId;
  ownerId: string;
  fleetId: EntityId;
  locationId: EntityId; // where to mine
  deliveryPlanetId: EntityId; // where to unload
  state: OpState;
  paused: boolean;
}

// ---- Scheduler (DESIGN §5.2) ----
export type ScheduledEvent =
  | { atMs: number; type: "construction-complete"; planetId: string; jobId: string }
  | { atMs: number; type: "scan-refresh"; regionKey: string };

export interface GameState {
  players: Map<string, PlayerState>;
  planets: Map<EntityId, PlanetState>;
  /** Mineable resource locations (plan 030). */
  resourceLocations: Map<EntityId, ResourceLocation>;
  /** Persistent automated resource operations (plan 032). */
  operations: Map<EntityId, ResourceOperation>;
  /** Floating salvage dropped by destroyed laden ships (plan 033). */
  debris: Debris[];
  /** Semi-permanent mining stations (plan 034). */
  stations: Map<EntityId, Station>;
  ships: Map<EntityId, ShipState>;
  fleets: Map<EntityId, FleetState>;
  /** Persistent per-ship kinematics — every ship always has one (always simulated). */
  shipRuntime: Map<EntityId, ShipRuntime>;
  /** All in-flight world-space projectiles. */
  projectiles: WorldProjectile[];
  /** Global seeded RNG state advanced each world step (determinism). */
  rngState: number;
  combatEvents: CombatEvent[]; // events produced this step, for broadcasting
}
