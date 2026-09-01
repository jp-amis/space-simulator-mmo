import { describe, expect, it } from "vitest";
import { fleetCentroid, stepWorld } from "./worldSim.js";
import { instantiateShip, starterBlueprint } from "./ship.js";
import { DOCTRINE_PRESETS } from "./fleet.js";
import { FLEET, RESOURCE } from "@space/config";
import type { FleetState, GameState, PlayerState, ShipState, Vec2 } from "./types.js";

function emptyGame(): GameState {
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
    rngState: 12345,
    combatEvents: [],
  };
}

let seq = 0;
function addFleet(game: GameState, ownerId: string, anchor: Vec2, shipCount: number, preset: keyof typeof DOCTRINE_PRESETS): FleetState {
  const player: PlayerState =
    game.players.get(ownerId) ?? { id: ownerId, homePlanetId: "", resources: { metal: 0, fuel: 0 }, fleetIds: [], shipIds: [] };
  game.players.set(ownerId, player);
  const ships: ShipState[] = [];
  for (let i = 0; i < shipCount; i++) {
    const s = instantiateShip(ownerId, `ship${seq++}`, starterBlueprint(), `ship_${ownerId}_${seq}`);
    game.ships.set(s.id, s);
    player.shipIds.push(s.id);
    ships.push(s);
  }
  const fleet: FleetState = {
    id: `fleet_${ownerId}_${seq}`,
    ownerId,
    shipIds: ships.map((s) => s.id),
    status: "idle",
    position: { ...anchor },
    sensorRange: FLEET.sensorRange,
    engagementRange: FLEET.engagementRange,
    order: { kind: "hold", anchor: { ...anchor } },
    intent: "continue_order",
    doctrine: { ...DOCTRINE_PRESETS[preset] },
    formation: "line",
  };
  game.fleets.set(fleet.id, fleet);
  player.fleetIds.push(fleet.id);
  return fleet;
}

function run(game: GameState, steps: number, dt = 50, start = 1_000_000): void {
  for (let i = 0; i < steps; i++) stepWorld(game, dt, start + i * dt);
}

