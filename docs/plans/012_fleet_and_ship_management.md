# 012 — Fleet & Ship Management

- **Status:** Done
- **Design step:** Post-prototype fix — playtest gap (built ships + fleet ops)
- **Design refs:** [DESIGN.md](../DESIGN.md) §4.2, §4.3, §8, §10.2
- **Depends on:** [004](004_fleet_domain_and_movement.md), [008](008_ship_builder_ui.md), [009](009_economy_and_construction.md)

## Goal
Make built ships visible and usable, and give the player real control over fleet
composition. Today a completed ship is added to `player.shipIds` only — never to a
fleet — and the map/inspector only surface ships that live inside a fleet, so a
freshly built ship silently disappears. `createFleet` exists server-side but the
client never calls it and there is no UI to form, split, merge, or reinforce fleets.
This plan adds a **Roster panel** plus one new command so the player can turn docked
ships into fleets and reorganize them.

## Scope
### In scope
- Surface **docked ships** (owned ships not in any fleet) in the UI.
- A dedicated, toggleable **Roster panel** listing fleets + docked ships with
  create / add / split / merge actions.
- New server command `addShipsToFleet`; shared empty-fleet cleanup.
- Reuse of the existing `createFleet` command for "create" and "split".

### Out of scope
- Drawing docked ships on the strategic map — they stay stationed/off-map, shown
  only in the roster/inspector (revisit later if needed).
- Physical co-location / logistics for regrouping (prototype simplification: ships
  regroup regardless of position; new fleets spawn at the home planet).
- Fleet renaming, waypoints, or formations.
- Battle-view exit and camera navigation — [013](013_battle_lifecycle_and_exit.md),
  [014](014_navigation_and_camera.md).

## Concept — "docked" ships
A **docked** ship is any owned ship in `player.shipIds` that is not a member of any
fleet. It is derivable **client-side** from the snapshot with no schema change:

```
dockedShipIds = you.shipIds  minus  union(ownFleets.map(f => f.shipIds))
```

`PlayerVisibleSnapshot.ships` already contains every owned ship
(`apps/server/src/snapshot.ts` builds `ships` from `player.shipIds`), and own
`FleetDto.shipIds` is already serialized (added in plan 004). So the data is present;
only UI + one command are missing. No change to `completeConstruction` is required —
a newly built ship is "docked" by definition.

## Tasks
- [ ] **Protocol** (`packages/protocol/src/index.ts`): add
      `addShipsToFleet { requestId, fleetId, shipIds }` to the `ClientMessage` union
      + Zod schema.
- [ ] **Server** (`apps/server/src/engine.ts`):
  - [ ] Add `handleAddShipsToFleet`: validate the target fleet is owned; pull
        `shipIds` (owned only) out of any other fleet; append to the target; reindex
        the target trajectory (`reindexFleetTrajectory`); mark dirty; ack.
  - [ ] Add a shared `removeEmptyFleets(player)` helper and call it from both
        `handleCreateFleet` and `handleAddShipsToFleet` — today `handleCreateFleet`
        strips ships from source fleets but leaves empty husks in `game.fleets` /
        `player.fleetIds`. Empty fleets should be dropped (or marked `destroyed` and
        removed from the spatial index).
  - [ ] Route the new command in `handle()`.
- [ ] **Client** — new `apps/client/src/roster.ts` (Roster panel), wired in
      `apps/client/src/main.ts`, with a toggle button added to the resource bar in
      `apps/client/src/ui.ts`:
  - [ ] Compute docked ships from the store snapshot.
  - [ ] Render **Fleets** section (name/short-id, ship count, status) and **Docked
        ships** section (checkboxes). Fleet ships are also checkbox-selectable.
  - [ ] Actions: **Create fleet** → `createFleet(checkedShipIds)`; **Add to fleet ▾**
        → `addShipsToFleet(targetFleetId, checkedShipIds)`. Split = check a subset of
        a fleet's ships → Create fleet. Merge = check all of fleet B's ships → Add to
        fleet A (B is then auto-removed by cleanup).
  - [ ] Reuse `NetClient.command` for sends and the inspector's per-ship "edit"
        affordance to open the ship builder from a roster row.
  - [ ] Only rebuild the panel on `snapshotVersion` / open-state changes (mirror the
        inspector's gating in `ui.ts`) so checkboxes/buttons aren't detached mid-click.
- [ ] Stable DOM hooks for e2e: `#roster`, `#roster-toggle`, `.roster-ship`,
      `.roster-fleet`, `#roster-create-fleet`, `#roster-add-fleet`.

## Key types & signatures
New command (protocol):
```ts
| { type: 'addShipsToFleet'; requestId: string; fleetId: string; shipIds: string[] }
```

Existing server handler reused for create/split (`apps/server/src/engine.ts`):
```ts
private handleCreateFleet(playerId: string, requestId: string, shipIds: string[]): void {
  const player = this.game.players.get(playerId);
  if (!player) return this.reject(playerId, requestId, "no player");
  const owned = shipIds.filter((id) => this.game.ships.get(id)?.ownerId === playerId);
  if (owned.length === 0) return this.reject(playerId, requestId, "no owned ships");
  for (const f of this.game.fleets.values()) f.shipIds = f.shipIds.filter((id) => !owned.includes(id));
  const fleet = createFleet(this.game, player, owned, this.nowFn());
  fleet.position = this.homePos(playerId);
  this.reindexFleetTrajectory(fleet);
  // + removeEmptyFleets(player)  ← new
  this.dirty = true;
  this.ack(playerId, requestId);
}
```

## Acceptance criteria
> A player can build a ship, see it, and organize ships into fleets from the client.

- [ ] Build a ship → it appears under **Docked ships** in the roster after the
      construction job completes.
- [ ] Create a fleet from one or more docked ships → a new fleet appears on the map.
- [ ] Add docked ships to an existing fleet → its ship count increases.
- [ ] Split: move a subset of a fleet's ships into a new fleet.
- [ ] Merge: fold one fleet's ships into another → the emptied fleet disappears.
- [ ] All operations are server-authoritative (ownership validated; bad requests
      `reject`ed without mutation).

## Testing
- **Unit** (`apps/server/src/engine.test.ts`): `addShipsToFleet` moves ships and
  removes an emptied source fleet; `createFleet` with a subset splits and cleans up;
  ownership rejection leaves state unchanged.
- **E2E** (`apps/client/e2e/game.spec.ts`): build a ship (advance/wait for
  completion), open the roster, assert the docked ship is listed, create a fleet
  (assert own fleet count +1 via `window.__game.store`), add/split/merge assertions,
  screenshot `07-roster.png`.

## Unresolved questions
- Should docked ships eventually get a small "docked at planet" marker on the map, or
  stay roster-only? (assumption: roster-only for now)
- Do we need a per-ship "dock" (remove from fleet without forming a new fleet)? Split
  currently always creates a fleet.
