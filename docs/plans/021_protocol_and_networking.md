# 021 — Protocol & Networking for Continuous Combat

- **Status:** Done
- **Design step:** Step 5 — continuous combat refactor (see [DESIGN.md](../DESIGN.md))
- **Design refs:** [015](015_continuous_combat_model.md) §9, §10; DESIGN §10.2, §10.3
- **Depends on:** [016](016_per_ship_kinematics_and_active_clusters.md), [017](017_continuous_combat_resolution.md), [020](020_fleet_orders_and_doctrine.md)

## Goal
Delete the discrete **battle-arena** wire protocol and replace it with **continuous, visibility-keyed** networking ([015](015_continuous_combat_model.md) §9). The per-player sensor-filtered `getVisibleState` (`apps/server/src/snapshot.ts`) is extended to include per-ship **world-space** state for sensed active-cluster ships, plus world-space projectiles and combat events. A higher-rate **active-region delta** channel — the map equivalent of the old `battleFrame`, keyed by player **visibility** and *not* by a battle subscription ([015](015_continuous_combat_model.md) §9) — carries fast-changing ship/projectile state. A player sees sensed ships fire and move; **nothing battle-arena remains in the wire protocol** (DESIGN §10.2, §10.3).

## Scope
### In scope
- **Remove** from `packages/protocol/src/index.ts`: `BattlePublicState`, `BattleDelta`, `BattleShipDto`, the arena `ProjectileDto`, server messages `battleStarted` / `battleFrame` / `battleEnded`, client message `subscribeBattle`, `FleetDto.battleId`, `PlayerVisibleSnapshot.activeBattleIds`, and `"battle"` from the `FleetDto.status` / `FleetStatus` enum. (`BattleEventDto` is repurposed as world combat events, `BattleResult` retired.)
- **Add** world-space DTOs: `ActiveShipDto` (world position/velocity/heading/shield/hull/target), world `ProjectileDto` (world position), `CombatEventDto` (fire/hit/roomDisabled/shipDestroyed with world coords).
- **Add** `ActiveRegionDelta` server message (`activeRegionDelta`), higher rate than `snapshot`, visibility-filtered per player.
- **Extend** `getVisibleState` to emit sensed active-cluster ships + world projectiles + combat events via the existing `sensorSources`/`canSensePoint` filter.
- **Add** `FleetStatus:"engaging"` to the `FleetDto.status` enum; the order/doctrine client messages from [020](020_fleet_orders_and_doctrine.md).

### Out of scope
- Client rendering/LOD consuming these DTOs — [022](022_client_rendering_and_lod.md).
- Combat resolution producing the events/projectiles — [017](017_continuous_combat_resolution.md).
- Order/doctrine command *handlers* — [020](020_fleet_orders_and_doctrine.md) (this plan only carries their wire schemas).
- Removal of engine-side `startBattle`/`endBattle`/`broadcastBattles`/`battleSubs` — [017](017_continuous_combat_resolution.md) per [015](015_continuous_combat_model.md) §11.

## Tasks
- [ ] Delete `BattleShipDto`, `ProjectileDto` (arena), `BattlePublicState`, `BattleDelta`, `BattleResult` from `packages/protocol/src/index.ts`.
- [ ] Remove `battleStarted` / `battleFrame` / `battleEnded` from `ServerMessage`; remove `subscribeBattle` from `ClientMessage`.
- [ ] Remove `FleetDto.battleId` and `PlayerVisibleSnapshot.activeBattleIds`; drop `"battle"` from the status enum, add `"engaging"`.
- [ ] Add world-space `ActiveShipDto`, `ProjectileDto` (world), `CombatEventDto` Zod schemas + types.
- [ ] Add `activeRegionDelta` to `ServerMessage`: `{ ships: ActiveShipDto[]; projectiles: ProjectileDto[]; events: CombatEventDto[] }`.
- [ ] Add order/doctrine client messages from [020](020_fleet_orders_and_doctrine.md) to `ClientMessage` (moveTo/attackMove/follow/pursue/escort/hold, setDoctrine preset).
- [ ] Extend `snapshot.ts`: `enemyFleetDto` drops `battleId`, maps `"battle"`→`"engaging"`; add sensed-ship inclusion using `sensorSources`.
- [ ] Add `buildActiveRegionDelta(game, playerId, nowMs)` in `snapshot.ts`, filtered by `canSensePoint`.
- [ ] Remove `activeBattleIds` assembly from `getVisibleState`; add sensed active-ship/projectile/event assembly.
- [ ] Emit `activeRegionDelta` from the engine heartbeat in place of `broadcastBattles` (higher rate than snapshots).

