import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@space/protocol";
import { fleetCentroid } from "@space/simulation";
import { GameServer } from "./engine.js";

// Headless harness: capture emitted messages per player and drive a fake clock.
function harness() {
  const inbox = new Map<string, ServerMessage[]>();
  let clock = 1_000_000;
  const engine = new GameServer(
    (pid, msg) => {
      (inbox.get(pid) ?? inbox.set(pid, []).get(pid)!).push(msg);
    },
    () => clock,
    { seedNpcs: false },
  );
  const drain = (pid: string) => inbox.get(pid) ?? [];
  const advance = (ms: number) => {
    clock += ms;
    engine.tick(clock);
  };
  const setClock = (ms: number) => (clock = ms);
  return { engine, drain, advance, setClock, now: () => clock };
}

function ownFleet(engine: GameServer, playerId: string) {
  return [...engine.game.fleets.values()].find((f) => f.ownerId === playerId)!;
}

describe("player registry (DESIGN §10.1, plan 002)", () => {
  it("creates separate in-memory players and sends welcome + snapshot", () => {
    const { engine, drain } = harness();
    expect(engine.connect("alice").ok).toBe(true);
    expect(engine.connect("bob").ok).toBe(true);
    const a = drain("alice");
    expect(a[0]).toMatchObject({ type: "welcome", playerId: "alice" });
    expect(a[1]!.type).toBe("snapshot");
    expect(engine.game.players.has("alice")).toBe(true);
    expect(engine.game.players.has("bob")).toBe(true);
    expect(engine.game.players.get("alice")!.homePlanetId).not.toBe(
      engine.game.players.get("bob")!.homePlanetId,
    );
  });

  it("rejects a second connection while the id is still connected", () => {
    const { engine } = harness();
    expect(engine.connect("alice").ok).toBe(true);
    const second = engine.connect("alice");
    expect(second.ok).toBe(false);
    engine.disconnect("alice");
    expect(engine.connect("alice").ok).toBe(true); // reconnect after close
  });

  it("returns the same state on reconnect", () => {
    const { engine } = harness();
    engine.connect("alice");
    const shipCount = engine.game.players.get("alice")!.shipIds.length;
    engine.disconnect("alice");
    engine.connect("alice");
    expect(engine.game.players.get("alice")!.shipIds.length).toBe(shipCount);
  });
});

describe("fleet movement (static anchor + always-on ships)", () => {
  it("jumps the anchor to the click and ships fly there, then park idle", () => {
    const { engine, advance } = harness();
    engine.connect("alice");
    const fleet = ownFleet(engine, "alice");
    const start = fleetCentroid(engine.game, fleet);
    const target = { x: start.x + 1200, y: start.y };
    engine.handle("alice", { type: "moveFleet", requestId: "r1", fleetId: fleet.id, target });
    // Anchor teleports to the target immediately; status flips to moving.
    expect(fleet.position.x).toBeCloseTo(target.x, 0);
    expect(fleet.status).toBe("moving");
    // Ships accelerate toward the anchor and eventually arrive + park.
    let arrived = false;
    for (let i = 0; i < 600; i++) {
      advance(50);
      const c = fleetCentroid(engine.game, fleet);
      if (Math.hypot(c.x - target.x, c.y - target.y) < 80) {
        arrived = true;
        break;
      }
    }
    expect(arrived).toBe(true);
    // Once parked, the fleet reports idle.
    for (let i = 0; i < 40; i++) advance(50);
    expect(engine.game.fleets.get(fleet.id)!.status).toBe("idle");
  });

  it("rejects moving a fleet you do not own without mutating state", () => {
    const { engine, drain } = harness();
    engine.connect("alice");
    engine.connect("bob");
    const bobFleet = ownFleet(engine, "bob");
    const before = { ...bobFleet.position };
    engine.handle("alice", { type: "moveFleet", requestId: "rx", fleetId: bobFleet.id, target: { x: 1, y: 1 } });
    expect(drain("alice").some((m) => m.type === "reject")).toBe(true);
    expect(bobFleet.status).toBe("idle");
    expect(bobFleet.position).toEqual(before);
  });
});

