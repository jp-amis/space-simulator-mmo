# 023 — Combat UI, Kiting/Retreat & Tests

- **Status:** Done
- **Design step:** Step 5 refactor — player-facing orders/doctrine + determinism & e2e tests (see [DESIGN.md](../DESIGN.md))
- **Design refs:** [015](015_continuous_combat_model.md) §2, §6, §12; DESIGN §7.4, §14
- **Depends on:** [020](020_fleet_orders_and_doctrine.md), [022](022_client_rendering_and_lod.md)

## Goal
Give the player the strategic controls the continuous model needs — fleet orders, fleet doctrine, and per-ship doctrine — through DOM UI ([015](015_continuous_combat_model.md) §2 three-layer command; the player commands fleets, never weapons/skills). Convert the old battle-result banner into a live **engagement summary**. Add a dev "spawn hostile" tool so continuous combat is deterministically reproducible for tests. Then prove that **kiting and retreat emerge from movement** ([015](015_continuous_combat_model.md) §6, DESIGN §17-style physical kiting): a player move order overrides autonomous aggression, fast ships escape and slow ships fall behind. Ship the determinism **unit** tests and a **rewritten** Playwright e2e that replaces the discrete-battle test.

## Scope
### In scope
- Fleet-order UI (`ui.ts` inspector, fleet selected + owned): buttons for **Move / Attack-Move / Pursue / Hold / Follow / Escort**, wired to the [020](020_fleet_orders_and_doctrine.md) `setFleetOrder` command ([015](015_continuous_combat_model.md) §2, §4 `FleetOrder`).
- Fleet **doctrine** UI: preset picker (Hold Fire / Return Fire / Attack on Sight / Pursue / Flee-if-attacked — [015](015_continuous_combat_model.md) §12) plus four sliders **aggression / pursuit / cohesion / survival** ([015](015_continuous_combat_model.md) §4 `FleetDoctrine`), wired to [020](020_fleet_orders_and_doctrine.md)'s doctrine command.
- **Ship-doctrine** controls (per-ship): formation role (front/middle/rear), preferred range (close/medium/long), target priority (nearest/small/large) — [015](015_continuous_combat_model.md) §12, DESIGN §7.4.
- Replace the `battle-banner`/`battleResult` banner with an **engagement summary** (participating fleets, rough strength, intent) driven by snapshot + active-region delta, not a battle DTO.
- Dev **spawn-hostile** tool: a `@space/server` debug endpoint/command (guarded, dev-only per DESIGN §15) that spawns an enemy fleet near a target so combat is deterministic to trigger; small client debug affordance to invoke it.
- Determinism **unit** tests for the sim (seed → outcome) and a rewritten Playwright e2e.

### Out of scope
- Fleet-brain scoring, intents, active clusters — [016](016_per_ship_kinematics_and_active_clusters.md)–[019](019_fleet_brain_consensus_and_intent.md).
- Order/doctrine command protocol + server handlers — [020](020_fleet_orders_and_doctrine.md) (consumed here).
- On-map rendering / LOD internals — [022](022_client_rendering_and_lod.md) (this plan asserts against it).
- Excluded V1 features: active skills, manual weapon activation, separate combat screens ([015](015_continuous_combat_model.md) §12).

## Tasks
- [ ] Add fleet-order buttons to the fleet inspector in `ui.ts`; add `onFleetOrder(fleetId, order, payload?)` to `UICallbacks`; wire in `main.ts` to the [020](020_fleet_orders_and_doctrine.md) command. Attack-Move/Pursue/Escort/Follow take a target picked on the map (reuse the `pickAt`/`handleClick` selection flow).
- [ ] Extend `doctrineControls` in `ui.ts`: add the preset `<select>` and aggression/pursuit/cohesion/survival sliders; keep existing preferredRange/targetPriority; emit via `onDoctrineChange`.
- [ ] Add ship-doctrine controls (formation role / preferred range / target priority) to the ship inspector / ship-builder side panel; wire to the [020](020_fleet_orders_and_doctrine.md) ship-doctrine command.
- [ ] Replace `battleBanner` + `renderBattleBanner` + `store.battleResult` with an engagement-summary element sourced from snapshot fleets in `status: "engaging"` + active-region delta.
- [ ] Add dev spawn-hostile: `@space/server` dev endpoint/command (DESIGN §15 dev-only guard) + a client debug button/`__game` hook to spawn a hostile fleet near a chosen point.
- [ ] Determinism unit tests: same seed + same inputs → identical outcome (reuse `mulberry32`/`rngFromState`, [015](015_continuous_combat_model.md) §10); e.g. "seed X → ship B destroyed by tick N", plus an N-tick state hash replay (DESIGN §14.1 Combat determinism).
- [ ] Kite/retreat emergence unit test: order a fleet away from a hostile; fast ships open range while slow ships fall behind; the player move order is never reversed by aggression ([015](015_continuous_combat_model.md) §6).
- [ ] Rewrite the discrete-battle e2e in `apps/client/e2e/game.spec.ts` (below).
- [ ] Ensure LOD thresholds + active-region delta rate remain `@space/config` tunables ([015](015_continuous_combat_model.md) §13); tests read them rather than hard-coding.

