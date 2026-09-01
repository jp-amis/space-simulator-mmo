# 022 — Client Continuous Rendering & LOD

- **Status:** Done
- **Design step:** Step 5 refactor — continuous combat on the shared map (see [DESIGN.md](../DESIGN.md))
- **Design refs:** [015](015_continuous_combat_model.md) §9; DESIGN §9, §9.3, §9.4
- **Depends on:** [021](021_protocol_and_networking.md)

## Goal
Delete the separate "battle view" from `@space/client` and render combat **on the same strategic map** in world coordinates, as [015](015_continuous_combat_model.md) §9 mandates ("LOD is a rendering change only — never a gameplay-state change"). Ships, fire, projectiles, shields, and explosions draw inline with fleet markers, interpolated from the per-visibility **active-region delta** channel introduced in [021](021_protocol_and_networking.md). Zoom drives a three-tier LOD (fleet marker → ship silhouette → full ship detail) reusing the existing `drawChevron` and `drawBattleShip` glyph logic, re-based from arena-relative to world coordinates. There is no player-visible "combat mode" ([015](015_continuous_combat_model.md) §1 rule 1, §3).

## Scope
### In scope
- Remove the battle-view path from `apps/client/src/`:
  - `store.ts`: `Store.battle`, `battleShipTargets`, `battleResult`, `battleLog`, `endBattleView`, `dismissBattleResult`, and the `battleStarted` / `battleFrame` / `battleEnded` cases + the `snapshot` `activeBattleIds` battle-exit fallback.
  - `scene.ts`: `battleLayer` / `battleGfx`, the `store.battle` branch in `render()`, `renderBattle`, and the arena-fit math (`battle.arena.*`, `toScreen`). Keep `drawBattleShip` but re-base it to world coords (below).
- Render individual active-cluster ships on the map from the active-region delta, in world coords via `camera.worldToScreen`.
- World-space projectiles, muzzle/fire flashes, shield rings, and short-lived explosion effects drawn from delta events (client-only visuals — DESIGN §9.4 "keep battle visual effects client-only").
- **Zoom LOD** in `scene.ts` (thresholds are tunables, see [015](015_continuous_combat_model.md) §13):
  - far (`zoom < LOD_SILHOUETTE`): fleet marker only — reuse `drawChevron`.
  - medium (`LOD_SILHOUETTE ≤ zoom < LOD_DETAIL`): per-ship silhouettes (small oriented glyph, no room grid).
  - close (`zoom ≥ LOD_DETAIL`): full ship detail — reuse `drawBattleShip` room/hull glyph, world-based, plus shields/fire/projectiles.
- Interpolate ship `position`/`heading`/`shield` between active-region delta frames (same technique the old `battleShipTargets` used, now keyed by world-space ship state).
- Extend `pickAt` (`main.ts`) to select an **individual ship** when `zoom ≥ LOD_DETAIL` and a ship is under the cursor; fleet-level pick otherwise.
- `camera.ts` reused **unchanged**.

### Out of scope
- Server active-cluster sim, promote/demote, world-space projectiles ownership — [016](016_per_ship_kinematics_and_active_clusters.md)–[019](019_fleet_brain_consensus_and_intent.md).
- Protocol DTOs / active-region delta channel definition — [021](021_protocol_and_networking.md) (consumed here).
- Fleet-order and doctrine UI, engagement summary banner, dev spawn tool, tests — [023](023_combat_ui_and_tests.md).
- Any gameplay/state change from LOD — forbidden by [015](015_continuous_combat_model.md) §9.

