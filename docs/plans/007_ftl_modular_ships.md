# 007 — FTL-like Modular Ships

- **Status:** Done
- **Design step:** Step 6 — see [DESIGN.md](../DESIGN.md)
- **Design refs:** §4.2, §7, §8.2
- **Depends on:** [006](006_minimal_battle_simulation.md)

## Goal
Replace simple ship circles with FTL-style modular ships: a grid hull with room/module placements, server-computed derived stats, and battle damage that targets individual rooms and disables capabilities. This makes the build itself the source of combat outcomes — layout, not one aggregate power number, decides fights. Derived stats are always computed by shared server-side simulation code; client values are never trusted.

## Scope
### In scope
- `ShipState` with hull grid, `RoomState[]`, `CrewState[]`, `derived` stats (`@space/simulation` types via `@space/protocol`).
- Room kinds: bridge, engine, reactor, weapon, shield, storage.
- Derived-stat recomputation after build changes and room damage: thrust, turn rate, sensor range, shield capacity, weapon groups, power production, cargo.
- Validation rules from §8.2 (server-side).
- Battle targeting of eligible rooms; shield-then-room/hull damage.
- Capability disabling: weapon disabled, engine thrust reduced, reactor power lost when rooms damaged.
- Procedural Pixi rendering of room layouts (strategic-icon + battle scale LOD).

### Out of scope
- The drag/drop grid editor UI and palette — [008](008_ship_builder_ui.md).
- Crew pathfinding / movement / repair (crew bonuses only for now; §4.2).
- Hardpoint constraints beyond basic power compatibility (optional, §8.2).
- Economy/construction costs of modules — Step 8.

## Tasks
- [ ] Define `ShipState`, `RoomState`, `CrewState` types (§4.2) in `@space/protocol` / `@space/simulation`.
- [ ] Implement derived-stat computation `ShipDerivedStats`: thrust, turn rate, sensor range, shield capacity, weapon groups, power production, cargo (§4.2). Never trust client-computed values.
- [ ] Recompute derived stats after build changes and after room damage (§4.2).
- [ ] Implement §8.2 validation: cells inside hull mask; no module overlap; exactly one bridge; reactor generation covers baseline or mark underpowered → power-priority behavior; engines contribute to fleet speed (slowest-caps vs formation value — pick one); weapon power/hardpoint compatibility; derived stats via shared server code.
- [ ] Update `stepBattle` firing to select an eligible target room and apply shield-first then room/hull damage (§7.2 steps 6–7).
- [ ] On room damage, recompute affected capabilities: weapons disabled, engine thrust reduced, reactor power lost (§7.2 step 8).
- [ ] Apply power-priority ordering when underpowered (§7.4 power priority).
- [ ] Procedurally render hull polygon + room rectangles by system category in Pixi; support strategic-icon and battle-scale LOD (§8.3 preview — full builder in [008](008_ship_builder_ui.md)).

## Key types & signatures
```ts
type ShipState = {
id: EntityId;
ownerId: string;
name: string;
hull: { hp: number; maxHp: number; width: number; height: number };
rooms: RoomState[];
crew: CrewState[];
derived: ShipDerivedStats;
};
type RoomState = {
id: EntityId;
kind: 'bridge' | 'engine' | 'reactor' | 'weapon' | 'shield' | 'storage';
x: number; y: number; w: number; h: number;
hp: number; maxHp: number;
powerDemand: number;
enabled: boolean;
weapon?: { damage: number; cooldownMs: number; range: number; projectileSpeed: number };
};
type CrewState = {
id: EntityId;
role: 'captain' | 'engineer' | 'gunner' | 'marine';
roomId?: EntityId;
hp: number;
bonuses: Record<string, number>;
};
```

Validation rules (§8.2), enforce all server-side:
- All occupied module cells must be inside the hull mask.
- Modules may not overlap.
- Exactly one bridge is required in the first ruleset.
- Total reactor generation must satisfy mandatory baseline systems, or the design is marked underpowered and needs power-priority behavior.
- Thrusters/engines can contribute to fleet speed; choose whether the slowest ship caps fleet speed or calculate a formation value.
- Weapons must have compatible power and hardpoint constraints if hardpoints are enabled.
- Derived stats must be computed by shared server-side simulation code.

## Acceptance criteria
> Acceptance: changing a ship layout materially changes combat performance and visibly damaged systems stop contributing.

- [ ] Two different layouts produce measurably different battle outcomes.
- [ ] A destroyed/disabled weapon room stops firing; a damaged engine reduces thrust; lost reactor cuts power.
- [ ] Derived stats recomputed on the server after damage; client-supplied stats ignored.

## Testing
Per DESIGN §14.1:
- **Ship validation:** overlap, outside hull, missing bridge, power deficits, rotation.
- **Combat damage:** weapon room disabled, engine degradation, shield depletion, destruction and retreat.
- Determinism preserved: room targeting draws from battle RNG in fixed order, no `Math.random()` (§7.3).

## Unresolved questions
- Fleet speed rule: slowest-ship cap vs formation value (§8.2)?
- Room target-selection order — pure doctrine (§7.4) or add positional/adjacency weighting?
- Underpowered auto-shutdown order shared with doctrine power-priority list?
