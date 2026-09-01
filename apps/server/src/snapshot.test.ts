import { describe, expect, it } from "vitest";
import { stepWorld, type FleetState } from "@space/simulation";
import { createGameState, getOrCreatePlayer } from "./world.js";
import { buildSensedShips, getVisibleState } from "./snapshot.js";

/** Position a fleet's anchor and materialize its ship runtime by stepping once. */
function placeFleet(game: ReturnType<typeof createGameState>, fleet: FleetState, x: number, y: number, now: number): void {
  fleet.position = { x, y };
  fleet.order = { kind: "hold", anchor: { x, y } };
  for (const id of fleet.shipIds) game.shipRuntime.delete(id); // respawn at the new anchor slot
  stepWorld(game, 50, now);
}

describe("sensed enemy visibility (always-on, tight sensor)", () => {
  it("reveals a nearby enemy fleet coarsely — centroid marker, no anchor/doctrine", () => {
    const now = 1_000_000;
    const game = createGameState(now);
    const alice = getOrCreatePlayer(game, "alice", now);
    const bob = getOrCreatePlayer(game, "bob", now);
    const aliceHome = game.planets.get(alice.homePlanetId)!;

    const bobFleet = [...game.fleets.values()].find((f) => f.ownerId === bob.id) as FleetState;
    placeFleet(game, bobFleet, aliceHome.position.x + 200, aliceHome.position.y, now);

    const snap = getVisibleState(game, "alice", now);
    const seen = snap.fleets.find((f) => f.id === bobFleet.id);
    expect(seen).toBeTruthy();
    // Coarse only: no goal anchor, no doctrine leak.
    expect(seen!.anchor).toBeUndefined();
    expect(seen!.doctrine).toBeUndefined();
  });

  it("streams every sensed ship (own + enemy) in full detail, and hides ships out of range", () => {
    const now = 1_000_000;
    const game = createGameState(now);
    const alice = getOrCreatePlayer(game, "alice", now);
    const bob = getOrCreatePlayer(game, "bob", now);
    const aliceHome = game.planets.get(alice.homePlanetId)!;
    const bobFleet = [...game.fleets.values()].find((f) => f.ownerId === bob.id) as FleetState;

    // In range of alice's home planet sensor.
    placeFleet(game, bobFleet, aliceHome.position.x + 250, aliceHome.position.y, now);
    const inRange = buildSensedShips(game, "alice", now);
    const owners = new Set(inRange.ships.map((s) => s.ownerId));
    expect(owners.has("alice")).toBe(true);
    expect(owners.has(bob.id)).toBe(true);
    expect(inRange.ships.every((s) => !!s.blueprint && !!s.rooms)).toBe(true); // full detail

    // Far outside every sensor source → enemy ships vanish; own ships still stream.
    placeFleet(game, bobFleet, aliceHome.position.x + 50_000, aliceHome.position.y, now);
    const outRange = buildSensedShips(game, "alice", now);
    expect(outRange.ships.some((s) => s.ownerId === bob.id)).toBe(false);
    expect(outRange.ships.some((s) => s.ownerId === "alice")).toBe(true);
  });

  it("reveals resource deposits only within sensor range, and streams ship cargo (plan 030)", () => {
    const now = 1_000_000;
    const game = createGameState(now);
    const alice = getOrCreatePlayer(game, "alice", now);
    const aliceHome = game.planets.get(alice.homePlanetId)!;

    // Plant a deposit inside the home sensor radius; another far away.
    game.resourceLocations.set("near", {
      id: "near",
      name: "Near Field",
      position: { x: aliceHome.position.x + 300, y: aliceHome.position.y },
      radius: 80,
      deposits: [{ resource: "metal", richness: 1.2, reserves: 5000, accessibility: 0.8 }],
    });
    game.resourceLocations.set("far", {
      id: "far",
      name: "Far Field",
      position: { x: aliceHome.position.x + 60_000, y: aliceHome.position.y },
      radius: 80,
      deposits: [{ resource: "fuel", richness: 1.0, reserves: 5000, accessibility: 0.8 }],
    });

    const snap = getVisibleState(game, "alice", now);
    const ids = snap.resourceLocations.map((l) => l.id);
    expect(ids).toContain("near");
    expect(ids).not.toContain("far");
    expect(snap.resourceLocations.find((l) => l.id === "near")!.deposits[0]!.resource).toBe("metal");
    // Own ships carry a cargo bag in their DTO.
    expect(snap.ships.every((s) => s.cargo !== undefined)).toBe(true);
  });
});