describe("continuous combat (always-on per-ship sim)", () => {
  it("converging hostile fleets fight to a resolution; the loser is pruned", () => {
    const { engine, advance } = harness();
    engine.connect("alice");
    engine.connect("bob");
    const fa = ownFleet(engine, "alice");
    const fb = ownFleet(engine, "bob");
    engine.handle("alice", { type: "setDoctrine", requestId: "d1", fleetId: fa.id, preset: "attack_on_sight" });
    engine.handle("bob", { type: "setDoctrine", requestId: "d2", fleetId: fb.id, preset: "attack_on_sight" });
    engine.handle("alice", { type: "attackMove", requestId: "a1", fleetId: fa.id, target: { ...fb.position } });
    engine.handle("bob", { type: "attackMove", requestId: "b1", fleetId: fb.id, target: { ...fa.position } });

    let fired = false;
    let resolved = false;
    for (let i = 0; i < 8000; i++) {
      advance(50);
      if (engine.game.projectiles.length > 0) fired = true;
      const aShips = engine.game.fleets.get(fa.id)?.shipIds.length ?? 0;
      const bShips = engine.game.fleets.get(fb.id)?.shipIds.length ?? 0;
      if (fired && (aShips === 0 || bShips === 0)) {
        resolved = true;
        break;
      }
    }
    expect(fired).toBe(true);
    expect(resolved).toBe(true);
  });

  it("streams activeRegion deltas of every sensed ship (own + enemy)", () => {
    const { engine, drain, advance } = harness();
    engine.connect("alice");
    const fa = ownFleet(engine, "alice");
    engine.handle("alice", { type: "setDoctrine", requestId: "d", fleetId: fa.id, preset: "attack_on_sight" });
    // Own ships alone already stream (always-on); a hostile adds enemy ships in range.
    engine.handle("alice", { type: "spawnHostile", requestId: "s", near: { ...fa.position } });
    let delta: Extract<ServerMessage, { type: "activeRegion" }> | undefined;
    for (let i = 0; i < 200 && !delta; i++) {
      advance(50);
      delta = drain("alice").find((m): m is Extract<ServerMessage, { type: "activeRegion" }> => m.type === "activeRegion");
    }
    expect(delta).toBeTruthy();
    const owners = new Set(delta!.delta.ships.map((s) => s.ownerId));
    expect(owners.has("alice")).toBe(true); // own ships visible always
    expect([...owners].some((o) => o !== "alice")).toBe(true); // enemy visible within range
    // Full detail for both own and enemy sensed ships.
    expect(delta!.delta.ships.every((s) => !!s.blueprint && !!s.rooms)).toBe(true);
  });
});

describe("economy & construction (DESIGN §4.1, §6, plan 009)", () => {
  it("accumulates resources lazily and builds a ship on a scheduled completion", () => {
    const { engine, advance } = harness();
    engine.connect("alice");
    const player = engine.game.players.get("alice")!;
    const planet = engine.game.planets.get(player.homePlanetId)!;
    // Let resources accumulate.
    advance(20_000);
    const snap = engine.snapshotFor("alice");
    expect(snap.you.resources.metal).toBeGreaterThan(0);
    const before = player.shipIds.length;
    const bp = engine.game.ships.get(player.shipIds[0]!)!.blueprint;
    engine.handle("alice", { type: "buildShip", requestId: "b1", planetId: planet.id, blueprint: bp, name: "Built" });
    // Not finished yet.
    advance(1000);
    expect(engine.game.players.get("alice")!.shipIds.length).toBe(before);
    // After build time completes.
    advance(9000);
    expect(engine.game.players.get("alice")!.shipIds.length).toBe(before + 1);
  });
});

