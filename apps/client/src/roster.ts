// Roster panel (plan 012 + 014). Lists your fleets and docked ships, lets you
// create / add / split / merge fleets, and locate (center camera on) a fleet.
// The renderer mirrors authoritative snapshots; the server validates every command.

import type { FleetDto } from "@space/protocol";
import type { NetClient } from "./net.js";
import type { Store } from "./store.js";

export interface RosterCallbacks {
  onLocateFleet: (fleetId: string) => void;
  onEditShip: (shipId: string) => void;
}

export class Roster {
  private panel!: HTMLDivElement;
  private checked = new Set<string>();
  private addTargetFleetId = "";
  private lastSig = "";
  visible = false;

  constructor(
    private root: HTMLElement,
    private store: Store,
    private net: NetClient,
    private cb: RosterCallbacks,
  ) {
    this.panel = document.createElement("div");
    this.panel.id = "roster";
    this.panel.setAttribute(
      "style",
      "position:absolute;top:46px;left:8px;width:280px;max-height:75vh;overflow:auto;padding:12px;background:rgba(13,20,32,0.94);border:1px solid #1b2433;border-radius:8px;color:#cdd6e4;font-family:system-ui;font-size:13px;display:none;z-index:12;",
    );
    this.root.append(this.panel);
  }

  toggle(): void {
    this.visible = !this.visible;
    this.panel.style.display = this.visible ? "block" : "none";
    this.lastSig = "";
    if (this.visible) this.render();
  }

  private ownFleets(): FleetDto[] {
    const snap = this.store.snapshot;
    if (!snap) return [];
    return snap.fleets.filter((f) => f.ownerId === this.store.playerId && f.status !== "destroyed");
  }

  /** Owned ships not in any fleet (plan 012). */
  private dockedShipIds(): string[] {
    const snap = this.store.snapshot;
    if (!snap) return [];
    const inFleet = new Set<string>();
    for (const f of this.ownFleets()) for (const id of f.shipIds ?? []) inFleet.add(id);
    return snap.you.shipIds.filter((id) => !inFleet.has(id));
  }

