# 040 — Ship Explosion on Death (client-side detection)

- **Status:** Done
- **Design step:** Post-resource playtest fix
- **Design refs:** [028](028_client_visual_polish.md) (explosion FX)
- **Depends on:** [028](028_client_visual_polish.md)

## Problem
Ships **don't explode when they die**. The explosion FX exists and renders correctly
(`apps/client/src/scene.ts` explosion loop; `store.explosions`), and the client spawns one on a
`shipDestroyed` combat event — but that event **never arrives**. In `stepWorld`
(`packages/simulation/src/worldSim.ts` §5) the dead ship is removed from `game.shipRuntime` in the
same step; then `buildSensedShips` (`apps/server/src/snapshot.ts`) filters `combatEvents` by
`sensedShipIds` (built from `game.shipRuntime`), so the destroyed ship's event — whose target is no
longer in `shipRuntime` — is **dropped**. Result: no explosion.

**Decision:** fix it **client-side only** (per request) — no server/protocol change. There is a clean,
reliable client death signal: a ship the client was already tracking as **mortally wounded** that then
**vanishes** from the sensed-ship stream almost certainly died (a ship merely leaving sensor range is
usually at healthy hull and far from the player).

## Approach (client only, `apps/client/src/store.ts`)
- The client already tracks sensed ships in `activeShips` (each with the last `dto` incl. `hullHp` /
  `hullMaxHp` and a smoothed `shown` position). On each `activeRegion` delta, mark the set of shipIds
  present this frame.
- In the prune/update path (`updateActiveShips`, or right after applying a delta), for any tracked
  ship that is **absent from the new delta** and was **mortally wounded last seen** — i.e.
  `hullHp / hullMaxHp` below a small threshold (e.g. `< 0.2`) **or** it was a lock target
  (some ship's `targetShipId`) last frame — **spawn an explosion at its last `shown` position**
  (reuse the existing `explosions.push({...})` used by the `shipDestroyed` handler), then remove it.
- Ships that vanish while **healthy** are treated as "left sensor range" → no explosion (avoids false
  bursts on enemies simply moving out of vision).
- Keep the existing `shipDestroyed` event handler as-is (harmless; a no-op today, and a bonus if the
  event ever does arrive).

## Key files
- `apps/client/src/store.ts` — track present-this-frame ship ids; on a mortally-wounded ship
  disappearing, spawn an explosion; helper for the "mortal" test.
- (No `scene.ts` change — the explosion render already exists; no server/protocol change.)

## Acceptance criteria
- When a ship dies in combat within your sensor range, an explosion plays at its position.
- A healthy enemy leaving your sensor range does **not** trigger an explosion (no false positives).

## Testing
- Unit (`@space/client`, vitest): feed a delta with ship "a" at low hull (e.g. hullHp 3 / hullMaxHp 100),
  then a delta without "a" → `store.explosions.length === 1` at a's last position. Feed a healthy ship
  "b" (full hull) that then disappears → no explosion.
- Manual: spawn a hostile, fight — dying ships burst; ships that scout away don't.

## Unresolved questions
- Mortal-hull threshold and whether to also treat "was a lock target + vanished" as death (reduces
  missed explosions for one-shot kills that skip the low-hull frame).
- Debris also appears at a death location ([033](033_logistics_warfare_cargo_and_salvage.md)); the debris arriving in the next
  snapshot could be a secondary confirmation signal if the hull-threshold heuristic misses.
