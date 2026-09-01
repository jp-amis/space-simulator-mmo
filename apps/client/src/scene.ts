// PixiJS scene (DESIGN §9). Procedural, asset-free rendering of the strategic map
// and battle. The renderer mirrors domain snapshots; it never owns game state
// (DESIGN §16 rule 8). Immediate-mode redraw each frame with pooled labels.

import { Application, Container, Graphics, Text } from "pixi.js";
import { PLANET_SENSOR_RANGE, STATION } from "@space/config";
import type { ActiveShipDto } from "@space/protocol";
import type { Camera } from "./camera.js";
import type { Store } from "./store.js";

const OWNER_COLORS = ["#54c8ff", "#ff6b6b", "#ffd166", "#a78bfa", "#4ade80"];
function colorFor(ownerId: string | undefined, myId: string): number {
  if (!ownerId) return 0x8899aa;
  if (ownerId === myId) return 0x54c8ff;
  let h = 0;
  for (let i = 0; i < ownerId.length; i++) h = (h * 31 + ownerId.charCodeAt(i)) >>> 0;
  return parseInt(OWNER_COLORS[(h % (OWNER_COLORS.length - 1)) + 1]!.slice(1), 16);
}

interface Star {
  x: number;
  y: number;
  r: number;
  a: number;
  layer: number;
}

export class Scene {
  private world = new Container();
  private bg = new Graphics();
  private trajectoryLayer = new Graphics();
  private planetLayer = new Graphics();
  private fleetLayer = new Graphics();
  private combatLayer = new Graphics();
  private overlayLayer = new Graphics();
  private fogVeil = new Graphics();
  private fogMask = new Graphics();
  private debugLayer = new Graphics();
  private labels = new Container();
  private labelPool = new Map<string, Text>();
  private stars: Star[] = [];
  showDebug = false;
  showSensors = true;
  showFog = true;

  constructor(
    private app: Application,
    private store: Store,
    private camera: Camera,
  ) {
    app.stage.addChild(this.bg);
    app.stage.addChild(this.world);
    this.world.addChild(
      this.trajectoryLayer,
      this.planetLayer,
      this.overlayLayer,
      this.fleetLayer,
      this.combatLayer,
      this.fogVeil,
      this.fogMask,
      this.debugLayer,
      this.labels,
    );
    // The veil shows everywhere EXCEPT the sensor bubbles (inverse mask) → fog of war.
    this.fogVeil.setMask({ mask: this.fogMask, inverse: true });
    this.generateStars();
  }

  private generateStars(): void {
    // Seeded point field, multiple sizes/brightness, parallax layers (DESIGN §9.3).
    let s = 1234567;
    const rnd = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    this.stars = [];
    for (let i = 0; i < 600; i++) {
      this.stars.push({
        x: rnd() * 4000 - 2000,
        y: rnd() * 3000 - 1500,
        r: rnd() * 1.6 + 0.3,
        a: rnd() * 0.6 + 0.2,
        layer: 1 + Math.floor(rnd() * 3),
      });
    }
  }

  private label(id: string, text: string, color = 0xcdd6e4, size = 12): Text {
    let t = this.labelPool.get(id);
    if (!t) {
      t = new Text({ text, style: { fill: color, fontSize: size, fontFamily: "system-ui" } });
      t.anchor.set(0.5, 0);
      this.labelPool.set(id, t);
      this.labels.addChild(t);
    }
    if (t.text !== text) t.text = text;
    t.visible = true;
    return t;
  }

  render(): void {
    for (const t of this.labelPool.values()) t.visible = false;
    this.renderBackground();
    this.renderMap();
    this.renderShips();
    this.renderFog();
  }

