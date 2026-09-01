// Shared combat helpers for continuous, world-space fleet combat (plan 015 §11, 017).
// Targeting, room selection and damage are lifted from the old arena battle and reused
// unchanged; they operate on ShipRuntime runtime + persistent ShipState. Deterministic:
// all randomness comes from the caller-supplied seeded index.

import { COMBAT } from "@space/config";
import type {
  ShipRuntime,
  CombatEvent,
  EntityId,
  RoomState,
  ShipState,
  ShipTargetPriority,
  ShipPreferredRange,
  Vec2,
} from "./types.js";
import { computeDerived } from "./ship.js";
import { dist } from "./vec.js";

export const HIT_RADIUS = COMBAT.hitRadius;

/** Shortest distance from point q to the segment [a,b] (swept projectile hit test). */
export function segmentPointDistance(ax: number, ay: number, bx: number, by: number, q: Vec2): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(q.x - ax, q.y - ay);
  let t = ((q.x - ax) * dx + (q.y - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(q.x - (ax + t * dx), q.y - (ay + t * dy));
}

/** Preferred combat distance from a ship's doctrine (plan 015 §8). */
export function preferredRangeUnits(range: ShipPreferredRange): number {
  return range === "close" ? 160 : range === "long" ? 460 : 300;
}

/** Choose an enemy target for `self` per its ship doctrine (plan 015 §8). */
export function chooseTarget(
  self: ShipRuntime,
  enemies: ShipRuntime[],
  priority: ShipTargetPriority,
  ships: Map<EntityId, ShipState>,
): ShipRuntime | undefined {
  const alive = enemies.filter((e) => e.alive);
  if (alive.length === 0) return undefined;
  const hullOf = (a: ShipRuntime) => ships.get(a.shipId)?.hull.maxHp ?? 0;
  const nearest = () =>
    alive.reduce((best, e) => (dist(self.position, e.position) < dist(self.position, best.position) ? e : best));
  if (priority === "small_ships") {
    return alive.reduce((best, e) => (hullOf(e) < hullOf(best) ? e : best));
  }
  if (priority === "large_ships") {
    return alive.reduce((best, e) => (hullOf(e) > hullOf(best) ? e : best));
  }
  return nearest();
}

/** Pick a live room to take a hit (deterministic via seeded pickIndex). */
export function pickTargetRoom(ship: ShipState, pickIndex: number): RoomState | undefined {
  const alive = ship.rooms.filter((r) => r.hp > 0);
  if (alive.length === 0) return undefined;
  return alive[pickIndex % alive.length];
}

/** Apply one hit: shields first, then a room, then hull overflow (plan 015 §11). */
export function applyDamage(
  target: ShipRuntime,
  targetShip: ShipState,
  damage: number,
  pickIndex: number,
  events: CombatEvent[],
): void {
  let remaining = damage;
  if (target.shield > 0) {
    const absorbed = Math.min(target.shield, remaining);
    target.shield -= absorbed;
    remaining -= absorbed;
    events.push({ type: "hit", ship: target.shipId, damage: absorbed, shield: true });
    if (remaining <= 0) return;
  }
  const room = pickTargetRoom(targetShip, pickIndex);
  if (room) {
    const before = room.hp;
    room.hp = Math.max(0, room.hp - remaining);
    const overflow = remaining - (before - room.hp);
    events.push({ type: "hit", ship: target.shipId, roomId: room.id, damage: remaining, shield: false });
    if (before > 0 && room.hp === 0) {
      room.enabled = false;
      events.push({ type: "roomDisabled", ship: target.shipId, roomId: room.id });
    }
    if (overflow > 0) targetShip.hull.hp = Math.max(0, targetShip.hull.hp - overflow);
    targetShip.derived = computeDerived(targetShip.rooms); // recompute after room loss
  } else {
    targetShip.hull.hp = Math.max(0, targetShip.hull.hp - remaining);
  }
  if (targetShip.hull.hp <= 0) {
    target.alive = false;
    events.push({ type: "shipDestroyed", ship: target.shipId, position: { x: target.position.x, y: target.position.y } });
  }
}
