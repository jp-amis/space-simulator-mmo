# 020 — Fleet Orders & Doctrine Presets

- **Status:** Done
- **Design step:** Step 5 — continuous combat refactor (see [DESIGN.md](../DESIGN.md))
- **Design refs:** [015](015_continuous_combat_model.md) §2, §4, §6; DESIGN §7.4
- **Depends on:** [019](019_fleet_brain_consensus_and_intent.md)

## Goal
Give the player the **strategic vocabulary** of [015](015_continuous_combat_model.md) §2 — `moveTo` / `follow` / `attackMove` / `pursue` / `escort` / `hold` — and a small set of **doctrine presets** (Hold Fire / Return Fire / Attack on Sight / Pursue / Flee-if-attacked) that map to the continuous doctrine params (`aggression` / `pursuit` / `cohesion` / `survival`) consumed by the fleet brain ([019](019_fleet_brain_consensus_and_intent.md)). The player commands **fleets and orders, never individual ships or weapons** ([015](015_continuous_combat_model.md) §2). Server command handlers in `apps/server/src/engine.ts` are extended so `moveFleet` becomes `moveTo`/`attackMove` and new `follow`/`pursue`/`escort`/`hold` orders exist; the fleet brain honors **player-order precedence** ([015](015_continuous_combat_model.md) §6).

## Scope
### In scope
- `FleetOrder` discriminated shape with payloads (target point / target fleet / escort anchor).
- Doctrine presets → continuous params mapping (`DoctrinePreset` → `FleetDoctrineContinuous`).
- Extend `handleMoveFleet` in `engine.ts`: `moveTo` (plain move, clears aggression) and `attackMove` (moves but permits autonomous engage within leash).
- New handlers: `handleFollow`, `handlePursue`, `handleEscort`, `handleHold`; extend `handleSetDoctrine` to accept a preset.
- Order → fleet-brain interaction: `moveTo`/`hold` assert player-order precedence; `attackMove`/`pursue`/`escort` permit brain-driven anchor moves within `pursuitRadius`.

### Out of scope
- Weighted consensus, `FleetIntent` machine, leash math — [019](019_fleet_brain_consensus_and_intent.md).
- Wire encoding of the new order/doctrine commands and `FleetStatus:"engaging"` — [021](021_protocol_and_networking.md).
- Ship-level execution of `follow`/`escort` steering — [018](018_ship_brain_and_doctrine.md) ship brain.
- Client UI to issue orders / pick presets — [023](023_combat_ui_and_tests.md).

## Tasks
- [ ] Define `FleetOrder` union + payloads in `packages/simulation/src/types.ts` ([015](015_continuous_combat_model.md) §4).
- [ ] Define `DoctrinePreset` and `presetToDoctrine(preset)` mapping in `packages/simulation/src/fleet.ts` (beside `DEFAULT_DOCTRINE`).
- [ ] Store `fleet.order` on issue; the brain reads it for precedence ([019](019_fleet_brain_consensus_and_intent.md)).
- [ ] Extend `handleMoveFleet` → split into `moveTo` vs `attackMove` semantics (payload flag); reuse existing origin-materialization + `MovementPlan` build.
- [ ] Add `handleFollow(fleetId, targetFleetId)`: anchor tracks target fleet position (moving `MovementPlan` re-issued on drift).
- [ ] Add `handlePursue(fleetId, targetFleetId)`: like follow but permits engage; leash-bounded.
- [ ] Add `handleEscort(fleetId, targetFleetId, offset)`: hold a soft offset from an ally fleet.
- [ ] Add `handleHold(fleetId)`: clear movement, `status` idle, block autonomous anchor moves (still fire/return-fire per doctrine).
- [ ] Extend `handleSetDoctrine` to accept a `DoctrinePreset` and expand it via `presetToDoctrine`.
- [ ] Route the new commands in `handle()`; keep ownership + status guards from the existing handlers.

## Key types & signatures
```ts
// packages/simulation/src/types.ts
type DoctrinePreset = "holdFire" | "returnFire" | "attackOnSight" | "pursue" | "fleeIfAttacked";

type FleetOrder =
  | { kind: "moveTo"; target: Vec2 }
  | { kind: "attackMove"; target: Vec2 }
  | { kind: "follow"; targetFleetId: EntityId }
  | { kind: "pursue"; targetFleetId: EntityId }
  | { kind: "escort"; targetFleetId: EntityId; offset: Vec2 }
  | { kind: "hold" };

// packages/simulation/src/fleet.ts
function presetToDoctrine(preset: DoctrinePreset): FleetDoctrineContinuous;
// holdFire      → { aggression:0.0, pursuit:0.0, cohesion:0.8, survival:0.5 }
// returnFire    → { aggression:0.3, pursuit:0.1, cohesion:0.7, survival:0.5 }
// attackOnSight → { aggression:0.9, pursuit:0.4, cohesion:0.5, survival:0.2 }
// pursue        → { aggression:0.9, pursuit:0.9, cohesion:0.4, survival:0.1 }
// fleeIfAttacked→ { aggression:0.0, pursuit:0.0, cohesion:0.9, survival:1.0 }

// apps/server/src/engine.ts (handlers)
private handleMoveFleet(playerId, requestId, fleetId, target, attackMove: boolean): void;
private handleFollow(playerId, requestId, fleetId, targetFleetId): void;
private handlePursue(playerId, requestId, fleetId, targetFleetId): void;
private handleEscort(playerId, requestId, fleetId, targetFleetId, offset): void;
private handleHold(playerId, requestId, fleetId): void;
private handleSetDoctrine(playerId, requestId, fleetId, preset: DoctrinePreset): void;
```

## Acceptance criteria
> Acceptance: each order produces the described movement/behavior; player order authority is respected over autonomous aggression.

- [ ] `moveTo` moves the fleet and suppresses autonomous engage; `attackMove` moves but permits leash-bounded engage.
- [ ] `follow`/`escort` keep the anchor tracking the target/ally fleet as it moves.
- [ ] `pursue` chases a target fleet, bounded by `pursuitRadius` ([019](019_fleet_brain_consensus_and_intent.md)).
- [ ] `hold` stops the fleet and blocks autonomous anchor moves while still firing per doctrine.
- [ ] Each `DoctrinePreset` expands to the documented continuous params and changes fleet-brain behavior accordingly.
- [ ] An explicit `moveTo`/`hold` overrides a standing autonomous engage intent ([015](015_continuous_combat_model.md) §6).

## Testing
- Unit (`@space/simulation`): `presetToDoctrine` mapping table; `FleetOrder` payload validation.
- Integration (in-process server): issue each order via command; assert resulting `fleet.order`, `status`, and `MovementPlan`.
- Integration: `moveTo` while a contact is in range → fleet does not autonomously engage (precedence).
- Integration: `attackMove` past an enemy → fleet engages within leash, then resumes toward `target`.
- Integration: invalid-ownership / wrong-status orders rejected without state mutation (mirror existing `handleMoveFleet` guards).

## Unresolved questions
- `follow`/`escort` re-issue cadence: event-driven on drift vs periodic tick?
- Does `pursue` as an order differ from `pursue` `FleetIntent`, or is the order just a high `pursuit` doctrine bias?
- Escort offset frame: world-space vs rotated into ally heading?
- Keep legacy `moveFleet` wire message as `attackMove:false`, or rename outright in [021](021_protocol_and_networking.md)?
