// DOM UI overlay (DESIGN §9.1). Menus/forms/tooltips live in the DOM; Pixi owns
// the world/battle canvas. Updated each frame from the store.

import type { DoctrinePreset, FleetDoctrine, FormationShape, ResourceDepositDto, ShipDoctrine, ShipDto, StationDto } from "@space/protocol";
import type { NetClient } from "./net.js";
import type { Store } from "./store.js";

export interface UICallbacks {
  onConnect: (playerId: string) => void;
  onEditShip: (shipId: string) => void;
  onBuildShip: (planetId: string) => void;
  onDoctrineChange: (fleetId: string, preset: DoctrinePreset) => void;
  onFormationChange: (fleetId: string, formation: FormationShape) => void;
  onShipDoctrineChange: (shipId: string, doctrine: ShipDoctrine) => void;
  onHoldFleet: (fleetId: string) => void;
  onUnloadCargo: (fleetId: string) => void;
  onCreateOperation: (fleetId: string) => void;
  onCancelOperation: (operationId: string) => void;
  onBuildStation: (locationId: string) => void;
  onAttackMoveMode: (on: boolean) => void;
  onCenterHome: () => void;
  onToggleRoster: () => void;
  onOpenGuide: () => void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "style") e.setAttribute("style", String(v));
    else if (k === "className") e.className = String(v);
    else if (k.startsWith("data-") || k === "title") e.setAttribute(k, String(v));
    else (e as unknown as Record<string, unknown>)[k] = v;
  }
  for (const c of children) e.append(c);
  return e;
}

export class UI {
  private idOverlay!: HTMLDivElement;
  private idInput!: HTMLInputElement;
  private statusEl!: HTMLSpanElement;
  private resourceBar!: HTMLDivElement;
  private inspector!: HTMLDivElement;
  private notifications!: HTMLDivElement;
  private battleBanner!: HTMLDivElement;

  constructor(
    private root: HTMLElement,
    private store: Store,
    private net: NetClient,
    private cb: UICallbacks,
  ) {
    this.build();
  }

