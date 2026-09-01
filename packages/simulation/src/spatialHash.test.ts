import { describe, expect, it } from "vitest";
import { SpatialHash } from "./spatialHash.js";
import type { MovementPlan } from "./types.js";

const plan = (fx: number, fy: number, tx: number, ty: number): MovementPlan => ({
  from: { x: fx, y: fy },
  to: { x: tx, y: ty },
  startMs: 0,
  endMs: 1000,
  speed: 1,
  revision: 1,
});

describe("SpatialHash broad phase (DESIGN §5.4)", () => {
  it("finds a fleet whose swept bounds overlap", () => {
    const h = new SpatialHash(1000);
    h.index("a", plan(0, 0, 5000, 0), 100);
    h.index("b", plan(2500, -100, 2500, 100), 100);
    expect(h.query("a", plan(0, 0, 5000, 0), 100).has("b")).toBe(true);
  });

  it("excludes far-away fleets", () => {
    const h = new SpatialHash(1000);
    h.index("a", plan(0, 0, 1000, 0), 100);
    h.index("b", plan(0, 50000, 1000, 50000), 100);
    expect(h.query("a", plan(0, 0, 1000, 0), 100).has("b")).toBe(false);
  });

  it("re-indexing moves a fleet's cells and removes old ones", () => {
    const h = new SpatialHash(1000);
    h.index("a", plan(0, 0, 100, 0), 50);
    h.index("a", plan(90000, 0, 90100, 0), 50); // relocated
    const before = h.query("x", plan(0, 0, 100, 0), 50);
    expect(before.has("a")).toBe(false);
  });

  it("remove clears all cells", () => {
    const h = new SpatialHash(1000);
    h.index("a", plan(0, 0, 5000, 0), 100);
    h.remove("a");
    expect(h.cellCount).toBe(0);
  });
});
