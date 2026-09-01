# 036 — Mining Ship Positioning: Outer Ring + Face the Deposit

- **Status:** Done
- **Design step:** Resource epic — mining presentation/behavior
- **Design refs:** [031](031_mining_and_cargo_transfer.md); [027](027_fleet_formation_presets.md); the mining-beam FX in [the mining-feedback work]
- **Depends on:** [031](031_mining_and_cargo_transfer.md)

## Problem
When a fleet mines, `handleMine` sets `fleet.position = loc.position` (the deposit **center**)
and ships steer to normal formation slots around that anchor (`computeFormationOffsets`,
`COMBAT.formationSpacing = 90`) — so miners **cluster on top of the core**. Also a parked
miner has ~0 velocity, so `rt.heading` (set from velocity in `worldSim.ts`) defaults to 0
(facing right) instead of **pointing at the deposit**. The mining beam therefore lances out
from a clump of ships that aren't even facing the rock.

Wanted: while mining, ships sit **farther out on a ring around the deposit** and **always point
inward** at the center (beam looks like it's actually being worked).

## Approach (server; the client already draws heading + the beam)
When a fleet's order is `mine`, override the normal formation with a **mining ring**:
- In `stepWorld` (`packages/simulation/src/worldSim.ts`), when `fleet.order.kind === "mine"`,
  compute each **mining ship's** slot as a point on a circle of radius `RESOURCE.mineRing`
  (new config, e.g. ~180 — comfortably inside `RESOURCE.mineRange = 260` so they still extract)
  centered on the deposit, evenly spaced by angle (stable per-ship angle from ship id / index).
  Non-mining ships are handled in [037](037_escort_screen_protects_miners.md).
- **Heading:** for a ship whose fleet is mining and that is in range of the deposit, set
  `rt.heading = atan2(loc.y - rt.position.y, loc.x - rt.position.x)` (face the core), instead of
  the velocity-derived heading. This needs the deposit `loc` in the steering loop — reuse the
  `mine` order's `locationId` (already looked up in the mining pass) or set `rt.miningLocationId`
  earlier so the movement loop can read it.
- Keep the small cosmetic client float (`miningFloat`) — it complements the ring.

## Key files
- `packages/config/src/index.ts` — `RESOURCE.mineRing` (new).
- `packages/simulation/src/worldSim.ts` — mining-ring slot computation for miners; face-the-deposit heading.
- (No protocol/client change required — heading + `miningLocationId` already stream; the beam draws from the ship's position/heading.)

## Acceptance criteria
- A mining fleet forms a visible **ring around** the field (not a pile at the center), with ships
  spaced apart and all **pointing inward**; beams converge on the deposit.
- Ships stay within `mineRange` so extraction continues; deterministic (same fleet → same ring).

## Testing
- Unit (`@space/simulation`): after several `stepWorld` steps on a `mine` order, each miner's
  distance to the deposit ≈ `mineRing` (± arrival slop) and `heading` points within a few degrees
  of the deposit center.
- Manual: start mining, zoom in — ships ring the field and face it.

## Unresolved questions
- Exact `mineRing` radius and whether it scales with miner count (bigger ring for more ships).
- Interaction with the fleet's selected `formation` preset (mining ring should override it while mining).
