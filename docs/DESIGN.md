# Space Strategy MMO — Developer Implementation Guide

> Source of truth extracted from design_doc.docx. Do not edit by hand; regenerate from the .docx.

| Prototype constraint | Decision |
| Accounts | No authentication. Player types an arbitrary ID; that string is the account key. |
| Persistence | None. Server state lives in memory and resets on restart. |
| Art pipeline | No image assets. All visuals are generated at runtime using vector primitives, particles, text, geometry, shaders, noise and color palettes. |
| Simulation | Authoritative server. Universe is event-driven; active battles use fixed-step simulation. |
| Primary goal | Reach a playable strategic loop quickly, while preserving clean seams for persistence, auth and scale later. |

Working design target: Travian / Tribal Wars / Subterfuge strategic pacing + free-moving space fleets + FTL-like ship internals resolved automatically.

# 1. Product Definition and Prototype Scope

The first implementation should prove one complete strategy loop rather than attempting an MMO-scale platform. A player enters an ID, sees a procedural star system, owns a planet, builds ships from modular rooms, groups ships into fleets, moves fleets continuously through space, gathers resources, encounters another fleet, and watches an automatic tactical battle resolve.

## 1.1 Prototype player loop

1. Enter a free-text player ID and connect to the server.
2. Receive or create an in-memory player state with one home planet and starting resources.
3. Inspect the strategic space map and select planets, fleets and points in free space.
4. Queue economic actions such as resource extraction or ship construction.
5. Build individual ships from a hull/grid plus rooms/modules and optional crew.
6. Create a fleet and issue a destination in continuous 2D space.
7. Allow trajectories to create encounters based on spatial proximity and timing.
8. When hostile fleets engage, transition those fleets into an active battle simulation.
9. Apply battle results to the persistent-in-memory strategic state and continue playing.

## 1.2 Explicitly out of scope for the first prototype

Passwords, OAuth, sessions, account recovery or security-hardening of identity.
Database persistence, migrations, backups and durable event logs.
Horizontal scaling, multi-region deployment or thousands of simultaneously simulated battles.
Polished art assets, animation authoring tools, audio production and localization.
Complex diplomacy, alliances, marketplaces, research trees and seasonal metagame.
Anti-cheat beyond making the server authoritative.

# 2. Recommended Technology Stack

| Layer | Recommended choice | Why now |
| Language | TypeScript end-to-end | Shared types, rapid iteration, easy transfer of simulation DTOs and validation schemas. |
| Runtime | Node.js | Excellent fit for websocket-heavy orchestration and event scheduling; prototype simulation load is manageable. |
| HTTP server | Fastify | Small, typed, fast API layer; easy health/debug endpoints. |
| Realtime transport | WebSocket (`ws`) | Low abstraction and full control over binary/JSON messages. Socket.IO can be substituted if reconnection/rooms are preferred. |
| Frontend build | Vite + TypeScript | Fast dev loop and simple production bundling. |
| Rendering | PixiJS | Efficient 2D GPU rendering, Graphics primitives, particles and shader filters without requiring art assets. |
| UI shell | HTML/CSS overlay or lightweight DOM framework | Use DOM for menus/forms/tooltips; keep Pixi for the world/map/battle canvas. |
| Validation | Zod or equivalent schema validation | Runtime validation at the network boundary. |
| Tests | Vitest | Fast TypeScript unit/integration testing. |
| Monorepo | pnpm workspaces | Shared contracts and simulation code without publishing packages. |

Do not begin by introducing ECS frameworks, Kafka, Redis, PostgreSQL, Kubernetes or microservices. The architecture below intentionally keeps boundaries that make those additions possible later, but they would slow down validation of the game itself today.

## 2.1 Proposed repository layout

