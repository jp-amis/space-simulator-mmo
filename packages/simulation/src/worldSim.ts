// Always-on per-ship world simulation. Every ship in every fleet is simulated every
// step: it steers to its formation slot around the fleet's STATIC anchor and parks
// there. Combat is an overlay — ships fire at (and, for aggressive orders, close on)
// enemies within range. Deterministic: one seeded RNG on GameState advanced per step.

import { COMBAT, RESOURCE, SALVAGE } from "@space/config";
import type { EntityId, FleetState, GameState, ResourceDeposit, ResourceLocation, ResourceType, ShipRuntime, ShipState, Vec2 } from "./types.js";
import { rngFromState } from "./rng.js";
import { computeFormationOffsets } from "./fleet.js";
import { applyDamage, HIT_RADIUS, preferredRangeUnits, segmentPointDistance } from "./combat.js";
import { addToBag, bagTotal, transfer } from "./resources.js";
import { clampLength, dist, normalize, sub } from "./vec.js";

/** Choose which deposit at a location to mine: the requested index, else the richest with reserves. */
export function pickDeposit(loc: ResourceLocation, index?: number): ResourceDeposit | undefined {
  if (index !== undefined && loc.deposits[index] && loc.deposits[index]!.reserves > 0) return loc.deposits[index];
  let best: ResourceDeposit | undefined;
  for (const d of loc.deposits) {
    if (d.reserves <= 0) continue;
    if (!best || d.richness > best.richness) best = d;
  }
  return best;
}

let projCounter = 0;
const UNDER_ATTACK_MS = 3000;

/** Centroid of a fleet's living ships (its real location); falls back to the anchor. */
export function fleetCentroid(game: GameState, fleet: FleetState): Vec2 {
  let x = 0;
  let y = 0;
  let n = 0;
  for (const id of fleet.shipIds) {
    const rt = game.shipRuntime.get(id);
    if (rt && rt.alive) {
      x += rt.position.x;
      y += rt.position.y;
      n++;
    }
  }
  return n > 0 ? { x: x / n, y: y / n } : { ...fleet.position };
}

/** A ship counts as a miner if it can actually extract (plan 036/037). */
export function isMiner(ship: ShipState): boolean {
  return ship.derived.miningPower > 0;
}

/** While mining, arrange miners on an inner ring around the deposit (fleet.position) and
 *  non-mining ships on a larger protective ring (plan 036/037). Deterministic by index. */
function miningRingSlots(fleet: FleetState, ships: ShipState[]): Map<EntityId, Vec2> {
  const out = new Map<EntityId, Vec2>();
  const miners = ships.filter(isMiner);
  const escorts = ships.filter((s) => !isMiner(s));
  const ring = (group: ShipState[], radius: number) => {
    const n = group.length;
    group.forEach((s, i) => {
      const a = n > 0 ? (i / n) * Math.PI * 2 : 0;
      out.set(s.id, { x: fleet.position.x + Math.cos(a) * radius, y: fleet.position.y + Math.sin(a) * radius });
    });
  };
  ring(miners, RESOURCE.mineRing);
  ring(escorts, RESOURCE.escortRing);
  return out;
}

/** Fleet facing = direction from its ships toward the anchor (its heading of travel). */
function fleetHeading(game: GameState, fleet: FleetState): number {
  const c = fleetCentroid(game, fleet);
  const dx = fleet.position.x - c.x;
  const dy = fleet.position.y - c.y;
  return dx * dx + dy * dy > 400 ? Math.atan2(dy, dx) : 0;
}

function homePos(game: GameState, ownerId: string): Vec2 | undefined {
  const player = game.players.get(ownerId);
  const planet = player && game.planets.get(player.homePlanetId);
  return planet ? { x: planet.position.x, y: planet.position.y } : undefined;
}

function makeRuntime(ship: ShipState, fleet: FleetState, slot: Vec2): ShipRuntime {
  return {
    shipId: ship.id,
    fleetId: fleet.id,
    ownerId: fleet.ownerId,
    position: { ...slot },
    velocity: { x: 0, y: 0 },
    heading: 0,
    shield: ship.derived.shieldCapacity,
    maxShield: ship.derived.shieldCapacity,
    weaponCooldowns: Object.fromEntries(ship.derived.weaponRoomIds.map((r) => [r, 0])),
    alive: true,
  };
}

const awarenessOf = (fleet: FleetState) => Math.max(fleet.sensorRange, 800);

