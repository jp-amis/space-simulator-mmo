# 014 — Navigation & Camera

- **Status:** Done
- **Design step:** Post-prototype UX — quick navigation (home + fleet locate)
- **Design refs:** [DESIGN.md](../DESIGN.md) §9.1, §9.2
- **Depends on:** [003](003_strategic_map_and_procedural_universe.md), [012](012_fleet_and_ship_management.md)

## Goal
Make it easy to get around the map: a one-click **Center on home** button, and a
**fleet list** where selecting a fleet recenters the camera on it. The map can be
panned far from anything of interest, and there is currently no way to jump back to
your home planet or to a specific fleet. Both affordances reuse the existing
`Camera.centerOn(wx, wy)` (`apps/client/src/camera.ts`) — no new camera math.

## Scope
### In scope
- Top-bar **Home** button (+ `H` keyboard shortcut) that centers the camera on the
  player's home planet at a sensible zoom.
- Fleet-list **center-on-fleet** navigation: choosing a fleet selects it and centers
  the camera on its current (interpolated) position.

### Out of scope
- The Roster panel's fleet **management** actions (create/add/split/merge) —
  [012](012_fleet_and_ship_management.md). This plan only adds the *navigation*
  behavior on top of that list.
- Minimap, bookmarks, edge-scroll, or follow-cam.

## Relationship to plan 012
The **fleet list** is the Fleets section of the Roster panel from
[012](012_fleet_and_ship_management.md). This plan specifies the camera behavior for
it: each fleet row gets a "locate" affordance (click the row or a ⌖ button) that
selects the fleet and centers on `store.fleetPosition(f)`.

**Ordering:** if 012 ships first, 014 only adds the center-on action + the Home
button. If 014 ships first, it introduces a minimal standalone fleet list that 012's
Roster later supersedes (reuse the same `#roster` / `.roster-fleet` hooks to avoid
divergence).

## Tasks
- [ ] **Client** (`apps/client/src/main.ts`): extract the existing inline
      `centerOnHome()` so it is callable on demand (currently only runs once after
      the first snapshot). Have it look up `you.homePlanetId` → planet position and
      set `camera.centerOn(...)` + a sensible `camera.zoom`.
- [ ] **Client** (`apps/client/src/ui.ts`): add a **Home** button (`#home-btn`) to
      the resource bar that calls the extracted `centerOnHome()`; bind `H` as a
      keyboard shortcut (ignore when typing in an input / the ID field).
- [ ] **Client** (`apps/client/src/roster.ts` from 012): each fleet row selects the
      fleet (`store.selectedId/Kind`) and calls `camera.centerOn(store.fleetPosition(f))`
      with a zoom-in; add a `.roster-fleet-locate` (⌖) control.
- [ ] Guard against a missing home planet (e.g. after a total loss) — no-op the Home
      button gracefully.

## Key types & signatures
Reused camera API (`apps/client/src/camera.ts`, unchanged):
```ts
centerOn(wx: number, wy: number): void; // sets camera.x/.y (world at screen center)
```

Extracted helper (`main.ts`):
```ts
function centerOnHome(): void {
  const home = store.snapshot?.planets.find((p) => p.id === store.snapshot?.you.homePlanetId);
  if (home) { camera.centerOn(home.position.x, home.position.y); camera.zoom = 0.18; }
}
```

## Acceptance criteria
> The player can jump the camera to home or to any of their fleets in one action.

- [ ] Clicking **Home** (or pressing `H`) recenters the camera on the home planet
      from anywhere on the map.
- [ ] Selecting a fleet from the list recenters the camera on that fleet, including
      while the fleet is moving (uses the interpolated position).

## Testing
- **E2E** (`apps/client/e2e/game.spec.ts`): pan far from home, click `#home-btn`,
  assert `window.__game.camera` is centered near the home planet's world position;
  open the fleet list, locate a fleet, assert the camera is centered near that
  fleet's position. Screenshot `09-home-recenter.png`.

## Unresolved questions
- Fixed home zoom level vs. preserving the current zoom — default to a fixed,
  comfortable zoom on Home.
- Should center-on-fleet smoothly animate or jump instantly? (assumption: instant
  for the prototype.)