space-game/
apps/
server/                 # Fastify + WebSocket + authoritative game runtime
client/                 # Vite + PixiJS + DOM UI
packages/
protocol/               # Network DTOs, schemas, message IDs
simulation/             # Pure movement/combat/domain logic where possible
config/                 # Game constants and balancing data
tools/                    # Dev scripts, seed/debug commands
package.json
pnpm-workspace.yaml
tsconfig.base.json

# 3. System Architecture

Treat the server as the single source of truth. The browser sends intentions such as “move fleet X to point Y” or “install module Z.” It never sends authoritative positions, damage values, resources or battle results.
Browser / PixiJS
├─ Input & UI
├─ Local interpolation / visual prediction
└─ WebSocket client
│ commands / snapshots / events
▼
Node.js Authoritative Server
├─ Connection + Player Session Registry
├─ Command Router
├─ World State (in-memory Maps)
├─ Movement Scheduler + Spatial Index
├─ Economy / Construction Scheduler
├─ Encounter Detector
├─ Active Battle Manager
└─ Snapshot / Event Broadcaster

## 3.1 Separate domain state from presentation state

| Domain/server state | Presentation/client state |
| Fleet trajectory, ship stats, room HP, crew assignments, resources | Camera position, zoom, selected entity, hover state, particle positions |
| Authoritative timestamps and battle ticks | Interpolated current position and animation progress |
| Visibility/fog-of-war decisions | How undiscovered space is shaded |
| Command validation and cooldowns | Button disabled states and tooltips |
| RNG seed / resolved outcomes | Screen shake, trails, impact particles |


# 4. Core In-Memory Domain Model

Start with plain TypeScript objects stored in Maps. IDs can be UUIDs or prefixed random IDs. Avoid class-heavy entity models; serializable data makes debugging and future persistence easier.
type EntityId = string;
type Vec2 = { x: number; y: number };
type GameState = {
players: Map<string, PlayerState>;
planets: Map<EntityId, PlanetState>;
ships: Map<EntityId, ShipState>;
fleets: Map<EntityId, FleetState>;
battles: Map<EntityId, BattleState>;
};
type PlayerState = {
id: string;                  // free-text account key for prototype
homePlanetId: EntityId;
resources: { metal: number; fuel: number; energy: number };
fleetIds: EntityId[];
shipIds: EntityId[];
};

## 4.1 Planet state

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
Resources do not need to increment every tick. Store the last update timestamp and derive the current amount lazily when the player opens the planet, spends resources, or a scheduled event requires the value.
function materializePlanetResources(p: PlanetState, nowMs: number) {
const dt = Math.max(0, nowMs - p.resourceUpdatedAtMs) / 1000;
p.storedResources.metal += p.resourceRates.metalPerSec * dt;
p.storedResources.fuel += p.resourceRates.fuelPerSec * dt;
p.resourceUpdatedAtMs = nowMs;
}

## 4.2 Modular ship state (FTL-like)

A ship is a grid-shaped hull with room/module placements. The first version should support enough topology for damage propagation and targeting without implementing crew pathfinding immediately.
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
Derived stats should be recalculated after build changes or room damage: thrust, turn rate, sensor range, shield capacity, weapon groups, power production and cargo. Do not trust client-computed derived values.

## 4.3 Fleet state

type FleetState = {
id: EntityId;
ownerId: string;
shipIds: EntityId[];
status: 'idle' | 'moving' | 'engaging' | 'battle' | 'destroyed';
movement?: MovementPlan;
battleId?: EntityId;
sensorRange: number;
engagementRange: number;
};
type MovementPlan = {
from: Vec2;
to: Vec2;
startMs: number;
endMs: number;
speed: number;
revision: number;
};

# 5. Continuous Movement Without Simulating Everything Every Frame

The strategic map uses continuous coordinates, not movement tiles. Movement is represented mathematically as a line segment plus a time interval. A fleet has no need for its position to be updated 20 times per second while nothing interacts with it.

## 5.1 Position is a function of time