  private build(): void {
    // ID entry (DESIGN §10.1).
    this.idInput = el("input", { type: "text", placeholder: "enter any player id", id: "player-id", maxLength: 24, style: "padding:10px 12px;font-size:16px;border-radius:6px;border:1px solid #2a3550;background:#0d1420;color:#cdd6e4;min-width:240px;" });
    const btn = el("button", { id: "connect-btn", style: "padding:10px 18px;font-size:16px;border-radius:6px;border:none;background:#54c8ff;color:#04101c;cursor:pointer;font-weight:600;" }, "Connect");
    const doConnect = () => {
      const id = this.idInput.value.trim();
      if (id) this.cb.onConnect(id);
    };
    btn.addEventListener("click", doConnect);
    this.idInput.addEventListener("keydown", (e) => e.key === "Enter" && doConnect());
    const guideLink = el("button", { id: "guide-link", style: "margin-top:2px;padding:6px 14px;border-radius:6px;border:1px solid #2a3550;background:transparent;color:#8ed0ff;cursor:pointer;font-size:14px;" }, "📖 How to play");
    guideLink.addEventListener("click", () => this.cb.onOpenGuide());
    this.idOverlay = el("div", { id: "id-overlay", style: "position:absolute;inset:0;display:grid;place-items:center;background:rgba(5,7,12,0.85);z-index:20;" },
      el("div", { style: "display:flex;flex-direction:column;gap:14px;align-items:center;" },
        el("h1", { style: "color:#cdd6e4;font-family:system-ui;margin:0;font-weight:600;" }, "Space Strategy MMO"),
        el("div", { style: "display:flex;gap:10px;" }, this.idInput, btn),
        el("div", { style: "color:#5a6b82;font-size:13px;font-family:system-ui;" }, "No account needed — your ID is your world key. State resets on server restart."),
        guideLink,
      ),
    );

    // Top resource bar (DESIGN §9.1).
    this.statusEl = el("span", { id: "conn-status", style: "font-weight:600;" }, "disconnected");
    const barBtn = (id: string, label: string, onClick: () => void) => {
      const b = el("button", { id, style: "padding:4px 10px;border-radius:5px;border:1px solid #2a3550;background:#0d1420;color:#cdd6e4;cursor:pointer;font-size:13px;" }, label);
      b.addEventListener("click", onClick);
      return b;
    };
    this.resourceBar = el("div", { id: "resource-bar", style: "position:absolute;top:0;left:0;right:0;height:38px;display:none;align-items:center;gap:16px;padding:0 16px;background:rgba(13,20,32,0.9);border-bottom:1px solid #1b2433;color:#cdd6e4;font-family:system-ui;font-size:14px;z-index:10;" },
      el("strong", {}, "SPACE MMO"),
      el("span", { id: "res-metal" }, "metal —"),
      el("span", { id: "res-fuel" }, "fuel —"),
      barBtn("home-btn", "⌂ Home", () => this.cb.onCenterHome()),
      barBtn("roster-toggle", "☰ Fleets", () => this.cb.onToggleRoster()),
      barBtn("guide-btn", "📖 Guide", () => this.cb.onOpenGuide()),
      el("span", { style: "margin-left:auto;" }, this.statusEl),
    );

    // Battle result banner (plan 013).
    this.battleBanner = el("div", { id: "battle-banner", style: "position:absolute;top:52px;left:50%;transform:translateX(-50%);display:none;align-items:center;gap:12px;padding:10px 16px;background:rgba(13,20,32,0.95);border:1px solid #54c8ff;border-radius:8px;color:#cdd6e4;font-family:system-ui;font-size:14px;z-index:15;" });

    // Right inspector (DESIGN §9.1).
    this.inspector = el("div", { id: "inspector", style: "position:absolute;top:46px;right:8px;width:280px;max-height:70vh;overflow:auto;padding:12px;background:rgba(13,20,32,0.92);border:1px solid #1b2433;border-radius:8px;color:#cdd6e4;font-family:system-ui;font-size:13px;display:none;z-index:10;" });

    // Notifications (bottom-left, DESIGN §11 feedback).
    this.notifications = el("div", { id: "notifications", style: "position:absolute;bottom:36px;left:8px;display:flex;flex-direction:column;gap:6px;z-index:10;" });

    // Bottom help / toggles.
    const help = el("div", { id: "help-bar", style: "position:absolute;bottom:0;left:0;right:0;height:28px;display:none;align-items:center;gap:16px;padding:0 12px;background:rgba(13,20,32,0.9);border-top:1px solid #1b2433;color:#5a6b82;font-family:system-ui;font-size:12px;z-index:10;" },
      el("span", {}, "drag=pan · wheel=zoom · click=select · click map with fleet selected=move"),
      el("label", { style: "margin-left:auto;cursor:pointer;" }, this.makeToggle("toggle-debug", (on) => (this.onToggleDebug?.(on))), " debug"),
      el("label", { style: "cursor:pointer;" }, this.makeToggle("toggle-sensors", (on) => (this.onToggleSensors?.(on)), true), " sensors"),
    );
    this.helpBar = help;

    this.root.append(this.resourceBar, this.battleBanner, this.inspector, this.notifications, help, this.idOverlay);
  }

  onToggleDebug?: (on: boolean) => void;
  onToggleSensors?: (on: boolean) => void;
  private helpBar!: HTMLDivElement;

  private makeToggle(id: string, onChange: (on: boolean) => void, checked = false): HTMLInputElement {
    const c = el("input", { type: "checkbox", id, checked });
    c.addEventListener("change", () => onChange(c.checked));
    return c;
  }

  setConnected(): void {
    this.idOverlay.style.display = "none";
    this.resourceBar.style.display = "flex";
    this.helpBar.style.display = "flex";
  }

  update(): void {
    const s = this.store;
    this.statusEl.textContent = this.net.status;
    this.statusEl.style.color = this.net.status === "connected" ? "#4ade80" : this.net.status === "connecting" ? "#ffd166" : "#ff6b6b";
    const res = s.snapshot?.you.resources;
    if (res) {
      (document.getElementById("res-metal") as HTMLElement).textContent = `metal ${Math.floor(res.metal)}`;
      (document.getElementById("res-fuel") as HTMLElement).textContent = `fuel ${Math.floor(res.fuel)}`;
    }
    this.renderInspector();
    this.patchLiveValues();
    this.renderNotifications();
  }

