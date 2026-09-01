# 005 — Movement Broad Phase & Encounter Scheduling

- **Status:** Done
- **Design step:** Step 4 — see [DESIGN.md](../DESIGN.md)
- **Design refs:** §5.3, §5.4, §11
- **Depends on:** [004](004_fleet_domain_and_movement.md)

## Goal
Detect when two moving fleets will pass within engagement distance of each other and schedule an encounter event at the exact time of closest approach. This is the trigger that turns free movement into combat — the highest-risk seam of the whole loop. It must work when fleets start moving at different times, using a spatial broad phase plus an exact relative-motion narrow phase, all in pure testable simulation code.

## Scope
### In scope
- Uniform spatial hash grid indexing swept movement bounding boxes (`@space/simulation`).
- Re-indexing a fleet trajectory only when its plan changes (not per frame).
- Candidate query: cells touched by a plan's swept bounds whose time intervals overlap.
- Relative-motion closest-approach solver over the common time interval.
- Encounter-check event type; scheduling into the existing event heap.
- Revalidation on execution (movement revisions + hostility) before combat.
- Unit tests for closest approach and stale-revision handling.

### Out of scope
- The battle simulation itself — starting/stepping combat is [006](006_minimal_battle_simulation.md).
- Room-level ship stats / derived engagement ranges from modules — [007](007_ftl_modular_ships.md).
- Sensor/visibility filtering of enemy trajectories — Step 10.
- R-tree / region partitioning (uniform grid is deliberate; see DESIGN §17).

## Tasks
- [ ] Implement uniform hash grid: key `"cx:cy"` → `Set<fleetId>`; cell size several times the engagement radius (§5.4).
- [ ] Compute a trajectory's swept AABB from `MovementPlan.from`/`to`; enumerate intersected cells.
- [ ] `reindexFleetTrajectory(fleet)` — remove old cells, insert new; called on plan change only.
- [ ] Candidate query on plan create/change: gather other active trajectories in touched cells whose `[startMs,endMs]` intervals overlap (§5.3 broad phase + candidate query).
- [ ] Implement relative-motion closest-approach (§5.3 narrow phase): `tClosest = clamp(-dot(r0, vRel) / dot(vRel, vRel), t0, t1)`; if `distanceAt(tClosest) <= engagementRadius` → candidate.
- [ ] Add `encounter-check` scheduled event at `tClosest`; insert into heap.
- [ ] On event execution: revalidate both fleets' `movement.revision` and hostility; only then hand off to combat (stub call for now).
- [ ] Wire `schedulePotentialEncounters(fleet)` into the `moveFleet` handler (§11).
- [ ] Vitest cases per §14.1 closest-approach table.

## Key types & signatures
```ts
type ScheduledEvent =
| { atMs: number; type: 'fleet-arrival'; fleetId: string; movementRevision: number }
| { atMs: number; type: 'construction-complete'; planetId: string; jobId: string }
| { atMs: number; type: 'scan-refresh'; regionKey: string };
```

Relative-motion closest approach (§5.3), copy verbatim into the solver:
```ts
// During the common time interval [t0, t1], each fleet has
// pA(t) = a0 + vA*t and pB(t) = b0 + vB*t.
// Relative position r(t) = (a0-b0) + (vA-vB)*t.
// Minimize |r(t)|²:
// tClosest = clamp(-dot(r0, vRel) / dot(vRel, vRel), t0, t1)
// If distanceAt(tClosest) <= engagementRadius -> candidate encounter.
```

Broad/narrow phase pipeline (§5.3):

| Phase | Implementation |
| --- | --- |
| Broad phase | Index each active movement segment into spatial cells intersected by its swept bounding box. Cell size can be several times the normal engagement radius. |
| Candidate query | When a movement command is created/changed, query the cells touched by its swept bounds for other active fleet trajectories whose time intervals overlap. |
| Narrow phase | Solve relative motion over the overlapping time interval and calculate time of closest approach. If distance <= engagement radius, produce an encounter candidate. |
| Schedule | Insert an encounter-check event at the calculated closest-approach timestamp. On execution, revalidate both movement revisions and hostility before starting combat. |

Command handler integration point (§11), `schedulePotentialEncounters(fleet)` is called here:
```ts
fleet.movement = { from: origin, to: cmd.target, startMs: now,
endMs: now + durationMs, speed, revision };
reindexFleetTrajectory(fleet);
scheduleArrival(fleet);
schedulePotentialEncounters(fleet);
markFleetDirty(fleet.id);
```

## Acceptance criteria
> Acceptance: two fleets whose paths cross at different start times engage only when they are spatially close at the same time.

- [ ] Fleet B may start minutes after Fleet A and still generate an encounter when their overlapping trajectory windows come within engagement radius (§5.3).
- [ ] Paths that cross in space but not in time produce no encounter.
- [ ] Re-indexing happens only on plan change; idle indexed fleets cost ~0 work.
- [ ] Stale-revision encounter events are ignored on execution.

## Testing
Per DESIGN §14.1:
- **Closest approach:** parallel paths; exact crossing; crossing at different times; stationary target; near miss at engagement radius boundary.
- **Scheduler:** event ordering; stale movement revision ignored; multiple due events in one heartbeat.
- Determinism: solver is pure math, no `Math.random()`; results reproducible.

## Unresolved questions
- Encounter radius source: fleet `engagementRange` const now vs derived from ship modules (deferred to [007](007_ftl_modular_ships.md))?
- Hostility model pre-combat: all non-owner fleets hostile, or explicit flag?
