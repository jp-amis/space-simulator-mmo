// Ship builder: blueprint validation (DESIGN §8.2), derived-stat computation
// (DESIGN §4.2) and blueprint → ShipState instantiation. All server-authoritative.

import { MODULES, COMBAT, type ModuleSpec } from "@space/config";
import type { ResourceType, RoomState, ShipBlueprint, ShipDerivedStats, ShipDoctrine, ShipState } from "./types.js";
import { deterministicId, makeId } from "./ids.js";

export interface ValidationError {
  code:
    | "outside-hull"
    | "overlap"
    | "no-bridge"
    | "multiple-bridges"
    | "unknown-module"
    | "on-blocked-cell";
  message: string;
}

/** Cells occupied by a placement (prototype: rectangular, rotation swaps w/h). */
export function occupiedCells(
  moduleType: string,
  x: number,
  y: number,
  rotation: 0 | 90 | 180 | 270,
): Array<{ x: number; y: number }> {
  const spec = MODULES[moduleType];
  if (!spec) return [];
  const w = rotation === 90 || rotation === 270 ? spec.h : spec.w;
  const h = rotation === 90 || rotation === 270 ? spec.w : spec.h;
  const cells: Array<{ x: number; y: number }> = [];
  for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < h; dy++) cells.push({ x: x + dx, y: y + dy });
  return cells;
}

export function validateBlueprint(bp: ShipBlueprint): ValidationError[] {
  const errors: ValidationError[] = [];
  const blocked = new Set(bp.blockedCells);
  const used = new Map<string, number>();
  let bridges = 0;

  for (const p of bp.placements) {
    const spec = MODULES[p.moduleType];
    if (!spec) {
      errors.push({ code: "unknown-module", message: `unknown module ${p.moduleType}` });
      continue;
    }
    if (spec.kind === "bridge") bridges++;
    for (const c of occupiedCells(p.moduleType, p.x, p.y, p.rotation)) {
      const key = `${c.x},${c.y}`;
      if (c.x < 0 || c.y < 0 || c.x >= bp.width || c.y >= bp.height) {
        errors.push({ code: "outside-hull", message: `${p.moduleType} cell ${key} outside hull` });
      }
      if (blocked.has(key)) {
        errors.push({ code: "on-blocked-cell", message: `${p.moduleType} on blocked cell ${key}` });
      }
      used.set(key, (used.get(key) ?? 0) + 1);
    }
  }
  for (const [key, n] of used) {
    if (n > 1) errors.push({ code: "overlap", message: `cell ${key} overlaps (${n})` });
  }
  if (bridges === 0) errors.push({ code: "no-bridge", message: "exactly one bridge required" });
  if (bridges > 1) errors.push({ code: "multiple-bridges", message: `found ${bridges} bridges` });
  return errors;
}

export function isValidBlueprint(bp: ShipBlueprint): boolean {
  return validateBlueprint(bp).length === 0;
}

function specOf(moduleType: string): ModuleSpec | undefined {
  return MODULES[moduleType];
}