  /** Compact "[carried/capacity]" chip for a ship. */
  private cargoChip(ship: ShipDto): string {
    const carried = (ship.cargo?.metal ?? 0) + (ship.cargo?.fuel ?? 0);
    return `[${Math.floor(carried)}/${ship.derived.cargo}]`;
  }
  private shipCargoText(ship: ShipDto): string {
    const carried = (ship.cargo?.metal ?? 0) + (ship.cargo?.fuel ?? 0);
    return `cargo ${Math.floor(carried)}/${ship.derived.cargo} (metal ${Math.floor(ship.cargo?.metal ?? 0)} · fuel ${Math.floor(ship.cargo?.fuel ?? 0)})`;
  }
  private stationText(st: StationDto): string {
    return `Station here${st.storage ? ` — storage ${Math.floor((st.storage.metal ?? 0) + (st.storage.fuel ?? 0))}/${st.capacity ?? 0}` : ""}`;
  }
  private depositText(d: ResourceDepositDto): string {
    return `${d.resource}: reserves ${Math.floor(d.reserves)} · richness ${d.richness.toFixed(2)} · access ${d.accessibility.toFixed(2)}`;
  }

  /**
   * Rewrite live scalar values in the (cached) inspector by id/selector every frame, so
   * cargo / planet stores / station storage / deposit reserves refresh without rebuilding
   * the DOM (which would detach a focused <select> mid-click). Mirrors the top-bar trick.
   */
  private patchLiveValues(): void {
    const s = this.store;
    if (!s.snapshot) return;
    // Fleet ship-row cargo chips.
    for (const span of Array.from(this.inspector.querySelectorAll<HTMLElement>("[data-shipcargo]"))) {
      const sh = s.ship(span.dataset.shipcargo ?? "");
      if (sh) span.textContent = this.cargoChip(sh);
    }
    if (s.selectedKind === "ship") {
      const sh = s.ship(s.selectedId ?? "");
      const line = document.getElementById("ship-cargo");
      if (sh && line) line.textContent = this.shipCargoText(sh);
    } else if (s.selectedKind === "planet") {
      const p = s.snapshot.planets.find((x) => x.id === s.selectedId);
      if (p?.storedResources) {
        const m = document.getElementById("planet-metal");
        const f = document.getElementById("planet-fuel");
        if (m) m.textContent = `metal: ${Math.floor(p.storedResources.metal)} (+${p.resourceRates?.metalPerSec.toFixed(1)}/s)`;
        if (f) f.textContent = `fuel: ${Math.floor(p.storedResources.fuel)} (+${p.resourceRates?.fuelPerSec.toFixed(1)}/s)`;
      }
    } else if (s.selectedKind === "resource") {
      const loc = s.snapshot.resourceLocations.find((l) => l.id === s.selectedId);
      if (loc) {
        for (const div of Array.from(this.inspector.querySelectorAll<HTMLElement>("[data-deposit]"))) {
          const d = loc.deposits[Number(div.dataset.deposit)];
          if (d) div.textContent = this.depositText(d);
        }
        const st = s.snapshot.stations.find((x) => x.locationId === loc.id);
        const line = document.getElementById("station-storage");
        if (st && line) line.textContent = this.stationText(st);
      }
    }
  }

  private renderNotifications(): void {
    const now = performance.now();
    this.store.notifications = this.store.notifications.filter((n) => now - n.atMs < 5000);
    this.notifications.replaceChildren(
      ...this.store.notifications.map((n) =>
        el("div", { style: `padding:6px 10px;border-radius:6px;font-family:system-ui;font-size:12px;background:${n.kind === "error" ? "rgba(255,107,107,0.15)" : "rgba(84,200,255,0.12)"};border:1px solid ${n.kind === "error" ? "#ff6b6b" : "#54c8ff"};color:#cdd6e4;` }, n.text),
      ),
    );
  }

  private lastInspectorKey = "";
  /** A signature of the inspector's structural content (not live scalars). */
  private inspectorContentKey(): string {
    const s = this.store;
    if (s.selectedKind === "fleet") {
      const f = s.snapshot?.fleets.find((x) => x.id === s.selectedId);
      return `fleet:${s.selectedId}:${f?.ownerId}:${f?.status}:${f?.doctrine?.preset}:${(f?.shipIds ?? []).join(",")}`;
    }
    if (s.selectedKind === "planet") {
      const p = s.snapshot?.planets.find((x) => x.id === s.selectedId);
      return `planet:${s.selectedId}:${p?.ownerId}:${(p?.constructionQueue ?? []).length}`;
    }
    if (s.selectedKind === "ship") {
      const sh = s.ship(s.selectedId ?? "");
      const d = sh?.doctrine;
      return `ship:${s.selectedId}:${sh?.rooms.length}:${d?.formationRole}/${d?.preferredRange}/${d?.targetPriority}:${sh?.hull.maxHp}`;
    }
    return `${s.selectedKind}:${s.selectedId}`;
  }