  /** Fog of war: a dark veil over everything the player cannot currently sense. The veil is
   *  inverse-masked by the player's sensor bubbles (own fleets' centroids + owned planets),
   *  so sensed space stays clear and the fog tracks the fleet (plan 028 #6). */
  private renderFog(): void {
    this.fogVeil.clear();
    this.fogMask.clear();
    const snap = this.store.snapshot;
    if (!this.showFog || !snap) return;
    const cam = this.camera;
    const myId = this.store.playerId;
    this.fogVeil.rect(0, 0, cam.viewWidth, cam.viewHeight).fill({ color: 0x02040a, alpha: 0.5 });
    for (const f of snap.fleets) {
      if (f.ownerId !== myId || !f.sensorRange) continue;
      const p = this.store.fleetPosition(f);
      const s = cam.worldToScreen(p.x, p.y);
      this.fogMask.circle(s.x, s.y, f.sensorRange * cam.zoom).fill(0xffffff);
    }
    for (const pl of snap.planets) {
      if (pl.ownerId !== myId) continue;
      const s = cam.worldToScreen(pl.position.x, pl.position.y);
      this.fogMask.circle(s.x, s.y, PLANET_SENSOR_RANGE * cam.zoom).fill(0xffffff);
    }
    for (const st of snap.stations) {
      if (st.ownerId !== myId) continue;
      const s = cam.worldToScreen(st.position.x, st.position.y);
      this.fogMask.circle(s.x, s.y, STATION.sensorRange * cam.zoom).fill(0xffffff);
    }
  }

  private renderBackground(): void {
    const g = this.bg;
    g.clear();
    g.rect(0, 0, camWidth(this.camera), camHeight(this.camera)).fill({ color: 0x05070c });
    for (const star of this.stars) {
      const parallax = 0.2 + star.layer * 0.25;
      const sx = ((star.x - this.camera.x * parallax) % camWidth(this.camera) + camWidth(this.camera)) % camWidth(this.camera);
      const sy = ((star.y - this.camera.y * parallax) % camHeight(this.camera) + camHeight(this.camera)) % camHeight(this.camera);
      g.circle(sx, sy, star.r).fill({ color: 0xffffff, alpha: star.a });
    }
  }

  private renderMap(): void {
    const snap = this.store.snapshot;
    const cam = this.camera;
    const myId = this.store.playerId;
    this.planetLayer.clear();
    this.fleetLayer.clear();
    this.trajectoryLayer.clear();
    this.overlayLayer.clear();
    this.debugLayer.clear();
    if (!snap) return;

    // Sensor range overlays (DESIGN §11 plan 011) — fleets + owned stations.
    if (this.showSensors) {
      const ring = (x: number, y: number, r: number) => {
        this.overlayLayer.circle(x, y, r * cam.zoom).fill({ color: 0x54c8ff, alpha: 0.04 });
        this.overlayLayer.circle(x, y, r * cam.zoom).stroke({ width: 1, color: 0x54c8ff, alpha: 0.15 });
      };
      for (const f of snap.fleets) {
        if (f.ownerId !== myId || !f.sensorRange) continue;
        const p = this.store.fleetPosition(f);
        const s = cam.worldToScreen(p.x, p.y);
        ring(s.x, s.y, f.sensorRange);
      }
      for (const st of snap.stations) {
        if (st.ownerId !== myId) continue;
        const s = cam.worldToScreen(st.position.x, st.position.y);
        ring(s.x, s.y, STATION.sensorRange);
      }
    }

    // Debris — floating salvage wrecks: a ♢ that gently drifts + slowly spins (plan 039).
    // The bob is visual only; picking still uses the authoritative `d.position`.
    const dnow = performance.now();
    for (const d of snap.debris) {
      const fl = this.miningFloat(d.id, dnow); // reuse the small orbital wobble
      const s = cam.worldToScreen(d.position.x + fl.x * 0.6, d.position.y + fl.y * 0.6);
      const r = Math.max(3, 6 * cam.zoom);
      const spin = dnow / 900 + this.phaseOf(d.id);
      const cs = Math.cos(spin);
      const sn = Math.sin(spin);
      const pt = (dx: number, dy: number) => ({ x: s.x + dx * cs - dy * sn, y: s.y + dx * sn + dy * cs });
      const selected = this.store.selectedKind === "wreck" && this.store.selectedId === d.id;
      this.planetLayer
        .poly([pt(0, -r), pt(r, 0), pt(0, r), pt(-r, 0)])
        .fill({ color: 0x1e2b26, alpha: 0.9 })
        .stroke({ width: 1.5, color: 0x9fead0, alpha: 0.85 });
      if (selected) this.planetLayer.circle(s.x, s.y, r + 6).stroke({ width: 2, color: 0xffffff, alpha: 0.9 });
    }

    // Resource locations — mineable fields, drawn as amber clusters (plan 030).
    for (const loc of snap.resourceLocations) {
      const s = cam.worldToScreen(loc.position.x, loc.position.y);
      const r = Math.max(2.5, loc.radius * cam.zoom);
      const selected = this.store.selectedKind === "resource" && this.store.selectedId === loc.id;
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        this.planetLayer.circle(s.x + Math.cos(a) * r * 0.7, s.y + Math.sin(a) * r * 0.7, Math.max(1.2, r * 0.4)).fill({ color: 0xffb454, alpha: 0.85 });
      }
      if (selected) this.planetLayer.circle(s.x, s.y, r + 8).stroke({ width: 2, color: 0xffffff, alpha: 0.9 });
      if (cam.zoom > 0.06) {
        const t = this.label(`res:${loc.id}`, loc.name, 0xffcf8f, 10);
        t.position.set(s.x, s.y + r + 3);
      }
    }

