import { describe, expect, it } from "vitest";
import { WORLD } from "@space/config";
import { generatePlanets } from "./worldgen.js";
import { mulberry32 } from "./rng.js";

describe("worldgen (DESIGN §12)", () => {
  it("is deterministic for a fixed seed", () => {
    const a = generatePlanets(12345, 0);
    const b = generatePlanets(12345, 0);
    expect(a.map((p) => [p.id, p.name, p.position])).toEqual(b.map((p) => [p.id, p.name, p.position]));
  });

  it("respects minimum planet separation", () => {
    const planets = generatePlanets(999, 0);
    for (let i = 0; i < planets.length; i++) {
      for (let j = i + 1; j < planets.length; j++) {
        const d = Math.hypot(
          planets[i]!.position.x - planets[j]!.position.x,
          planets[i]!.position.y - planets[j]!.position.y,
        );
        expect(d).toBeGreaterThanOrEqual(WORLD.minPlanetSeparation - 1e-6);
      }
    }
  });

  it("generates a bounded planet count", () => {
    const n = generatePlanets(1, 0).length;
    expect(n).toBeGreaterThanOrEqual(WORLD.planetCountMin);
    expect(n).toBeLessThanOrEqual(WORLD.planetCountMax);
  });
});

describe("rng determinism (DESIGN §7.3)", () => {
  it("same seed yields the same sequence", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()]);
  });
});
