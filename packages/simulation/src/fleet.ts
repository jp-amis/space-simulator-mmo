// Fleet-level derived values (DESIGN §8.2 — slowest ship caps fleet speed) and
// continuous-combat doctrine presets + formation layout (plan 015 §4, §7).

import { COMBAT, FLEET } from "@space/config";
import type { DoctrinePreset, FleetDoctrine, FormationShape, ShipState, Vec2 } from "./types.js";

export function shipStrategicSpeed(ship: ShipState): number {
  const factor = Math.max(0.4, Math.min(1.6, ship.derived.thrust / 90));
  return FLEET.baseSpeed * factor;
}

/** Slowest ship caps the fleet; empty fleets fall back to base speed. */
export function calculateFleetStrategicSpeed(ships: ShipState[]): number {
  if (ships.length === 0) return FLEET.baseSpeed;
  return Math.max(
    40,
    ships.reduce((min, s) => Math.min(min, shipStrategicSpeed(s)), Infinity),
  );
}

/** Doctrine presets → continuous parameters (plan 015 §12, plan 020). */
export const DOCTRINE_PRESETS: Record<DoctrinePreset, FleetDoctrine> = {
  hold_fire: { preset: "hold_fire", aggression: 0.0, pursuit: 0.0, cohesion: 0.9, survival: 0.9 },
  return_fire: { preset: "return_fire", aggression: 0.25, pursuit: 0.1, cohesion: 0.8, survival: 0.7 },
  attack_on_sight: { preset: "attack_on_sight", aggression: 0.8, pursuit: 0.4, cohesion: 0.6, survival: 0.4 },
  pursue: { preset: "pursue", aggression: 0.85, pursuit: 0.95, cohesion: 0.5, survival: 0.3 },
  flee_if_attacked: { preset: "flee_if_attacked", aggression: 0.1, pursuit: 0.0, cohesion: 0.75, survival: 0.95 },
};

// Default to attack-on-sight so fleets that meet actually fight (a pair of purely
// defensive fleets would otherwise stand off forever). Players can pick a calmer
// doctrine per fleet.
export const DEFAULT_DOCTRINE: FleetDoctrine = { ...DOCTRINE_PRESETS.attack_on_sight };

// ---- Fleet formation presets (plan 027) ----

export const FORMATION_SHAPES: FormationShape[] = [
  "column",
  "line",
  "wedge",
  "echelon",
  "box",
  "screen",
  "protect",
  "loose",
];

/** Coarse tactical class derived from hull/module mix — drives which slot a ship fills. */
export type ShipRole = "heavy" | "line" | "light" | "support";

export function shipRole(ship: ShipState): ShipRole {
  const area = ship.hull.width * ship.hull.height;
  const weapons = ship.derived.weaponRoomIds.length;
  const cargo = ship.derived.cargo ?? 0;
  if (weapons === 0 && cargo > 0) return "support"; // haulers/miners/valuable
  if (area >= 16) return "heavy";
  if (area <= 6) return "light";
  return "line";
}

/** Which roles fill the priority slots (index 0..) for a given shape. */
function roleOrder(shape: FormationShape): ShipRole[] {
  switch (shape) {
    case "wedge":
      return ["heavy", "line", "light", "support"]; // toughest at the point
    case "screen":
      return ["light", "line", "heavy", "support"]; // pickets forward
    case "protect":
      return ["support", "heavy", "line", "light"]; // valuable to the centre slot
    default:
      return ["line", "heavy", "light", "support"];
  }
}

/** Ordered local-frame slot positions for `n` ships (index 0 = the shape's priority slot). */
function formationSlots(shape: FormationShape, n: number, spacing: number): Vec2[] {
  const out: Vec2[] = [];
  switch (shape) {
    case "column": {
      for (let i = 0; i < n; i++) out.push({ x: -i * spacing, y: 0 });
      break;
    }
    case "line": {
      for (let i = 0; i < n; i++) out.push({ x: 0, y: (i - (n - 1) / 2) * spacing });
      break;
    }
    case "loose": {
      const s = spacing * 2.2;
      for (let i = 0; i < n; i++) out.push({ x: 0, y: (i - (n - 1) / 2) * s });
      break;
    }
    case "echelon": {
      for (let i = 0; i < n; i++) out.push({ x: -i * spacing, y: i * spacing });
      break;
    }
    case "wedge": {
      // Expanding rows behind a single point ship; heavies (index 0) at the point.
      let placed = 0;
      let d = 0;
      while (placed < n) {
        const inRow = Math.min(d + 1, n - placed);
        for (let k = 0; k < inRow; k++) out.push({ x: -d * spacing, y: (k - (inRow - 1) / 2) * spacing });
        placed += inRow;
        d++;
      }
      break;
    }
    case "box": {
      const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
      for (let i = 0; i < n; i++) {
        const row = Math.floor(i / cols);
        const col = i % cols;
        out.push({ x: -row * spacing, y: (col - (cols - 1) / 2) * spacing });
      }
      break;
    }
    case "screen": {
      // Front screen (first half) spread wide; the main body in a line behind.
      const front = Math.ceil(n / 2);
      for (let i = 0; i < front; i++) out.push({ x: spacing, y: (i - (front - 1) / 2) * spacing * 1.4 });
      const rear = n - front;
      for (let i = 0; i < rear; i++) out.push({ x: -spacing, y: (i - (rear - 1) / 2) * spacing });
      break;
    }
    case "protect": {
      // Valuable ship at the centre (slot 0); the rest ring around it.
      out.push({ x: 0, y: 0 });
      const ring = n - 1;
      const r = spacing * 1.3;
      for (let k = 0; k < ring; k++) {
        const a = (2 * Math.PI * k) / ring;
        out.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
      }
      break;
    }
  }
  return out;
}

/**
 * Assign each ship a formation slot relative to the fleet anchor (local frame, +x =
 * heading), according to the fleet's chosen `shape`. Placement is by ship **role** (heavier/
 * valuable ships take the shape's priority slots), not selection order. Offsets are
 * re-centred so the fleet's centroid sits on the anchor. Soft objective — the ship brain
 * steers toward it but combat can pull ships away.
 */
export function computeFormationOffsets(ships: ShipState[], shape: FormationShape = "column"): Map<string, Vec2> {
  const out = new Map<string, Vec2>();
  if (ships.length === 0) return out;
  const spacing = COMBAT.formationSpacing;
  const order = roleOrder(shape);
  // Deterministic role-priority ordering (tie-break by id) → slot index.
  const ordered = [...ships].sort((a, b) => {
    const ra = order.indexOf(shipRole(a));
    const rb = order.indexOf(shipRole(b));
    if (ra !== rb) return ra - rb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const slots = formationSlots(shape, ordered.length, spacing);
  // Re-centre so the shape is balanced on the anchor (fleet centroid ≈ anchor).
  let mx = 0;
  let my = 0;
  for (const s of slots) {
    mx += s.x;
    my += s.y;
  }
  mx /= slots.length;
  my /= slots.length;
  ordered.forEach((ship, i) => {
    const s = slots[i] ?? { x: 0, y: 0 };
    out.set(ship.id, { x: s.x - mx, y: s.y - my });
  });
  return out;
}