## Key types & signatures
```ts
// packages/protocol/src/index.ts  (ADD)
export const ActiveShipDto = z.object({
  shipId: z.string(), fleetId: z.string(), ownerId: z.string(),
  position: Vec2, velocity: Vec2, heading: z.number(),
  shield: z.number(), maxShield: z.number(),
  hullHp: z.number(), hullMaxHp: z.number(),
  targetShipId: z.string().optional(), alive: z.boolean(),
});
export const ProjectileDto = z.object({ id: z.string(), position: Vec2, velocity: Vec2 }); // world-space
export const CombatEventDto = z.discriminatedUnion("type", [
  z.object({ type: z.literal("fire"), from: Vec2, to: Vec2, projectileId: z.string() }),
  z.object({ type: z.literal("hit"), ship: z.string(), at: Vec2, damage: z.number(), shield: z.boolean() }),
  z.object({ type: z.literal("roomDisabled"), ship: z.string(), roomId: z.string() }),
  z.object({ type: z.literal("shipDestroyed"), ship: z.string(), at: Vec2 }),
]);

// PlayerVisibleSnapshot: drop activeBattleIds; FleetDto.status enum: drop "battle", add "engaging"; drop FleetDto.battleId.

export const ServerMessage = z.discriminatedUnion("type", [
  /* ...welcome, snapshot, ack, reject, fleetMovement... */
  z.object({ type: z.literal("activeRegionDelta"),
             ships: z.array(ActiveShipDto),
             projectiles: z.array(ProjectileDto),
             events: z.array(CombatEventDto) }),
]);

// apps/server/src/snapshot.ts  (ADD)
function buildActiveRegionDelta(
  game: GameState, playerId: string, nowMs: number,
): { ships: ActiveShipDto[]; projectiles: ProjectileDto[]; events: CombatEventDto[] };
// filtered by sensorSources()/canSensePoint()
```

## Acceptance criteria
> Acceptance: a player sees sensed ships' positions and fire via snapshot + delta; nothing battle-arena remains in the wire protocol; the visibility filter is unit- and integration-tested.

- [ ] `grep BattlePublicState|BattleDelta|BattleShipDto|battleStarted|battleFrame|battleEnded|subscribeBattle|activeBattleIds|battleId` finds nothing in `packages/protocol/src/index.ts`.
- [ ] `FleetStatus`/`FleetDto.status` has `"engaging"` and no `"battle"`.
- [ ] `getVisibleState` includes sensed active-cluster ships (world coords) but never enemy ship internals (DESIGN §10.3).
- [ ] `activeRegionDelta` is emitted per player, visibility-filtered, at a higher rate than `snapshot`, and is not gated on any subscription.
- [ ] The order/doctrine client messages from [020](020_fleet_orders_and_doctrine.md) decode via `ClientMessage`.
- [ ] Client + server both typecheck against the trimmed protocol.

## Testing
- Unit (`@space/protocol`): schemas parse valid `ActiveShipDto`/`ProjectileDto`/`CombatEventDto`/`activeRegionDelta`; removed schemas no longer exported (type-level).
- Unit (`apps/server`): `buildActiveRegionDelta` includes only ships passing `canSensePoint`; enemy internals absent.
- Unit: `enemyFleetDto` maps `"battle"`→`"engaging"` and omits `battleId`.
- Integration: two players, one sensing the other's engaging fleet — sensing player receives `activeRegionDelta` with the enemy ships' world positions + `fire` events; non-sensing player receives neither.
- Integration: issue each [020](020_fleet_orders_and_doctrine.md) order over the wire; assert ack + no arena messages emitted.

## Unresolved questions
- `activeRegionDelta` rate + whether to diff vs full active set each send?
- Coalesce delta into `snapshot` when a player senses no active cluster (suppress empty deltas)?
- Keep `BattleEventDto` name for `CombatEventDto`, or rename to avoid "battle"?
- Per-player delta cost — cap sensed-ship count / cull by zoom hint from client?
