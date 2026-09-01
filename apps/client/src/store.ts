// Client-side presentation state (DESIGN §3.1). Mirrors authoritative snapshots;
// owns nothing authoritative. Fleet markers ride the ships' centroid, streamed at high
// rate via the activeRegion (sensed-ship) stream; the anchor is the static goal point.

import type {
  ActiveShipDto,
  FleetDto,
  PlayerVisibleSnapshot,
  ProjectileDto,
  ServerMessage,
  ShipDto,
} from "@space/protocol";

export interface Notification {
  text: string;
  atMs: number;
  kind: "info" | "error";
}

/** A ship the player can currently sense (always streamed, in or out of combat). */
export interface ClientActiveShip {
  dto: ActiveShipDto;
  shown: { x: number; y: number };
  atMs: number;
}

/** A projectile, smoothed on the client between server frames (plan 028 #4). */
export interface ClientProjectile {
  dto: ProjectileDto;
  shown: { x: number; y: number };
  atMs: number;
}

/** A transient explosion effect spawned when a ship is destroyed (plan 028 #8). */
export interface Explosion {
  x: number;
  y: number;
  startMs: number;
  mine: boolean;
}

export class Store {
  snapshot?: PlayerVisibleSnapshot;
  snapshotVersion = 0;
  playerId = "";
  selectedId?: string | undefined;
  selectedKind?: "planet" | "fleet" | "ship" | "resource" | "wreck" | undefined;
  notifications: Notification[] = [];
  // Every ship the player can currently sense (own + enemy), always streamed.
  activeShips = new Map<string, ClientActiveShip>();
  projectiles = new Map<string, ClientProjectile>();
  explosions: Explosion[] = [];
  combatLog: string[] = [];
  /** Estimated client/server clock offset (serverTime - clientPerfNow). */
  private serverClockOffset = 0;

  serverNow(): number {
    return performance.now() + this.serverClockOffset;
  }

  applyServer(msg: ServerMessage): void {
    switch (msg.type) {
      case "welcome":
        this.playerId = msg.playerId;
        this.serverClockOffset = msg.serverTimeMs - performance.now();
        break;
      case "snapshot":
        this.snapshot = msg.world;
        this.snapshotVersion++;
        this.serverClockOffset = msg.world.serverTimeMs - performance.now();
        break;
      case "reject":
        this.notify(`Rejected: ${msg.reason}`, "error");
        break;
      case "activeRegion": {
        const now = performance.now();
        const seen = new Set<string>(msg.delta.ships.map((s) => s.shipId));
        // Client-side death detection (plan 040): a tracked ship that vanishes from the stream
        // while mortally wounded (or while being shot at) almost certainly died — explode it at
        // its last position. Healthy ships that vanish are assumed to have left sensor range.
        const targeted = new Set<string>();
        for (const t of this.activeShips.values()) if (t.dto.targetShipId) targeted.add(t.dto.targetShipId);
        for (const [id, s] of this.activeShips) {
          if (seen.has(id)) continue;
          const frac = s.dto.hullMaxHp > 0 ? s.dto.hullHp / s.dto.hullMaxHp : 1;
          if (s.dto.alive && (frac < 0.2 || targeted.has(id))) {
            this.explosions.push({ x: s.shown.x, y: s.shown.y, startMs: now, mine: s.dto.ownerId === this.playerId });
            this.combatLog.push(`Ship ${id.slice(-4)} destroyed`);
            this.activeShips.delete(id);
          }
        }
        for (const s of msg.delta.ships) {
          const cur = this.activeShips.get(s.shipId);
          if (cur) {
            cur.dto = s;
            cur.atMs = now;
          } else {
            this.activeShips.set(s.shipId, { dto: s, shown: { ...s.position }, atMs: now });
          }
        }
        // Reconcile projectiles into the smoothing map (keep `shown` for continuity).
        const pseen = new Set<string>();
        for (const p of msg.delta.projectiles) {
          pseen.add(p.id);
          const cur = this.projectiles.get(p.id);
          if (cur) {
            cur.dto = p;
            cur.atMs = now;
          } else {
            this.projectiles.set(p.id, { dto: p, shown: { ...p.position }, atMs: now });
          }
        }
        for (const id of [...this.projectiles.keys()]) if (!pseen.has(id)) this.projectiles.delete(id);
        for (const e of msg.delta.events) {
          if (e.type === "shipDestroyed") {
            this.combatLog.push(`Ship ${e.ship.slice(-4)} destroyed`);
            const s = this.activeShips.get(e.ship);
            // Prefer the server-provided death position so the FX always fires, even if the
            // ship wasn't currently streamed; fall back to the last shown position.
            const pos = e.position ?? s?.shown;
            if (pos) this.explosions.push({ x: pos.x, y: pos.y, startMs: now, mine: s?.dto.ownerId === this.playerId });
            this.activeShips.delete(e.ship);
          } else if (e.type === "roomDisabled") {
            this.combatLog.push(`Room disabled on ${e.ship.slice(-4)}`);
          }
        }
        if (this.combatLog.length > 30) this.combatLog = this.combatLog.slice(-30);
        break;
      }
      case "ack":
        break;
    }
  }

