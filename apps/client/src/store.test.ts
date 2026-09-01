import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveShipDto, PlayerVisibleSnapshot, ServerMessage } from "@space/protocol";
import { Store } from "./store.js";

let clock = 1000;
beforeEach(() => {
  clock = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});
afterEach(() => vi.restoreAllMocks());

function snapshot(fleets: PlayerVisibleSnapshot["fleets"], serverTimeMs = 100_000): ServerMessage {
  return {
    type: "snapshot",
    world: {
      serverTimeMs,
      you: { id: "alice", homePlanetId: "p", resources: { metal: 0, fuel: 0 }, fleetIds: [], shipIds: [] },
      planets: [],
      resourceLocations: [],
      operations: [],
      debris: [],
      stations: [],
      fleets,
      ships: [],
    },
  };
}

const ship = (over: Partial<ActiveShipDto> = {}): ActiveShipDto => ({
  shipId: "s",
  fleetId: "f",
  ownerId: "alice",
  position: { x: 0, y: 0 },
  heading: 0,
  shield: 0,
  maxShield: 0,
  hullHp: 100,
  hullMaxHp: 100,
  alive: true,
  ...over,
});

function activeRegion(
  ships: ActiveShipDto[],
  projectiles: any[] = [],
  events: any[] = [],
): ServerMessage {
  return { type: "activeRegion", delta: { serverTimeMs: 100_000, ships, projectiles, events } } as ServerMessage;
}

const ownFleet = (over: Partial<PlayerVisibleSnapshot["fleets"][number]> = {}) => ({
  id: "f",
  ownerId: "alice",
  position: { x: 0, y: 0 },
  status: "idle" as const,
  shipCount: 2,
  ...over,
});

describe("fleet marker rides the sensed-ship centroid", () => {
  it("returns the centroid of a fleet's streamed ships", () => {
    const store = new Store();
    store.applyServer(snapshot([ownFleet({ position: { x: 999, y: 999 } })]));
    store.applyServer(
      activeRegion([
        ship({ shipId: "a", fleetId: "f", position: { x: 100, y: 0 } }),
        ship({ shipId: "b", fleetId: "f", position: { x: 200, y: 0 } }),
      ]),
    );
    const p = store.fleetPosition(store.snapshot!.fleets[0]!);
    expect(p.x).toBeCloseTo(150, 3);
    expect(p.y).toBeCloseTo(0, 3);
  });

  it("falls back to the snapshot position when no ships are streamed", () => {
    const store = new Store();
    store.applyServer(snapshot([ownFleet({ position: { x: 42, y: 7 } })]));
    const p = store.fleetPosition(store.snapshot!.fleets[0]!);
    expect(p.x).toBeCloseTo(42, 3);
    expect(p.y).toBeCloseTo(7, 3);
  });

  it("exposes the static goal anchor separately from the marker", () => {
    const store = new Store();
    store.applyServer(snapshot([ownFleet({ anchor: { x: 500, y: -500 } })]));
    const anchor = store.fleetAnchor(store.snapshot!.fleets[0]!);
    expect(anchor).toEqual({ x: 500, y: -500 });
  });
});

describe("inCombat reflects own ships locked on a target", () => {
  it("is true when an own ship has a target, false when only enemies do", () => {
    const store = new Store();
    store.playerId = "alice";
    store.applyServer(activeRegion([ship({ shipId: "e", ownerId: "bob", targetShipId: "x" })]));
    expect(store.inCombat).toBe(false);
    store.applyServer(activeRegion([ship({ shipId: "a", ownerId: "alice", targetShipId: "e" })]));
    expect(store.inCombat).toBe(true);
  });
});

describe("projectile smoothing + explosions (plan 028)", () => {
  it("interpolates a projectile by its velocity and prunes it when it disappears", () => {
    const store = new Store();
    store.applyServer(activeRegion([], [{ id: "p1", position: { x: 0, y: 0 }, targetShipId: "t", velocity: { x: 100, y: 0 } }]));
    expect(store.projectiles.has("p1")).toBe(true);
    store.updateProjectiles(100); // +0.1s → dead-reckon forward
    expect(store.projectiles.get("p1")!.shown.x).toBeGreaterThan(0);
    // Next delta no longer contains it → removed on reconcile.
    store.applyServer(activeRegion([], []));
    expect(store.projectiles.has("p1")).toBe(false);
  });

  it("spawns an explosion at a destroyed ship's last position, then expires it", () => {
    const store = new Store();
    store.playerId = "alice";
    store.applyServer(activeRegion([ship({ shipId: "a", ownerId: "alice", position: { x: 50, y: 20 } })]));
    store.applyServer(activeRegion([], [], [{ type: "shipDestroyed", ship: "a", position: { x: 50, y: 20 } }]));
    expect(store.explosions.length).toBe(1);
    expect(store.explosions[0]!.x).toBeCloseTo(50, 3);
    expect(store.activeShips.has("a")).toBe(false);
    // After its lifetime the effect is pruned.
    clock += 700;
    store.updateProjectiles(16);
    expect(store.explosions.length).toBe(0);
  });

  it("spawns an explosion from the event position even if the ship was never streamed", () => {
    const store = new Store();
    store.playerId = "alice";
    // No activeShips entry for "z" — must still explode using the event's position.
    store.applyServer(activeRegion([], [], [{ type: "shipDestroyed", ship: "z", position: { x: 12, y: -8 } }]));
    expect(store.explosions.length).toBe(1);
    expect(store.explosions[0]!.x).toBeCloseTo(12, 3);
    expect(store.explosions[0]!.y).toBeCloseTo(-8, 3);
  });

  it("client-side death: a mortally-wounded ship that vanishes explodes; a healthy one does not (plan 040)", () => {
    const store = new Store();
    store.playerId = "alice";
    // Low-hull ship "a" is streamed, then disappears → explosion at its last position.
    store.applyServer(activeRegion([ship({ shipId: "a", ownerId: "bob", position: { x: 7, y: 3 }, hullHp: 4, hullMaxHp: 100 })]));
    store.applyServer(activeRegion([])); // "a" gone
    expect(store.explosions.length).toBe(1);
    expect(store.explosions[0]!.x).toBeCloseTo(7, 3);
    expect(store.activeShips.has("a")).toBe(false);

    // Healthy ship "b" that vanishes = left sensor range → no explosion.
    store.explosions = [];
    store.applyServer(activeRegion([ship({ shipId: "b", ownerId: "bob", hullHp: 100, hullMaxHp: 100 })]));
    store.applyServer(activeRegion([]));
    expect(store.explosions.length).toBe(0);
  });

  it("client-side death: a ship being shot at that vanishes explodes even at full-ish hull (plan 040)", () => {
    const store = new Store();
    store.playerId = "alice";
    // "c" is a lock target of "a"; then "c" vanishes → explode (one-shot kill heuristic).
    store.applyServer(
      activeRegion([
        ship({ shipId: "a", ownerId: "alice", targetShipId: "c" }),
        ship({ shipId: "c", ownerId: "bob", position: { x: 9, y: 0 }, hullHp: 80, hullMaxHp: 100 }),
      ]),
    );
    store.applyServer(activeRegion([ship({ shipId: "a", ownerId: "alice" })])); // "c" gone
    expect(store.explosions.length).toBe(1);
    expect(store.explosions[0]!.x).toBeCloseTo(9, 3);
  });
});