  private renderInspector(): void {
    const s = this.store;
    if (!s.selectedId || !s.snapshot) {
      this.inspector.style.display = "none";
      this.lastInspectorKey = "";
      return;
    }
    // Only rebuild when the inspector's *content structure* changes — NOT on every
    // snapshot. During combat the server broadcasts snapshots continuously; rebuilding
    // each time detached the doctrine <select> / buttons mid-click (#1, #9).
    const key = this.inspectorContentKey();
    if (key === this.lastInspectorKey) return;
    this.lastInspectorKey = key;
    this.inspector.style.display = "block";
    const children: (Node | string)[] = [];

    if (s.selectedKind === "planet") {
      const p = s.snapshot.planets.find((x) => x.id === s.selectedId);
      if (p) {
        children.push(el("h3", { style: "margin:0 0 8px;" }, p.name));
        children.push(el("div", {}, `owner: ${p.ownerId ?? "unclaimed"}`));
        if (p.storedResources) {
          children.push(el("div", { id: "planet-metal" }, `metal: ${Math.floor(p.storedResources.metal)} (+${p.resourceRates?.metalPerSec.toFixed(1)}/s)`));
          children.push(el("div", { id: "planet-fuel" }, `fuel: ${Math.floor(p.storedResources.fuel)} (+${p.resourceRates?.fuelPerSec.toFixed(1)}/s)`));
          const q = p.constructionQueue ?? [];
          children.push(el("div", { style: "margin-top:6px;" }, `queue: ${q.length}`));
          for (const j of q) children.push(el("div", { style: "color:#9fb2c8;" }, `· ${j.name} (${Math.max(0, Math.ceil((j.finishAtMs - s.serverNow()) / 1000))}s)`));
          const build = el("button", { id: "build-ship-btn", style: this.btnStyle() }, "Build ship (120m/40f)");
          build.addEventListener("click", () => this.cb.onBuildShip(p.id));
          children.push(build);
        }
      }
    } else if (s.selectedKind === "fleet") {
      const f = s.snapshot.fleets.find((x) => x.id === s.selectedId);
      if (f) {
        const deselect = el("button", { id: "fleet-deselect", title: "Deselect", style: "border:none;background:#1b2433;color:#cdd6e4;border-radius:6px;width:24px;height:24px;cursor:pointer;font-size:14px;line-height:1;" }, "✕");
        deselect.addEventListener("click", () => {
          this.store.selectedId = undefined;
          this.store.selectedKind = undefined;
        });
        children.push(
          el("div", { style: "display:flex;justify-content:space-between;align-items:center;margin:0 0 8px;" }, el("h3", { style: "margin:0;" }, `Fleet (${f.shipCount} ships)`), deselect),
        );
        children.push(el("div", {}, `owner: ${f.ownerId}`));
        children.push(el("div", {}, `status: ${f.status}`));
        if (f.ownerId === s.playerId) {
          children.push(el("div", { style: "margin-top:6px;color:#5a6b82;font-size:11px;" }, "The marker is the fleet's ships; the crosshair is its goal anchor. Ships fly to it and maneuver on their own in combat."));
          children.push(el("div", { style: "margin-top:4px;color:#9fb2c8;" }, "Click empty space to move · click an enemy to pursue."));
          if (f.doctrine) children.push(this.fleetOrderControls(f.id, f.doctrine, f.formation ?? "line"));
          children.push(this.operationControls(f.id));
          const ships = el("div", { style: "margin-top:8px;display:flex;flex-direction:column;gap:4px;" }, el("strong", {}, "Ships"));
          for (const sid of f.shipIds ?? []) {
            const ship = s.ship(sid);
            if (!ship) continue;
            // Clicking the name selects the ship (its doctrine controls); ✎ opens the builder.
            const name = el("button", { style: "flex:1;text-align:left;padding:5px 8px;border-radius:5px;border:1px solid #2a3550;background:#0d1420;color:#cdd6e4;cursor:pointer;" }, `${ship.name} (hull ${Math.floor(ship.hull.hp)})`);
            name.addEventListener("click", () => {
              this.store.selectedId = ship.id;
              this.store.selectedKind = "ship";
            });
            const edit = el("button", { className: "fleet-ship-btn", style: "padding:5px 8px;border-radius:5px;border:1px solid #2a3550;background:#0d1420;color:#cdd6e4;cursor:pointer;" }, "✎");
            edit.addEventListener("click", () => this.cb.onEditShip(ship.id));
            const row = el("div", { style: "display:flex;gap:4px;align-items:center;" }, name);
            if (ship.derived.cargo > 0) {
              row.append(el("span", { "data-shipcargo": ship.id, style: "font-size:11px;color:#9fb2c8;white-space:nowrap;" }, this.cargoChip(ship)));
            }
            row.append(edit);
            ships.append(row);
          }
          children.push(ships);
        }
      }
    } else if (s.selectedKind === "ship") {
      const ship = s.ship(s.selectedId);
      if (ship) {
        children.push(el("h3", { style: "margin:0 0 8px;" }, ship.name));
        children.push(el("div", {}, `hull: ${Math.floor(ship.hull.hp)}/${ship.hull.maxHp}`));
        children.push(el("div", {}, `thrust ${ship.derived.thrust} · turn ${ship.derived.turnRate.toFixed(1)}`));
        children.push(el("div", {}, `shield ${ship.derived.shieldCapacity} · sensor ${ship.derived.sensorRange}`));
        children.push(el("div", { style: ship.derived.underpowered ? "color:#ff6b6b;" : "color:#4ade80;" }, `power ${ship.derived.powerProduction}/${ship.derived.powerDemand}${ship.derived.underpowered ? " (underpowered)" : ""}`));
        if (ship.derived.cargo > 0) {
          const carried = (ship.cargo?.metal ?? 0) + (ship.cargo?.fuel ?? 0);
          children.push(el("div", { id: "ship-cargo" }, `cargo ${Math.floor(carried)}/${ship.derived.cargo} (metal ${Math.floor(ship.cargo?.metal ?? 0)} · fuel ${Math.floor(ship.cargo?.fuel ?? 0)})`));
        }
        const edit = el("button", { id: "edit-ship-btn", style: this.btnStyle() }, "Edit in ship builder");
        edit.addEventListener("click", () => this.cb.onEditShip(ship.id));
        children.push(edit);
        children.push(this.shipDoctrineControls(ship));
      }
    } else if (s.selectedKind === "resource") {
      const loc = s.snapshot.resourceLocations.find((l) => l.id === s.selectedId);
      if (loc) {
        children.push(el("h3", { style: "margin:0 0 8px;" }, loc.name));
        loc.deposits.forEach((d, i) => {
          children.push(el("div", { "data-deposit": String(i) }, this.depositText(d)));
        });
        const station = s.snapshot.stations.find((st) => st.locationId === loc.id);
        if (station) {
          children.push(el("div", { id: "station-storage", style: "margin-top:6px;color:#cfe6ff;" }, this.stationText(station)));
        } else {
          const build = el("button", { id: "build-station-btn", style: this.btnStyle() }, "Build mining station (300m/120f)");
          build.addEventListener("click", () => this.cb.onBuildStation(loc.id));
          children.push(build);
        }
        children.push(el("div", { style: "margin-top:4px;color:#9fb2c8;" }, "Select a fleet then click this field to mine it."));
      }
    } else if (s.selectedKind === "wreck") {
      const w = s.snapshot.debris.find((d) => d.id === s.selectedId);
      if (w) {
        children.push(el("h3", { style: "margin:0 0 8px;" }, "Wreck"));
        const total = Math.floor((w.cargo.metal ?? 0) + (w.cargo.fuel ?? 0));
        children.push(el("div", {}, `salvage: ${total} (metal ${Math.floor(w.cargo.metal ?? 0)} · fuel ${Math.floor(w.cargo.fuel ?? 0)})`));
        children.push(el("div", { style: "margin-top:4px;color:#9fb2c8;" }, "Select a fleet then click this wreck to salvage it (a passing ship with free cargo will also collect it)."));
      }
    }
    this.inspector.replaceChildren(...children);
  }