describe("fleet management (plan 012)", () => {
  it("splits ships into a new fleet and merges them back, dropping the empty fleet", () => {
    const { engine } = harness();
    engine.connect("alice");
    const player = engine.game.players.get("alice")!;
    const original = ownFleet(engine, "alice");
    expect(original.shipIds.length).toBe(2);
    const [s1] = original.shipIds;

    // Split: create a new fleet from one ship.
    engine.handle("alice", { type: "createFleet", requestId: "c1", shipIds: [s1!] });
    expect(player.fleetIds.length).toBe(2);
    const newFleet = engine.game.fleets.get(player.fleetIds[1]!)!;
    expect(newFleet.shipIds).toEqual([s1]);
    expect(engine.game.fleets.get(original.id)!.shipIds.length).toBe(1);

    // Merge: add the split ship back into the original fleet → new fleet emptied + removed.
    engine.handle("alice", { type: "addShipsToFleet", requestId: "a1", fleetId: original.id, shipIds: [s1!] });
    expect(engine.game.fleets.get(original.id)!.shipIds.length).toBe(2);
    expect(engine.game.fleets.has(newFleet.id)).toBe(false);
    expect(player.fleetIds.length).toBe(1);
  });

  it("rejects adding ships to a fleet you do not own", () => {
    const { engine, drain } = harness();
    engine.connect("alice");
    engine.connect("bob");
    const bobFleet = ownFleet(engine, "bob");
    const aliceShip = engine.game.players.get("alice")!.shipIds[0]!;
    engine.handle("alice", { type: "addShipsToFleet", requestId: "x", fleetId: bobFleet.id, shipIds: [aliceShip] });
    expect(drain("alice").some((m) => m.type === "reject")).toBe(true);
    expect(bobFleet.shipIds).not.toContain(aliceShip);
  });
});