function positionAt(m: MovementPlan, nowMs: number): Vec2 {
if (nowMs <= m.startMs) return m.from;
if (nowMs >= m.endMs) return m.to;
const t = (nowMs - m.startMs) / (m.endMs - m.startMs);
return {
x: m.from.x + (m.to.x - m.from.x) * t,
y: m.from.y + (m.to.y - m.from.y) * t,
};
}
When a new command is issued, first materialize the fleet’s position at the command timestamp. That becomes the new segment origin. Increment `revision` so stale scheduled events can cheaply detect that the movement plan changed.

## 5.2 Arrival scheduling

Schedule one arrival event for the fleet at `endMs`. A binary min-heap ordered by timestamp is sufficient. Each server heartbeat processes all due events. If a fleet changed course, the old event is ignored by comparing its stored movement revision.
type ScheduledEvent =
| { atMs: number; type: 'fleet-arrival'; fleetId: string; movementRevision: number }
| { atMs: number; type: 'construction-complete'; planetId: string; jobId: string }
| { atMs: number; type: 'scan-refresh'; regionKey: string };

## 5.3 Detecting fleets whose paths may intersect

The important problem is not line intersection alone; it is whether two moving fleets occupy positions within engagement distance at approximately the same time. Use a broad phase followed by an exact closest-approach test.
| Phase | Implementation |
| Broad phase | Index each active movement segment into spatial cells intersected by its swept bounding box. Cell size can be several times the normal engagement radius. |
| Candidate query | When a movement command is created/changed, query the cells touched by its swept bounds for other active fleet trajectories whose time intervals overlap. |
| Narrow phase | Solve relative motion over the overlapping time interval and calculate time of closest approach. If distance <= engagement radius, produce an encounter candidate. |
| Schedule | Insert an encounter-check event at the calculated closest-approach timestamp. On execution, revalidate both movement revisions and hostility before starting combat. |


### Relative-motion closest approach

// During the common time interval [t0, t1], each fleet has
// pA(t) = a0 + vA*t and pB(t) = b0 + vB*t.
// Relative position r(t) = (a0-b0) + (vA-vB)*t.
// Minimize |r(t)|²:
// tClosest = clamp(-dot(r0, vRel) / dot(vRel, vRel), t0, t1)
// If distanceAt(tClosest) <= engagementRadius -> candidate encounter.
This means Fleet B can begin moving five minutes after Fleet A and still generate an encounter. The server compares the time-overlapping portions of both trajectories whenever B creates its new plan.

## 5.4 Spatial index for the prototype

Use a uniform hash grid first. A key such as `"12:-4"` maps to a Set of fleet IDs. Re-index a fleet only when its trajectory changes, not every frame. An R-tree can replace this later if fleet density becomes irregular enough to justify it.

# 6. Server Time, Heartbeat and Simulation Modes

Use one lightweight server heartbeat, for example 10 times per second, to process due scheduled events, active battles and outgoing network batches. This heartbeat is not a full-universe simulation tick.
| System | Update model | Typical frequency |
| Long-distance fleet travel | Analytical / event-driven | On command, query, arrival or encounter |
| Resource production | Lazy timestamp materialization | On read/spend/event |
| Construction | Scheduled completion event | At completion |
| Strategic sensor visibility | Event-driven + periodic refresh if needed | 1–2 Hz or on movement changes |
| Active battles | Fixed timestep | 10–20 simulation steps/sec |
| Client rendering | Interpolated visual frames | Browser display rate, usually 60 fps |


## 6.1 Fixed-step battle accumulator

const BATTLE_DT_MS = 100; // 10 Hz prototype
let previousMs = performance.now();
let accumulator = 0;
setInterval(() => {
const now = performance.now();
accumulator += now - previousMs;
previousMs = now;
processScheduledEvents(Date.now());
while (accumulator >= BATTLE_DT_MS) {
for (const battle of activeBattles.values()) {
stepBattle(battle, BATTLE_DT_MS / 1000);
}
accumulator -= BATTLE_DT_MS;
}
broadcastDirtyState();
}, 50);
Prefer monotonic time such as `performance.now()` for loop deltas, while timestamps exchanged/stored for strategic plans may use epoch milliseconds (`Date.now()`). Never derive physics deltas directly from wall-clock jumps.

