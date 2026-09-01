// Persistent resource-operation state machine (plan 032). Runs the mining loop
// automatically by issuing fleet orders: travel+mine → cargo full → return → unload →
// repeat. Pure over GameState (mutates it); no wall-clock, deterministic.

import { RESOURCE } from "@space/config";
import type { GameState, ResourceOperation } from "./types.js";
import { fleetCentroid, pickDeposit } from "./worldSim.js";
import { addToBag, bagTotal } from "./resources.js";
import { materializePlanetResources } from "./economy.js";
import { dist } from "./vec.js";

/** Advance mining stations: each auto-extracts from its location into its storage (plan 034). */
export function stepStations(game: GameState, dtMs: number): void {
  const dt = dtMs / 1000;
  for (const station of game.stations.values()) {
    const loc = game.resourceLocations.get(station.locationId);
    if (!loc) continue;
    const deposit = pickDeposit(loc);
    if (!deposit || deposit.reserves <= 0) continue;
    const free = station.capacity - bagTotal(station.storage);
    if (free <= 0) continue;
    const rate = station.extraction * deposit.richness * deposit.accessibility * dt;
    const moved = Math.max(0, Math.min(rate, free, deposit.reserves));
    if (moved <= 0) continue;
    addToBag(station.storage, deposit.resource, moved);
    deposit.reserves -= moved;
  }
}

/** True once every mining-capable ship in the fleet has filled its cargo (plan 035).
 *  Robust to escorts/haulers whose empty holds would otherwise drag a fleet-average below 100%. */
function minersFull(game: GameState, fleetId: string): boolean {
  const fleet = game.fleets.get(fleetId);
  if (!fleet) return true;
  let anyMiner = false;
  for (const id of fleet.shipIds) {
    const s = game.ships.get(id);
    if (!s || s.derived.miningPower <= 0) continue;
    anyMiner = true;
    if (s.derived.cargo - bagTotal(s.cargo) > 0.5) return false; // still room
  }
  return anyMiner; // no miners → nothing to fill, don't loiter
}

/** Total cargo carried vs. total capacity across a fleet's ships. */
function fleetCargo(game: GameState, fleetId: string): { carried: number; capacity: number } {
  const fleet = game.fleets.get(fleetId);
  let carried = 0;
  let capacity = 0;
  if (fleet) {
    for (const id of fleet.shipIds) {
      const s = game.ships.get(id);
      if (!s) continue;
      carried += bagTotal(s.cargo);
      capacity += s.derived.cargo;
    }
  }
  return { carried, capacity };
}

/** Advance every active operation one step. Mutates `game` (issues orders, moves cargo). */
export function stepOperations(game: GameState, _dtMs: number, nowMs: number): void {
  for (const [id, op] of game.operations) {
    const fleet = game.fleets.get(op.fleetId);
    if (!fleet || fleet.status === "destroyed" || fleet.shipIds.length === 0) {
      game.operations.delete(id); // fleet gone → operation impossible
      continue;
    }
    const loc = game.resourceLocations.get(op.locationId);
    const planet = game.planets.get(op.deliveryPlanetId);
    if (!loc || !planet) {
      game.operations.delete(id);
      continue;
    }
    if (op.paused) continue;

    switch (op.state) {
      case "mining": {
        if (fleet.order.kind !== "mine" || fleet.order.locationId !== op.locationId) {
          fleet.order = { kind: "mine", locationId: op.locationId };
          fleet.position = { ...loc.position };
        }
        const depleted = !pickDeposit(loc);
        if (minersFull(game, op.fleetId) || depleted) {
          op.state = "returning";
          fleet.order = { kind: "moveTo", target: { ...planet.position } };
          fleet.position = { ...planet.position };
        }
        break;
      }
      case "returning": {
        const c = fleetCentroid(game, fleet);
        if (dist(c, planet.position) <= RESOURCE.transferRange) {
          op.state = "unloading";
          // Hand off to the timed unload pass (worldSim) so it streams with a beam (plan 038).
          fleet.order = { kind: "unloadAt", planetId: op.deliveryPlanetId };
          fleet.position = { ...planet.position };
        }
        break;
      }
      case "unloading": {
        materializePlanetResources(planet, nowMs);
        // The world step's unload pass performs the actual transfer; the operation just waits
        // for the cargo to drain, then heads back out to mine again.
        if (fleetCargo(game, op.fleetId).carried <= 0.5) {
          op.state = "mining";
          fleet.order = { kind: "mine", locationId: op.locationId };
          fleet.position = { ...loc.position };
        }
        break;
      }
    }
  }
}

/** Create + register an operation, immediately kicking its fleet into the mining state. */
export function startOperation(
  game: GameState,
  op: Omit<ResourceOperation, "state" | "paused">,
): ResourceOperation {
  const full: ResourceOperation = { ...op, state: "mining", paused: false };
  game.operations.set(full.id, full);
  const fleet = game.fleets.get(full.fleetId);
  const loc = game.resourceLocations.get(full.locationId);
  if (fleet && loc) {
    fleet.order = { kind: "mine", locationId: full.locationId };
    fleet.position = { ...loc.position };
  }
  return full;
}