  private mkSelect(label: string, opts: string[], value: string, id: string, onChange: (v: string) => void): HTMLElement {
    const sel = el("select", { id, style: "background:#0d1420;color:#cdd6e4;border:1px solid #2a3550;border-radius:4px;padding:3px;" }, ...opts.map((o) => el("option", { value: o, selected: o === value }, o)));
    sel.addEventListener("change", () => onChange(sel.value));
    return el("label", { style: "display:flex;justify-content:space-between;align-items:center;gap:8px;" }, `${label}:`, sel);
  }

  /** Fleet orders + doctrine preset + formation (plan 020, 023, 027). */
  private fleetOrderControls(fleetId: string, doctrine: FleetDoctrine, formation: FormationShape): HTMLElement {
    const wrap = el("div", { style: "margin-top:8px;display:flex;flex-direction:column;gap:6px;" }, el("strong", {}, "Orders"));
    const presets: DoctrinePreset[] = ["hold_fire", "return_fire", "attack_on_sight", "pursue", "flee_if_attacked"];
    wrap.append(
      this.mkSelect("doctrine", presets, doctrine.preset, "fleet-doctrine", (v) =>
        this.cb.onDoctrineChange(fleetId, v as DoctrinePreset),
      ),
    );
    const shapes: FormationShape[] = ["column", "line", "wedge", "echelon", "box", "screen", "protect", "loose"];
    wrap.append(
      this.mkSelect("formation", shapes, formation, "fleet-formation-shape", (v) =>
        this.cb.onFormationChange(fleetId, v as FormationShape),
      ),
    );
    const row = el("div", { style: "display:flex;gap:6px;" });
    const hold = el("button", { id: "order-hold", style: this.smallBtn() }, "Hold");
    hold.addEventListener("click", () => this.cb.onHoldFleet(fleetId));
    const unload = el("button", { id: "order-unload", style: this.smallBtn() }, "Unload");
    unload.addEventListener("click", () => this.cb.onUnloadCargo(fleetId));
    const amLabel = el("label", { style: "display:flex;align-items:center;gap:4px;cursor:pointer;" }, this.makeToggle("order-attackmove", (on) => this.cb.onAttackMoveMode(on)), " attack-move");
    row.append(hold, unload, amLabel);
    wrap.append(row);
    wrap.append(el("div", { style: "color:#5a6b82;font-size:11px;" }, "Click space = move · click a field = mine · click an enemy = pursue · Unload at home"));
    return wrap;
  }