    // Mining stations — hexagonal markers at resource locations (plan 034).
    for (const st of snap.stations) {
      const s = cam.worldToScreen(st.position.x, st.position.y);
      const col = colorFor(st.ownerId, myId);
      const r = Math.max(5, 14 * cam.zoom);
      const pts: { x: number; y: number }[] = [];
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        pts.push({ x: s.x + Math.cos(a) * r, y: s.y + Math.sin(a) * r });
      }
      this.planetLayer.poly(pts).fill({ color: 0x11202e, alpha: 0.95 }).stroke({ width: 1.5, color: col, alpha: 0.9 });
      this.planetLayer.circle(s.x, s.y, r * 0.4).fill({ color: col, alpha: 0.6 });
      if (cam.zoom > 0.06) {
        const t = this.label(`station:${st.id}`, st.name, 0xcfe6ff, 10);
        t.position.set(s.x, s.y - r - 10);
      }
    }

    // Planets (concentric circles, atmosphere ring, owner marker — DESIGN §9.3).
    for (const p of snap.planets) {
      const s = cam.worldToScreen(p.position.x, p.position.y);
      const r = Math.max(3, p.radius * cam.zoom);
      const col = colorFor(p.ownerId, myId);
      this.planetLayer.circle(s.x, s.y, r * 1.5).fill({ color: col, alpha: 0.06 });
      this.planetLayer.circle(s.x, s.y, r).fill({ color: 0x1b2433 });
      this.planetLayer.circle(s.x, s.y, r).stroke({ width: 1.5, color: col, alpha: 0.9 });
      this.planetLayer.circle(s.x, s.y, r * 0.55).fill({ color: col, alpha: 0.25 });
      if (this.store.selectedKind === "planet" && this.store.selectedId === p.id) {
        this.planetLayer.circle(s.x, s.y, r + 6).stroke({ width: 2, color: 0xffffff, alpha: 0.9 });
      }
      if (cam.zoom > 0.06 || p.ownerId === myId) {
        const t = this.label(`planet:${p.id}`, p.name, 0x9fb2c8, 11);
        t.position.set(s.x, s.y + r + 3);
      }
    }

    // Move lines: own fleet centroid → its static anchor (goal), plan #2.
    for (const f of snap.fleets) {
      if (f.ownerId !== myId) continue;
      const anchor = this.store.fleetAnchor(f);
      if (!anchor) continue;
      const c = this.store.fleetPosition(f);
      if (Math.hypot(anchor.x - c.x, anchor.y - c.y) < 24) continue; // parked → no line
      const from = cam.worldToScreen(c.x, c.y);
      const to = cam.worldToScreen(anchor.x, anchor.y);
      const col = colorFor(f.ownerId, myId);
      this.trajectoryLayer.moveTo(from.x, from.y).lineTo(to.x, to.y).stroke({ width: 1, color: col, alpha: 0.35 });
      // Anchor marker (small ring at the goal point).
      this.trajectoryLayer.circle(to.x, to.y, 4).stroke({ width: 1, color: col, alpha: 0.6 });
      this.trajectoryLayer.moveTo(to.x - 4, to.y).lineTo(to.x + 4, to.y).moveTo(to.x, to.y - 4).lineTo(to.x, to.y + 4).stroke({ width: 1, color: col, alpha: 0.5 });
    }

    // Fleets (oriented chevrons + count badge + selection halo — DESIGN §9.3).
    for (const f of snap.fleets) {
      const p = this.store.fleetPosition(f);
      const s = cam.worldToScreen(p.x, p.y);
      const col = colorFor(f.ownerId, myId);
      // Heading = toward the anchor while moving (own fleets), else 0.
      let ang = 0;
      const anchor = this.store.fleetAnchor(f);
      if (anchor && f.status === "moving") ang = Math.atan2(anchor.y - p.y, anchor.x - p.x);
      this.drawChevron(this.fleetLayer, s.x, s.y, ang, 8, col);
      if (this.store.selectedKind === "fleet" && this.store.selectedId === f.id) {
        this.fleetLayer.circle(s.x, s.y, 14).stroke({ width: 2, color: 0xffffff, alpha: 0.9 });
      }
      const t = this.label(`fleet:${f.id}`, `${f.shipCount}`, col, 10);
      t.position.set(s.x, s.y - 20);
    }

    if (this.showDebug) this.renderDebug();
  }

  private renderDebug(): void {
    const snap = this.store.snapshot;
    const cam = this.camera;
    const g = this.debugLayer;
    if (!snap) return;
    for (const f of snap.fleets) {
      const p = this.store.fleetPosition(f);
      const s = cam.worldToScreen(p.x, p.y);
      // Sensor + engagement range at the fleet centroid.
      if (f.sensorRange) g.circle(s.x, s.y, f.sensorRange * cam.zoom).stroke({ width: 1, color: 0x00ff88, alpha: 0.25 });
      if (f.engagementRange) g.circle(s.x, s.y, f.engagementRange * cam.zoom).stroke({ width: 1, color: 0xff9e3d, alpha: 0.4 });
      const lbl = this.label(`dbg:${f.id}`, `${f.status}${f.intent ? "/" + f.intent : ""}`, 0x00ff88, 9);
      lbl.position.set(s.x, s.y + 10);
      // Anchor crosshair — the fleet's static goal point.
      const anchor = this.store.fleetAnchor(f);
      if (anchor) {
        const a = cam.worldToScreen(anchor.x, anchor.y);
        g.moveTo(a.x - 6, a.y).lineTo(a.x + 6, a.y).moveTo(a.x, a.y - 6).lineTo(a.x, a.y + 6).stroke({ width: 1, color: 0xffffff, alpha: 0.5 });
      }
    }
  }

  private drawChevron(g: Graphics, x: number, y: number, ang: number, size: number, color: number): void {
    const pts = [
      { x: size, y: 0 },
      { x: -size * 0.7, y: size * 0.7 },
      { x: -size * 0.3, y: 0 },
      { x: -size * 0.7, y: -size * 0.7 },
    ];
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);
    const tp = pts.map((p) => ({ x: x + p.x * cos - p.y * sin, y: y + p.x * sin + p.y * cos }));
    g.moveTo(tp[0]!.x, tp[0]!.y);
    for (let i = 1; i < tp.length; i++) g.lineTo(tp[i]!.x, tp[i]!.y);
    g.closePath().fill({ color }).stroke({ width: 1, color: 0xffffff, alpha: 0.5 });
  }

  // ---- On-map ship rendering: every sensed ship, always (LOD by zoom) ----
  private renderShips(): void {
    const g = this.combatLayer;
    g.clear();
    const cam = this.camera;
    const store = this.store;
    const myId = store.playerId;

    // Attack "lock" lines from each ship to its current target (plan: #13).
    for (const as of store.activeShips.values()) {
      if (!as.dto.alive || !as.dto.targetShipId) continue;
      const tgt = store.activeShips.get(as.dto.targetShipId);
      if (!tgt) continue;
      const a = cam.worldToScreen(as.shown.x, as.shown.y);
      const b = cam.worldToScreen(tgt.shown.x, tgt.shown.y);
      const mine = as.dto.ownerId === myId;
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 1, color: mine ? 0xff9e3d : 0xff5c5c, alpha: 0.25 });
    }

    // Projectiles — lasers are thin bright streaks along their velocity; cannon shots are
    // slower round tracers (plan 028 #4, #5).
    for (const p of store.projectiles.values()) {
      const s = cam.worldToScreen(p.shown.x, p.shown.y);
      if (p.dto.kind === "laser") {
        const v = p.dto.velocity ?? { x: 1, y: 0 };
        const len = Math.hypot(v.x, v.y) || 1;
        const tail = cam.worldToScreen(p.shown.x - (v.x / len) * 26, p.shown.y - (v.y / len) * 26);
        g.moveTo(tail.x, tail.y).lineTo(s.x, s.y).stroke({ width: 1.6, color: 0x8ef0ff, alpha: 0.9 });
        g.circle(s.x, s.y, 1.6).fill({ color: 0xe6ffff });
      } else {
        g.circle(s.x, s.y, 2.8).fill({ color: 0xffb454 });
        g.circle(s.x, s.y, 1.4).fill({ color: 0xfff2a8 });
      }
    }

    // Explosions — an expanding ring + flash + sparks that fade over the lifetime (plan 028 #8).
    const now = performance.now();
    for (const ex of store.explosions) {
      const t = Math.min(1, (now - ex.startMs) / 550);
      const s = cam.worldToScreen(ex.x, ex.y);
      const r = (10 + t * 64) * Math.max(0.55, cam.zoom);
      const alpha = (1 - t) * 0.9;
      g.circle(s.x, s.y, r).stroke({ width: 2.5, color: 0xffd166, alpha });
      g.circle(s.x, s.y, r * 0.6).fill({ color: 0xff7b3d, alpha: alpha * 0.55 });
      if (t < 0.45) g.circle(s.x, s.y, r * 0.4).fill({ color: 0xffffff, alpha: (0.45 - t) * 2 });
      // A few flung sparks.
      const sparks = 6;
      for (let i = 0; i < sparks; i++) {
        const a = (i / sparks) * Math.PI * 2 + (ex.startMs % 100) / 16;
        const d = r * (0.9 + 0.5 * t);
        g.circle(s.x + Math.cos(a) * d, s.y + Math.sin(a) * d, Math.max(1, 2 * cam.zoom)).fill({ color: 0xffe08a, alpha });
      }
    }

    // Mining beams — a pulsing amber lance from each actively-mining ship to its deposit.
    const snap = store.snapshot;
    if (snap) {
      for (const as of store.activeShips.values()) {
        const locId = as.dto.miningLocationId;
        if (!as.dto.alive || !locId) continue;
        const loc = snap.resourceLocations.find((l) => l.id === locId);
        if (!loc) continue;
        const off = this.miningFloat(as.dto.shipId, now);
        const from = cam.worldToScreen(as.shown.x + off.x, as.shown.y + off.y);
        const to = cam.worldToScreen(loc.position.x, loc.position.y);
        const pulse = 0.5 + 0.5 * Math.sin(now / 110 + this.phaseOf(as.dto.shipId));
        g.moveTo(from.x, from.y).lineTo(to.x, to.y).stroke({ width: 1.5, color: 0xffcf6a, alpha: 0.25 + 0.45 * pulse });
        g.circle(to.x, to.y, Math.max(2, 4 * cam.zoom)).fill({ color: 0xffe6a8, alpha: 0.4 + 0.4 * pulse });
      }
      // Unload beams — a pulsing cool-green lance from each delivering ship to its planet (plan 038).
      for (const as of store.activeShips.values()) {
        const pid = as.dto.unloadLocationId;
        if (!as.dto.alive || !pid) continue;
        const planet = snap.planets.find((p) => p.id === pid);
        if (!planet) continue;
        const from = cam.worldToScreen(as.shown.x, as.shown.y);
        const to = cam.worldToScreen(planet.position.x, planet.position.y);
        const pulse = 0.5 + 0.5 * Math.sin(now / 120 + this.phaseOf(as.dto.shipId));
        g.moveTo(from.x, from.y).lineTo(to.x, to.y).stroke({ width: 1.5, color: 0x6be3a0, alpha: 0.22 + 0.4 * pulse });
        g.circle(from.x, from.y, Math.max(1.5, 3 * cam.zoom)).fill({ color: 0xbdffdb, alpha: 0.4 + 0.4 * pulse });
      }
    }

    const detailed = cam.zoom > 0.5; // close LOD → draw ship internals
    for (const as of store.activeShips.values()) {
      const dto = as.dto;
      // Actively-mining ships gently float/orbit their slot (cosmetic only).
      const off = dto.miningLocationId ? this.miningFloat(dto.shipId, now) : { x: 0, y: 0 };
      const s = cam.worldToScreen(as.shown.x + off.x, as.shown.y + off.y);
      const col = dto.ownerId === myId ? 0x54c8ff : 0xff6b6b;
      if (!dto.alive) {
        g.circle(s.x, s.y, 5).fill({ color: 0x442222, alpha: 0.5 });
        continue;
      }
      if (dto.shield > 0 && dto.maxShield > 0) {
        g.circle(s.x, s.y, detailed ? 22 : 12).stroke({
          width: 1.5,
          color: 0x54c8ff,
          alpha: 0.12 + 0.3 * (dto.shield / dto.maxShield),
        });
      }
      if (detailed && dto.blueprint && dto.rooms) {
        this.drawShipDetailed(g, s.x, s.y, dto.heading, dto, col);
      } else {
        this.drawChevron(g, s.x, s.y, dto.heading, Math.max(5, 9 * Math.min(1, cam.zoom * 3)), col);
      }
    }
  }

  /** Stable per-ship phase in [0, 2π) from the ship id (for de-synced pulses/orbits). */
  private phaseOf(id: string): number {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return (h % 628) / 100;
  }
  /** Small cosmetic orbital offset (world units) for a mining ship. */
  private miningFloat(id: string, now: number): { x: number; y: number } {
    const ph = this.phaseOf(id);
    const a = now / 320 + ph;
    return { x: Math.cos(a) * 7, y: Math.sin(a) * 7 };
  }

  private drawShipDetailed(g: Graphics, x: number, y: number, ang: number, bs: Pick<ActiveShipDto, "blueprint" | "rooms">, col: number): void {
    const cell = 10;
    const bp = bs.blueprint;
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);
    const rot = (dx: number, dy: number) => ({ x: x + dx * cos - dy * sin, y: y + dx * sin + dy * cos });
    if (bp && bs.rooms) {
      const ox = (bp.width * cell) / 2;
      const oy = (bp.height * cell) / 2;
      // Hull silhouette.
      const corners = [rot(-ox - 3, -oy - 3), rot(ox + 6, 0), rot(-ox - 3, oy + 3)];
      g.moveTo(corners[0]!.x, corners[0]!.y).lineTo(corners[1]!.x, corners[1]!.y).lineTo(corners[2]!.x, corners[2]!.y).closePath().fill({ color: 0x141c28 }).stroke({ width: 1, color: col, alpha: 0.8 });
      for (const r of bs.rooms) {
        const c = rot(r.x * cell - ox + cell / 2, r.y * cell - oy + cell / 2);
        const roomCol = r.hp <= 0 ? 0x552222 : roomColor(r.kind);
        g.rect(c.x - cell / 2 + 1, c.y - cell / 2 + 1, cell - 2, cell - 2).fill({ color: roomCol, alpha: r.enabled ? 0.9 : 0.4 });
      }
    } else {
      // Fallback: simple chevron.
      this.drawChevron(g, x, y, ang, 9, col);
    }
  }

  clearLabels(): void {
    for (const t of this.labelPool.values()) t.visible = false;
  }
}

function roomColor(kind: string): number {
  switch (kind) {
    case "bridge":
      return 0xffd166;
    case "engine":
      return 0x4ade80;
    case "reactor":
      return 0xa78bfa;
    case "weapon":
      return 0xff6b6b;
    case "shield":
      return 0x54c8ff;
    default:
      return 0x8899aa;
  }
}

function camWidth(c: Camera): number {
  return c.viewWidth;
}
function camHeight(c: Camera): number {
  return c.viewHeight;
}
