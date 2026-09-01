# 006 — Minimal Battle Simulation

- **Status:** Done
- **Design step:** Step 5 — see [DESIGN.md](../DESIGN.md)
- **Design refs:** §6, §6.1, §7, §7.1, §7.2, §7.3, §7.4
- **Depends on:** [005](005_encounter_detection.md)

## Goal
Turn a scheduled encounter into an automatic, fixed-step tactical battle that runs only while fleets are fighting, then writes survivors and damage back to strategic state. This closes the movement → encounter → combat loop. Combat must be deterministic under a seed so battles are reproducible in headless tests. First version uses simple ship circles (position, HP, range, cooldown, damage); modular rooms come later in [007](007_ftl_modular_ships.md).

## Scope
### In scope
- Battle manager owning active `BattleState`s (`@space/server`).
- Fixed-step accumulator loop stepping only active battles (§6.1), 10 Hz prototype.
- `stepBattle(battle, dt)` in `@space/simulation`: target selection, movement, cooldowns, firing, damage.
- Simple ship circles: position, HP, range, cooldown, damage (no rooms yet).
- Deterministic seeded RNG abstraction (no `Math.random()`).
- Deterministic seeded initial placement of fleets on opposing sides.
- Doctrine fields consumed by target selection / movement / retreat.
- Start battle from an encounter event; write result back to fleets and place survivors at encounter position.
- Headless battle tests (fixed seed → deterministic winner).

### Out of scope
- Modular hull grids, room targeting, capability disabling — [007](007_ftl_modular_ships.md).
- Ship builder UI — [008](008_ship_builder_ui.md).
- Battle visualization / interpolated frames / effects — Step 9.
- Crew movement/repair behavior (bonuses only, later).

## Tasks
- [ ] Add battle manager: `activeBattles: Map<EntityId, BattleState>`; start/resolve lifecycle.
- [ ] Implement fixed-step accumulator (§6.1): `BATTLE_DT_MS = 100`, monotonic `performance.now()` deltas, epoch `Date.now()` for scheduled events; never derive physics deltas from wall-clock jumps.
- [ ] Build local battle instance by copying/referencing participating ship combat state (§7.2 step 1).
- [ ] Deterministic seeded placement on opposing sides of a bounded combat space (§7.2 step 2).
- [ ] Per-tick doctrine target choose/validate (§7.2 step 3, §7.4).
- [ ] Desired movement: close distance / maintain range / retreat per doctrine (§7.2 step 4).
- [ ] Update velocity/position from ship stats (§7.2 step 5).
- [ ] Advance weapon cooldowns; fire when ready and in range (§7.2 step 6).
- [ ] Resolve projectile/beam hit: shield first, then hull damage (§7.2 step 7).
- [ ] Apply crew bonuses (§7.2 step 9).
- [ ] Remove destroyed ships; end battle when one side has no combat-capable ships or retreats (§7.2 step 10).
- [ ] Write survivors/damage back to strategic ship state; place surviving fleets at encounter position (§7.2 step 11).
- [ ] Implement deterministic RNG consuming battle `rngState` in fixed order (§7.3).
- [ ] Headless test: "run seed 42817 for 30 seconds and expect ship B destroyed" (§7.3).

## Key types & signatures
```ts
type BattleState = {
id: EntityId;
startedAtMs: number;
tick: number;
rngState: number;
participants: BattleFleetState[];
projectiles: ProjectileState[];
eventsSinceBroadcast: BattleEvent[];
status: 'running' | 'resolved';
};
type BattleShipState = {
shipId: EntityId;
position: Vec2;
velocity: Vec2;
facingRad: number;
targetShipId?: EntityId;
weaponCooldowns: Record<EntityId, number>;
shield: number;
};
```

Fixed-step battle accumulator (§6.1) — copy verbatim:
```ts
const BATTLE_DT_MS = 100; // 10 Hz prototype
let previousMs = performance.now();
let accumulator = 0;
setInterval(() => {
const now = performance.now();
accumulator += now - previousMs;
previousMs = now;
processScheduledEvents(Date.now());
while (accumulator >= BATTLE_DT_MS) {
for (const battle of activeBattles.values()) {
stepBattle(battle, BATTLE_DT_MS / 1000);
}
accumulator -= BATTLE_DT_MS;
}
broadcastDirtyState();
}, 50);
```

Combat doctrine (§7.4) drives per-tick decisions:

| Doctrine field | Examples |
| --- | --- |
| Preferred range | close / medium / long |
| Target priority | weapons first / engines first / weakest hull / nearest |
| Focus fire | same target / independent targets |
| Retreat rule | never / hull below 25% / flagship destroyed |
| Power priority | shields > engines > weapons, or player-defined ordering |

## Acceptance criteria
> Acceptance: encounters reliably transition into automatic combat and produce deterministic winners for a fixed seed.

- [ ] An encounter event starts a battle without manual input.
- [ ] Only active battles tick; idle world stays event-driven.
- [ ] Same seed + same inputs → identical result (winner, final state).
- [ ] Survivors and damage are written back into strategic fleet/ship state at the encounter position.

## Testing
Per DESIGN §14:
- **Combat determinism:** same seed + same inputs = same result; replay N ticks gives expected hash/state (§14.1).
- **Combat damage:** shield depletion, destruction and retreat (room-specific cases deferred to [007](007_ftl_modular_ships.md)) (§14.1).
- **Integration (§14.2):** two players send crossing movement plans and assert `battleStarted` occurs near predicted time.
- No `Math.random()` in core combat (§7.3); RNG consumed in deterministic order.

## Unresolved questions
- Combat space bounds / placement spread — config values in `@space/config`?
- Retreat: teleport survivors to encounter point or resume prior trajectory?
- Broadcast cadence of battle frames now vs deferred to Step 9?
