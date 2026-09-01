// Uniform spatial hash for trajectory broad phase (DESIGN §5.4). A cell key
// "cx:cy" maps to a Set of fleet IDs. Re-index a fleet only when its trajectory
// changes, not every frame.

import type { MovementPlan } from "./types.js";
import { sweptBounds } from "./movement.js";

export class SpatialHash {
  private cells = new Map<string, Set<string>>();
  private ownerCells = new Map<string, string[]>();

  constructor(private readonly cellSize: number) {}

  private key(cx: number, cy: number): string {
    return `${cx}:${cy}`;
  }

  private cellsForBounds(b: { minX: number; minY: number; maxX: number; maxY: number }): string[] {
    const cs = this.cellSize;
    const keys: string[] = [];
    const x0 = Math.floor(b.minX / cs);
    const x1 = Math.floor(b.maxX / cs);
    const y0 = Math.floor(b.minY / cs);
    const y1 = Math.floor(b.maxY / cs);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) keys.push(this.key(cx, cy));
    }
    return keys;
  }

  /** Insert/replace a fleet's swept trajectory. `pad` widens the box (engagement radius). */
  index(fleetId: string, plan: MovementPlan, pad: number): void {
    this.remove(fleetId);
    const keys = this.cellsForBounds(sweptBounds(plan, pad));
    for (const k of keys) {
      let set = this.cells.get(k);
      if (!set) this.cells.set(k, (set = new Set()));
      set.add(fleetId);
    }
    this.ownerCells.set(fleetId, keys);
  }

  remove(fleetId: string): void {
    const keys = this.ownerCells.get(fleetId);
    if (!keys) return;
    for (const k of keys) {
      const set = this.cells.get(k);
      if (set) {
        set.delete(fleetId);
        if (set.size === 0) this.cells.delete(k);
      }
    }
    this.ownerCells.delete(fleetId);
  }

  /** Fleet IDs (excluding `self`) whose cells intersect the swept bounds of `plan`. */
  query(self: string, plan: MovementPlan, pad: number): Set<string> {
    const out = new Set<string>();
    for (const k of this.cellsForBounds(sweptBounds(plan, pad))) {
      const set = this.cells.get(k);
      if (!set) continue;
      for (const id of set) if (id !== self) out.add(id);
    }
    return out;
  }

  get cellCount(): number {
    return this.cells.size;
  }
}
