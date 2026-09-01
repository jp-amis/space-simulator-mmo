# 003 — Pixi Strategic Map & Procedural Universe

- **Status:** Done
- **Design step:** Step 2 — see [DESIGN.md](../DESIGN.md)
- **Design refs:** §9, §9.1, §9.2, §12
- **Depends on:** [002](002_id_entry_and_player_registry.md)

## Goal
Turn the abstract in-memory world into something a player can see and navigate: a PixiJS application with a pan/zoom camera, a procedural asset-free background, seeded planets and labels, and selection/hover feeding a DOM inspector. The server generates a deterministic universe from a fixed seed and sends only the visible planet/player data via a `getVisibleState` snapshot. This delivers loop step 3 (§1.1 — inspect the strategic map, select planets) and proves the "no image assets" and visibility-seam requirements from §19.

## Scope
### In scope
- Create the Pixi Application; camera pan (pointer drag) and zoom-around-cursor (wheel); resize handling.
- Layered scene per §9.1 (background, planets, fleet trajectory/fleet layers can be stubbed, effects, debug).
- Procedural background (seeded star field / nebula noise) — client-side, no server entities.
- Render planets (concentric circles / radial lighting / seeded arcs / owner-colored marker) and labels with screen-space label culling.
- Selection + hover interaction wired to a DOM inspector panel.
- Server procedural generation: fixed world seed; 50–200 planets in a bounded region with minimum separation; radii, resource biases, names from deterministic syllable tables.
- Server snapshot exposing only visible planet/player data via `getVisibleState(playerId)`.
- Home-planet selection for a new player (choose unowned/newly generated planet — wired from [002](002_id_entry_and_player_registry.md)).

### Out of scope
- Fleet markers, trajectory rendering, movement, interpolation — [004](004_fleet_domain_and_movement.md).
- Full sensor/fog-of-war visibility rules and enemy-trajectory filtering (§10.3) — later plan.
- Encounter detection, battles, economy UI.
- Optional local NPC/test players (may be added later to ease encounter testing).

## Tasks
- [ ] Create Pixi Application; implement camera pan/zoom (zoom around cursor) and window resize handling.
- [ ] Build the layered stage per §9.1 scene tree (stub fleet/trajectory/effect layers).
- [ ] Render procedural background: seeded point star field, parallax layers, optional shader/noise.
- [ ] Render planets procedurally (circles, radial lighting, seeded land/cloud arcs, atmosphere ring, owner marker).
- [ ] Render planet labels with screen-space label culling; clamp zoom so detail stays meaningful/cheap.
- [ ] Add selection + hover interaction; populate a DOM inspector for the selected object.
- [ ] Server: fixed world seed; generate 50–200 planets, bounded region, minimum separation.
- [ ] Server: assign radii, resource biases, and names from deterministic syllable tables.
- [ ] Server: `getVisibleState(playerId)` snapshot with only visible planet/player data (not the whole `GameState`).
- [ ] Generate decorative stars client-side from a visual-only (or shared) seed — no server entities.
- [ ] Cull off-screen planets/labels; reuse Graphics geometry, redraw statics only on visual-state change.

## Key types & signatures
Scene organization (§9.1):
```
Pixi Application
Stage
├─ BackgroundLayer       # procedural stars / nebula noise
├─ GridOrTerritoryLayer  # optional strategic guidance, ranges
├─ PlanetLayer
├─ FleetTrajectoryLayer
├─ FleetLayer
├─ EffectLayer           # trails, impacts, selection pulses
└─ DebugLayer
DOM Overlay
├─ ID entry
├─ top resource bar
├─ selected-object inspector
├─ ship builder panels
├─ queues / notifications
└─ battle controls / speed display
```

Camera rules (§9.2): world coordinates stay independent of screen coordinates; pan by pointer drag; zoom around cursor with the wheel; clamp zoom so procedural detail stays meaningful/cheap; use screen-space label culling; for a very large galaxy keep coordinates near the camera origin in the render transform if float precision becomes visible.

Procedural generation (§12): use a fixed world seed so restarts recreate the same base galaxy even before persistence — 50–200 planets in a bounded 2D region with seeded positions and minimum separation; planet radii, resource biases and names from deterministic syllable tables; decorative stars generated client-side; when a new player ID appears, choose an unowned or newly generated home planet.

Planet domain state (§4.1) rendered/exposed here:
```ts
type PlanetState = {
id: EntityId;
ownerId?: string;
name: string;
position: Vec2;
radius: number;
resourceRates: { metalPerSec: number; fuelPerSec: number };
resourceUpdatedAtMs: number;
storedResources: { metal: number; fuel: number };
facilities: FacilityState[];
constructionQueue: ConstructionJob[];
};
```

## Acceptance criteria
> Acceptance: player can navigate a smooth asset-free star map and select their home planet.

- [ ] Pan/zoom is smooth; resize works.
- [ ] Map renders with zero image assets (all procedural).
- [ ] Planets + labels render from server snapshot data.
- [ ] Player can select their home planet; DOM inspector shows its details.
- [ ] Snapshot contains only visible data (built via `getVisibleState`).

## Testing
From §14:
- §14.1 visibility: enemy private fields never appear outside sensor/permission rules — assert `getVisibleState(playerId)` omits non-visible planet/player fields (seam established here even if full fog-of-war is later).
- Determinism of generation: same fixed world seed reproduces the same planets (positions, radii, names) across restarts — supports §19 reproducibility.
- §14.2 integration: connect, `hello`, receive snapshot, assert the home planet is present and selectable-relevant fields are populated.

## Unresolved questions
- Planet count for the prototype: 50–200 (§12) vs 10–30 first-milestone (§18) — pick a default.
- Star field: separate visual-only seed or reuse the world seed?
- Which planet fields are visible pre-sensors (own vs neutral vs enemy)?