  update(): void {
    if (!this.visible) return;
    // Rebuild only when the LIST changes — not on every snapshot. Combat churn moves
    // ship positions constantly, but the roster's contents (fleets, docked ships,
    // counts/status) rarely change, so this keeps its buttons stable to click.
    const fleetSig = this.ownFleets()
      .map((f) => `${f.id}#${f.shipCount}#${f.status}`)
      .join(",");
    const sig = `${fleetSig}|${this.dockedShipIds().join(",")}|${[...this.checked].sort().join(",")}|${this.addTargetFleetId}`;
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      this.render();
    }
    this.patchLive(); // refresh live cargo chips without a rebuild
  }

  /** Refresh per-ship cargo chips each frame without rebuilding the list. */
  private patchLive(): void {
    if (!this.visible) return;
    for (const span of Array.from(this.panel.querySelectorAll<HTMLElement>("[data-shipcargo]"))) {
      const sh = this.store.ship(span.dataset.shipcargo ?? "");
      if (sh && sh.derived.cargo > 0) {
        const carried = (sh.cargo?.metal ?? 0) + (sh.cargo?.fuel ?? 0);
        span.textContent = `[${Math.floor(carried)}/${sh.derived.cargo}]`;
      }
    }
  }

  private toggleCheck(shipId: string, on: boolean): void {
    if (on) this.checked.add(shipId);
    else this.checked.delete(shipId);
    this.lastSig = ""; // force re-render to reflect action-button enablement
  }

  private render(): void {
    const fleets = this.ownFleets();
    const docked = this.dockedShipIds();
    const children: (Node | string)[] = [row("h3", "Fleets & Ships", "margin:0 0 8px;")];

    if (this.addTargetFleetId === "" && fleets[0]) this.addTargetFleetId = fleets[0].id;

    // Fleets
    for (const f of fleets) {
      const header = document.createElement("div");
      header.className = "roster-fleet";
      header.dataset.fleet = f.id;
      header.setAttribute("style", "display:flex;align-items:center;gap:6px;margin-top:6px;font-weight:600;");
      const locate = btn("⌖", "roster-fleet-locate", () => this.cb.onLocateFleet(f.id));
      const title = document.createElement("span");
      title.textContent = `Fleet ${f.id.slice(-4)} · ${f.shipCount} · ${f.status}`;
      title.style.cursor = "pointer";
      title.addEventListener("click", () => this.cb.onLocateFleet(f.id));
      header.append(locate, title);
      children.push(header);
      for (const sid of f.shipIds ?? []) children.push(this.shipRow(sid));
    }

    // Docked ships
    children.push(row("div", "Docked ships", "margin-top:10px;font-weight:600;color:#9fb2c8;"));
    if (docked.length === 0) children.push(row("div", "— none —", "color:#5a6b82;"));
    for (const sid of docked) children.push(this.shipRow(sid));

    // Actions
    const checkedIds = [...this.checked];
    const actions = document.createElement("div");
    actions.setAttribute("style", "margin-top:12px;display:flex;flex-direction:column;gap:6px;");
    const createBtn = btn(`Create fleet (${checkedIds.length})`, "roster-create-fleet", () => {
      if (checkedIds.length === 0) return;
      this.net.command({ type: "createFleet", shipIds: checkedIds });
      this.checked.clear();
      this.lastSig = "";
    });
    createBtn.id = "roster-create-fleet";
    (createBtn as HTMLButtonElement).disabled = checkedIds.length === 0;
    createBtn.setAttribute("style", primaryBtnStyle(checkedIds.length === 0));

    const addWrap = document.createElement("div");
    addWrap.setAttribute("style", "display:flex;gap:6px;");
    const select = document.createElement("select");
    select.id = "roster-add-target";
    select.setAttribute("style", "flex:1;background:#0d1420;color:#cdd6e4;border:1px solid #2a3550;border-radius:5px;padding:4px;");
    for (const f of fleets) {
      const opt = document.createElement("option");
      opt.value = f.id;
      opt.textContent = `Fleet ${f.id.slice(-4)}`;
      if (f.id === this.addTargetFleetId) opt.selected = true;
      select.append(opt);
    }
    select.addEventListener("change", () => (this.addTargetFleetId = select.value));
    const addBtn = btn("Add ▾", "roster-add-fleet", () => {
      if (checkedIds.length === 0 || !this.addTargetFleetId) return;
      this.net.command({ type: "addShipsToFleet", fleetId: this.addTargetFleetId, shipIds: checkedIds });
      this.checked.clear();
      this.lastSig = "";
    });
    addBtn.id = "roster-add-fleet";
    addBtn.setAttribute("style", primaryBtnStyle(checkedIds.length === 0));
    (addBtn as HTMLButtonElement).disabled = checkedIds.length === 0;
    addWrap.append(select, addBtn);

    actions.append(createBtn, addWrap);
    children.push(actions);
    children.push(row("div", "Check ships, then Create a fleet or Add them to one. Split = check a subset; Merge = check a whole fleet then Add.", "margin-top:8px;color:#5a6b82;font-size:11px;"));

    this.panel.replaceChildren(...children);
  }

  private shipRow(shipId: string): HTMLElement {
    const ship = this.store.ship(shipId);
    const wrap = document.createElement("div");
    wrap.className = "roster-ship";
    wrap.dataset.ship = shipId;
    wrap.setAttribute("style", "display:flex;align-items:center;gap:6px;padding:2px 0 2px 10px;");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "roster-ship-check";
    cb.checked = this.checked.has(shipId);
    cb.addEventListener("change", () => this.toggleCheck(shipId, cb.checked));
    const name = document.createElement("span");
    name.style.flex = "1";
    name.textContent = ship ? `${ship.name} (hull ${Math.floor(ship.hull.hp)})` : shipId.slice(-6);
    const edit = btn("✎", "roster-ship-edit", () => this.cb.onEditShip(shipId));
    if (ship && ship.derived.cargo > 0) {
      const cargo = document.createElement("span");
      cargo.dataset.shipcargo = shipId;
      cargo.setAttribute("style", "font-size:11px;color:#9fb2c8;white-space:nowrap;");
      const carried = (ship.cargo?.metal ?? 0) + (ship.cargo?.fuel ?? 0);
      cargo.textContent = `[${Math.floor(carried)}/${ship.derived.cargo}]`;
      wrap.append(cb, name, cargo, edit);
    } else {
      wrap.append(cb, name, edit);
    }
    return wrap;
  }
}

function row(tag: keyof HTMLElementTagNameMap, text: string, style: string): HTMLElement {
  const e = document.createElement(tag);
  e.setAttribute("style", style);
  e.textContent = text;
  return e;
}
function btn(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = className;
  b.textContent = label;
  b.setAttribute("style", "padding:3px 8px;border-radius:5px;border:1px solid #2a3550;background:#0d1420;color:#cdd6e4;cursor:pointer;font-size:12px;");
  b.addEventListener("click", onClick);
  return b;
}
function primaryBtnStyle(disabled: boolean): string {
  return `padding:8px;border-radius:6px;border:none;background:#54c8ff;color:#04101c;font-weight:600;cursor:${disabled ? "default" : "pointer"};opacity:${disabled ? 0.5 : 1};`;
}
