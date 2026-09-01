// WebSocket client. Sends intentions (never authoritative state) and surfaces
// server messages + connection status to the app (DESIGN §3, §10).

import { decodeServer, encode, type ClientMessage, type ServerMessage } from "@space/protocol";

export type ConnStatus = "disconnected" | "connecting" | "connected";
type Listener = (msg: ServerMessage) => void;
type StatusListener = (status: ConnStatus) => void;

export class NetClient {
  private ws?: WebSocket;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();
  private reqCounter = 0;
  status: ConnStatus = "disconnected";
  playerId?: string;

  constructor(private url: string) {}

  onMessage(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  onStatus(fn: StatusListener): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }
  private setStatus(s: ConnStatus): void {
    this.status = s;
    for (const fn of this.statusListeners) fn(s);
  }

  connect(playerId: string): void {
    this.playerId = playerId;
    this.setStatus("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.setStatus("connected");
      this.send({ type: "hello", playerId });
    });
    ws.addEventListener("message", (ev) => {
      let msg: ServerMessage;
      try {
        msg = decodeServer(String(ev.data));
      } catch {
        return;
      }
      for (const fn of this.listeners) fn(msg);
    });
    ws.addEventListener("close", () => this.setStatus("disconnected"));
    ws.addEventListener("error", () => this.setStatus("disconnected"));
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(encode(msg));
  }

  /** Send a command that carries a requestId; returns the id. */
  command(msg: { type: string } & Record<string, unknown>): string {
    const requestId = `req_${++this.reqCounter}`;
    this.send({ ...msg, requestId } as unknown as ClientMessage);
    return requestId;
  }
}
