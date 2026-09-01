// Authoritative game server: Fastify HTTP + WebSocket transport around GameServer.
// In-memory, resets on restart (DESIGN §1, §10).

import Fastify from "fastify";
import { WebSocketServer, type WebSocket } from "ws";
import { HEARTBEAT_MS } from "@space/config";
import { encode, safeDecodeClient, type ServerMessage } from "@space/protocol";
import { GameServer } from "./engine.js";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

// Route messages back to the right socket.
const sockets = new Map<string, WebSocket>();
const engine = new GameServer(
  (playerId, msg: ServerMessage) => {
    const ws = sockets.get(playerId);
    if (ws && ws.readyState === ws.OPEN) ws.send(encode(msg));
  },
  () => Date.now(),
  { seedNpcs: process.env.SEED_NPCS !== "false" },
);

app.get("/health", async () => ({ status: "ok" }));

// Sanitized whole-world debug state (dev only) — DESIGN §15.
app.get("/debug/state", async () => ({
  players: [...engine.game.players.keys()],
  planets: engine.game.planets.size,
  ships: engine.game.ships.size,
  fleets: [...engine.game.fleets.values()].map((f) => ({ id: f.id, owner: f.ownerId, status: f.status, intent: f.intent })),
  shipRuntime: engine.game.shipRuntime.size,
  projectiles: engine.game.projectiles.length,
  counters: engine.counters,
}));

await app.ready();

// Attach the WebSocket server to Fastify's underlying HTTP server.
const wss = new WebSocketServer({ server: app.server });

wss.on("connection", (ws) => {
  let playerId: string | null = null;

  ws.on("message", (data) => {
    const decoded = safeDecodeClient(data.toString());
    if (!decoded.ok) {
      ws.send(encode({ type: "reject", reason: `bad message: ${decoded.error}` }));
      return;
    }
    const msg = decoded.msg;
    if (msg.type === "hello") {
      if (playerId) return; // already said hello
      const id = msg.playerId.trim().slice(0, 24);
      if (engine.isConnected(id)) {
        ws.send(encode({ type: "reject", reason: "player id already connected" }));
        ws.close(4001, "player id already connected");
        return;
      }
      // Register the socket BEFORE connect() so its welcome/snapshot emits arrive.
      sockets.set(id, ws);
      const result = engine.connect(id);
      if (!result.ok) {
        sockets.delete(id);
        ws.send(encode({ type: "reject", reason: result.reason }));
        ws.close(4001, result.reason);
        return;
      }
      playerId = id;
      return;
    }
    if (!playerId) {
      ws.send(encode({ type: "reject", reason: "say hello first" }));
      return;
    }
    engine.handle(playerId, msg);
  });

  ws.on("close", () => {
    if (playerId) {
      sockets.delete(playerId);
      engine.disconnect(playerId);
    }
  });
});

// Single lightweight heartbeat drives scheduled events + battles + broadcasts.
const heartbeat = setInterval(() => engine.tick(), HEARTBEAT_MS);

const port = Number(process.env.PORT ?? 8080);
app.listen({ port, host: "0.0.0.0" }).then(
  () => app.log.info(`server listening on http://localhost:${port}`),
  (err) => {
    app.log.error(err);
    process.exit(1);
  },
);

function shutdown(): void {
  clearInterval(heartbeat);
  wss.close();
  void app.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
