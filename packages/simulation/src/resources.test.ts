import { describe, expect, it } from "vitest";
import { addToBag, bagTotal, cloneBag, transfer } from "./resources.js";
import { computeDerived, instantiateShip, starterBlueprint } from "./ship.js";
import { generateResourceLocations, generatePlanets } from "./worldgen.js";
import type { ResourceBag, RoomState } from "./types.js";

describe("resource bag helpers (plan 030)", () => {
  it("adds, totals and clones without negatives", () => {
    const b: ResourceBag = {};
    addToBag(b, "metal", 50);
    addToBag(b, "fuel", 20);
    addToBag(b, "metal", -100); // clamped at 0
    expect(b.metal).toBe(0);
    expect(bagTotal(b)).toBe(20);
    const c = cloneBag(b);
    c.fuel = 999;
    expect(b.fuel).toBe(20); // clone is independent
  });

  it("transfer conserves totals and respects stock + capacity", () => {
    const src: ResourceBag = { metal: 100 };
    const dst: ResourceBag = {};
    expect(transfer(src, dst, "metal", 40)).toBe(40);
    expect(src.metal).toBe(60);
    expect(dst.metal).toBe(40);
    // Bounded by remaining stock.
    expect(transfer(src, dst, "metal", 1000)).toBe(60);
    // Bounded by capacity left.
    src.metal = 100;
    expect(transfer(src, dst, "metal", 100, 10)).toBe(10);
  });
});

describe("mining derived stats (plan 030)", () => {
  it("a plain starter ship has no mining power; a mining room adds it", () => {
    const ship = instantiateShip("p", "s", starterBlueprint());
    expect(ship.derived.miningPower).toBe(0);
    expect(ship.cargo).toEqual({});
    // Synthesize a mining room and recompute.
    const rooms: RoomState[] = [
      ...ship.rooms,
      { id: "m1", kind: "mining", moduleType: "miningLaser", x: 0, y: 0, w: 1, h: 1, hp: 30, maxHp: 30, powerDemand: 6, enabled: true },
    ];
    const derived = computeDerived(rooms);
    expect(derived.miningPower).toBeGreaterThan(0);
    expect(derived.miningResources).toContain("metal");
    expect(derived.energy.consumption).toBeGreaterThan(0);
  });
});

describe("resource-location worldgen (plan 030)", () => {
  it("is deterministic and keeps a gap from planets", () => {
    const planets = generatePlanets(123, 0);
    const a = generateResourceLocations(123, planets);
    const b = generateResourceLocations(123, planets);
    expect(a.length).toBeGreaterThan(0);
    expect(a.map((l) => [Math.round(l.position.x), Math.round(l.position.y)])).toEqual(
      b.map((l) => [Math.round(l.position.x), Math.round(l.position.y)]),
    );
    for (const l of a) {
      expect(l.deposits.length).toBeGreaterThan(0);
      for (const p of planets) expect(Math.hypot(l.position.x - p.position.x, l.position.y - p.position.y)).toBeGreaterThan(699);
    }
  });
});
