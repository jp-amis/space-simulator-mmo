# 017 — Continuous Combat Resolution

- **Status:** Done
- **Design step:** Step 5 (combat refactor) — see [DESIGN.md](../DESIGN.md)
- **Design refs:** [015](015_continuous_combat_model.md) §10, §11; DESIGN §7
- **Depends on:** [016](016_per_ship_kinematics_and_active_clusters.md)

## Goal
Move combat resolution — target selection, firing, world-space projectiles, swept hit tests, and damage — **inside the active-cluster step** from [016](016_per_ship_kinematics_and_active_clusters.md), running in **world space** on the shared map ([015](015_continuous_combat_model.md) §10, §11). The reusable resolution logic (`chooseTarget`, `pickTargetRoom`, `applyDamage`, `segmentPointDistance`, `HIT_RADIUS`, `preferredRangeUnits`) is lifted **unchanged** out of `packages/simulation/src/battle.ts` into a shared `packages/simulation/src/combat.ts` (`@space/simulation`) so it operates on `ActiveShip` + world-space `Projectile`. Damage writes **live** to the persistent `ShipState` (`hull`, `rooms`) — ships die and are removed mid-simulation. This deletes the arena abstraction entirely: `BattleState`, `setupBattle`, `runBattleToEnd`, `stepBattle`, arena placement, and the `startBattle`/`endBattle`/`broadcastBattles` lifecycle in `apps/server/src/engine.ts` (`@space/server`).

## Scope
### In scope
- New `packages/simulation/src/combat.ts` that **lifts unchanged** from `battle.ts` ([015](015_continuous_combat_model.md) §11): `chooseTarget`, `pickTargetRoom`, `applyDamage`, `segmentPointDistance`, `HIT_RADIUS`, `preferredRangeUnits`.
- World-space `Projectile` type (owned by the `ActiveCluster`, not arena-relative) — replaces `ProjectileState`.
- `resolveCombatStep(cluster, dtSec, ships, rng)` — the combat hook that [016](016_per_ship_kinematics_and_active_clusters.md)'s `ActiveClusterManager.step` calls: choose targets, fire (world-space), advance projectiles, swept-hit, apply damage live.
- Live damage to `ShipState.hull`/`ShipState.rooms` via the unchanged `applyDamage`; recompute `computeDerived` on room loss (as `battle.ts` already does).
- Mid-cluster death: destroyed ships removed from `ActiveCluster.ships`, `fleet.shipIds`, `game.ships`, and owner `shipIds`.
- Cluster-seeded RNG drives all draws (`pickTargetRoom` tie-break) in fixed order ([015](015_continuous_combat_model.md) §10).
- Remove from `battle.ts`/`types.ts`/`engine.ts`: `BattleState`, `BattleShipState`, `ProjectileState`, `setupBattle`, `stepBattle`, `runBattleToEnd`, arena placement, `startBattle`/`endBattle`/`broadcastBattles`/`tryStartBattle`, and `BATTLE.arenaWidth/arenaHeight/separation/maxDurationMs`.

### Out of scope
- Kinematics, cluster promote/demote, `ActiveShip`, `ACTIVE_DT` stepping — [016](016_per_ship_kinematics_and_active_clusters.md) (§3, §4). This phase only fills the combat hook.
- Steering, perception, formation, `ShipDoctrine` — [018](018_ship_brain_and_doctrine.md) (§7, §8). Here targeting uses `chooseTarget` against `ActiveShip` positions with a placeholder steering.
- Fleet-brain engagement scoring / intent — [019](019_fleet_brain_consensus_and_intent.md) (§5).
- Protocol removal of `battleFrame`/`battleStarted`/`battleEnded` and world-space projectile/event DTOs — [021](021_protocol_and_networking.md) (§9).
- Client rendering of world-space fire/projectiles — [022](022_client_rendering_and_lod.md) (§9).

## Tasks
- [ ] Create `combat.ts`; move `chooseTarget`, `pickTargetRoom`, `applyDamage`, `segmentPointDistance`, `HIT_RADIUS`, `preferredRangeUnits` from `battle.ts` **verbatim**, retyped to operate on `ActiveShip` (they already read `ShipState` for hull/rooms).
- [ ] Define world-space `Projectile` (`types.ts`) owned by `ActiveCluster`; add `projectiles: Projectile[]` and a `combatEvents: CombatEvent[]` buffer to `ActiveCluster`.
- [ ] Implement `resolveCombatStep(cluster, dtSec, ships, rng)`: for each alive `ActiveShip`, `chooseTarget` among hostile members, fire per-weapon (cooldowns on `ActiveShip.weaponCooldowns`, world-space velocity toward target), shield regen (`shieldRegenPerSec`).
- [ ] Advance projectiles in **world space**; swept hit via `segmentPointDistance` ≤ `HIT_RADIUS`; on hit call `applyDamage` (unchanged) with a `rng.int(...)` room pick.
- [ ] Wire `resolveCombatStep` as the combat hook invoked by `ActiveClusterManager.step` (the no-op seam from [016](016_per_ship_kinematics_and_active_clusters.md)).
- [ ] Remove destroyed ships mid-step: delete from `cluster.ships`, `game.ships`, owner `shipIds`, and `fleet.shipIds`; if a fleet empties, mark `destroyed`.
- [ ] Delete `BattleState`/`BattleShipState`/`ProjectileState` from `types.ts`; delete `setupBattle`/`stepBattle`/`runBattleToEnd` and `BATTLE.arena*`/`separation`/`maxDurationMs` from `battle.ts`/`@space/config`; `battle.ts` becomes a thin re-export or is deleted.
- [ ] Rip out `startBattle`/`endBattle`/`broadcastBattles`/`tryStartBattle`/`battlePublic`/`battleSubs`/`endedBattles` and `game.battles` usage from `engine.ts`; port survivor/destruction bookkeeping into demote (from [016](016_per_ship_kinematics_and_active_clusters.md)) + live removal here.

