# 009 — Economy and Construction

- **Status:** Done
- **Design step:** Step 8 — see [DESIGN.md](../DESIGN.md)
- **Design refs:** §4.1, §6, §11
- **Depends on:** [008 — Ship Builder UI](./008_ship_builder_ui.md)

## Goal
Turn the strategic map into an economy: planets accumulate resources over real
time via lazy timestamp materialization, and a construction queue produces ships
and modules with resource costs, resolved through scheduled completion events
rather than per-second ticking. This closes the "gather resources → build ships"
half of the core loop so a player can grow a fleet from an owned planet without
any per-entity per-frame server work.

## Scope
### In scope
- Lazy resource accumulation on `PlanetState` (materialize on read/spend/event).
- Construction queue with `construction-complete` scheduled events.
- Building ships/modules against `storedResources` with validated costs.
- Command handlers following the standard resolve → validate → materialize →
  mutate → schedule → mark-dirty pattern (§11).
- DOM UI exposing stored resources, rates, queue timers and costs.
- Completed ships entering player inventory (`PlayerState.shipIds`).

### Out of scope
- Sensor-gated visibility of enemy resources — deferred to
  [011 — Visibility, Sensors and Polish](./011_visibility_sensors_and_polish.md).
- Combat presentation — [010 — Combat Presentation](./010_combat_presentation.md).
- Research trees, marketplaces, deep resource chains (out of prototype scope).

## Tasks
- [ ] Implement `materializePlanetResources(p, nowMs)` in `@space/simulation`.
- [ ] Call materialize on every read/spend and before any scheduled event that
      needs the current value.
- [ ] Define construction costs and durations in `@space/config`.
- [ ] Add `ConstructionJob` handling on `PlanetState.constructionQueue`.
- [ ] Schedule `construction-complete` events on the shared event heap (§6).
- [ ] On completion: create the ship/module, add to `PlayerState.shipIds`
      (or install module), mark planet dirty.
- [ ] Add `enqueueConstruction` command handler (validate authority, materialize
      resources, deduct cost, schedule completion, ack/reject) per §11.
- [ ] Add protocol DTOs + Zod schemas for construction commands/events in
      `@space/protocol`.
- [ ] DOM UI: resource bar with live-derived amounts, planet queue panel with
      per-job cost and ETA, build buttons disabled when unaffordable.
- [ ] Ensure resource accrual on the client is display-only interpolation from
      `resourceRates` + `resourceUpdatedAtMs` (no client authority).

## Key types & signatures
```ts
type PlanetState = {
  id: EntityId;
  ownerId?: string;
  name: string;
  position: Vec2;
  radius: number;
  resourceRates: { metalPerSec: number; fuelPerSec: number };
  resourceUpdatedAtMs: number;
  storedResources: { metal: number; fuel: number };
  facilities: FacilityState[];
  constructionQueue: ConstructionJob[];
};
```

```ts
function materializePlanetResources(p: PlanetState, nowMs: number) {
  const dt = Math.max(0, nowMs - p.resourceUpdatedAtMs) / 1000;
  p.storedResources.metal += p.resourceRates.metalPerSec * dt;
  p.storedResources.fuel += p.resourceRates.fuelPerSec * dt;
  p.resourceUpdatedAtMs = nowMs;
}
```

```ts
// Scheduled completion event on the shared heap (§5.2 / §6).
type ScheduledEvent =
  | { atMs: number; type: 'construction-complete'; planetId: string; jobId: string }
  // ...other event kinds
  ;
```

## Acceptance criteria
> Acceptance: resources accumulate with real time, construction finishes without per-second entity ticking, and completed ships enter player inventory.

- [ ] Stored resources reflect elapsed real time when a planet is opened/spent.
- [ ] No per-second per-entity update loop drives resources or construction.
- [ ] Construction completes via a single scheduled event at `atMs`.
- [ ] Completed ship appears in `PlayerState.shipIds` and is fleet-usable.
- [ ] Costs and timers are visible in the DOM UI.

## Testing
From [DESIGN.md §14](../DESIGN.md):
- Scheduler: event ordering; multiple due events in one heartbeat; stale/ignored
  events do not double-complete a job.
- Lazy materialization: amount before/at/after an interval; zero-`dt` no-op;
  spend then re-materialize yields consistent totals.
- Integration: enqueue construction, advance time, assert `construction-complete`
  fires and the ship enters inventory.
- Invalid-ownership / unaffordable enqueue is rejected without state mutation.

## Unresolved questions
- Fuel-only rates in `resourceRates` vs `energy` in `PlayerState.resources` — reconcile which resource set economy uses.
- Construction queue: parallel jobs or strictly serial? (durations chain if serial.)
- Do modules build on a planet then attach, or build directly onto a docked ship?
