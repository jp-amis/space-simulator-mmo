// Continuous movement as a function of time (DESIGN §5.1) and relative-motion
// closest-approach detection (DESIGN §5.3). Pure functions — unit tested.

import type { MovementPlan, Vec2 } from "./types.js";
import { dot, sub } from "./vec.js";

/** Position of a movement plan at an absolute timestamp (DESIGN §5.1). */
export function positionAt(m: MovementPlan, nowMs: number): Vec2 {
  if (nowMs <= m.startMs) return { x: m.from.x, y: m.from.y };
  if (nowMs >= m.endMs) return { x: m.to.x, y: m.to.y };
  const t = (nowMs - m.startMs) / (m.endMs - m.startMs);
  return {
    x: m.from.x + (m.to.x - m.from.x) * t,
    y: m.from.y + (m.to.y - m.from.y) * t,
  };
}

/** Constant velocity of a plan (units/ms). Zero-duration plans have zero velocity. */
export function velocityOf(m: MovementPlan): Vec2 {
  const dur = m.endMs - m.startMs;
  if (dur <= 0) return { x: 0, y: 0 };
  return { x: (m.to.x - m.from.x) / dur, y: (m.to.y - m.from.y) / dur };
}

export interface ClosestApproach {
  tMs: number; // absolute timestamp of closest approach within overlap
  distance: number;
}

/**
 * Closest approach of two moving fleets over their overlapping active interval
 * (DESIGN §5.3 "Relative-motion closest approach"). Returns null if their time
 * intervals do not overlap. Positions are evaluated with positionAt so pre-start
 * / post-arrival segments are treated as stationary endpoints.
 */
export function closestApproach(a: MovementPlan, b: MovementPlan): ClosestApproach | null {
  const t0 = Math.max(a.startMs, b.startMs);
  const t1 = Math.min(a.endMs, b.endMs);
  if (t1 < t0) return null;

  // Within [t0,t1] both are strictly moving with constant velocity.
  const a0 = positionAt(a, t0);
  const b0 = positionAt(b, t0);
  const va = velocityOf(a);
  const vb = velocityOf(b);
  const r0 = sub(a0, b0);
  const vRel = { x: va.x - vb.x, y: va.y - vb.y };
  const vv = dot(vRel, vRel);

  let tClosest: number;
  if (vv === 0) {
    tClosest = t0; // parallel / identical velocity — distance constant
  } else {
    const rawOffset = -dot(r0, vRel) / vv; // ms after t0
    tClosest = Math.min(Math.max(t0 + rawOffset, t0), t1);
  }
  const pa = positionAt(a, tClosest);
  const pb = positionAt(b, tClosest);
  return { tMs: tClosest, distance: Math.hypot(pa.x - pb.x, pa.y - pb.y) };
}

/** Axis-aligned swept bounding box of a movement plan, padded by `pad`. */
export function sweptBounds(
  m: MovementPlan,
  pad: number,
): { minX: number; minY: number; maxX: number; maxY: number } {
  return {
    minX: Math.min(m.from.x, m.to.x) - pad,
    minY: Math.min(m.from.y, m.to.y) - pad,
    maxX: Math.max(m.from.x, m.to.x) + pad,
    maxY: Math.max(m.from.y, m.to.y) + pad,
  };
}
