import { describe, expect, it } from "vitest";
import { closestApproach, positionAt, velocityOf } from "./movement.js";
import type { MovementPlan } from "./types.js";

const plan = (fx: number, fy: number, tx: number, ty: number, s: number, e: number): MovementPlan => ({
  from: { x: fx, y: fy },
  to: { x: tx, y: ty },
  startMs: s,
  endMs: e,
  speed: 1,
  revision: 1,
});

describe("positionAt", () => {
  const m = plan(0, 0, 100, 0, 1000, 2000);
  it("returns origin before start", () => expect(positionAt(m, 500)).toEqual({ x: 0, y: 0 }));
  it("returns origin at start", () => expect(positionAt(m, 1000)).toEqual({ x: 0, y: 0 }));
  it("interpolates mid", () => expect(positionAt(m, 1500)).toEqual({ x: 50, y: 0 }));
  it("returns destination at end", () => expect(positionAt(m, 2000)).toEqual({ x: 100, y: 0 }));
  it("returns destination after end", () => expect(positionAt(m, 9999)).toEqual({ x: 100, y: 0 }));
  it("zero-distance target stays put", () => {
    const z = plan(5, 5, 5, 5, 0, 0);
    expect(positionAt(z, 100)).toEqual({ x: 5, y: 5 });
    expect(velocityOf(z)).toEqual({ x: 0, y: 0 });
  });
});

describe("closestApproach (DESIGN §5.3)", () => {
  it("exact crossing at same time → distance ~0", () => {
    const a = plan(-100, 0, 100, 0, 0, 2000);
    const b = plan(0, -100, 0, 100, 0, 2000);
    const ca = closestApproach(a, b)!;
    expect(ca).not.toBeNull();
    expect(ca.distance).toBeLessThan(1);
    expect(ca.tMs).toBeCloseTo(1000, 0);
  });

  it("paths cross in space but at different times → large distance", () => {
    const a = plan(-100, 0, 100, 0, 0, 2000);
    const b = plan(0, -100, 0, 100, 10000, 12000); // same X-crossing much later
    expect(closestApproach(a, b)).toBeNull(); // no time overlap
  });

  it("parallel paths keep constant separation", () => {
    const a = plan(0, 0, 100, 0, 0, 1000);
    const b = plan(0, 50, 100, 50, 0, 1000);
    const ca = closestApproach(a, b)!;
    expect(ca.distance).toBeCloseTo(50, 5);
  });

  it("stationary target, mover passes near", () => {
    const mover = plan(-100, 10, 100, 10, 0, 2000);
    const still = plan(0, 0, 0, 0, 0, 2000);
    const ca = closestApproach(mover, still)!;
    expect(ca.distance).toBeCloseTo(10, 5);
  });

  it("fleet B starting later still generates an encounter over overlap", () => {
    const a = plan(-1000, 0, 1000, 0, 0, 10000); // speed 0.2/ms
    const b = plan(0, -1000, 0, 1000, 4000, 14000);
    const ca = closestApproach(a, b);
    expect(ca).not.toBeNull();
  });
});
