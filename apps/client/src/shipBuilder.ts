// Ship builder (DESIGN §8) — data-driven grid editor built from programmatic DOM.
// Reuses the shared simulation validator + derived stats (DESIGN §19: same core
// package callable from client and server). Server remains authoritative.

import { MODULES } from "@space/config";
import { computeDerived, roomsFromBlueprint, validateBlueprint } from "@space/simulation";
import type { ShipBlueprint } from "@space/protocol";

const PALETTE = ["bridge", "reactor", "engine", "shield", "laser", "cannon", "storage", "miningLaser"];

export interface BuilderCallbacks {
  onApply: (blueprint: ShipBlueprint) => void; // update existing ship
  onBuild: (planetId: string, blueprint: ShipBlueprint, name: string) => void;
}

export class ShipBuilder {
  private overlay!: HTMLDivElement;
  private blueprint!: ShipBlueprint;
  private selectedModule = "engine";
  private rotation: 0 | 90 | 180 | 270 = 0;
  private mode: { kind: "edit" } | { kind: "build"; planetId: string } = { kind: "edit" };
  visible = false;

  constructor(
    private root: HTMLElement,
    private cb: BuilderCallbacks,
  ) {
    this.build();
  }

  private build(): void {
    this.overlay = document.createElement("div");
    this.overlay.id = "ship-builder";
    this.overlay.setAttribute(
      "style",
      "position:absolute;inset:0;display:none;place-items:center;background:rgba(5,7,12,0.9);z-index:30;font-family:system-ui;color:#cdd6e4;",
    );
    this.root.append(this.overlay);
  }

  openEdit(blueprint: ShipBlueprint): void {
    this.blueprint = structuredClone(blueprint);
    this.mode = { kind: "edit" };
    this.show();
  }
  openBuild(planetId: string, base: ShipBlueprint): void {
    this.blueprint = structuredClone(base);
    this.mode = { kind: "build", planetId };
    this.show();
  }

  private show(): void {
    this.visible = true;
    this.overlay.style.display = "grid";
    this.render();
  }
  close(): void {
    this.visible = false;
    this.overlay.style.display = "none";
  }

  private cellAt(x: number, y: number): number {
    return this.blueprint.placements.findIndex((p) => {
      const spec = MODULES[p.moduleType];
      if (!spec) return false;
      const w = p.rotation === 90 || p.rotation === 270 ? spec.h : spec.w;
      const h = p.rotation === 90 || p.rotation === 270 ? spec.w : spec.h;
      return x >= p.x && x < p.x + w && y >= p.y && y < p.y + h;
    });
  }

  private clickCell(x: number, y: number): void {
    const idx = this.cellAt(x, y);
    if (idx >= 0) {
      this.blueprint.placements.splice(idx, 1); // remove
    } else {
      this.blueprint.placements.push({ moduleType: this.selectedModule, x, y, rotation: this.rotation });
    }
    this.render();
  }