# 7. Automatic Fleet Combat

Combat is a tactical simulation attached only to fleets that are currently fighting. It should feel like watching an automated FTL battle: ship layouts matter, rooms can fail, weapons target systems, crew provides bonuses, and outcomes emerge from the build rather than from one aggregate fleet power number.

## 7.1 Battle state

type BattleState = {
id: EntityId;
startedAtMs: number;
tick: number;
rngState: number;
participants: BattleFleetState[];
projectiles: ProjectileState[];
eventsSinceBroadcast: BattleEvent[];
status: 'running' | 'resolved';
};
type BattleShipState = {
shipId: EntityId;
position: Vec2;
velocity: Vec2;
facingRad: number;
targetShipId?: EntityId;
weaponCooldowns: Record<EntityId, number>;
shield: number;
};

## 7.2 First combat algorithm

1. Build a local battle instance by copying or referencing the participating ship combat state.
2. Place fleets on opposing sides of a bounded combat space using deterministic seeded placement.
3. Each battle tick, choose/validate targets based on simple doctrine rules.
4. Update desired movement: close distance, maintain weapon range, retreat if doctrine permits.
5. Update ship velocity/position using derived thrust and turn stats.
6. Advance weapon cooldowns. When ready and in range, select an eligible target room and fire.
7. Resolve projectile travel or beam hit. Apply shield first, then room/hull damage.
8. When rooms are damaged, recompute affected capabilities (weapons disabled, engine thrust reduced, reactor power lost).
9. Apply crew bonuses and, later, crew movement/repair behavior.
10. Remove destroyed ships. End the battle when one side has no combat-capable ships or successfully retreats.
11. Write survivors/damage back to strategic ship state and place surviving fleets at the encounter position.

## 7.3 Deterministic RNG

Each battle receives a seed. Every random decision must consume the battle RNG in a deterministic order. This makes bugs reproducible and permits headless battle tests such as “run seed 42817 for 30 seconds and expect ship B to be destroyed.” Do not use `Math.random()` inside core combat logic.

## 7.4 Combat doctrine rather than player micromanagement

| Doctrine field | Examples |
| Preferred range | close / medium / long |
| Target priority | weapons first / engines first / weakest hull / nearest |
| Focus fire | same target / independent targets |
| Retreat rule | never / hull below 25% / flagship destroyed |
| Power priority | shields > engines > weapons, or player-defined ordering |

These rules give players strategic control over how their builds behave without requiring live tactical input. They also make asynchronous combat possible later.

# 8. Ship Builder

The ship builder is one of the main strategic differentiators, so implement it as a data-driven validator plus a procedural Pixi editor.

## 8.1 Grid representation

Use a small integer grid per hull. Rooms occupy rectangles or explicit cell masks. Start with rectangular placements for simplicity. Every room declares its occupied cells, power needs and gameplay tags.
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

## 8.2 Validation rules

All occupied module cells must be inside the hull mask.
Modules may not overlap.
Exactly one bridge is required in the first ruleset.
Total reactor generation must satisfy mandatory baseline systems, or the design is marked underpowered and needs power-priority behavior.
Thrusters/engines can contribute to fleet speed; choose whether the slowest ship caps fleet speed or calculate a formation value.
Weapons must have compatible power and hardpoint constraints if hardpoints are enabled.
Derived stats must be computed by shared server-side simulation code.

## 8.3 Procedural ship rendering

Render the hull as a polygon or rounded rectangle assembled from Pixi `Graphics`; draw room rectangles with strokes/fills based on system category; add small procedural details such as vents, grid lines, reactor arcs and weapon barrels using geometry. The same blueprint can render at strategic-icon scale and detailed battle scale by changing the level of detail.

