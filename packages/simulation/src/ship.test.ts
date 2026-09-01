import { describe, expect, it } from "vitest";
import {
  computeDerived,
  instantiateShip,
  isValidBlueprint,
  roomsFromBlueprint,
  starterBlueprint,
  validateBlueprint,
} from "./ship.js";
import type { ShipBlueprint } from "./types.js";

const bp = (placements: ShipBlueprint["placements"], extra: Partial<ShipBlueprint> = {}): ShipBlueprint => ({
  hullType: "test",
  width: 3,
  height: 3,
  blockedCells: [],
  placements,
  ...extra,
});

describe("blueprint validation (DESIGN §8.2)", () => {
  it("accepts the starter blueprint", () => {
    expect(validateBlueprint(starterBlueprint())).toEqual([]);
    expect(isValidBlueprint(starterBlueprint())).toBe(true);
  });

  it("requires exactly one bridge", () => {
    const none = bp([{ moduleType: "reactor", x: 0, y: 0, rotation: 0 }]);
    expect(validateBlueprint(none).some((e) => e.code === "no-bridge")).toBe(true);
    const two = bp([
      { moduleType: "bridge", x: 0, y: 0, rotation: 0 },
      { moduleType: "bridge", x: 1, y: 0, rotation: 0 },
    ]);
    expect(validateBlueprint(two).some((e) => e.code === "multiple-bridges")).toBe(true);
  });

  it("rejects overlapping modules", () => {
    const over = bp([
      { moduleType: "bridge", x: 1, y: 1, rotation: 0 },
      { moduleType: "reactor", x: 1, y: 1, rotation: 0 },
    ]);
    expect(validateBlueprint(over).some((e) => e.code === "overlap")).toBe(true);
  });

  it("rejects modules outside the hull", () => {
    const out = bp([{ moduleType: "bridge", x: 5, y: 5, rotation: 0 }]);
    expect(validateBlueprint(out).some((e) => e.code === "outside-hull")).toBe(true);
  });

  it("rejects placement on blocked cells", () => {
    const blk = bp([{ moduleType: "bridge", x: 0, y: 0, rotation: 0 }], { blockedCells: ["0,0"] });
    expect(validateBlueprint(blk).some((e) => e.code === "on-blocked-cell")).toBe(true);
  });
});

describe("derived stats (DESIGN §4.2)", () => {
  it("damaged/disabled rooms stop contributing", () => {
    const rooms = roomsFromBlueprint(starterBlueprint());
    const full = computeDerived(rooms);
    expect(full.thrust).toBeGreaterThan(0);
    // Destroy the engine room.
    const engine = rooms.find((r) => r.kind === "engine")!;
    engine.hp = 0;
    engine.enabled = false;
    const damaged = computeDerived(rooms);
    expect(damaged.thrust).toBeLessThan(full.thrust);
  });

  it("flags underpowered designs", () => {
    const rooms = roomsFromBlueprint(
      bp([
        { moduleType: "bridge", x: 0, y: 0, rotation: 0 },
        { moduleType: "shield", x: 1, y: 0, rotation: 0 },
        { moduleType: "laser", x: 2, y: 0, rotation: 0 },
      ]),
    );
    expect(computeDerived(rooms).underpowered).toBe(true);
  });
});

describe("instantiateShip", () => {
  it("produces rooms and derived stats", () => {
    const ship = instantiateShip("alice", "Test", starterBlueprint());
    expect(ship.rooms.length).toBe(6);
    expect(ship.derived.weaponRoomIds.length).toBe(2);
    expect(ship.hull.hp).toBeGreaterThan(0);
  });
});
