# 011 — Visibility, Sensors and Strategic Polish

- **Status:** Done
- **Design step:** Step 10 — see [DESIGN.md](../DESIGN.md)
- **Design refs:** §10.3, §15
- **Depends on:** [010 — Combat Presentation](./010_combat_presentation.md)

## Goal
Close the prototype by making information intentionally filtered and the
simulation inspectable. Per-player visible-state filtering (`getVisibleState`)
prevents leakage of enemy layouts, destinations and resources; sensor ranges gate
what enemy trajectory detail is revealed; and strategic UX polish (ETAs,
engagement-range overlays, notifications, rejection feedback) plus developer debug
overlays let both players and developers understand why encounters were or were
not scheduled.

## Scope
### In scope
- `getVisibleState(playerId)` snapshot builder — never serialize full `GameState`
  (§10.3), building on the seam established in
  [002 — ID Entry and Player Registry](./002_id_entry_and_player_registry.md).
- Sensor-range-gated reveal of enemy fleets/trajectory detail (uses
  `FleetState.sensorRange`, per §4.3 / §6 sensor visibility model).
- Strategic UI: movement ETA, engagement-range overlays, notifications, command
  rejection feedback.
- Debug overlays: spatial hash cells, swept trajectory AABBs, fleet movement
  revision + start/end timestamps + computed current position, event heap
  inspector, battle pause/step/speed, seed display + "restart with same seed",
  optional per-tick state hash (§15).
- `/debug/state` sanitized whole-world endpoint (dev only).

### Out of scope
- Persistence of scheduled jobs / durable timers (future migration, §17).
- Binary protocol, sharding, auth (future, §17).
- New gameplay systems — this step is filtering + observability polish only.

## Tasks
- [ ] Implement `getVisibleState(playerId)`; route all snapshots through it so
      enemy private fields (room layouts, destinations, resources) never leak.
- [ ] Gate enemy fleet/trajectory detail by sensor range (event-driven + 1–2 Hz
      refresh per §6); reveal only design-permitted fields.
- [ ] Client: movement ETA display and engagement-range overlays (from
      `FleetState.engagementRange` / `sensorRange`).
- [ ] Client: notification feed and command `reject` feedback surfaced in UI.
- [ ] Debug toggle: draw spatial hash cells and each fleet's swept trajectory AABB
      (references [004 — Fleet Domain and Movement](./004_fleet_domain_and_movement.md)).
- [ ] Debug overlay: fleet movement revision, start/end timestamps, computed
      current server position.
- [ ] Event heap inspector listing next scheduled events.
- [ ] Battle dev controls: pause/step/speed, seed display, restart-with-same-seed.
- [ ] Optional deterministic state hash per battle tick for desync/replay.
- [ ] Add `/debug/state` endpoint returning sanitized whole-world state (dev only).

## Key types & signatures
```ts
// Visibility is a filtering function over existing state (§10.3):
//   getVisibleState(playerId): PlayerVisibleSnapshot
// sent via the existing protocol DTO from §10.2:
//   { type: 'snapshot'; world: PlayerVisibleSnapshot }
// Sensor/engagement ranges come from FleetState (§4.3):
type FleetState = {
  id: EntityId;
  ownerId: string;
  shipIds: EntityId[];
  status: 'idle' | 'moving' | 'engaging' | 'battle' | 'destroyed';
  movement?: MovementPlan;
  battleId?: EntityId;
  sensorRange: number;
  engagementRange: number;
};
```

## Acceptance criteria
> Acceptance: strategic information is intentionally filtered and developers can visualize why encounters were or were not scheduled.

- [ ] Enemy private fields never appear outside sensor/permission rules.
- [ ] Snapshots are always built via `getVisibleState`, never raw `GameState`.
- [ ] Developers can toggle overlays showing spatial cells, swept AABBs, movement
      revisions/timestamps/current position and the scheduled-event heap.
- [ ] ETA, engagement-range overlays, notifications and rejection feedback appear
      in the strategic UI.

## Testing
From [DESIGN.md §14](../DESIGN.md):
- Visibility: enemy private fields never appear outside sensor/permission rules.
- Integration: issue invalid ownership command → `reject` with no state mutation,
  surfaced in UI.
- Closest-approach cases (parallel, exact crossing, crossing at different times,
  stationary target, near-miss at engagement-radius boundary) remain visualizable
  via the debug overlays to explain scheduling decisions.
- Scheduler: event heap inspector reflects ordering / stale-revision skipping.

## Unresolved questions
- Exact reveal rules: what enemy trajectory detail (destination? speed? ship count?) is disclosed inside sensor range vs merely "contact present"?
- Sensor visibility update: purely event-driven or periodic 1–2 Hz refresh, or both?
- Which debug overlays ship in prod builds vs dev-only gate?