## Key types & signatures
Client callback surface (extends `UICallbacks` in `ui.ts`):
```ts
interface UICallbacks {
  // …existing…
  onFleetOrder: (fleetId: string, order: FleetOrder, payload?: OrderPayload) => void;
  onDoctrineChange: (fleetId: string, doctrine: FleetDoctrine) => void; // now incl. preset + sliders
  onShipDoctrineChange: (shipId: string, doctrine: ShipDoctrine) => void;
}
// mirrors [015] §4 (defined in @space/protocol by [020])
type FleetOrder = "moveTo" | "follow" | "attackMove" | "pursue" | "escort" | "hold";
```
Dev spawn tool (`@space/server`, dev-guarded — DESIGN §15):
```ts
// e.g. POST /debug/spawn-hostile { near: Vec2; ships?: number; seed?: number }
// or a dev-only ClientMessage { type: "debugSpawnHostile"; near: Vec2; seed?: number }
```
Determinism unit test shape (`@space/simulation`, vitest — [015](015_continuous_combat_model.md) §10):
```ts
const a = runActiveCluster({ seed: 42, ships, ticks: 300 });
const b = runActiveCluster({ seed: 42, ships, ticks: 300 });
expect(hash(a)).toBe(hash(b));            // seed → identical outcome
expect(a.destroyed).toContain("shipB");   // "seed X → ship B destroyed by tick N"
```

## Acceptance criteria
> Acceptance: the player can issue fleet orders, kite, and retreat — kiting/retreat **emerge from movement**, not a scripted combat mode; the full unit + e2e suite is green.

- [ ] Player can issue Move / Attack-Move / Pursue / Hold / Follow / Escort from the fleet inspector; the order reaches the server ([020](020_fleet_orders_and_doctrine.md)).
- [ ] Fleet doctrine preset + aggression/pursuit/cohesion/survival sliders and per-ship doctrine (role/range/priority) are editable and applied.
- [ ] Ordering a fleet away from a hostile makes it retreat; fast ships escape and slow ships fall behind ([015](015_continuous_combat_model.md) §6) — the move order is never reversed by aggression.
- [ ] The engagement summary replaces the old battle banner; no separate combat screen exists.
- [ ] Determinism unit tests pass (seed → identical outcome / replay hash); rewritten e2e passes.

## Testing
Unit (`@space/simulation`, vitest — DESIGN §14.1):
- Combat determinism: same seed + same inputs → identical outcome; N-tick replay yields the same state hash.
- Combat damage: shield depletion, room disabled, destruction ([015](015_continuous_combat_model.md) §10/§11 reused `applyDamage`).
- Kite/retreat emergence: fleet moved away → range increases; fast vs slow ships diverge; player order precedence over aggression ([015](015_continuous_combat_model.md) §6).

e2e (Playwright, `apps/client/e2e/game.spec.ts`) — **replaces** the `plan 006/010 — automatic battle` test:
- Connect; use the dev spawn-hostile tool to create a deterministic hostile near the player fleet.
- Assert on-map combat: `__game.store.activeShips.size > 0` and ships render in world coords at the current zoom ([022](022_client_rendering_and_lod.md)); no `#battle-banner`/battle-view path.
- Assert LOD: zoom out → chevron marker; zoom in → ship detail (via `__game.camera.zoom` + scene tier) — [022](022_client_rendering_and_lod.md).
- Assert kiting: issue a move order away from the hostile; poll that the fleet's distance to the hostile increases and the order is honored (not overridden).
- Screenshots: on-map combat, retreat/kite, and a close-zoom detail frame.

## Unresolved questions
- Slider ranges/steps for aggression/pursuit/cohesion/survival — 0–1 continuous vs discrete notches mapped to preset thresholds ([015](015_continuous_combat_model.md) §5)?
- Spawn-hostile transport: HTTP `/debug` endpoint vs dev-only WS command — which is easier to drive from Playwright deterministically?
- Engagement summary content: how much enemy detail before it leaks sensor-restricted data (DESIGN §14.1 visibility)?
- e2e flakiness: rely on the dev spawn tool + fixed seed only, or also keep a two-client crossing-move variant?
