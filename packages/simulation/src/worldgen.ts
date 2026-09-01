// Procedural world generation (DESIGN §12). Deterministic from a fixed seed so
// restarts recreate the same base galaxy even before persistence exists.

import { WORLD, HOME_PLANET } from "@space/config";
import type { PlanetState, ResourceLocation, ResourceType } from "./types.js";
import { mulberry32, type Rng } from "./rng.js";
import { deterministicId } from "./ids.js";

const SYL_A = ["Ka", "Zo", "Vel", " Tir".trim(), "Nyx", "Or", "Ael", "Bru", "Cel", "Dra"];
const SYL_B = ["ran", "dus", "mir", "lox", "phi", "tex", "vor", "nul", "ket", "sar"];
const SYL_C = ["", "-I", "-II", " Prime", " Minor", " IX", "-B"];

function planetName(rng: Rng): string {
  return rng.pick(SYL_A) + rng.pick(SYL_B) + rng.pick(SYL_C);
}

export function generatePlanets(seed: number, nowMs: number): PlanetState[] {
  const rng = mulberry32(seed);
  const count = Math.floor(rng.range(WORLD.planetCountMin, WORLD.planetCountMax + 1));
  const planets: PlanetState[] = [];
  let attempts = 0;
  const maxAttempts = count * 200;

  while (planets.length < count && attempts < maxAttempts) {
    attempts++;
    const x = rng.range(-WORLD.width / 2, WORLD.width / 2);
    const y = rng.range(-WORLD.height / 2, WORLD.height / 2);
    const sep = WORLD.minPlanetSeparation;
    if (planets.some((p) => (p.position.x - x) ** 2 + (p.position.y - y) ** 2 < sep * sep)) continue;

    const idx = planets.length;
    planets.push({
      id: deterministicId("planet", idx),
      name: planetName(rng),
      position: { x, y },
      radius: rng.range(50, 120),
      resourceRates: {
        metalPerSec: rng.range(0.8, 3.5),
        fuelPerSec: rng.range(0.4, 1.8),
      },
      resourceUpdatedAtMs: nowMs,
      storedResources: { metal: 0, fuel: 0 },
      facilities: [],
      constructionQueue: [],
    });
  }
  return planets;
}

const FIELD_KIND = ["Asteroid Field", "Gas Cloud", "Ice Belt", "Ore Ring", "Debris Field"];

/** Seed standalone mineable resource locations away from planets (plan 030). Deterministic. */
export function generateResourceLocations(seed: number, planets: PlanetState[]): ResourceLocation[] {
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const count = Math.floor(rng.range(8, 14));
  const locations: ResourceLocation[] = [];
  let attempts = 0;
  while (locations.length < count && attempts < count * 200) {
    attempts++;
    const x = rng.range(-WORLD.width / 2, WORLD.width / 2);
    const y = rng.range(-WORLD.height / 2, WORLD.height / 2);
    const sep = 700;
    if (planets.some((p) => (p.position.x - x) ** 2 + (p.position.y - y) ** 2 < sep * sep)) continue;
    if (locations.some((l) => (l.position.x - x) ** 2 + (l.position.y - y) ** 2 < sep * sep)) continue;
    const idx = locations.length;
    const primary: ResourceType = rng.range(0, 1) < 0.6 ? "metal" : "fuel";
    const deposits = [
      {
        resource: primary,
        richness: rng.range(0.6, 1.5),
        reserves: Math.floor(rng.range(20_000, 120_000)),
        accessibility: rng.range(0.4, 1.0),
      },
    ];
    if (rng.range(0, 1) < 0.4) {
      deposits.push({
        resource: primary === "metal" ? "fuel" : "metal",
        richness: rng.range(0.6, 1.2),
        reserves: Math.floor(rng.range(10_000, 60_000)),
        accessibility: rng.range(0.4, 1.0),
      });
    }
    locations.push({
      id: deterministicId("field", idx),
      name: `${rng.pick(FIELD_KIND)} ${idx + 1}`,
      position: { x, y },
      radius: rng.range(60, 140),
      deposits,
    });
  }
  return locations;
}

/** Materialize a home planet for a new player (DESIGN §12.1 — pick an unowned planet). */
export function makeHomePlanet(planet: PlanetState, ownerId: string, nowMs: number): void {
  planet.ownerId = ownerId;
  planet.radius = HOME_PLANET.radius;
  planet.resourceRates = { metalPerSec: HOME_PLANET.metalPerSec, fuelPerSec: HOME_PLANET.fuelPerSec };
  planet.resourceUpdatedAtMs = nowMs;
  planet.storedResources = { metal: 0, fuel: 0 };
}