# 9. Client Architecture with PixiJS


## 9.1 Scene organization

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

## 9.2 Camera

World coordinates remain independent of screen coordinates.
Pan by pointer drag; zoom around cursor using the wheel.
Clamp zoom levels so procedural details do not become meaningless or expensive.
Use screen-space label culling; do not render text for every entity at all zoom levels.
For a very large galaxy, keep coordinates near the camera origin in the rendering transform if floating-point precision becomes visible.

## 9.3 Procedural visual language — no assets

| Object | Programmatic treatment |
| Stars | Seeded point field with multiple sizes/brightness; parallax layers; optional shader/noise background. |
| Planets | Concentric circles, radial lighting, seeded land/cloud arcs, atmosphere ring, owner-colored orbital marker. |
| Fleets | Small oriented triangular/chevron silhouettes, count badges, velocity trail, selection halo. |
| Movement | Thin trajectory line with animated dash/particle flow and arrival marker. |
| Ships | Hull polygon + internal room rectangles + weapon geometry + thruster particles. |
| Projectiles | Lines/circles with additive-like bloom/filter kept conservative for performance. |
| Explosions | Short-lived expanding circles, particles and noise-based fragments. |
| UI icons | Simple vector glyphs built from lines/circles or text symbols; keep a consistent geometric style. |


## 9.4 Rendering performance rules

Reuse display objects and Graphics geometry where practical rather than recreate everything each frame.
Batch simple sprites/particles when counts become large; procedural does not mean every object must be a unique draw call.
Redraw static Graphics only when their visual state changes.
Interpolate fleets on the client from authoritative movement plans instead of receiving position packets every frame.
Cull off-screen planets, labels and effects.
Keep battle visual effects client-only; combat state comes from the server.

# 10. Networking Protocol

Use a small typed message protocol. For the prototype, JSON is acceptable and much easier to inspect. Binary encoding can be introduced after measuring bandwidth.

## 10.1 Connection flow with free-text ID

1. Client opens the page and shows a text input.
2. Player enters any non-empty ID such as `alice`.
3. Client opens WebSocket and sends `hello { playerId: "alice" }`.
4. Server normalizes only what is necessary (for example max length); if the ID does not exist in memory, create the player and starting world state.
5. Server associates the socket with that player ID. In this prototype, a second connection with the same ID can either replace the first or share the same account; choose one deterministic rule.
6. Server sends an initial snapshot and subsequent events/deltas.

## 10.2 Commands and server events

type ClientMessage =
| { type: 'hello'; playerId: string }
| { type: 'moveFleet'; requestId: string; fleetId: string; target: Vec2 }
| { type: 'createFleet'; requestId: string; shipIds: string[] }
| { type: 'updateShipBlueprint'; requestId: string; shipId: string; blueprint: ShipBlueprint }
| { type: 'setDoctrine'; requestId: string; fleetId: string; doctrine: FleetDoctrine };
type ServerMessage =
| { type: 'snapshot'; world: PlayerVisibleSnapshot }
| { type: 'ack'; requestId: string }
| { type: 'reject'; requestId: string; reason: string }
| { type: 'fleetMovement'; fleetId: string; movement: MovementPlan }
| { type: 'battleStarted'; battle: BattlePublicState }
| { type: 'battleFrame'; battleId: string; tick: number; delta: BattleDelta }
| { type: 'battleEnded'; battleId: string; result: BattleResult };

## 10.3 Visibility and information leakage

Even in the prototype, build snapshots through a `getVisibleState(playerId)` function rather than serializing the entire `GameState`. This creates the correct architectural seam for fog of war and prevents accidental disclosure of enemy room layouts, destinations or resources.

# 11. Command Processing Pattern

