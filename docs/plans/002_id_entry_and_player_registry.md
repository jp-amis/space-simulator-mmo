# 002 — ID Entry & In-Memory Player Registry

- **Status:** Done
- **Design step:** Step 1 — see [DESIGN.md](../DESIGN.md)
- **Design refs:** §4, §10.1, §10.2, §11
- **Depends on:** [001](001_monorepo_and_dev_loop.md)

## Goal
Give the prototype an identity boundary: a player types a free-text ID, the client sends a `hello`, and the server creates or retrieves an in-memory `PlayerState` with one home planet and starting resources. This is the entry point of the loop (§1.1 steps 1–2) and establishes the command-handler pattern (§11) plus the DTO/domain separation every later plan reuses. No auth, no persistence — the ID string *is* the account key, and everything resets on restart.

## Scope
### In scope
- DOM ID-entry screen (non-empty free-text input).
- WebSocket `hello { playerId }` message in `@space/protocol` with Zod validation at the boundary.
- `GameState` skeleton with `players: Map<string, PlayerState>` and `getOrCreatePlayer(id)`.
- Create one home planet + starter resources for a new ID.
- Associate the socket with a player ID. **Decision:** a second `hello` for an ID that is *still connected* is **rejected** (`reject` with reason); reconnecting after the previous socket has closed reuses the same in-memory state.
- Server normalizes only what is necessary (e.g. max length).
- Reconnect with the same ID → same in-memory state while the server runs.

### Out of scope
- Procedural universe / map rendering — [003](003_strategic_map_and_procedural_universe.md).
- `getVisibleState` filtering detail and snapshots beyond player/home data — starts in [003](003_strategic_map_and_procedural_universe.md), full filtering later (§10.3).
- Fleets, ships, movement — [004](004_fleet_domain_and_movement.md).
- Real accounts, sessions, reconnect tokens (§17).

## Tasks
- [ ] Build DOM ID-entry screen; reject empty ID.
- [ ] Define `hello` in `@space/protocol` (`ClientMessage`) + Zod schema.
- [ ] Client opens WebSocket and sends `hello { playerId: "alice" }`.
- [ ] Add `GameState` with `players: Map<string, PlayerState>`.
- [ ] Implement `getOrCreatePlayer(id)`: normalize (max length), create if absent.
- [ ] On new ID, create one home planet + starting resources; wire `homePlanetId`.
- [ ] Associate socket ↔ player ID; track live connection per ID. If a `hello` arrives for an ID whose socket is still open, `reject` it (do not replace or share). Allow reconnect once the prior socket closes.
- [ ] Send an initial snapshot (at minimum the player's own state / home planet).
- [ ] Verify reconnect with same ID returns the same in-memory state.

## Key types & signatures
```ts
type EntityId = string;
type Vec2 = { x: number; y: number };
type GameState = {
players: Map<string, PlayerState>;
planets: Map<EntityId, PlanetState>;
ships: Map<EntityId, ShipState>;
fleets: Map<EntityId, FleetState>;
battles: Map<EntityId, BattleState>;
};
type PlayerState = {
id: string;                  // free-text account key for prototype
homePlanetId: EntityId;
resources: { metal: number; fuel: number; energy: number };
fleetIds: EntityId[];
shipIds: EntityId[];
};
```

Connection flow (§10.1): client shows a text input → player enters any non-empty ID such as `alice` → client opens WebSocket and sends `hello { playerId: "alice" }` → server normalizes only what is necessary (e.g. max length); if the ID does not exist in memory, create the player and starting world state → server associates the socket with that player ID (a second connection with the same ID may replace or share — choose one deterministic rule) → server sends an initial snapshot and subsequent events/deltas.

Relevant protocol messages (§10.2):
```ts
type ClientMessage =
| { type: 'hello'; playerId: string }
| { type: 'moveFleet'; requestId: string; fleetId: string; target: Vec2 }
| { type: 'createFleet'; requestId: string; shipIds: string[] }
| { type: 'updateShipBlueprint'; requestId: string; shipId: string; blueprint: ShipBlueprint }
| { type: 'setDoctrine'; requestId: string; fleetId: string; doctrine: FleetDoctrine };
type ServerMessage =
| { type: 'snapshot'; world: PlayerVisibleSnapshot }
| { type: 'ack'; requestId: string }
| { type: 'reject'; requestId: string; reason: string }
| { type: 'fleetMovement'; fleetId: string; movement: MovementPlan }
| { type: 'battleStarted'; battle: BattlePublicState }
| { type: 'battleFrame'; battleId: string; tick: number; delta: BattleDelta }
| { type: 'battleEnded'; battleId: string; result: BattleResult };
```

Command-handler pattern (§11) — every handler follows: resolve actor, validate authority/state, materialize lazy state, mutate authoritative domain state, schedule secondary events, mark dirty state, return ack or rejection.

## Acceptance criteria
> Acceptance: two browser tabs with different IDs see separate in-memory players; restarting server resets both.

- [ ] Two tabs with different IDs → two distinct `PlayerState`s.
- [ ] Each new player gets a home planet + starter resources.
- [ ] Reconnect same ID (server still running) → same state.
- [ ] Server restart → both players gone (in-memory only).

## Testing
From §14 (Testing Strategy):
- §14.2 integration: start server in-process, connect WebSocket client, send `hello`, observe the initial snapshot/events.
- §14.2 integration: reconnect to an existing free-text ID and verify the current in-memory state is returned.
- §14.2 integration: two concurrent `hello`s with the same ID → second is rejected; after the first socket closes, a fresh `hello` for that ID succeeds and returns the same state.
- §14.1 visibility (seam only here): initial snapshot must not leak fields the player shouldn't see — full filtering lands later, but build the `getVisibleState(playerId)` seam now (§10.3).

## Unresolved questions
- ~~Same-ID second connection: replace or share?~~ **Resolved:** reject while the existing socket is connected; allow reconnect after it closes.
- ID normalization: max length value? case-fold?
- Starting resource amounts + home-planet defaults — from `@space/config`?
