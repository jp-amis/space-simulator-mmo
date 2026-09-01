// Lazy resource accumulation (DESIGN §4.1, §6). Resources are not ticked every
// frame; the stored amount is derived from the last-update timestamp on read.

import type { PlanetState } from "./types.js";

export function materializePlanetResources(p: PlanetState, nowMs: number): void {
  const dt = Math.max(0, nowMs - p.resourceUpdatedAtMs) / 1000;
  p.storedResources.metal += p.resourceRates.metalPerSec * dt;
  p.storedResources.fuel += p.resourceRates.fuelPerSec * dt;
  p.resourceUpdatedAtMs = nowMs;
}