async function handleMoveFleet(playerId: string, cmd: MoveFleetCommand) {
const fleet = game.fleets.get(cmd.fleetId);
assert(fleet && fleet.ownerId === playerId);
assert(fleet.status !== 'battle');
const now = Date.now();
const origin = getFleetPosition(fleet, now);
const speed = calculateFleetStrategicSpeed(fleet);
const distance = length(sub(cmd.target, origin));
const durationMs = distance / speed * 1000;
const revision = (fleet.movement?.revision ?? 0) + 1;
fleet.status = 'moving';
fleet.movement = { from: origin, to: cmd.target, startMs: now,
endMs: now + durationMs, speed, revision };
reindexFleetTrajectory(fleet);
scheduleArrival(fleet);
schedulePotentialEncounters(fleet);
markFleetDirty(fleet.id);
}
Every command handler should follow the same pattern: resolve actor, validate authority/state, materialize lazy state, mutate authoritative domain state, schedule secondary events, mark dirty state, and return an acknowledgment or rejection.

# 12. Procedural World Generation

Use a fixed world seed so restarts can recreate the same base galaxy even before persistence exists. Player-owned state will still reset, but development remains reproducible.

## 12.1 Prototype generation

Generate 50–200 planets in a bounded 2D region with seeded pseudo-random positions and minimum separation.
Assign planet radii, resource biases and names from deterministic syllable tables.
Generate decorative stars client-side from the same or a visual-only seed; they do not need server entities.
When a new player ID appears, choose an unowned or newly generated home planet and create starter ships.
For local development, optionally create NPC/test players automatically so encounters are easy to trigger.

# 13. Step-by-Step Implementation Plan

Each step should compile, run and be demonstrable before moving to the next. Keep feature branches small and write simulation tests alongside each domain feature.

## Step 0 — Monorepo and developer loop

Create pnpm workspace with `apps/server`, `apps/client`, `packages/protocol`, `packages/simulation` and `packages/config`.
Configure strict TypeScript, ESLint/formatter if desired, Vitest and shared tsconfig.
Add `pnpm dev` to run server and Vite client together.
Add `/health` endpoint and client connection-status indicator.
Acceptance: one command starts both processes; browser connects to the development server.

## Step 1 — ID entry and in-memory player registry

Create a DOM ID-entry screen.
Implement websocket `hello` message.
Add `Map<string, PlayerState>` and `getOrCreatePlayer(id)`.
Create one home planet and starter resources for a new ID.
Reconnect with the same ID and return the same state while the server remains running.
Acceptance: two browser tabs with different IDs see separate in-memory players; restarting server resets both.

## Step 2 — Pixi strategic map and procedural universe

Create Pixi application, camera pan/zoom and resize handling.
Render procedural background, planets and labels.
Add selection/hover interaction and a DOM inspector.
Implement server snapshot with only visible planet/player data.
Acceptance: player can navigate a smooth asset-free star map and select their home planet.

## Step 3 — Fleet domain and free movement

Create ship and fleet data types.
Render fleet markers and trajectory lines.
Implement `moveFleet` command, analytical `positionAt`, arrival event scheduling and client interpolation.
Allow issuing a new destination mid-flight using the materialized current position.
Acceptance: fleets move continuously, arrive at the expected server timestamp, and can be redirected without positional jumps.

## Step 4 — Movement broad phase and encounter scheduling

Implement uniform spatial hash for moving trajectories.
Query overlapping swept bounds when plans change.
Implement relative-motion closest-approach calculation and unit tests.
Schedule/revalidate encounter events.
Acceptance: two fleets whose paths cross at different start times engage only when they are spatially close at the same time.

## Step 5 — Minimal battle simulation

Add battle manager and fixed-step loop for active battles only.
Use simple ship circles first: position, HP, range, cooldown, damage.
Implement deterministic RNG and headless battle tests.
Start battle from encounter and write result back to fleets.
Acceptance: encounters reliably transition into automatic combat and produce deterministic winners for a fixed seed.

## Step 6 — FTL-like modular ships

