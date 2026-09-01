# 008 — Ship Builder UI

- **Status:** Done
- **Design step:** Step 7 — see [DESIGN.md](../DESIGN.md)
- **Design refs:** §8, §8.1, §8.2, §8.3
- **Depends on:** [007](007_ftl_modular_ships.md)

## Goal
Give players a fully programmatic ship builder: a grid editor with a module palette, drag/place/remove/rotate interactions, live validation errors and derived stats, and a command that sends the blueprint to the server for authoritative re-derivation. This is one of the game's main strategic differentiators — designing a valid ship and fielding it in a fleet. Validation and derived stats are shared server-side simulation code; the UI mirrors them, it does not own them.

## Scope
### In scope
- DOM/Pixi grid editor for a hull; module palette (bridge, engine, reactor, shield, weapons, storage).
- Drag/place/remove/rotate (0/90/180/270) interactions on the grid.
- Live validation error display and live derived-stat readout (computed via shared `@space/simulation` code).
- `updateShipBlueprint` command → server rebuilds authoritative derived state.
- Save/apply behavior within in-memory state.
- Procedural rendering of the design (hull polygon + room rectangles + details) per §8.3.

### Out of scope
- Server-side room mechanics / derived-stat math and battle damage — [007](007_ftl_modular_ships.md).
- Resource costs / construction queue for building the ship — Step 8.
- Hardpoint authoring UI if hardpoints stay off in first ruleset (§8.2).
- Persistence of blueprints across restart (none; §1.2, in-memory only).

## Tasks
- [ ] Build grid editor bound to a `ShipBlueprint` (§8.1); render blocked cells and placements.
- [ ] Module palette with drag-to-place; support remove and rotate (0 | 90 | 180 | 270).
- [ ] Run shared validation (§8.2) client-side for live feedback; show errors (overlap, outside hull, missing bridge, power deficit, rotation).
- [ ] Compute and show live derived stats using the same `@space/simulation` code the server uses (never a separate client formula).
- [ ] Procedural render (§8.3): hull polygon / rounded rect from Pixi `Graphics`; room rectangles stroked/filled by system category; procedural details (vents, grid lines, reactor arcs, weapon barrels); reuse the [007](007_ftl_modular_ships.md) renderer at builder LOD.
- [ ] Send `updateShipBlueprint { requestId, shipId, blueprint }`; handle `ack`/`reject`.
- [ ] On server, re-run validation and rebuild authoritative derived state (client values untrusted).
- [ ] Save/apply the design into in-memory ship state so it can be added to a fleet.

## Key types & signatures
```ts
type ShipBlueprint = {
hullType: string;
width: number;
height: number;
blockedCells: string[];       // e.g. "3,4"
placements: Array<{
moduleType: string;
x: number; y: number;
rotation: 0 | 90 | 180 | 270;
}>;
};
```

Blueprint command (§10.2), sent on save/apply:
```ts
| { type: 'updateShipBlueprint'; requestId: string; shipId: string; blueprint: ShipBlueprint }
```

Validation rules mirrored in UI, authoritative on server (§8.2):
- All occupied module cells must be inside the hull mask.
- Modules may not overlap.
- Exactly one bridge is required in the first ruleset.
- Total reactor generation must satisfy mandatory baseline systems, or the design is marked underpowered and needs power-priority behavior.
- Thrusters/engines can contribute to fleet speed; choose whether the slowest ship caps fleet speed or calculate a formation value.
- Weapons must have compatible power and hardpoint constraints if hardpoints are enabled.
- Derived stats must be computed by shared server-side simulation code.

Procedural rendering (§8.3): render the hull as a polygon or rounded rectangle from Pixi `Graphics`; draw room rectangles with strokes/fills by system category; add procedural details (vents, grid lines, reactor arcs, weapon barrels). The same blueprint renders at strategic-icon scale and detailed battle scale by changing LOD.

## Acceptance criteria
> Acceptance: a player can design a valid ship entirely from programmatic UI elements and use it in a fleet.

- [ ] Player places/removes/rotates modules on the grid with no image assets.
- [ ] Invalid designs surface clear validation errors; valid designs show live derived stats.
- [ ] Blueprint is sent to server, re-validated, and authoritative derived state rebuilt.
- [ ] The saved ship can be added to a fleet and used (feeds [007](007_ftl_modular_ships.md) combat).

## Testing
Per DESIGN §14:
- **Ship validation (§14.1):** overlap, outside hull, missing bridge, power deficits, rotation — same shared code the UI calls.
- **Integration (§14.2):** issue invalid ownership/blueprint commands and assert rejection without state mutation.
- Client validation must match server results exactly (single shared `@space/simulation` implementation).

## Unresolved questions
- Editing a live ship vs designing a template then instantiating?
- Reject partial/invalid blueprints outright, or accept-and-flag underpowered (§8.2)?
- Palette contents fixed in `@space/config` for first ruleset?