## Key types & signatures
World-space combat state, owned by the cluster ([015](015_continuous_combat_model.md) §11):
```ts
// packages/simulation/src/types.ts
export interface Projectile {
  id: EntityId;
  ownerShipId: EntityId;
  targetShipId: EntityId;
  position: Vec2;   // world space
  velocity: Vec2;   // world space
  damage: number;
  ttlMs: number;
}

export type CombatEvent =
  | { type: "fire"; from: EntityId; to: EntityId; projectileId: EntityId; at: Vec2 }
  | { type: "hit"; ship: EntityId; roomId?: EntityId; damage: number; shield: boolean }
  | { type: "roomDisabled"; ship: EntityId; roomId: EntityId }
  | { type: "shipDestroyed"; ship: EntityId };
```
`ActiveCluster` (extended from [016](016_per_ship_kinematics_and_active_clusters.md)) gains `projectiles: Projectile[]` and `combatEvents: CombatEvent[]`.

Lifted-unchanged surface (`packages/simulation/src/combat.ts`, [015](015_continuous_combat_model.md) §11):
```ts
export const HIT_RADIUS = 26;
export function segmentPointDistance(ax: number, ay: number, bx: number, by: number, q: Vec2): number;
export function preferredRangeUnits(d: FleetDoctrine): number;
export function chooseTarget(self: ActiveShip, enemies: ActiveShip[], doctrine: FleetDoctrine, ships: Map<EntityId, ShipState>): ActiveShip | undefined;
export function pickTargetRoom(ship: ShipState, priority: FleetDoctrine["targetPriority"], pickIndex: number): RoomState | undefined;
export function applyDamage(target: ActiveShip, targetShip: ShipState, damage: number, doctrine: FleetDoctrine, pickIndex: number, events: CombatEvent[]): void;

// combat hook called by ActiveClusterManager.step (016)
export function resolveCombatStep(cluster: ActiveCluster, dtSec: number, ships: Map<EntityId, ShipState>, rng: Rng): void;
```

## Acceptance criteria
> Acceptance: ships fight on the shared map (world-space positions/projectiles), damage persists to `ShipState`, ships die mid-simulation, and a fixed seed yields a deterministic winner.

- [ ] Weapons, projectiles, and hits resolve in **world space** — no arena coordinates anywhere ([015](015_continuous_combat_model.md) §11).
- [ ] `applyDamage` writes **live** to `ShipState.hull`/`rooms`; a ship reaching `hull.hp <= 0` is removed from `cluster.ships`, `game.ships`, and its fleet mid-step.
- [ ] `chooseTarget`/`pickTargetRoom`/`applyDamage`/`segmentPointDistance`/`HIT_RADIUS`/`preferredRangeUnits` are **byte-identical** to the `battle.ts` originals (moved, not rewritten).
- [ ] Deterministic: seed X → same ship destroyed by step N, same winner ([015](015_continuous_combat_model.md) §10) — the old `battle.test.ts` determinism assertion still holds, retargeted at `resolveCombatStep`.
- [ ] `BattleState`, `setupBattle`, `runBattleToEnd`, arena placement, and the battle lifecycle in `engine.ts` are gone.

## Testing
- Port `packages/simulation/src/battle.test.ts` → a combat test that promotes a 2-fleet cluster ([016](016_per_ship_kinematics_and_active_clusters.md)), steps to resolution, and asserts the deterministic winner + destroyed roster for a fixed seed.
- Live damage: assert `game.ships.get(loser).hull.hp` decreases across steps and the entry is deleted on death.
- World-space sanity: projectiles spawn at the firer's world position and travel toward the target's world position (not arena-relative).
- Determinism: two identical runs (same seed) produce identical `combatEvents` streams and identical surviving `ShipState` snapshots.
- Regression: assert `battle.ts` arena/`BattleState` symbols no longer resolve (compile-level removal).

## Unresolved questions
- Ship-vs-ship collision/overlap during combat, or ignore (as arena did)?
- Winner/leash resolution now that there is no `maxDurationMs` timeout — does demote ([016](016_per_ship_kinematics_and_active_clusters.md)) or the fleet brain ([019](019_fleet_brain_consensus_and_intent.md)) own "battle over"?
- Keep the `fire`/`hit`/`roomDisabled`/`shipDestroyed` event shapes for reuse in [022](022_client_rendering_and_lod.md), or redesign for world-space rendering?
