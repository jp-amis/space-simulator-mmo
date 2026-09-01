# 010 — Combat Presentation

- **Status:** Done
- **Design step:** Step 9 — see [DESIGN.md](../DESIGN.md)
- **Design refs:** §9.3, §9.4
- **Depends on:** [009 — Economy and Construction](./009_economy_and_construction.md)

## Goal
Make the automatic battle readable. The authoritative simulation already exists
(see [006 — Minimal Battle Simulation](./006_minimal_battle_simulation.md)); this
step renders it entirely from procedural geometry — no assets — with client-side
interpolation of server battle frames plus effects (projectiles, beams, impacts,
shield rings, explosions) and a battle log / room-damage readout. The point is
that a viewer can understand what is happening and why a build won, using only
Pixi primitives.

## Scope
### In scope
- Battle scene rendering: hull polygons + internal room rectangles + weapon
  geometry + thruster particles (procedural, §9.3).
- Interpolation of `battleFrame` deltas for smooth 60fps visuals from a 10–20 Hz
  authoritative feed.
- Effects: projectiles, beams, impact pulses, shield rings, destroyed-ship
  explosions (client-only; state comes from server, §9.4).
- Battle log and per-room damage indicators.
- Rendering-performance discipline (§9.4): reuse Graphics, redraw on change only,
  cull off-screen, batch particles.

### Out of scope
- Battle simulation math, RNG, damage model — owned by
  [006 — Minimal Battle Simulation](./006_minimal_battle_simulation.md).
- Dev pause/step/speed controls and seed replay UI — deferred to
  [011 — Visibility, Sensors and Polish](./011_visibility_sensors_and_polish.md).
- Combat doctrine editing UI.

## Tasks
- [ ] Build a battle scene / layer set that mirrors `BattlePublicState` and
      `BattleDelta` snapshots — no game state stored on display objects.
- [ ] Render each ship from its blueprint: hull polygon, room rects colored by
      system category, weapon barrels, thruster particles.
- [ ] Interpolate ship position/facing and projectile travel between authoritative
      `battleFrame` ticks; do not snap on each frame.
- [ ] Draw projectiles/beams as lines/circles with conservative additive bloom.
- [ ] Draw shield rings that react to shield value and depletion.
- [ ] Spawn short-lived expanding explosion + particle/fragment effects on
      ship/room destruction.
- [ ] Show room damage indicators (hp bars / darkening / disabled markers) and a
      scrolling battle log fed from `BattleEvent`s.
- [ ] Apply §9.4 perf rules: reuse display objects/geometry, redraw static
      Graphics only on visual-state change, batch particles, cull off-screen.
- [ ] Keep all effects client-only; never derive authoritative state on the client.

## Key types & signatures
```ts
// No new DESIGN types are introduced by this presentation step.
// The renderer consumes existing protocol DTOs from §10.2:
//   { type: 'battleStarted'; battle: BattlePublicState }
//   { type: 'battleFrame'; battleId: string; tick: number; delta: BattleDelta }
//   { type: 'battleEnded'; battleId: string; result: BattleResult }
// and mirrors them onto Pixi display objects (never the reverse).
```

## Acceptance criteria
> Acceptance: combat is understandable visually without textures or authored assets.

- [ ] Ships, rooms, weapons and thrusters render from geometry only.
- [ ] Motion and projectiles are smooth despite a 10–20 Hz server feed.
- [ ] Shields, impacts, room damage and destruction are visually distinct.
- [ ] A viewer can follow the battle and infer the outcome cause from visuals + log.

## Testing
From [DESIGN.md §14](../DESIGN.md):
- Presentation is client-only; correctness of combat is covered by combat
  determinism/damage tests in
  [006](./006_minimal_battle_simulation.md) (same seed + inputs = same result).
- Manual/visual verification that interpolation stays consistent with
  authoritative frames (no drift between interpolated and delivered positions).
- Verify effects (shield depletion, room disable, destruction) trigger from
  `BattleEvent`s and never mutate or infer authoritative state.

## Unresolved questions
- Exact shape of `BattleDelta` / `BattleEvent` (fields renderer must interpolate).
- Interpolation buffer depth vs latency — how many frames behind to render?
- LOD threshold for switching between strategic-icon and detailed battle ships.
