# 035 — Mining Fills Cargo to Full (not 95%)

- **Status:** Done
- **Design step:** Resource epic — playtest fix
- **Design refs:** [032](032_resource_operations_and_industrial_roles.md); [031](031_mining_and_cargo_transfer.md)
- **Depends on:** [032](032_resource_operations_and_industrial_roles.md)

## Problem
A miner's cargo stops filling at **95/100**. The manual `mine` order fills correctly to 100%
(the extraction pass in `packages/simulation/src/worldSim.ts` runs while `free = derived.cargo
- bagTotal(cargo) > 0`). The culprit is the **auto-mine operation**: `stepOperations`
(`packages/simulation/src/operations.ts`) uses `const FULL_FRACTION = 0.95` and transitions
`mining → returning` as soon as **fleet-aggregate** fill `carried / capacity >= 0.95`, so ships
never top off.

## Fix
- Raise the return threshold so the fleet leaves only when effectively **full**. Use a small
  epsilon rather than exactly `1.0` to avoid a stall on the last sliver: transition when
  `fill >= 0.999` **or** `capacity - carried <= 1` (within one unit), **or** the deposit is
  depleted (existing `!pickDeposit(loc)` check).
- Keep `fleetCargo()` (per-fleet carried/capacity) as-is. Confirm the manual `mine` path already
  reaches 100% and add a regression test so it can't drift.

## Key files
- `packages/simulation/src/operations.ts` — `FULL_FRACTION` / the `mining → returning` condition in `stepOperations`.

## Acceptance criteria
- An auto-mine operation fills its miners to **100%** (or until the deposit runs dry) before returning.
- A manual `mine` order fills a ship to exactly `derived.cargo`.

## Testing
- Unit (`@space/simulation`): drive `stepOperations` with a full-capacity miner over a rich deposit;
  assert it only flips to `returning` at ~capacity (not 95%); assert manual `stepWorld` mining fills to 100%.

## Unresolved questions
- None — pure threshold fix. (Consider whether escorts with cargo-but-no-mining should count toward
  `capacity`; today they do, which can drag the aggregate — revisit if fleets mix miners + haulers,
  tracked in [037](037_escort_screen_protects_miners.md).)
