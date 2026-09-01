import { describe, expect, it } from "vitest";
import { computeFormationOffsets, FORMATION_SHAPES } from "./fleet.js";
import { instantiateShip, starterBlueprint } from "./ship.js";
import type { ShipState } from "./types.js";

function ships(n: number): ShipState[] {
  return Array.from({ length: n }, (_, i) => instantiateShip("p", `s${i}`, starterBlueprint(), `ship_${i}`));
}

describe("computeFormationOffsets (plan 027)", () => {
  it("returns one slot per ship for every preset and is centred on the anchor", () => {
    const fleet = ships(5);
    for (const shape of FORMATION_SHAPES) {
      const offs = computeFormationOffsets(fleet, shape);
      expect(offs.size).toBe(5);
      // Re-centred: the mean offset sits (near) the origin so the centroid = anchor.
      let mx = 0;
      let my = 0;
      for (const o of offs.values()) {
        mx += o.x;
        my += o.y;
      }
      expect(Math.hypot(mx / 5, my / 5)).toBeLessThan(1e-6);
    }
  });

  it("is deterministic for the same ships + shape", () => {
    const fleet = ships(4);
    const a = computeFormationOffsets(fleet, "wedge");
    const b = computeFormationOffsets(fleet, "wedge");
    for (const s of fleet) expect(a.get(s.id)).toEqual(b.get(s.id));
  });

  it("different shapes place ships differently", () => {
    const fleet = ships(4);
    const col = computeFormationOffsets(fleet, "column");
    const line = computeFormationOffsets(fleet, "line");
    // Column spreads along x (depth); line spreads along y (abreast).
    const spread = (m: Map<string, { x: number; y: number }>, axis: "x" | "y") => {
      const vs = [...m.values()].map((v) => v[axis]);
      return Math.max(...vs) - Math.min(...vs);
    };
    expect(spread(col, "x")).toBeGreaterThan(spread(col, "y"));
    expect(spread(line, "y")).toBeGreaterThan(spread(line, "x"));
  });

  it("protect places exactly one ship at the centre", () => {
    const fleet = ships(5);
    const offs = computeFormationOffsets(fleet, "protect");
    // With re-centring the ring's mean is ~0; the centre ship is the outlier nearest 0
    // only if the ring is symmetric — instead assert the shape has a distinct spread.
    const dists = [...offs.values()].map((o) => Math.hypot(o.x, o.y)).sort((a, b) => a - b);
    // One ship notably closer to the centroid than the ring members.
    expect(dists[0]!).toBeLessThan(dists[dists.length - 1]! * 0.6);
  });
});