  notify(text: string, kind: "info" | "error" = "info"): void {
    this.notifications.push({ text, kind, atMs: performance.now() });
    if (this.notifications.length > 6) this.notifications.shift();
  }

  /** True while any of the player's own ships is firing on / locked to an enemy. */
  get inCombat(): boolean {
    for (const s of this.activeShips.values()) {
      if (s.dto.ownerId === this.playerId && s.dto.targetShipId) return true;
    }
    return false;
  }

  /** Ms an explosion effect lives on screen. */
  static readonly EXPLOSION_MS = 550;

  /** Ease sensed-ship display positions toward their latest server position; prune stale. */
  updateActiveShips(): void {
    const now = performance.now();
    for (const [id, s] of this.activeShips) {
      if (now - s.atMs > 2000) {
        this.activeShips.delete(id);
        continue;
      }
      s.shown.x += (s.dto.position.x - s.shown.x) * 0.3;
      s.shown.y += (s.dto.position.y - s.shown.y) * 0.3;
    }
  }

  /** Dead-reckon projectiles by velocity and ease toward the latest server position. */
  updateProjectiles(dtMs: number): void {
    const now = performance.now();
    const dt = dtMs / 1000;
    for (const [id, p] of this.projectiles) {
      if (now - p.atMs > 1200) {
        this.projectiles.delete(id);
        continue;
      }
      if (p.dto.velocity) {
        p.shown.x += p.dto.velocity.x * dt;
        p.shown.y += p.dto.velocity.y * dt;
      }
      // Gently correct toward the authoritative position so we never drift far.
      p.shown.x += (p.dto.position.x - p.shown.x) * 0.2;
      p.shown.y += (p.dto.position.y - p.shown.y) * 0.2;
    }
    // Expire finished explosions.
    if (this.explosions.length) this.explosions = this.explosions.filter((e) => now - e.startMs < Store.EXPLOSION_MS);
  }

  /** Live ships (smoothed) belonging to a fleet. */
  shipsOfFleet(fleetId: string): ClientActiveShip[] {
    const out: ClientActiveShip[] = [];
    for (const s of this.activeShips.values()) if (s.dto.fleetId === fleetId && s.dto.alive) out.push(s);
    return out;
  }

  /**
   * A fleet's on-screen location — the centroid of its sensed ships (smooth, high-rate).
   * Falls back to the snapshot's centroid position if no ships are currently streamed.
   */
  fleetCentroid(fleetId: string, fallback: { x: number; y: number }): { x: number; y: number } {
    const ships = this.shipsOfFleet(fleetId);
    if (ships.length === 0) return { ...fallback };
    let x = 0;
    let y = 0;
    for (const s of ships) {
      x += s.shown.x;
      y += s.shown.y;
    }
    return { x: x / ships.length, y: y / ships.length };
  }

  /** Position to render/pick a fleet at — the ships' centroid. */
  fleetPosition(fleet: FleetDto): { x: number; y: number } {
    return this.fleetCentroid(fleet.id, fleet.position);
  }

  /** The static goal/rally anchor for an own fleet (endpoint of the move line). */
  fleetAnchor(fleet: FleetDto): { x: number; y: number } | undefined {
    return fleet.anchor;
  }

  myShips(): ShipDto[] {
    return this.snapshot?.ships ?? [];
  }
  ship(id: string): ShipDto | undefined {
    return this.snapshot?.ships.find((s) => s.id === id);
  }
}