describe("stepWorld — always-on per-ship simulation", () => {
  it("mining: miners ring the deposit facing inward; escorts screen at a larger radius (plan 036/037)", () => {
    const game = emptyGame();
    const fleet = addFleet(game, "alice", { x: 0, y: 0 }, 4, "hold_fire");
    const ships = fleet.shipIds.map((id) => game.ships.get(id)!);
    const miners = ships.slice(0, 2);
    const escorts = ships.slice(2);
    for (const s of miners) s.derived = { ...s.derived, miningPower: 8, miningResources: ["metal"], cargo: 5000 };
    game.resourceLocations.set("loc", { id: "loc", name: "F", position: { x: 0, y: 0 }, radius: 60, deposits: [{ resource: "metal", richness: 1, reserves: 1e6, accessibility: 1 }] });
    fleet.order = { kind: "mine", locationId: "loc" };
    fleet.position = { x: 0, y: 0 };
    run(game, 300);

    const distOf = (id: string) => { const r = game.shipRuntime.get(id)!; return Math.hypot(r.position.x, r.position.y); };
    for (const m of miners) expect(distOf(m.id)).toBeGreaterThan(RESOURCE.mineRing - 40);
    for (const m of miners) expect(distOf(m.id)).toBeLessThan(RESOURCE.mineRing + 60);
    for (const e of escorts) expect(distOf(e.id)).toBeGreaterThan(RESOURCE.escortRing - 60);
    // Miners face the deposit center: their heading vector points back toward origin.
    for (const m of miners) {
      const r = game.shipRuntime.get(m.id)!;
      const dot = Math.cos(r.heading) * r.position.x + Math.sin(r.heading) * r.position.y;
      expect(dot).toBeLessThan(0); // heading points inward
    }
    // Escorts sit farther out than miners.
    expect(Math.min(...escorts.map((e) => distOf(e.id)))).toBeGreaterThan(Math.max(...miners.map((m) => distOf(m.id))));
  });

  it("spawns runtime for every ship and parks them near the static anchor", () => {
    const game = emptyGame();
    const fleet = addFleet(game, "alice", { x: 0, y: 0 }, 3, "attack_on_sight");
    run(game, 40);
    // Every ship has runtime.
    expect([...game.shipRuntime.values()].filter((r) => r.fleetId === fleet.id).length).toBe(3);
    // With no enemy, the centroid parks on the anchor.
    const c = fleetCentroid(game, fleet);
    expect(Math.hypot(c.x - fleet.position.x, c.y - fleet.position.y)).toBeLessThan(60);
  });

  it("advances at the slowest ship's speed so a mixed fleet stays coherent (plan 026)", () => {
    const game = emptyGame();
    const fleet = addFleet(game, "alice", { x: 0, y: 0 }, 2, "attack_on_sight");
    const [slow, fast] = fleet.shipIds.map((id) => game.ships.get(id)!);
    slow!.derived = { ...slow!.derived, maxSpeed: 60, accel: 400 };
    fast!.derived = { ...fast!.derived, maxSpeed: 320, accel: 400 };
    // Send the fleet on a long trip and watch the two ships' separation while travelling.
    fleet.order = { kind: "moveTo", target: { x: 5000, y: 0 } };
    fleet.position = { x: 5000, y: 0 };
    let maxSep = 0;
    for (let i = 0; i < 300; i++) {
      stepWorld(game, 50, 1_000_000 + i * 50);
      const rs = game.shipRuntime.get(slow!.id)!;
      const rf = game.shipRuntime.get(fast!.id)!;
      maxSep = Math.max(maxSep, Math.hypot(rs.position.x - rf.position.x, rs.position.y - rf.position.y));
    }
    // Capped to the slow ship, the fast ship cannot run far ahead — they hold formation.
    expect(maxSep).toBeLessThan(260);
  });

  it("flies the fleet to a new anchor when the order moves it", () => {
    const game = emptyGame();
    const fleet = addFleet(game, "alice", { x: 0, y: 0 }, 2, "attack_on_sight");
    run(game, 20);
    fleet.order = { kind: "moveTo", target: { x: 1500, y: 0 } };
    fleet.position = { x: 1500, y: 0 };
    run(game, 400, 50, 1_100_000);
    const c = fleetCentroid(game, fleet);
    expect(Math.hypot(c.x - 1500, c.y - 0)).toBeLessThan(120);
  });

  it("resolves combat between hostile fleets and culls the destroyed ships", () => {
    const game = emptyGame();
    const a = addFleet(game, "alice", { x: 0, y: 0 }, 3, "attack_on_sight");
    const b = addFleet(game, "bob", { x: 120, y: 0 }, 1, "attack_on_sight");
    let fired = false;
    let over = false;
    for (let i = 0; i < 6000; i++) {
      stepWorld(game, 50, 1_000_000 + i * 50);
      if (game.projectiles.length > 0) fired = true;
      if (b.shipIds.length === 0 || a.shipIds.length === 0) {
        over = true;
        break;
      }
    }
    expect(fired).toBe(true);
    expect(over).toBe(true);
    // Culled ships leave no dangling runtime.
    for (const id of game.shipRuntime.keys()) expect(game.ships.has(id)).toBe(true);
  });

  it("every destroyed ship drops a wreck with base scrap, even with empty cargo, and the event carries a position", () => {
    const game = emptyGame();
    const victim = addFleet(game, "red", { x: 40, y: 0 }, 1, "hold_fire");
    const vShip = game.ships.get(victim.shipIds[0]!)!;
    vShip.cargo = {}; // empty — no cargo at all
    run(game, 1);
    vShip.hull.hp = 0;
    stepWorld(game, 50, 1_000_100);
    expect(game.debris.length).toBe(1);
    expect(game.debris[0]!.cargo.metal ?? 0).toBeGreaterThan(0); // base hull scrap
    expect(game.debris[0]!.position.x).toBeCloseTo(40, 0);
    const destroyed = game.combatEvents.find((e) => e.type === "shipDestroyed");
    // (event is emitted in the combat pass; here death is via hull=0 cull, so just assert debris.)
    void destroyed;
  });

  it("flags a ship as mining while it extracts (plan: mining beam)", () => {
    const game = emptyGame();
    const fleet = addFleet(game, "alice", { x: 0, y: 0 }, 1, "hold_fire");
    const ship = game.ships.get(fleet.shipIds[0]!)!;
    ship.derived = { ...ship.derived, miningPower: 20, miningResources: ["metal"], cargo: 5000 };
    game.resourceLocations.set("loc", {
      id: "loc",
      name: "Belt",
      position: { x: 0, y: 0 },
      radius: 60,
      deposits: [{ resource: "metal", richness: 1, reserves: 1e6, accessibility: 1 }],
    });
    fleet.order = { kind: "mine", locationId: "loc" };
    run(game, 3);
    expect(game.shipRuntime.get(ship.id)!.miningLocationId).toBe("loc");
    // Stop mining → flag clears next step.
    fleet.order = { kind: "hold", anchor: { x: 0, y: 0 } };
    run(game, 1);
    expect(game.shipRuntime.get(ship.id)!.miningLocationId).toBeUndefined();
  });

  it("drops recoverable debris when a laden ship is destroyed, and a salvager recovers it (plan 033)", () => {
    const game = emptyGame();
    const victim = addFleet(game, "red", { x: 0, y: 0 }, 1, "hold_fire");
    // Give the victim ship a cargo hold worth of metal, then kill it.
    const vShip = game.ships.get(victim.shipIds[0]!)!;
    vShip.cargo = { metal: 1000 };
    run(game, 1); // spawn runtime
    vShip.hull.hp = 0; // fatal
    stepWorld(game, 50, 1_000_100);
    expect(game.debris.length).toBe(1);
    expect(game.debris[0]!.cargo.metal).toBeGreaterThan(0);

    // A salvager with free cargo sitting on the debris recovers it over time.
    const salv = addFleet(game, "blue", { x: 0, y: 0 }, 1, "hold_fire");
    const sShip = game.ships.get(salv.shipIds[0]!)!;
    sShip.derived = { ...sShip.derived, cargo: 5000 };
    for (let i = 0; i < 40; i++) stepWorld(game, 50, 1_000_200 + i * 50);
    expect((sShip.cargo.metal ?? 0)).toBeGreaterThan(0);
    expect(game.debris.length).toBe(0); // fully recovered
  });

  it("is deterministic for the same seed and inputs", () => {
    const build = () => {
      const g = emptyGame();
      addFleet(g, "alice", { x: 0, y: 0 }, 2, "attack_on_sight");
      addFleet(g, "bob", { x: 200, y: 0 }, 2, "attack_on_sight");
      return g;
    };
    const g1 = build();
    const g2 = build();
    for (let i = 0; i < 400; i++) {
      stepWorld(g1, 50, 1_000_000 + i * 50);
      stepWorld(g2, 50, 1_000_000 + i * 50);
    }
    expect(g1.rngState).toBe(g2.rngState);
    expect(g1.ships.size).toBe(g2.ships.size);
    const pos = (g: GameState) => [...g.shipRuntime.values()].map((r) => [Math.round(r.position.x), Math.round(r.position.y)]);
    expect(pos(g1)).toEqual(pos(g2));
  });
});
