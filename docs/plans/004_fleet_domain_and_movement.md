# 004 — Fleet Domain & Free Movement

- **Status:** Done
- **Design step:** Step 3 — see [DESIGN.md](../DESIGN.md)
- **Design refs:** §4.3, §5, §5.1, §5.2, §11
- **Depends on:** [003](003_strategic_map_and_procedural_universe.md)

## Goal
Make fleets move continuously through 2D space using analytical, event-driven trajectories instead of per-frame simulation. A fleet's position is a pure function of time; the server schedules a single arrival event per fleet and the client interpolates from the authoritative movement plan. This delivers loop steps 6–7 (§1.1 — create a fleet, issue a destination, let trajectories play out) and satisfies the core §19 requirement that an idle moving fleet costs effectively zero per-frame server work while remaining redirectable without positional jumps.

## Scope
### In scope
- Ship and fleet data types (`ShipState` references, `FleetState`, `MovementPlan`).
- Render fleet markers (oriented chevrons/count badges) and trajectory lines client-side.
- `moveFleet` command handler following the §11 pattern.
- Analytical `positionAt(m, nowMs)` for server + client-side interpolation.
- Arrival event scheduling via a timestamped min-heap; `revision`-based stale-event rejection.
- Redirect mid-flight: materialize current position at command time as the new segment origin, bump `revision`.

### Out of scope
- Spatial hash broad phase, swept-bounds indexing, closest-approach / encounter scheduling — Step 4 (DESIGN §5.3–§5.4, §13 Step 4).
- Battles / combat — Step 5+ (§7, §13 Step 5).
- Ship builder, modular rooms and derived stats used for strategic speed (§8) — later; use a placeholder `calculateFleetStrategicSpeed` for now.
- Full sensor visibility on fleet trajectories (§10.3).

## Tasks
- [ ] Define ship/fleet data types in the domain model; add `fleets: Map` usage.
- [ ] Implement `createFleet` (from `shipIds`) sufficient to have a fleet to move.
- [ ] Implement `positionAt(m, nowMs)` (pure) in `@space/simulation`.
- [ ] Implement `moveFleet` handler per §11: resolve actor, assert ownership + not in battle, materialize origin at `now`, compute speed/distance/duration, build `MovementPlan` with incremented `revision`, schedule arrival, mark dirty, ack.
- [ ] Implement a binary min-heap of `ScheduledEvent` ordered by `atMs`; process due events each heartbeat.
- [ ] Handle `fleet-arrival`: ignore if stored `movementRevision` no longer matches the fleet's plan.
- [ ] Emit `fleetMovement { fleetId, movement }` to clients; interpolate client-side with `positionAt`.
- [ ] Render fleet markers + trajectory lines + arrival marker; interpolate from the plan (no per-frame position packets).
- [ ] Support redirect mid-flight: new command re-materializes current position as segment origin, bumps `revision`.

## Key types & signatures
Fleet state (§4.3):
```ts
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
type MovementPlan = {
from: Vec2;
to: Vec2;
startMs: number;
endMs: number;
speed: number;
revision: number;
};
```

Position as a function of time (§5.1):
```ts
function positionAt(m: MovementPlan, nowMs: number): Vec2 {
if (nowMs <= m.startMs) return m.from;
if (nowMs >= m.endMs) return m.to;
const t = (nowMs - m.startMs) / (m.endMs - m.startMs);
return {
x: m.from.x + (m.to.x - m.from.x) * t,
y: m.from.y + (m.to.y - m.from.y) * t,
};
}
```
When a new command is issued, first materialize the fleet's position at the command timestamp; that becomes the new segment origin. Increment `revision` so stale scheduled events can cheaply detect that the movement plan changed (§5.1).

Scheduled events (§5.2) — one arrival per fleet at `endMs`; a binary min-heap ordered by timestamp is sufficient; a changed-course fleet's old event is ignored by comparing the stored movement revision:
```ts
type ScheduledEvent =
| { atMs: number; type: 'fleet-arrival'; fleetId: string; movementRevision: number }
| { atMs: number; type: 'construction-complete'; planetId: string; jobId: string }
| { atMs: number; type: 'scan-refresh'; regionKey: string };
```

Command handler pattern (§11):
```ts
async function handleMoveFleet(playerId: string, cmd: MoveFleetCommand) {
const fleet = game.fleets.get(cmd.fleetId);
assert(fleet && fleet.ownerId === playerId);
assert(fleet.status !== 'battle');
const now = Date.now();
const origin = getFleetPosition(fleet, now);
const speed = calculateFleetStrategicSpeed(fleet);
const distance = length(sub(cmd.target, origin));
const durationMs = distance / speed * 1000;
const revision = (fleet.movement?.revision ?? 0) + 1;
fleet.status = 'moving';
fleet.movement = { from: origin, to: cmd.target, startMs: now,
endMs: now + durationMs, speed, revision };
reindexFleetTrajectory(fleet);
scheduleArrival(fleet);
schedulePotentialEncounters(fleet);
markFleetDirty(fleet.id);
}
```
Note: `reindexFleetTrajectory` and `schedulePotentialEncounters` are stubs here (they belong to Step 4); keep them as no-op seams so this handler is complete when the broad phase lands.

## Acceptance criteria
> Acceptance: fleets move continuously, arrive at the expected server timestamp, and can be redirected without positional jumps.

- [ ] Fleets move continuously (client interpolation from the plan, no per-frame packets).
- [ ] Arrival fires at the expected server `endMs` timestamp.
- [ ] Redirect mid-flight starts from the materialized current position (no jump), `revision` incremented.
- [ ] Idle moving fleet costs ~0 per-frame server work (§19).

## Testing
From §14:
- §14.1 movement: position before/start/mid/end; redirect mid-flight; zero-distance target; speed changes.
- §14.1 scheduler: event ordering; stale movement revision ignored; multiple due events in one heartbeat.
- §14.2 integration: start server in-process, connect WebSocket, `hello`, create/move a fleet, observe `fleetMovement` events.
- §14.2 integration: issue an invalid-ownership `moveFleet` and assert rejection without state mutation.
- `positionAt` and the min-heap live in `@space/simulation` — the same package callable from handlers and tests (§19).

## Unresolved questions
- `calculateFleetStrategicSpeed`: placeholder constant until ship derived stats exist (§8) — slowest-ship cap vs formation value (§8.2)?
- Fleet speed source before the ship builder: fixed config value?
- Do neutral/enemy fleet movements broadcast at all before sensor visibility (§10.3)?