describe("fleet orders (plan 020)", () => {
  it("hold stops the fleet; pursue chases a moving target", () => {
    const { engine, advance } = harness();
    engine.connect("alice");
    engine.connect("bob");
    const fa = ownFleet(engine, "alice");
    const fb = ownFleet(engine, "bob");
    const centroidOf = (id: string) => fleetCentroid(engine.game, engine.game.fleets.get(id)!);
    const gap = () => {
      const a = centroidOf(fa.id);
      const b = centroidOf(fb.id);
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    // Bob cruises away; Alice pursues and closes the gap between their fleets.
    engine.handle("bob", { type: "moveFleet", requestId: "b1", fleetId: fb.id, target: { x: fb.position.x + 6000, y: fb.position.y + 3000 } });
    engine.handle("alice", { type: "pursueFleet", requestId: "a1", fleetId: fa.id, targetFleetId: fb.id });
    const startGap = gap();
    for (let i = 0; i < 120; i++) advance(50);
    expect(gap()).toBeLessThan(startGap); // chased toward bob

    // Hold freezes the anchor at the fleet's current location.
    engine.handle("alice", { type: "holdFleet", requestId: "h1", fleetId: fa.id });
    const held = engine.game.fleets.get(fa.id)!.position.x;
    for (let i = 0; i < 20; i++) advance(50);
    expect(Math.abs(engine.game.fleets.get(fa.id)!.position.x - held)).toBeLessThan(1);
  });

  it("a miner offloads to a co-located storage ship so it can keep mining (plan 034)", () => {
    const { engine, advance } = harness();
    engine.connect("alice");
    const player = engine.game.players.get("alice")!;
    const fleet = ownFleet(engine, "alice");
    const [miner, storage] = fleet.shipIds.map((id) => engine.game.ships.get(id)!);
    // Storage ship = big cargo hold; give the miner a full-ish load.
    storage!.derived = { ...storage!.derived, cargo: 100_000 };
    miner!.derived = { ...miner!.derived, cargo: 1000 };
    miner!.cargo = { metal: 900 };
    for (let i = 0; i < 6; i++) advance(50); // materialize runtime + settle into formation
    void player;
    engine.handle("alice", { type: "transferCargo", requestId: "t1", fromShipId: miner!.id, toShipId: storage!.id });
    expect(miner!.cargo.metal ?? 0).toBe(0); // miner emptied → free to keep mining
    expect(storage!.cargo.metal ?? 0).toBe(900); // storage now holds it
  });

  it("salvageWreck sends the fleet to a wreck and it gets recovered (plan: clickable salvage)", () => {
    const { engine, advance } = harness();
    engine.connect("alice");
    const fa = ownFleet(engine, "alice");
    for (const id of fa.shipIds) {
      const s = engine.game.ships.get(id)!;
      s.derived = { ...s.derived, cargo: 5000 };
    }
    const at = { x: fa.position.x + 300, y: fa.position.y };
    engine.game.debris.push({ id: "w1", position: at, cargo: { metal: 800 }, ttlMs: 60_000 });
    engine.handle("alice", { type: "salvageWreck", requestId: "sv", fleetId: fa.id, debrisId: "w1" });
    expect(engine.game.fleets.get(fa.id)!.position.x).toBeCloseTo(at.x, 0); // anchor jumped to wreck
    let recovered = false;
    for (let i = 0; i < 300 && !recovered; i++) {
      advance(50);
      if (!engine.game.debris.find((d) => d.id === "w1")) recovered = true;
    }
    expect(recovered).toBe(true);
    const carried = fa.shipIds.reduce((sum, id) => sum + (engine.game.ships.get(id)!.cargo.metal ?? 0), 0);
    expect(carried).toBeGreaterThan(0);
  });

  it("builds a mining station that deducts resources, is a sensor source, and auto-extracts (plan 034)", () => {
    const { engine, drain, advance } = harness();
    engine.connect("alice");
    const player = engine.game.players.get("alice")!;
    const home = engine.game.planets.get(player.homePlanetId)!;
    home.storedResources = { metal: 1000, fuel: 1000 };
    // A resource field far from home (out of the home sensor), so the station provides vision.
    engine.game.resourceLocations.set("far", {
      id: "far",
      name: "Far Belt",
      position: { x: home.position.x + 8000, y: home.position.y },
      radius: 80,
      deposits: [{ resource: "metal", richness: 1.2, reserves: 500_000, accessibility: 1 }],
    });

    engine.handle("alice", { type: "buildStation", requestId: "b1", locationId: "far", planetId: home.id });
    expect(home.storedResources.metal).toBeLessThan(1000); // paid for it
    expect(engine.game.stations.size).toBe(1);
    // Duplicate on the same location is rejected.
    engine.handle("alice", { type: "buildStation", requestId: "b2", locationId: "far", planetId: home.id });
    expect(drain("alice").some((m) => m.type === "reject")).toBe(true);
    expect(engine.game.stations.size).toBe(1);

    // The far field is now sensed (station sensor) and the station auto-extracts.
    for (let i = 0; i < 40; i++) advance(50);
    const snap = engine.snapshotFor("alice");
    expect(snap.resourceLocations.some((l) => l.id === "far")).toBe(true);
    const st = [...engine.game.stations.values()][0]!;
    expect((st.storage.metal ?? 0)).toBeGreaterThan(0);
  });

  it("calls the nearest armed fleet to help when an operation's fleet is attacked (plan 033)", () => {
    const { engine, advance, now } = harness();
    engine.connect("alice");
    const player = engine.game.players.get("alice")!;
    const home = engine.game.planets.get(player.homePlanetId)!;
    const opFleet = ownFleet(engine, "alice");
    // Split off a second (military) fleet from one of the starter ships.
    const [, s2] = opFleet.shipIds;
    engine.handle("alice", { type: "createFleet", requestId: "c1", shipIds: [s2!] });
    const milFleet = engine.game.fleets.get(player.fleetIds[1]!)!;

    const at = { x: opFleet.position.x, y: opFleet.position.y };
    engine.game.resourceLocations.set("dep", { id: "dep", name: "F", position: at, radius: 60, deposits: [{ resource: "metal", richness: 1, reserves: 1e6, accessibility: 1 }] });
    engine.handle("alice", { type: "createOperation", requestId: "o1", fleetId: opFleet.id, locationId: "dep", deliveryPlanetId: home.id });

    // Mark the operation's fleet as under attack (decoupled from combat balance) and tick:
    // the owner's nearest idle armed fleet should be dispatched to help.
    engine.game.fleets.get(opFleet.id)!.underAttackUntil = now() + 5000;
    let responded = false;
    for (let i = 0; i < 10 && !responded; i++) {
      advance(50);
      if (engine.game.fleets.get(milFleet.id)?.order.kind === "attackMove") responded = true;
    }
    expect(responded).toBe(true);
  });

  it("runs an automated resource operation that delivers resources without manual clicks (plan 032)", () => {
    const { engine, advance } = harness();
    engine.connect("alice");
    const player = engine.game.players.get("alice")!;
    const fa = ownFleet(engine, "alice");
    const home = engine.game.planets.get(player.homePlanetId)!;
    for (const id of fa.shipIds) {
      const s = engine.game.ships.get(id)!;
      s.derived = { ...s.derived, miningPower: 40, miningResources: ["metal"], cargo: 2000 };
    }
    engine.game.resourceLocations.set("dep", {
      id: "dep",
      name: "Auto Field",
      position: { x: home.position.x + 900, y: home.position.y },
      radius: 60,
      deposits: [{ resource: "metal", richness: 1.5, reserves: 1_000_000, accessibility: 1 }],
    });
    const before = home.storedResources.metal;
    engine.handle("alice", { type: "createOperation", requestId: "o1", fleetId: fa.id, locationId: "dep", deliveryPlanetId: home.id });
    // Let it cycle: travel → mine → return → unload → repeat, several times.
    let cycledUnloading = false;
    let maxCarried = 0;
    for (let i = 0; i < 4000; i++) {
      advance(50);
      const op = [...engine.game.operations.values()][0];
      if (op?.state === "unloading") cycledUnloading = true;
      for (const id of fa.shipIds) maxCarried = Math.max(maxCarried, engine.game.ships.get(id)?.cargo.metal ?? 0);
    }
    expect(cycledUnloading).toBe(true);
    expect(home.storedResources.metal).toBeGreaterThan(before);
    // Miners fill essentially to capacity (2000), not the old 95% (plan 035).
    expect(maxCarried).toBeGreaterThan(1980);
    // The operation persists and keeps running.
    expect(engine.game.operations.size).toBe(1);
  });

  it("mines a deposit into cargo, then unloads it to the home planet (plan 031)", () => {
    const { engine, advance } = harness();
    engine.connect("alice");
    const player = engine.game.players.get("alice")!;
    const fa = ownFleet(engine, "alice");
    const home = engine.game.planets.get(player.homePlanetId)!;
    // Give the fleet's ships mining capability + place a rich deposit next to home.
    for (const id of fa.shipIds) {
      const s = engine.game.ships.get(id)!;
      s.derived = { ...s.derived, miningPower: 20, miningResources: ["metal"], cargo: 10_000 };
    }
    engine.game.resourceLocations.set("dep", {
      id: "dep",
      name: "Test Field",
      position: { x: home.position.x + 120, y: home.position.y },
      radius: 60,
      deposits: [{ resource: "metal", richness: 1.5, reserves: 100_000, accessibility: 1 }],
    });
    engine.handle("alice", { type: "mineResource", requestId: "m1", fleetId: fa.id, locationId: "dep" });
    for (let i = 0; i < 200; i++) advance(50); // fly there + mine
    const carried = fa.shipIds.reduce((sum, id) => sum + (engine.game.ships.get(id)!.cargo.metal ?? 0), 0);
    expect(carried).toBeGreaterThan(0);

    // Fly the fleet back home and unload — unload is now timed (streams over ticks, plan 038).
    engine.handle("alice", { type: "moveFleet", requestId: "mv", fleetId: fa.id, target: { ...home.position } });
    for (let i = 0; i < 200; i++) advance(50);
    const before = home.storedResources.metal;
    engine.handle("alice", { type: "unloadCargo", requestId: "u1", fleetId: fa.id, planetId: home.id });
    expect(engine.game.fleets.get(fa.id)!.order.kind).toBe("unloadAt"); // timed order issued
    let sawBeamFlag = false;
    for (let i = 0; i < 200; i++) {
      advance(50); // fly to the planet + stream cargo in
      if (fa.shipIds.some((id) => engine.game.shipRuntime.get(id)?.unloadLocationId === home.id)) sawBeamFlag = true;
    }
    expect(sawBeamFlag).toBe(true); // ship flagged as delivering → client draws the unload beam
    expect(home.storedResources.metal).toBeGreaterThan(before);
    // Cargo drains to (near) empty as it delivers.
    const left = fa.shipIds.reduce((sum, id) => sum + (engine.game.ships.get(id)?.cargo.metal ?? 0), 0);
    expect(left).toBeLessThan(carried);
  });

  it("setFormation updates the fleet's formation; rejects a fleet you do not own (plan 027)", () => {
    const { engine, drain } = harness();
    engine.connect("alice");
    engine.connect("bob");
    const fa = ownFleet(engine, "alice");
    engine.handle("alice", { type: "setFormation", requestId: "f1", fleetId: fa.id, formation: "wedge" });
    expect(engine.game.fleets.get(fa.id)!.formation).toBe("wedge");
    const fb = ownFleet(engine, "bob");
    const before = fb.formation;
    engine.handle("alice", { type: "setFormation", requestId: "f2", fleetId: fb.id, formation: "box" });
    expect(drain("alice").some((m) => m.type === "reject")).toBe(true);
    expect(engine.game.fleets.get(fb.id)!.formation).toBe(before);
  });

  it("pursue keeps a standoff distance and a stable anchor vs. a stationary target (plan 026)", () => {
    const { engine, advance } = harness();
    engine.connect("alice");
    engine.connect("bob");
    const fa = ownFleet(engine, "alice");
    const fb = ownFleet(engine, "bob");
    // Both hold fire so we measure standoff geometry without a fight resolving.
    engine.handle("alice", { type: "setDoctrine", requestId: "da", fleetId: fa.id, preset: "hold_fire" });
    engine.handle("bob", { type: "setDoctrine", requestId: "db", fleetId: fb.id, preset: "hold_fire" });
    // Bob stays put; Alice pursues until she settles on the standoff ring.
    engine.handle("alice", { type: "pursueFleet", requestId: "a1", fleetId: fa.id, targetFleetId: fb.id });
    for (let i = 0; i < 1000; i++) advance(50);

    const gap = () => {
      const a = fleetCentroid(engine.game, engine.game.fleets.get(fa.id)!);
      const b = fleetCentroid(engine.game, engine.game.fleets.get(fb.id)!);
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    // Standoff: pursuers hold a ring, not overlapping the target centroid.
    expect(gap()).toBeGreaterThan(80);
    expect(gap()).toBeLessThan(fa.engagementRange + 250);

    // Anchor stability: with the target stationary, the anchor should not drift each tick.
    const before = { ...engine.game.fleets.get(fa.id)!.position };
    for (let i = 0; i < 10; i++) advance(50);
    const after = engine.game.fleets.get(fa.id)!.position;
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(1);
  });
});