  /** Automated resource-operation controls for a fleet (plan 032). */
  private operationControls(fleetId: string): HTMLElement {
    const wrap = el("div", { style: "margin-top:8px;display:flex;flex-direction:column;gap:6px;" }, el("strong", {}, "Mining operation"));
    const op = this.store.snapshot?.operations.find((o) => o.fleetId === fleetId);
    if (op) {
      wrap.append(el("div", { id: "op-state", style: "color:#ffcf8f;" }, `${op.paused ? "paused" : op.state}`));
      const cancel = el("button", { id: "op-cancel", style: this.smallBtn() }, "Stop operation");
      cancel.addEventListener("click", () => this.cb.onCancelOperation(op.id));
      wrap.append(cancel);
    } else {
      const start = el("button", { id: "op-start", style: this.smallBtn() }, "Auto-mine nearest field → home");
      start.addEventListener("click", () => this.cb.onCreateOperation(fleetId));
      wrap.append(start);
    }
    return wrap;
  }

  private shipDoctrineControls(ship: ShipDto): HTMLElement {
    const wrap = el("div", { style: "margin-top:8px;display:flex;flex-direction:column;gap:6px;" }, el("strong", {}, "Ship doctrine"));
    const d: ShipDoctrine = ship.doctrine ?? { formationRole: "middle", preferredRange: "medium", targetPriority: "nearest" };
    const emit = (patch: Partial<ShipDoctrine>) => this.cb.onShipDoctrineChange(ship.id, { ...d, ...patch });
    wrap.append(
      this.mkSelect("formation", ["front", "middle", "rear"], d.formationRole, "ship-formation", (v) => emit({ formationRole: v as ShipDoctrine["formationRole"] })),
      this.mkSelect("range", ["close", "medium", "long"], d.preferredRange, "ship-range", (v) => emit({ preferredRange: v as ShipDoctrine["preferredRange"] })),
      this.mkSelect("target", ["nearest", "small_ships", "large_ships"], d.targetPriority, "ship-target", (v) => emit({ targetPriority: v as ShipDoctrine["targetPriority"] })),
    );
    return wrap;
  }

  private smallBtn(): string {
    return "padding:6px 12px;border-radius:6px;border:none;background:#54c8ff;color:#04101c;font-weight:600;cursor:pointer;";
  }

  private btnStyle(): string {
    return "margin-top:10px;width:100%;padding:8px;border-radius:6px;border:none;background:#54c8ff;color:#04101c;font-weight:600;cursor:pointer;";
  }
}