/** Derived stats from a ship's current (possibly damaged) rooms (DESIGN §4.2). */
export function computeDerived(rooms: RoomState[]): ShipDerivedStats {
  let thrust = 0;
  let turnRate = 0;
  let sensorRange = 0;
  let shieldCapacity = 0;
  let powerProduction = 0;
  let powerDemand = 0;
  let cargo = 0;
  let miningPower = 0;
  const miningSet = new Set<ResourceType>();
  const weaponRoomIds: string[] = [];

  for (const r of rooms) {
    const spec = specOf(r.moduleType);
    if (!spec) continue;
    const active = r.enabled && r.hp > 0;
    if (spec.power < 0) {
      // reactor generation scales with remaining hp fraction
      powerProduction += -spec.power * (r.hp / r.maxHp);
      continue;
    }
    if (!active) continue;
    powerDemand += spec.power;
    thrust += spec.thrust ?? 0;
    turnRate += spec.turnRate ?? 0;
    sensorRange = Math.max(sensorRange, spec.sensorRange ?? 0);
    shieldCapacity += spec.shieldCapacity ?? 0;
    cargo += spec.cargo ?? 0;
    if (spec.mining) {
      miningPower += spec.mining.miningPower;
      for (const t of spec.mining.supportedResources) miningSet.add(t as ResourceType);
    }
    if (spec.kind === "weapon") weaponRoomIds.push(r.id);
  }

  const maxSpeed = Math.max(
    COMBAT.minMaxSpeed,
    Math.min(COMBAT.maxMaxSpeed, thrust * COMBAT.speedPerThrust),
  );
  return {
    thrust,
    turnRate,
    sensorRange,
    shieldCapacity,
    powerProduction,
    powerDemand,
    cargo,
    weaponRoomIds,
    underpowered: powerDemand > powerProduction,
    maxSpeed,
    accel: Math.max(20, thrust * COMBAT.accelPerThrust),
    miningPower,
    miningResources: [...miningSet],
    energy: { generation: powerProduction, consumption: powerDemand, available: powerProduction - powerDemand },
  };
}

/** Build authoritative rooms from a validated blueprint. */
export function roomsFromBlueprint(bp: ShipBlueprint, idIndexBase = 0): RoomState[] {
  return bp.placements.map((p, i) => {
    const spec = MODULES[p.moduleType]!;
    const w = p.rotation === 90 || p.rotation === 270 ? spec.h : spec.w;
    const h = p.rotation === 90 || p.rotation === 270 ? spec.w : spec.h;
    return {
      id: deterministicId("room", idIndexBase + i),
      kind: spec.kind,
      moduleType: p.moduleType,
      x: p.x,
      y: p.y,
      w,
      h,
      hp: spec.hp,
      maxHp: spec.hp,
      powerDemand: spec.power > 0 ? spec.power : 0,
      enabled: true,
      ...(spec.weapon ? { weapon: { ...spec.weapon } } : {}),
    } satisfies RoomState;
  });
}

export const DEFAULT_SHIP_DOCTRINE: ShipDoctrine = {
  formationRole: "middle",
  preferredRange: "medium",
  targetPriority: "nearest",
};

/** A rough combat weight from hull size + weapon count (plan 015 §5). */
export function shipCombatWeight(ship: Pick<ShipState, "hull" | "derived">): number {
  return 1 + ship.hull.maxHp / 100 + ship.derived.weaponRoomIds.length * 0.5;
}

export function instantiateShip(
  ownerId: string,
  name: string,
  bp: ShipBlueprint,
  id = makeId("ship"),
): ShipState {
  const rooms = roomsFromBlueprint(bp);
  const hullHp = COMBAT.hullBaseHp + bp.width * bp.height * 4;
  const derived = computeDerived(rooms);
  return {
    id,
    ownerId,
    name,
    hull: { hp: hullHp, maxHp: hullHp, width: bp.width, height: bp.height },
    blueprint: bp,
    rooms,
    crew: [],
    derived,
    doctrine: { ...DEFAULT_SHIP_DOCTRINE },
    combatWeight: shipCombatWeight({ hull: { hp: hullHp, maxHp: hullHp, width: bp.width, height: bp.height }, derived }),
    cargo: {},
  };
}

/** A minimal valid starter blueprint: bridge, reactor, engine, shield, two weapons. */
export function starterBlueprint(): ShipBlueprint {
  return {
    hullType: "scout",
    width: 3,
    height: 3,
    blockedCells: [],
    placements: [
      { moduleType: "bridge", x: 1, y: 1, rotation: 0 },
      { moduleType: "reactor", x: 0, y: 1, rotation: 0 },
      { moduleType: "engine", x: 0, y: 0, rotation: 0 },
      { moduleType: "shield", x: 2, y: 1, rotation: 0 },
      { moduleType: "laser", x: 2, y: 0, rotation: 0 },
      { moduleType: "cannon", x: 1, y: 2, rotation: 0 },
    ],
  };
}