Implement hull grids, room placements and validation.
Add reactor/engine/weapon/shield rooms and derived stats.
Make battle damage target rooms and disable capabilities.
Render room layouts procedurally in Pixi.
Acceptance: changing a ship layout materially changes combat performance and visibly damaged systems stop contributing.

## Step 7 — Ship builder UI

Build grid editor with module palette, drag/place/remove/rotate interactions.
Show validation errors and live derived stats.
Send blueprint command to server and rebuild authoritative derived state.
Add save/apply behavior within in-memory state.
Acceptance: a player can design a valid ship entirely from programmatic UI elements and use it in a fleet.

## Step 8 — Economy and construction

Implement lazy resource accumulation.
Add construction queue with completion events.
Allow building ships/modules with resource costs.
Expose clear timers and costs in DOM UI.
Acceptance: resources accumulate with real time, construction finishes without per-second entity ticking, and completed ships enter player inventory.

## Step 9 — Combat presentation

Render battle scene with procedural ships and rooms.
Interpolate server battle frames for smooth visuals.
Add projectiles, beams, impact pulses, shield rings and destroyed-ship effects.
Add battle log / room damage indicators.
Acceptance: combat is understandable visually without textures or authored assets.

## Step 10 — Visibility, sensors and strategic polish

Implement per-player visible-state filtering and sensor ranges.
Only reveal enemy trajectory details according to design rules.
Add movement ETA, engagement range overlays, notifications and command rejection feedback.
Add debug overlays for spatial cells, trajectory bounds and scheduled events.
Acceptance: strategic information is intentionally filtered and developers can visualize why encounters were or were not scheduled.

# 14. Testing Strategy


## 14.1 Pure simulation tests first

| Test area | Important cases |
| Movement | position before/start/mid/end; redirect mid-flight; zero-distance target; speed changes |
| Closest approach | parallel paths; exact crossing; crossing at different times; stationary target; near miss at engagement radius boundary |
| Scheduler | event ordering; stale movement revision ignored; multiple due events in one heartbeat |
| Ship validation | overlap, outside hull, missing bridge, power deficits, rotation |
| Combat determinism | same seed + same inputs = same result; replay N ticks gives expected hash/state |
| Combat damage | weapon room disabled, engine degradation, shield depletion, destruction and retreat |
| Visibility | enemy private fields never appear outside sensor/permission rules |


## 14.2 Integration tests

Start server in-process, connect websocket client, hello, create/move fleet and observe events.
Create two players, send crossing movement plans and assert `battleStarted` occurs near predicted time.
Issue invalid ownership commands and assert rejection without state mutation.
Reconnect to an existing free-text ID and verify current in-memory state is returned.

# 15. Debug and Developer Tools

Simulation-heavy games become much easier to build when internal state can be inspected. Developer tooling is a first-class feature, not a final polish task.
`/debug/state` endpoint in development to inspect sanitized whole-world state.
In-game toggle to draw spatial hash cells and each fleet’s swept trajectory AABB.
Show fleet movement revision, start/end timestamps and computed current server position.
Battle pause/step/speed controls available only in dev mode.
Battle seed display plus “restart with same seed” command.
Event heap inspector listing next scheduled events.
Optional deterministic state hash every battle tick for desync/replay debugging.

# 16. Rules for Keeping the Prototype Evolvable

1. Keep protocol DTOs separate from internal domain objects. Do not send Maps/classes directly over the wire.
2. Keep core movement and combat functions as pure as practical so they can be unit tested and moved to worker threads later.
3. Use IDs for cross-entity references; avoid deeply nested canonical state that is hard to persist.
4. All game-changing actions enter through command handlers, including developer cheats where possible.
5. Use timestamps and scheduled events for long-duration systems instead of per-entity timers.
6. Use a deterministic RNG abstraction in simulation code.
7. Centralize balance values in configuration data rather than scattering constants through rendering and handlers.
8. Never let Pixi display objects become game-state objects. The renderer mirrors domain snapshots/deltas.
9. Build visibility filtering before the world becomes complex.
10. Add profiling counters early: active fleets, indexed trajectories, candidate pairs checked, active battles, battle tick duration and websocket bytes/sec.

