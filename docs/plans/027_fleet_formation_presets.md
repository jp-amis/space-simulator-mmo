# 027 — Fleet Formation Presets

- **Status:** Done
- **Design step:** Post-025 feature
- **Design refs:** [025](025_always_on_ship_sim_static_anchor.md); [015](015_continuous_combat_model.md) §7 (formation as soft objective)
- **Depends on:** [025](025_always_on_ship_sim_static_anchor.md)

## Goal
Let the player pick a **fleet formation preset** with an obvious tactical purpose, not just a
shape. A preset decides **which ships go where by role** (heavy/tanky forward, damage behind,
support/valuable rear), so it stays meaningful as fleet composition changes.

## Scope
### In scope
- A `FormationPreset` model (shape + role-slotting) and a **v1 catalog of 8** presets.
- Store the selected preset on `FleetState`; feed it into `computeFormationOffsets`.
- `setFormation` client command → server handler (mirrors `setDoctrine`); UI selector.
- Role-aware placement derived from existing signals (hull size, weapon vs. industrial mix)
  until a richer ship-role taxonomy lands in [032](032_resource_operations_and_industrial_roles.md).

### Out of scope
- The full 18-formation catalog (only 8 core in v1; rest noted as future).
- An explicit ship-class taxonomy (DD/CL/BB/CV) — shared with 032; v1 approximates.
- Per-ship manual slot assignment (formation is by role, not selection order).

## Detailed design
Today `computeFormationOffsets()` (`packages/simulation/src/fleet.ts:40-54`) only buckets ships
by `ShipDoctrine.formationRole` (front/middle/rear) at fixed `COMBAT.formationSpacing`. There is
no player-selectable shape and no fleet-level state for it.

### FormationPreset model
```ts
// packages/simulation/src/types.ts
type FormationShape =
  | "column" | "line" | "wedge" | "echelon" | "box" | "screen" | "protect" | "loose";

interface FormationPreset {
  shape: FormationShape;
  spacing: number;        // base slot spacing (× COMBAT.formationSpacing)
  orientation: number;    // extra rotation vs. fleet heading (echelon L/R)
  // Which ship roles fill each zone (evaluated by role, not order):
  frontlineRoles: ShipRole[];
  centerRoles: ShipRole[];
  flankRoles: ShipRole[];
  rearRoles: ShipRole[];
  priority: number;       // tie-break / draw order
}
```
`ShipRole` in v1 is derived (a small helper `shipRole(ship)` mapping hull size + module mix to
e.g. `heavy` / `line` / `light` / `support` / `valuable`); 032 may replace it with an explicit
field. `FleetState.formation: FormationShape` (default `column`) selects the active preset from a
`FORMATION_PRESETS` table.

### v1 core catalog (8)
| Preset | Purpose | Slotting idea |
| --- | --- | --- |
| `column` | default / travel | single file behind the lead; minimal width |
| `line` | max frontal firepower | ships abreast, weapons facing forward |
| `wedge` | aggressive breakthrough | heavy/tanky at the point, damage behind, support rear |
| `echelon` | directional flank (L/R via `orientation`) | diagonal staircase |
| `box` | all-around defense | rectangle, mutual coverage |
| `screen` | detection / picket | light/scout ships forward, main body behind |
| `protect` | shield a valuable ship | valuable centered, escorts surrounding |
| `loose` | anti-AoE | max spacing, reduced clumping |

`computeFormationOffsets(ships, preset)` returns local-frame offsets; `stepWorld`
(`worldSim.ts:206-224`) already rotates offsets by fleet heading and steers ships to slots — no
change needed there beyond passing the preset through.

### Command + UI
- Protocol: new `ClientMessage` `{ type: "setFormation"; requestId; fleetId; formation }`
  (`packages/protocol/src/index.ts`, beside `setDoctrine`).
- Server: `handleSetFormation` in `apps/server/src/engine.ts` mirroring `setDoctrine` (ownership
  guard, set `fleet.formation`, mark dirty, ack).
- Client: a `<select>` beside the doctrine dropdown in `fleetOrderControls`
  (`apps/client/src/ui.ts:247-263`) with an `onFormationChange` callback wired in
  `main.ts:68` (`net.command({ type: "setFormation", … })`).

## Key changes (per file)
- `packages/simulation/src/types.ts` — `FormationShape`, `FormationPreset`, `FleetState.formation`, `ShipRole`.
- `packages/simulation/src/fleet.ts` — `FORMATION_PRESETS` table, `shipRole()`, extend `computeFormationOffsets(ships, preset)`.
- `packages/simulation/src/worldSim.ts` — pass `fleet.formation` preset into `computeFormationOffsets`.
- `packages/protocol/src/index.ts` — `setFormation` message; add `formation` to `FleetDto` for display.
- `apps/server/src/engine.ts` — `handleSetFormation`; include formation in snapshots.
- `apps/client/src/ui.ts` + `main.ts` — formation selector + callback.

## Acceptance criteria
- Selecting a preset visibly re-slots the fleet's ships by role and persists per fleet.
- `wedge` puts heavier ships at the point and support toward the rear; `protect` centers a
  valuable ship with escorts around it; `screen` pushes light ships forward.
- Deterministic: same fleet + preset → same offsets.

## Testing
- Unit (`@space/simulation`): `computeFormationOffsets` per preset — slot count = ship count,
  role zones populated as documented, deterministic; `shipRole()` classification table.
- Integration (`engine.test.ts`): `setFormation` sets `fleet.formation`; ownership rejected.
- E2E: change preset from the inspector → ships re-slot on screen.

## Unresolved questions
- v1 `ShipRole` derivation heuristic (hull size thresholds; weapon vs. mining vs. cargo mix).
- Whether `echelon` is one preset with an L/R orientation param or two entries.
- How presets interact with the per-ship `formationRole` field (override vs. blend).