  private render(): void {
    const bp = this.blueprint;
    const errors = validateBlueprint(bp);
    const derived = computeDerived(roomsFromBlueprint(bp));
    const cell = 44;

    const grid = document.createElement("div");
    grid.setAttribute("style", `position:relative;width:${bp.width * cell}px;height:${bp.height * cell}px;background:#0b111c;border:1px solid #2a3550;`);
    for (let y = 0; y < bp.height; y++) {
      for (let x = 0; x < bp.width; x++) {
        const c = document.createElement("div");
        c.className = "builder-cell";
        c.dataset.x = String(x);
        c.dataset.y = String(y);
        c.setAttribute("style", `position:absolute;left:${x * cell}px;top:${y * cell}px;width:${cell}px;height:${cell}px;box-sizing:border-box;border:1px solid #16202f;`);
        c.addEventListener("click", () => this.clickCell(x, y));
        grid.append(c);
      }
    }
    for (const p of bp.placements) {
      const spec = MODULES[p.moduleType];
      if (!spec) continue;
      const w = p.rotation === 90 || p.rotation === 270 ? spec.h : spec.w;
      const h = p.rotation === 90 || p.rotation === 270 ? spec.w : spec.h;
      const box = document.createElement("div");
      box.setAttribute("style", `position:absolute;left:${p.x * cell + 2}px;top:${p.y * cell + 2}px;width:${w * cell - 4}px;height:${h * cell - 4}px;background:${roomColorHex(spec.kind)};border-radius:4px;display:grid;place-items:center;font-size:11px;color:#04101c;font-weight:600;pointer-events:none;`);
      box.textContent = p.moduleType.slice(0, 4);
      grid.append(box);
    }

    const palette = document.createElement("div");
    palette.setAttribute("style", "display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;");
    for (const m of PALETTE) {
      const b = document.createElement("button");
      b.className = "palette-btn";
      b.dataset.module = m;
      b.textContent = m;
      b.setAttribute("style", `padding:6px 10px;border-radius:6px;border:2px solid ${this.selectedModule === m ? "#54c8ff" : "#2a3550"};background:${roomColorHex(MODULES[m]!.kind)};color:#04101c;cursor:pointer;font-weight:600;`);
      b.addEventListener("click", () => {
        this.selectedModule = m;
        this.render();
      });
      palette.append(b);
    }

    const stats = document.createElement("div");
    stats.setAttribute("style", "font-size:13px;line-height:1.6;");
    stats.innerHTML =
      `<strong>Derived stats</strong><br>` +
      `thrust ${derived.thrust} · turn ${derived.turnRate.toFixed(1)}<br>` +
      `shield ${derived.shieldCapacity} · sensor ${derived.sensorRange} · cargo ${derived.cargo}<br>` +
      `power <span style="color:${derived.underpowered ? "#ff6b6b" : "#4ade80"}">${derived.powerProduction}/${derived.powerDemand}${derived.underpowered ? " underpowered" : ""}</span>`;

    const errBox = document.createElement("div");
    errBox.id = "builder-errors";
    errBox.setAttribute("style", `margin-top:8px;font-size:12px;color:${errors.length ? "#ff6b6b" : "#4ade80"};min-height:18px;`);
    errBox.textContent = errors.length ? errors.map((e) => e.message).join("; ") : "valid design ✓";

    const controls = document.createElement("div");
    controls.setAttribute("style", "display:flex;gap:8px;margin-top:12px;");
    const rotateBtn = mkBtn("rotate", "#2a3550", "#cdd6e4", () => {
      this.rotation = ((this.rotation + 90) % 360) as 0 | 90 | 180 | 270;
      this.render();
    });
    const applyBtn = mkBtn(this.mode.kind === "build" ? "Build ship" : "Apply", "#54c8ff", "#04101c", () => {
      if (errors.length) return;
      if (this.mode.kind === "build") this.cb.onBuild(this.mode.planetId, structuredClone(bp), "Custom");
      else this.cb.onApply(structuredClone(bp));
      this.close();
    });
    applyBtn.id = "builder-apply";
    (applyBtn as HTMLButtonElement).disabled = errors.length > 0;
    if (errors.length) applyBtn.style.opacity = "0.5";
    const cancelBtn = mkBtn("Cancel", "#2a3550", "#cdd6e4", () => this.close());

    controls.append(rotateBtn, applyBtn, cancelBtn);

    const panel = document.createElement("div");
    panel.setAttribute("style", "display:flex;flex-direction:column;gap:8px;padding:20px;background:#0d1420;border:1px solid #2a3550;border-radius:10px;");
    panel.append(
      titleEl(`Ship Builder — place: ${this.selectedModule} (rot ${this.rotation}°) · click cell to place/remove`),
      grid,
      palette,
      stats,
      errBox,
      controls,
    );
    this.overlay.replaceChildren(panel);
  }
}

function titleEl(text: string): HTMLElement {
  const h = document.createElement("h3");
  h.setAttribute("style", "margin:0 0 4px;");
  h.textContent = text;
  return h;
}
function mkBtn(label: string, bg: string, fg: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.setAttribute("style", `padding:8px 16px;border-radius:6px;border:none;background:${bg};color:${fg};font-weight:600;cursor:pointer;`);
  b.addEventListener("click", onClick);
  return b;
}
function roomColorHex(kind: string): string {
  switch (kind) {
    case "bridge":
      return "#ffd166";
    case "engine":
      return "#4ade80";
    case "reactor":
      return "#a78bfa";
    case "weapon":
      return "#ff6b6b";
    case "shield":
      return "#54c8ff";
    case "mining":
      return "#ffb454";
    default:
      return "#8899aa";
  }
}
