# 038 — Timed Unload with a Transfer Beam

- **Status:** Done
- **Design step:** Resource epic — logistics presentation/behavior
- **Design refs:** [031](031_mining_and_cargo_transfer.md); [032](032_resource_operations_and_industrial_roles.md); mining-beam FX
- **Depends on:** [031](031_mining_and_cargo_transfer.md)

## Problem
Delivering cargo to a planet is **instant and invisible**: `handleUnloadCargo`
(`apps/server/src/engine.ts`) moves up to `RESOURCE.transferPerSec` per ship in **one call**, with
no on-screen feedback. It should feel like mining in reverse — the fleet parks at the planet and
**streams cargo over a few seconds with a beam** ship→planet. (The auto-operation `unloading` state
in `operations.ts` already unloads over time via `rate * dt` — we want the manual/visible version.)

## Approach
### Server — make unload a timed order
- Add a fleet order `{ kind: "unloadAt"; planetId }` to `FleetOrder` (`packages/simulation/src/types.ts`)
  (mirrors the `mine` order). `handleUnloadCargo`/a new `handleUnload` sets `fleet.order = unloadAt`
  and `fleet.position = planet.position` so ships fly to the planet and hold.
- In `stepWorld` (`worldSim.ts`), add an **unload pass** (mirror of the mining pass): for a fleet on
  `unloadAt`, each ship within `RESOURCE.transferRange` of the planet transfers `RESOURCE.transferPerSec
  * dt` of metal/fuel into `planet.storedResources`, and sets a per-ship runtime flag
  `rt.unloadLocationId = planetId` (cleared each step like `miningLocationId`). When the fleet's cargo
  is empty, revert to `hold` (and, for an operation, its state machine already advances).
- The operation `unloading` state can reuse the same order/pass for consistency.

### Protocol + client — the beam
- Add `unloadLocationId?: string` to `ActiveShipDto` (`packages/protocol/src/index.ts`); copy it from
  `rt.unloadLocationId` in `buildSensedShips` (`apps/server/src/snapshot.ts`), exactly like
  `miningLocationId`.
- `apps/client/src/scene.ts`: after the mining-beam loop, draw an **outbound transfer beam** from each
  ship with `unloadLocationId` to `snap.planets.find(p => p.id === …)`, reusing the mining-beam
  pulse/alpha pattern but a distinct color (e.g. cool green/blue to read as "delivering"). The planet
  cargo already updates live (per the mining-feedback work), so the numbers tick up as the beam runs.

## Key files
- `packages/simulation/src/types.ts` — `unloadAt` `FleetOrder`; `ShipRuntime.unloadLocationId`.
- `packages/simulation/src/worldSim.ts` — timed unload pass + flag; clear flag each step.
- `apps/server/src/engine.ts` — `handleUnload` issues the order (replace instant transfer).
- `packages/protocol/src/index.ts` + `apps/server/src/snapshot.ts` — `ActiveShipDto.unloadLocationId`.
- `apps/client/src/{scene.ts,main.ts,ui.ts}` — draw the unload beam; the existing **Unload** button
  now issues the timed order.

## Acceptance criteria
- Pressing **Unload** (or an operation returning home) makes the fleet park at the planet and stream
  cargo over a few seconds with a visible beam; planet stores rise gradually; the fleet's cargo
  empties, then it goes idle.
- Determinism preserved (rate `* dt`).

## Testing
- Unit (`@space/simulation`): a laden fleet on `unloadAt` near a planet empties over multiple steps
  (not one), planet stores rise by the moved amount; `rt.unloadLocationId` set while unloading, cleared after.
- Server (`engine.test.ts`): `handleUnload` sets the order; out-of-range ships don't transfer.
- E2E/manual: unload shows a beam; numbers climb live.

## Unresolved questions
- Keep a one-shot fallback if the fleet is already parked on the planet, or always route through the
  timed order? (Prefer always-timed for consistent feedback.)
- Beam color/'(delivering vs mining)' visual language — tune in play.
