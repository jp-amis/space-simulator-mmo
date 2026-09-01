import { describe, expect, it } from "vitest";
import { stepStations } from "./operations.js";
import { bagTotal } from "./resources.js";
import type { GameState } from "./types.js";

function game(): GameState {
  return {
    players: new Map(),
    planets: new Map(),
    resourceLocations: new Map(),
    operations: new Map(),
    debris: [],
    stations: new Map(),
    ships: new Map(),
    fleets: new Map(),
    shipRuntime: new Map(),
    projectiles: [],
    rngState: 1,
    combatEvents: [],
  };
}

describe("mining stations (plan 034)", () => {
  it("auto-extracts from its location into storage and depletes the deposit", () => {
    const g = game();
    g.resourceLocations.set("loc", {
      id: "loc",
      name: "Belt",
      position: { x: 0, y: 0 },
      radius: 80,
      deposits: [{ resource: "metal", richness: 1, reserves: 1000, accessibility: 1 }],
    });
    g.stations.set("st", {
      id: "st",
      ownerId: "alice",
      name: "Belt Station",
      position: { x: 0, y: 0 },
      locationId: "loc",
      storage: {},
      capacity: 5000,
      extraction: 12,
      hp: 100,
      maxHp: 100,
    });
    const reservesBefore = g.resourceLocations.get("loc")!.deposits[0]!.reserves;
    for (let i = 0; i < 50; i++) stepStations(g, 100);
    const st = g.stations.get("st")!;
    expect(bagTotal(st.storage)).toBeGreaterThan(0);
    expect(g.resourceLocations.get("loc")!.deposits[0]!.reserves).toBeLessThan(reservesBefore);
  });

  it("stops extracting when the deposit is exhausted", () => {
    const g = game();
    g.resourceLocations.set("loc", {
      id: "loc",
      name: "Belt",
      position: { x: 0, y: 0 },
      radius: 80,
      deposits: [{ resource: "metal", richness: 1, reserves: 5, accessibility: 1 }],
    });
    g.stations.set("st", {
      id: "st",
      ownerId: "alice",
      name: "S",
      position: { x: 0, y: 0 },
      locationId: "loc",
      storage: {},
      capacity: 5000,
      extraction: 12,
      hp: 100,
      maxHp: 100,
    });
    for (let i = 0; i < 100; i++) stepStations(g, 100);
    expect(g.resourceLocations.get("loc")!.deposits[0]!.reserves).toBe(0);
    expect(bagTotal(g.stations.get("st")!.storage)).toBeCloseTo(5, 1);
  });
});