## Tasks
- [ ] Remove `Store.battle` / `battleShipTargets` / `battleResult` / `battleLog` and the `battleStarted`/`battleFrame`/`battleEnded` cases from `store.ts`; drop the `activeBattleIds` battle-exit fallback in the `snapshot` case.
- [ ] Add store state for active ships: `activeShips: Map<shipId, { fleetId; position; heading; shield; maxShield; alive }>` + interpolation targets, fed by the [021](021_protocol_and_networking.md) active-region delta message; prune on demote/out-of-view.
- [ ] Delete `battleLayer`/`battleGfx`, the `store.battle` branch of `Scene.render()`, `renderBattle`, and arena-fit math from `scene.ts`.
- [ ] Add a `shipLayer` (world container) and draw active ships each frame in world coords.
- [ ] Re-base `drawBattleShip` to accept a world→screen mapping (drop the arena `toScreen`; scale room `cell` by `cam.zoom`); keep the room/hull glyph + shield ring logic (reuse from [015](015_continuous_combat_model.md) §9 "reuse `drawBattleShip`").
- [ ] Implement the three LOD tiers gated by `camera.zoom` vs `LOD_SILHOUETTE` / `LOD_DETAIL` tunables.
- [ ] Draw world-space projectiles + fire flashes + explosion effects from delta events (pooled Graphics, culled off-screen — DESIGN §9.4).
- [ ] Interpolate ship transforms between delta frames using `serverNow()` (mirror `fleetPosition` interpolation).
- [ ] Extend `pickAt` in `main.ts`: at `zoom ≥ LOD_DETAIL`, hit-test `store.activeShips` first (tight screen-space radius) and return `{ kind: "ship", id }`; else fall back to fleet/planet pick.
- [ ] Name LOD thresholds + delta-consumption cadence as tunables in `@space/config` ([015](015_continuous_combat_model.md) §13).

## Key types & signatures
Client-only presentation state (mirrors the world; owns nothing authoritative — DESIGN §16 rule 8):
```ts
// store.ts — replaces battle*/battleShipTargets
interface ActiveShipView {
  fleetId: string;
  position: Vec2;
  heading: number;
  shield: number;
  maxShield: number;
  alive: boolean;
}
// interpolation target buffered from the active-region delta ([021])
activeShips = new Map<string, ActiveShipView>();
```
LOD selection (thresholds are `@space/config` tunables — [015](015_continuous_combat_model.md) §13):
```ts
// scene.ts
const enum Lod { Marker, Silhouette, Detail }
function lodFor(zoom: number): Lod {
  if (zoom >= LOD_DETAIL) return Lod.Detail;
  if (zoom >= LOD_SILHOUETTE) return Lod.Silhouette;
  return Lod.Marker;
}
// re-based glyph: world coords in, screen mapping supplied by caller
drawBattleShip(g: Graphics, sx: number, sy: number, heading: number, ship: ActiveShipView, cellPx: number, col: number): void;
```
Ship-aware picking (extends the existing return union in `main.ts`):
```ts
function pickAt(sx: number, sy: number):
  | { id: string; kind: "planet" | "fleet" | "ship" }
  | undefined;
```

## Acceptance criteria
> Acceptance: two fleets fight **on the shared map** with no separate combat screen; individual ships render in world coordinates; the LOD tier switches purely by zoom; a Playwright screenshot shows on-map combat.

- [ ] `store.battle` and the battle-view branch of `Scene.render()` no longer exist; combat renders inside `renderMap`'s world container.
- [ ] Two engaging fleets show individual ships + projectiles/shields on the map at the correct world positions.
- [ ] Zooming out collapses ships to a fleet chevron; zooming in reveals silhouettes then full detail — no state/gameplay change across tiers.
- [ ] `pickAt` selects an individual ship at close zoom and a fleet at far zoom.
- [ ] `camera.ts` is unchanged.

## Testing
- Unit (`@space/client`, vitest): `lodFor(zoom)` returns the expected tier at/around each threshold; the re-based `drawBattleShip` world→screen mapping matches `camera.worldToScreen` for sample points; interpolation returns endpoints before/after a frame window and a lerp mid-window.
- e2e (Playwright) is authored in [023](023_combat_ui_and_tests.md) (it replaces the discrete-battle test in `apps/client/e2e/game.spec.ts`); this plan only guarantees the render path it asserts against (on-map ships, LOD by zoom, screenshot).
- Manual: connect two clients, spawn a hostile ([023](023_combat_ui_and_tests.md) dev tool), confirm on-map combat and LOD by wheel-zoom.

## Unresolved questions
- LOD thresholds: fixed zoom cuts vs hysteresis to avoid flicker at boundaries?
- Delta interpolation: fixed frame window vs adaptive to active-region delta rate ([015](015_continuous_combat_model.md) §13)?
- Explosion/fire effects: pool sizing + max on-screen count before culling (DESIGN §9.4)?
- Ship pick radius at close zoom — per-ship hull extent vs constant screen px?
