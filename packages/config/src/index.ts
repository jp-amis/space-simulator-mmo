// Centralized balance values and game constants.
// Keep tunable numbers here rather than scattering them across handlers/renderers.
// See docs/DESIGN.md §16 rule 7.

/** Fixed world seed so restarts recreate the same base galaxy (DESIGN §12). */
export const WORLD_SEED = 0x5eedc0de;

/** Server heartbeat period in ms (DESIGN §6 — ~10-20 Hz). */
export const HEARTBEAT_MS = 50;

/** Fixed active-simulation timestep for continuous combat (plan 015 §3, §10). */
export const ACTIVE_DT_MS = 100;

/** Fleet-brain decision interval — slower than the physics tick (plan 015 §5). */
export const DECISION_INTERVAL_MS = 500;

/** Bounded 2D region for the strategic map. */
export const WORLD = {
  width: 20000,
  height: 20000,
  minPlanetSeparation: 900,
  planetCountMin: 18,
  planetCountMax: 26,
} as const;

/** Uniform spatial-hash cell size for trajectory broad phase (DESIGN §5.4). */
export const SPATIAL_CELL_SIZE = 1200;

/** Starting resources for a fresh player (physical commodities only — plan 030). */
export const STARTING_RESOURCES = { metal: 400, fuel: 200 } as const;

/** Home-planet defaults. */
export const HOME_PLANET = {
  radius: 90,
  metalPerSec: 2.5,
  fuelPerSec: 1.25,
} as const;

/** Default fleet values (world units / second). Travel is now per-ship (ships fly to
 *  the anchor), so `baseSpeed` is only a fallback. Sensor range is deliberately tight. */
export const FLEET = {
  baseSpeed: 260,
  sensorRange: 650,
  engagementRange: 240,
} as const;

/** How far an owned planet can sense (smaller than before). */
export const PLANET_SENSOR_RANGE = 900;

/** Resource extraction + cargo logistics tuning (plan 031). */
export const RESOURCE = {
  mineRange: 260, // how close a miner must be to a deposit to extract
  transferRange: 160, // ship↔ship / ship↔planet cargo transfer distance
  transferPerSec: 400, // cargo units moved per second while unloading/transferring
  mineRing: 170, // miners orbit the deposit on this radius (inside mineRange) — plan 036
  escortRing: 320, // non-mining ships screen the miners at this larger radius — plan 037
} as const;

/** Mining station tuning (plan 034). */
export const STATION = {
  cost: { metal: 300, fuel: 120 } as Record<string, number>,
  capacity: 60_000,
  extraction: 12, // auto-mining power (stronger than a bare miner)
  hp: 1200,
  sensorRange: 1100,
} as const;

/** Debris + salvage tuning (plan 033). */
export const SALVAGE = {
  survivalFraction: 0.35, // fraction of a destroyed ship's cargo that becomes debris
  scrapPerCell: 6, // base metal scrap per hull cell — every wreck leaves something to recover
  ttlMs: 60_000, // how long debris floats before decaying
  recoverPerSec: 300, // cargo units salvaged per second by a nearby ship
  range: 200, // how close a salvager must be to recover debris
} as const;

/** Resource cost per constructed ship (prototype flat cost). */
export const SHIP_COST = { metal: 120, fuel: 40 } as const;
export const SHIP_BUILD_MS = 8000;

/** Room / module catalog. Power > 0 consumes, < 0 produces. */
export type ModuleKind = "bridge" | "engine" | "reactor" | "weapon" | "shield" | "storage" | "mining";

export interface ModuleSpec {
  kind: ModuleKind;
  w: number;
  h: number;
  hp: number;
  /** Positive = demand, negative = generation. */
  power: number;
  thrust?: number;
  turnRate?: number;
  sensorRange?: number;
  shieldCapacity?: number;
  cargo?: number;
  weapon?: { damage: number; cooldownMs: number; range: number; projectileSpeed: number };
  /** Industrial extraction (plan 030). `supportedResources` are ResourceType keys. */
  mining?: { miningPower: number; supportedResources: string[]; range: number };
}

export const MODULES: Record<string, ModuleSpec> = {
  bridge: { kind: "bridge", w: 1, h: 1, hp: 40, power: 2, turnRate: 0.6, sensorRange: 800 },
  reactor: { kind: "reactor", w: 1, h: 1, hp: 30, power: -10 },
  engine: { kind: "engine", w: 1, h: 1, hp: 30, power: 3, thrust: 90, turnRate: 0.5 },
  shield: { kind: "shield", w: 1, h: 1, hp: 25, power: 4, shieldCapacity: 60 },
  storage: { kind: "storage", w: 1, h: 1, hp: 35, power: 0, cargo: 100 },
  miningLaser: {
    kind: "mining",
    w: 1,
    h: 1,
    hp: 30,
    power: 6,
    mining: { miningPower: 8, supportedResources: ["metal", "fuel"], range: 220 },
  },
  laser: {
    kind: "weapon",
    w: 1,
    h: 1,
    hp: 25,
    power: 3,
    weapon: { damage: 8, cooldownMs: 900, range: 520, projectileSpeed: 900 },
  },
  cannon: {
    kind: "weapon",
    w: 1,
    h: 1,
    hp: 28,
    power: 4,
    weapon: { damage: 16, cooldownMs: 1600, range: 380, projectileSpeed: 520 },
  },
} as const;

/** Continuous combat tuning (plan 015 §7, §13). */
export const COMBAT = {
  shieldRegenPerSec: 4,
  hullBaseHp: 60,
  hitRadius: 26,
  // Ship steering weights (plan 015 §7 — soft formation).
  formationWeight: 1.0,
  rangeWeight: 1.3,
  pursuitWeight: 1.0,
  avoidanceWeight: 1.6,
  avoidanceRadius: 70,
  formationSpacing: 90,
  // Kinematics derived from thrust (ships fly to the anchor at this speed).
  speedPerThrust: 2.0, // maxSpeed = thrust * this (bounded)
  minMaxSpeed: 60,
  maxMaxSpeed: 320,
  accelPerThrust: 4.0,
  // Fleet-brain default engagement gate (doctrine.aggression shifts it).
  engageThreshold: 0.55,
  disengageThreshold: 0.3,
  // How close a ship parks to its formation slot before it counts as "arrived".
  slotArriveDist: 12,
  // Tracking orders (pursue/follow/escort) only re-snap the static anchor once the
  // desired point has drifted past this, so the anchor doesn't jitter every tick.
  anchorRetargetDist: 120,
} as const;

export const CONFIG_PLACEHOLDER = true;
