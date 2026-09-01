# 037 — Escort Screen: Non-Mining Ships Protect the Miners

- **Status:** Done
- **Design step:** Resource epic — industrial roles/behavior
- **Design refs:** [029](029_resource_and_industrial_logistics_design.md) §7 (industrial roles); [033](033_logistics_warfare_cargo_and_salvage.md); [036](036_mining_ring_and_heading.md)
- **Depends on:** [036](036_mining_ring_and_heading.md)

## Problem
In a mining fleet only ships with `derived.miningPower > 0` extract; every other ship (an escort,
a warship) just takes a normal formation slot next to the miners with no protective intent. The
player expects non-mining ships to **screen/guard the miners** while they work. `IndustrialRole`
exists in `types.ts` but is unused, and `shipRole()` (`fleet.ts`) is a tactical class, not a
miner/escort signal.

Wanted: while a fleet mines, the **miners** work the inner ring ([036](036_mining_ring_and_heading.md)) and the
**non-miners form a protective outer screen** around them, positioned between the miners and the
likely threat, ready to engage.

## Approach (server)
- Classify per ship at mining time: **miner** = `derived.miningPower > 0`; **escort** = everything
  else. (No new field needed; derive it. Optionally set the unused `ShipState.role`/`IndustrialRole`
  for clarity, but derivation is enough.)
- In `stepWorld` (`worldSim.ts`), while `fleet.order.kind === "mine"`:
  - Miners → the mining ring (radius `RESOURCE.mineRing`, [036](036_mining_ring_and_heading.md)).
  - Escorts → an **outer perimeter** ring at a larger radius (new `RESOURCE.escortRing`, e.g. ~340,
    outside the miners), spread by angle. They face **outward** (or toward the nearest sensed enemy)
    so they meet threats first.
- Escorts keep their combat doctrine — the fleet brain/`fleetFires` still lets them engage enemies
  that approach; they just hold the perimeter geometry when idle. Retreat/flee behavior
  ([033](033_logistics_warfare_cargo_and_salvage.md)) is unchanged.

## Key files
- `packages/config/src/index.ts` — `RESOURCE.escortRing` (new).
- `packages/simulation/src/worldSim.ts` — split miners vs escorts during a `mine` order; escort perimeter slots + outward/threat-facing heading.
- `packages/simulation/src/fleet.ts` — optional `isMiner(ship)` helper reused by 036/037.

## Acceptance criteria
- With a mixed fleet mining, miners occupy the inner ring and non-miners form a wider protective
  ring around them (visibly "guarding"); escorts face outward / toward threats.
- If an enemy approaches, the escorts (nearest to it) engage before the miners are hit.

## Testing
- Unit (`@space/simulation`): a fleet of 2 miners + 2 escorts on a `mine` order — miners settle at
  ~`mineRing`, escorts at ~`escortRing` (farther out); deterministic angles.
- Integration (`engine.test.ts`): spawn a hostile near a mining fleet → an escort is the first to
  acquire/engage it while miners keep mining (or flee per doctrine).

## Unresolved questions
- Escort facing: always outward vs. toward the nearest sensed enemy (prefer enemy when one is sensed).
- Should escorts bias their arc toward the enemy's bearing (a screen on the threatened side) rather
  than an even ring? (Nice-to-have; even ring first.)
