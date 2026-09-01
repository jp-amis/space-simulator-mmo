# 013 — Battle Lifecycle & Client Exit

- **Status:** Done
- **Design step:** Post-prototype fix — playtest gap (client stuck in battle view)
- **Design refs:** [DESIGN.md](../DESIGN.md) §7, §10.2, §10.3
- **Depends on:** [006](006_minimal_battle_simulation.md), [010](010_combat_presentation.md)

## Goal
Guarantee the client always returns to the strategic map when a battle ends. Today
the client's exit from the battle view depends **solely** on receiving a single
`battleEnded` message plus a 4-second `setTimeout` (`apps/client/src/store.ts`), and
`scene.render()` hard-returns to the battle view for as long as `store.battle` is
truthy. If that one message is ever missed or delayed, the client is locked in the
battle view forever. This plan makes the **authoritative snapshot** the exit signal
(with `battleEnded` reduced to a result banner), and cleans up resolved battles on
the server so they don't linger.

## Scope
### In scope
- Client exits the battle view when the authoritative snapshot no longer lists the
  battle as active (`activeBattleIds`), independent of `battleEnded`.
- A brief **"Battle over"** result banner with a **Return to map** button, replacing
  the silent timer.
- Server: emit `battleEnded` to all connected participants (not just current
  subscribers) and **delete** the resolved battle from `game.battles`.

### Out of scope
- Battle rendering/effects themselves — [010](010_combat_presentation.md).
- Rewards, post-battle salvage, or retreat mechanics beyond current behavior.

## Root cause (confirmed)
- `startBattle` (`apps/server/src/engine.ts:407`) pre-subscribes connected
  participants, so `battleEnded` normally *is* delivered — but there is **no
  fallback** if it isn't.
- `store.applyServer` `battleEnded` case clears `store.battle` only inside a 4 s
  `setTimeout` guarded by `this.battle?.id === msg.battleId`.
- `scene.render()` begins with `if (this.store.battle) { …renderBattle(); return; }`
  — so a non-cleared `store.battle` locks the whole view.
- Resolved battles are never removed from `game.battles`; they linger and are
  re-iterated every tick.

## Tasks
- [ ] **Client** (`apps/client/src/store.ts`): in the `snapshot` handler, if
      `this.battle` is set and `msg.world.activeBattleIds` does **not** include
      `this.battle.id`, transition out of the battle (record the result if known,
      then clear `this.battle`). This is the authoritative fallback.
- [ ] **Client** (`apps/client/src/store.ts` + `apps/client/src/ui.ts`): replace the
      silent 4 s timer with a **battle-result banner** (winner side, ships lost) plus
      a **Return to map** button; auto-return after ~2 s. Banner data comes from the
      `battleEnded` result when present, else a neutral "Battle over" from the
      snapshot fallback.
- [ ] **Client** (`apps/client/src/scene.ts`): keep the `store.battle` guard, but
      ensure the result-banner state renders the map underneath (or a clearly final
      frame) so exit is visible.
- [ ] **Server** (`apps/server/src/engine.ts` `endBattle`):
  - [ ] Emit `battleEnded` to participants derived from `battle.ships` owner ids
        (all currently connected), not only `this.battleSubs`.
  - [ ] After emitting, **delete** the battle from `game.battles` (and clear it from
        `battleSubs` / `endedBattles` bookkeeping). Confirm `activeBattleIds` in
        `apps/server/src/snapshot.ts` already excludes non-running battles (it does).

## Key types & signatures
Client snapshot fallback (`store.ts`):
```ts
case "snapshot":
  this.snapshot = msg.world;
  this.snapshotVersion++;
  // Authoritative battle exit: the server no longer lists this battle as active.
  if (this.battle && !msg.world.activeBattleIds.includes(this.battle.id)) {
    this.endBattleView(); // set result banner (if any) then clear this.battle
  }
  break;
```

Relevant server message (unchanged, `packages/protocol/src/index.ts`):
```ts
| { type: 'battleEnded'; battleId: string; result: BattleResult }
```

## Acceptance criteria
> After a battle resolves, every participant's client returns to the strategic map.

- [ ] When a battle ends, the client shows a brief result banner and returns to the
      map within ~2 s — even if the `battleEnded` message is dropped (verified by the
      snapshot fallback).
- [ ] Survivors reappear on the map with preserved damage; destroyed ships are gone.
- [ ] No resolved battle remains in `game.battles` (`/debug/state` shows none).

## Testing
- **Unit** (`apps/server/src/engine.test.ts`): after a battle resolves and a tick
  runs, `game.battles` no longer contains it, and `battleEnded` was emitted to both
  participants.
- **E2E** (`apps/client/e2e/game.spec.ts`): extend the existing two-context battle
  test — after `store.battle` becomes set, **poll until it clears**, then assert the
  map is visible again (`window.__game.scene`/`store` shows no battle and
  `activeBattleIds` is empty). Screenshot `08-post-battle.png`.

## Implementation notes (done)
- Client exits via the snapshot fallback (`store.ts` `endBattleView`), plus a result
  banner + **Return to map** in `ui.ts`. Server `endBattle` now emits to all connected
  participants and deletes the battle from `game.battles`.
- The redundant client `subscribeBattle` on `battleStarted` was removed — participants
  are auto-subscribed in `startBattle`, and the late send raced battle deletion,
  producing a spurious "no such battle" reject.
- **Combat decisiveness fix (`packages/simulation/src/battle.ts`):** playtesting the
  exit revealed the real 2v2 ran to the 90 s max-duration cap. Fast projectiles move
  52–90 units per 100 ms step but the hit radius is 26, so endpoint hit-testing made
  them overshoot almost every step → near-zero damage → stalemate. Replaced the
  endpoint check with a **swept segment** test (`segmentPointDistance`), so a
  projectile hits if its travel segment passes within the radius. Battles now resolve
  decisively (~40 s for identical starter fleets) instead of timing out.

## Unresolved questions
- Auto-return delay (~2 s) vs. requiring the **Return to map** click — default to
  auto-return with the button as an override.
- Should the loser see a distinct "defeated" banner vs. the winner's "victory"?
  (assumption: same banner showing winner side.)
- Combat tuning: identical starter fleets still take ~40 s. Consider higher weapon
  damage / lower shield regen for punchier fights (balance, separate task).
