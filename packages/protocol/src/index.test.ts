import { describe, expect, it } from "vitest";
import { ClientMessage, decodeServer, encode, safeDecodeClient, ShipBlueprint } from "./index.js";

describe("protocol codec", () => {
  it("round-trips a hello message", () => {
    const raw = encode({ type: "hello", playerId: "alice" });
    const decoded = safeDecodeClient(raw);
    expect(decoded.ok).toBe(true);
  });

  it("validates a moveFleet command at the boundary", () => {
    const ok = ClientMessage.safeParse({
      type: "moveFleet",
      requestId: "r1",
      fleetId: "f1",
      target: { x: 1, y: 2 },
    });
    expect(ok.success).toBe(true);
  });

  it("rejects malformed messages", () => {
    expect(safeDecodeClient('{"type":"moveFleet"}').ok).toBe(false);
    expect(safeDecodeClient("not json").ok).toBe(false);
  });

  it("round-trips a server snapshot envelope shape", () => {
    const msg = decodeServer(encode({ type: "ack", requestId: "r9" }));
    expect(msg.type).toBe("ack");
  });

  it("validates ship blueprints", () => {
    const bp = ShipBlueprint.safeParse({
      hullType: "scout",
      width: 3,
      height: 3,
      blockedCells: [],
      placements: [{ moduleType: "bridge", x: 1, y: 1, rotation: 0 }],
    });
    expect(bp.success).toBe(true);
  });
});