function nearestEnemyWithin(rt: ShipRuntime, game: GameState, range: number): ShipRuntime | undefined {
  let best: ShipRuntime | undefined;
  let bestD = range;
  for (const o of game.shipRuntime.values()) {
    if (!o.alive || o.ownerId === rt.ownerId) continue;
    const d = dist(rt.position, o.position);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

function fleetUnderAttack(fleet: FleetState, nowMs: number): boolean {
  return nowMs < (fleet.underAttackUntil ?? 0);
}

/** May this fleet's ships fire this step (doctrine gate)? */
function fleetFires(fleet: FleetState, nowMs: number): boolean {
  switch (fleet.doctrine.preset) {
    case "hold_fire":
      return false;
    case "return_fire":
    case "flee_if_attacked":
      return fleetUnderAttack(fleet, nowMs);
    default:
      return true; // attack_on_sight, pursue
  }
}

function fleetHealth(game: GameState, fleet: FleetState): number {
  let hp = 0;
  let max = 0;
  for (const id of fleet.shipIds) {
    const s = game.ships.get(id);
    if (!s) continue;
    hp += s.hull.hp;
    max += s.hull.maxHp;
  }
  return max > 0 ? hp / max : 1;
}

/** Fleet-level decisions: intent (display), flee-home + survival retreat. */
function stepFleetBrain(game: GameState, fleet: FleetState, nowMs: number): void {
  const underAttack = fleetUnderAttack(fleet, nowMs);
  const d = fleet.doctrine;

  // flee_if_attacked or a badly-losing fleet retreats home (moves the anchor).
  const losing = fleetHealth(game, fleet) < 0.3 && d.survival > 0.6;
  const wantsFlee = (d.preset === "flee_if_attacked" && underAttack) || losing;
  if (wantsFlee) {
    const home = homePos(game, fleet.ownerId) ?? awayFromEnemy(game, fleet);
    if (home) fleet.order = { kind: "moveTo", target: home };
    fleet.position = home ?? fleet.position;
    fleet.intent = "flee";
    return;
  }
  const centroid = fleetCentroid(game, fleet);
  let enemyNear = false;
  for (const o of game.shipRuntime.values()) {
    if (o.alive && o.ownerId !== fleet.ownerId && dist(centroid, o.position) <= awarenessOf(fleet)) {
      enemyNear = true;
      break;
    }
  }
  fleet.intent = enemyNear && fleetFires(fleet, nowMs) ? "engage" : "continue_order";
}

function awayFromEnemy(game: GameState, fleet: FleetState): Vec2 | undefined {
  const c = fleetCentroid(game, fleet);
  let ex = 0;
  let ey = 0;
  let n = 0;
  for (const o of game.shipRuntime.values()) {
    if (o.alive && o.ownerId !== fleet.ownerId && dist(c, o.position) <= awarenessOf(fleet)) {
      ex += o.position.x;
      ey += o.position.y;
      n++;
    }
  }
  if (n === 0) return undefined;
  const dir = normalize({ x: c.x - ex / n, y: c.y - ey / n });
  return { x: c.x + dir.x * 1500, y: c.y + dir.y * 1500 };
}

/** Desired velocity for one ship: arrive at its slot, optionally close to weapon range.
 *  `fleetMaxSpeed` is the slowest-ship cap for the fleet: during formation travel the ship
 *  holds to it so faster ships don't outrun the group; a ship breaking formation to fight
 *  (approach) may use its own top speed. */
function desiredVelocity(
  rt: ShipRuntime,
  ship: ShipState,
  slot: Vec2,
  target: ShipRuntime | undefined,
  approach: boolean,
  game: GameState,
  fleetMaxSpeed: number,
): Vec2 {
  const shipMax = ship.derived.maxSpeed;
  const travelMax = Math.min(shipMax, fleetMaxSpeed); // slowest-ship cap for coherent travel
  let vx = 0;
  let vy = 0;
  // Arrival toward the formation slot (slows to a stop — ships PARK, no idle drift).
  const toSlot = sub(slot, rt.position);
  const dSlot = Math.hypot(toSlot.x, toSlot.y);
  const formScale = approach ? 0.3 : 1;
  if (dSlot > COMBAT.slotArriveDist) {
    const sp = Math.min(travelMax, dSlot * 3) * formScale;
    const dir = normalize(toSlot);
    vx += dir.x * sp;
    vy += dir.y * sp;
  }
  // Combat range-keeping — only when the order allows breaking formation to fight.
  if (approach && target) {
    const to = sub(target.position, rt.position);
    const d = Math.hypot(to.x, to.y) || 1;
    const want = preferredRangeUnits(ship.doctrine.preferredRange);
    const dir = normalize(to);
    const sign = d > want + 40 ? 1 : d < want - 60 ? -1 : 0;
    vx += dir.x * sign * shipMax;
    vy += dir.y * sign * shipMax;
  }
  // Collision avoidance from nearby friendlies.
  for (const o of game.shipRuntime.values()) {
    if (o === rt || !o.alive || o.ownerId !== rt.ownerId) continue;
    const away = sub(rt.position, o.position);
    const dd = Math.hypot(away.x, away.y);
    if (dd > 0 && dd < COMBAT.avoidanceRadius) {
      const w = (shipMax * (COMBAT.avoidanceRadius - dd)) / COMBAT.avoidanceRadius;
      vx += (away.x / dd) * w;
      vy += (away.y / dd) * w;
    }
  }
  // Cap to ship top speed when fighting, otherwise to the fleet's slowest-ship speed.
  return clampLength({ x: vx, y: vy }, approach ? shipMax : travelMax);
}

export interface WorldStepResult {
  destroyedShipIds: string[];
}

/** Advance the whole world one fixed step. Mutates `game`. */
export function stepWorld(game: GameState, dtMs: number, nowMs: number): WorldStepResult {
  const dt = dtMs / 1000;
  const rng = rngFromState(game.rngState);
  game.combatEvents = [];
  const events = game.combatEvents;

  // 1. Sync per-ship runtime with fleet membership + compute formation slots.
  const slots = new Map<EntityId, Vec2>();
  const fleeted = new Set<EntityId>();
  const fleetSpeedCap = new Map<EntityId, number>(); // slowest-ship cap, per fleet
  for (const fleet of game.fleets.values()) {
    if (fleet.status === "destroyed") continue;
    const ships = fleet.shipIds.map((id) => game.ships.get(id)).filter((s): s is ShipState => !!s);
    // Fleet advances at its slowest member's top speed so it stays coherent in travel.
    let cap = Infinity;
    for (const ship of ships) cap = Math.min(cap, ship.derived.maxSpeed);
    fleetSpeedCap.set(fleet.id, Number.isFinite(cap) ? cap : COMBAT.minMaxSpeed);

    // While mining, override the formation: miners ring the deposit, escorts screen them
    // (plan 036/037). Otherwise use the fleet's selected formation.
    const miningSlots = fleet.order.kind === "mine" ? miningRingSlots(fleet, ships) : undefined;
    const offsets = miningSlots ? undefined : computeFormationOffsets(ships, fleet.formation);
    const heading = fleetHeading(game, fleet);
    const cos = Math.cos(heading);
    const sin = Math.sin(heading);
    for (const ship of ships) {
      fleeted.add(ship.id);
      let slot: Vec2;
      if (miningSlots) {
        slot = miningSlots.get(ship.id) ?? { ...fleet.position };
      } else {
        const off = offsets!.get(ship.id) ?? { x: 0, y: 0 };
        slot = { x: fleet.position.x + off.x * cos - off.y * sin, y: fleet.position.y + off.x * sin + off.y * cos };
      }
      slots.set(ship.id, slot);
      if (!game.shipRuntime.has(ship.id)) game.shipRuntime.set(ship.id, makeRuntime(ship, fleet, slot));
    }
  }
  for (const id of [...game.shipRuntime.keys()]) if (!fleeted.has(id)) game.shipRuntime.delete(id);

  // 2. Fleet brains.
  for (const fleet of game.fleets.values()) if (fleet.status !== "destroyed") stepFleetBrain(game, fleet, nowMs);

  // 3. Ship movement + firing.
  for (const rt of game.shipRuntime.values()) {
    if (!rt.alive) continue;
    rt.miningLocationId = undefined; // cleared here; the mining/unload passes re-set them
    rt.unloadLocationId = undefined;
    const ship = game.ships.get(rt.shipId);
    const fleet = game.fleets.get(rt.fleetId);
    if (!ship || !fleet || ship.hull.hp <= 0) {
      rt.alive = false;
      continue;
    }
    const slot = slots.get(rt.shipId) ?? fleet.position;
    const fires = fleetFires(fleet, nowMs);
    const target = fires ? nearestEnemyWithin(rt, game, awarenessOf(fleet)) : undefined;
    rt.targetShipId = target?.shipId;
    // A plain move order keeps formation (retreat/kite); aggressive orders may break it.
    const retreating = fleet.order.kind === "moveTo";
    const approach = !!target && !retreating && fleet.order.kind !== "hold";

    const dv = desiredVelocity(rt, ship, slot, target, approach, game, fleetSpeedCap.get(rt.fleetId) ?? ship.derived.maxSpeed);
    const maxDv = ship.derived.accel * dt;
    const ddx = dv.x - rt.velocity.x;
    const ddy = dv.y - rt.velocity.y;
    const dvLen = Math.hypot(ddx, ddy);
    if (dvLen > maxDv && dvLen > 0) {
      rt.velocity.x += (ddx / dvLen) * maxDv;
      rt.velocity.y += (ddy / dvLen) * maxDv;
    } else {
      rt.velocity.x = dv.x;
      rt.velocity.y = dv.y;
    }
    rt.position.x += rt.velocity.x * dt;
    rt.position.y += rt.velocity.y * dt;
    if (target && fires) rt.heading = Math.atan2(target.position.y - rt.position.y, target.position.x - rt.position.x);
    else if (fleet.order.kind === "mine") {
      // Mining: miners face the deposit (they're working it); escorts face outward to screen.
      const c = fleet.position;
      rt.heading = isMiner(ship)
        ? Math.atan2(c.y - rt.position.y, c.x - rt.position.x)
        : Math.atan2(rt.position.y - c.y, rt.position.x - c.x);
    } else if (rt.velocity.x !== 0 || rt.velocity.y !== 0) rt.heading = Math.atan2(rt.velocity.y, rt.velocity.x);

    if (rt.shield < rt.maxShield) rt.shield = Math.min(rt.maxShield, rt.shield + COMBAT.shieldRegenPerSec * dt);

    if (fires && target) {
      for (const room of ship.rooms) {
        if (room.kind !== "weapon" || room.hp <= 0 || !room.enabled || !room.weapon) continue;
        const cd = (rt.weaponCooldowns[room.id] ?? 0) - dtMs;
        if (cd > 0) {
          rt.weaponCooldowns[room.id] = cd;
          continue;
        }
        if (dist(rt.position, target.position) > room.weapon.range) {
          rt.weaponCooldowns[room.id] = 0;
          continue;
        }
        rt.weaponCooldowns[room.id] = room.weapon.cooldownMs;
        const dir = normalize(sub(target.position, rt.position));
        const pid = `proj_${(projCounter = (projCounter + 1) & 0xffffff).toString(36)}`;
        game.projectiles.push({
          id: pid,
          ownerShipId: rt.shipId,
          ownerFleetId: rt.fleetId,
          targetShipId: target.shipId,
          kind: room.moduleType, // e.g. "laser" / "cannon" — client differentiates visuals
          position: { x: rt.position.x, y: rt.position.y },
          velocity: { x: dir.x * room.weapon.projectileSpeed, y: dir.y * room.weapon.projectileSpeed },
          damage: room.weapon.damage,
          ttlMs: (room.weapon.range / room.weapon.projectileSpeed) * 1000 + 500,
        });
        events.push({ type: "fire", from: rt.shipId, to: target.shipId, projectileId: pid });
      }
    }
  }

  // 3b. Mining: ships whose fleet is on a `mine` order extract from the target deposit
  // into physical cargo while in range (plan 031).
  for (const fleet of game.fleets.values()) {
    if (fleet.status === "destroyed" || fleet.order.kind !== "mine") continue;
    const loc = game.resourceLocations.get(fleet.order.locationId);
    if (!loc) continue;
    const deposit = pickDeposit(loc, fleet.order.depositIndex);
    if (!deposit || deposit.reserves <= 0) continue;
    for (const id of fleet.shipIds) {
      const ship = game.ships.get(id);
      const rt = game.shipRuntime.get(id);
      if (!ship || !rt || !rt.alive || ship.derived.miningPower <= 0) continue;
      if (!ship.derived.miningResources.includes(deposit.resource)) continue;
      if (dist(rt.position, loc.position) > RESOURCE.mineRange) continue;
      const free = ship.derived.cargo - bagTotal(ship.cargo);
      if (free <= 0) continue;
      const rate = ship.derived.miningPower * deposit.richness * deposit.accessibility * dt;
      const moved = Math.max(0, Math.min(rate, free, deposit.reserves));
      if (moved <= 0) continue;
      addToBag(ship.cargo, deposit.resource, moved);
      deposit.reserves -= moved;
      rt.miningLocationId = loc.id; // actively extracting → client draws a mining beam
    }
  }

  // 3c. Unloading: ships whose fleet is on an `unloadAt` order stream cargo into the target
  // planet over time (rate * dt) while in range (plan 038) — mirror of the mining pass.
  for (const fleet of game.fleets.values()) {
    if (fleet.status === "destroyed" || fleet.order.kind !== "unloadAt") continue;
    const planet = game.planets.get(fleet.order.planetId);
    if (!planet || planet.ownerId !== fleet.ownerId) continue;
    const budget = RESOURCE.transferPerSec * dt;
    for (const id of fleet.shipIds) {
      const ship = game.ships.get(id);
      const rt = game.shipRuntime.get(id);
      if (!ship || !rt || !rt.alive) continue;
      if (dist(rt.position, planet.position) > RESOURCE.transferRange) continue;
      if (bagTotal(ship.cargo) <= 0) continue;
      const moved = transfer(ship.cargo, planet.storedResources, "metal", budget) + transfer(ship.cargo, planet.storedResources, "fuel", budget);
      if (moved > 0) rt.unloadLocationId = planet.id; // actively delivering → client draws a beam
    }
  }

  // 4. Projectiles: advance, swept-hit, live damage.
  const surviving: typeof game.projectiles = [];
  for (const p of game.projectiles) {
    const target = game.shipRuntime.get(p.targetShipId);
    p.ttlMs -= dtMs;
    if (!target || !target.alive || p.ttlMs <= 0) continue;
    const dir = normalize(sub(target.position, p.position));
    const spd = Math.hypot(p.velocity.x, p.velocity.y);
    p.velocity.x = dir.x * spd;
    p.velocity.y = dir.y * spd;
    const px = p.position.x;
    const py = p.position.y;
    p.position.x += p.velocity.x * dt;
    p.position.y += p.velocity.y * dt;
    if (segmentPointDistance(px, py, p.position.x, p.position.y, target.position) <= HIT_RADIUS) {
      const targetShip = game.ships.get(target.shipId);
      if (targetShip) {
        applyDamage(target, targetShip, p.damage, rng.int(1 << 20), events);
        const tf = game.fleets.get(target.fleetId);
        if (tf) tf.underAttackUntil = nowMs + UNDER_ATTACK_MS;
      }
      continue;
    }
    surviving.push(p);
  }
  game.projectiles = surviving;

  // 4b. Salvage: ships with free cargo recover nearby debris; debris decays over time.
  const survivingDebris: typeof game.debris = [];
  for (const d of game.debris) {
    d.ttlMs -= dtMs;
    if (d.ttlMs <= 0 || bagTotal(d.cargo) <= 0.5) continue;
    for (const rt of game.shipRuntime.values()) {
      if (!rt.alive) continue;
      const ship = game.ships.get(rt.shipId);
      if (!ship) continue;
      const free = ship.derived.cargo - bagTotal(ship.cargo);
      if (free <= 0) continue;
      if (dist(rt.position, d.position) > SALVAGE.range) continue;
      let capacityLeft = free;
      for (const res of Object.keys(d.cargo) as ResourceType[]) {
        const moved = transfer(d.cargo, ship.cargo, res, SALVAGE.recoverPerSec * dt, capacityLeft);
        capacityLeft -= moved;
      }
    }
    if (bagTotal(d.cargo) > 0.5) survivingDebris.push(d);
  }
  game.debris = survivingDebris;

  // 5. Cull dead ships from the world / fleets / players; EVERY wreck drops salvage
  // (base hull scrap + a fraction of surviving cargo) so kills always leave loot.
  const destroyedShipIds: string[] = [];
  for (const [id, rt] of game.shipRuntime) {
    const ship = game.ships.get(id);
    if (rt.alive && ship && ship.hull.hp > 0) continue;
    if (ship) {
      const cargo: typeof ship.cargo = {};
      for (const res of Object.keys(ship.cargo) as ResourceType[]) {
        const amt = (ship.cargo[res] ?? 0) * SALVAGE.survivalFraction;
        if (amt > 0) cargo[res] = amt;
      }
      const scrap = SALVAGE.scrapPerCell * ship.hull.width * ship.hull.height;
      cargo.metal = (cargo.metal ?? 0) + scrap; // base scrap from the wreck hull
      const did = `debris_${(projCounter = (projCounter + 1) & 0xffffff).toString(36)}`;
      game.debris.push({ id: did, position: { x: rt.position.x, y: rt.position.y }, cargo, ttlMs: SALVAGE.ttlMs });
    }
    game.shipRuntime.delete(id);
    if (ship) {
      const player = game.players.get(ship.ownerId);
      if (player) player.shipIds = player.shipIds.filter((s) => s !== id);
      game.ships.delete(id);
    }
    const fleet = game.fleets.get(rt.fleetId);
    if (fleet) fleet.shipIds = fleet.shipIds.filter((s) => s !== id);
    destroyedShipIds.push(id);
  }

  game.rngState = rng.state;
  return { destroyedShipIds };
}