# 17. Future Migration Path (Not for the First Build)

| Prototype | Later evolution |
| In-memory Maps | PostgreSQL for durable player/ship/planet data; possibly Redis for hot ephemeral coordination. |
| One Node process | Partition world into regions/shards; route players/fleets to authoritative simulation workers. |
| In-process battle loop | Worker Threads or separate battle workers for CPU isolation. |
| JSON websocket | Compact binary protocol when profiling proves network size is material. |
| Free-text ID | Real accounts, signed sessions, reconnect tokens and authorization. |
| Single event heap | Durable scheduled jobs / partitioned queues when server restarts must preserve timers. |
| Uniform hash grid | Region partitioning, R-tree/BVH or specialized spatiotemporal index if profiling requires it. |


# 18. Suggested First Playable Milestone

The first milestone worth putting in front of testers should stop before the full economy. It needs only enough systems to answer whether moving fleets and automated modular-ship combat are fun.
Free-text player ID.
Procedural map with 10–30 planets.
Each player starts with two configurable ships.
Simple ship builder with bridge, engine, reactor, shield and two weapon types.
Create fleet, click any point in space to move, redirect while moving.
Two players can intentionally cross trajectories and start a battle.
Battle is fully automatic, seeded, visualized with procedural geometry, and damages individual rooms.
Survivors return to the strategic map with their damage preserved in memory.
Do not add research trees, alliances or deep resource chains until this milestone has been played. The movement/encounter/combat loop is the highest-risk and most distinctive part of the game.

# 19. Definition of Done for the Prototype Architecture

No authoritative gameplay state is owned only by the client.
An idle moving fleet costs effectively zero per-frame simulation work on the server.
A new trajectory can discover future encounters against fleets already in motion.
Only active battles run fixed-step combat simulation.
Battle results are deterministic under a known seed and reproducible in tests.
Ships are data-driven grids with programmatically rendered rooms and systems.
The entire visible game can run without external image assets.
The same core movement/combat package is callable from both command handlers and tests.
All player state disappears safely on server restart, matching the current prototype requirement.
The codebase has clear seams for later persistence, authentication and distributed simulation without requiring those systems now.

# 20. Team Ownership Split

| Workstream | Primary responsibilities | Dependencies |
| Server/domain | GameState, command handlers, scheduler, movement, encounter index, battle manager | Protocol + simulation |
| Simulation | Math primitives, ship derived stats, deterministic combat, tests | Config |
| Client/world | Pixi camera, map, planets, fleets, trajectories, procedural effects | Protocol |
| Client/UI | ID entry, inspectors, ship builder DOM, queues, feedback | Protocol + client/world |
| Protocol/config | Schemas, DTOs, validation, balance constants | Shared by all |

For a small team, these are ownership hats rather than separate services. Keep daily integration frequent: movement, protocol and rendering are tightly coupled during early gameplay discovery.

# 21. Implementation Checklist

☐ Workspace boots with one command.
☐ Player ID creates/retrieves in-memory account.
☐ Procedural Pixi map renders with pan/zoom.
☐ Fleet movement uses time-based trajectories.
☐ Arrival event heap works.
☐ Trajectory spatial hash works.
☐ Closest-approach tests pass.
☐ Encounter creates battle.
☐ Battle fixed-step loop is deterministic.
☐ Rooms/modules affect ship capabilities.
☐ Ship builder validates server-side.
☐ Battle damage writes back to strategic ships.
☐ Economy uses lazy timestamps.
☐ Construction uses scheduled events.
☐ Visibility filter prevents full-state leakage.
☐ Debug overlays expose movement/index/battle internals.