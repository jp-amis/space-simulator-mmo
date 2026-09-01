# 000 — Prototype Overview & Architecture

- **Status:** Reference (living document)
- **Design refs:** [DESIGN.md](../DESIGN.md) §1–§3, §16, §18, §19

## Purpose

Anchor document for the prototype. It fixes scope, the tech stack, the
architectural rules every plan must respect, and the definition of done. Each
numbered plan in this folder implements one step of [DESIGN.md §13](../DESIGN.md)
and links back here.

## Prototype constraints (non-negotiable for the first build)

| Area | Decision |
| --- | --- |
| Accounts | No auth. Free-text player ID is the account key. |
| Persistence | None. In-memory state; resets on restart. |
| Art | No image assets. All visuals procedural (Pixi primitives, particles, noise). |
| Simulation | Authoritative server. Event-driven universe; fixed-step battles only. |
| Goal | Prove the movement → encounter → automatic modular-ship combat loop is fun. |

## The one loop we are proving

Enter ID → see procedural system → own a planet → build modular ships → form a
fleet → move continuously in 2D → trajectories create encounters → hostile
fleets drop into an automatic FTL-style battle → results write back to the
strategic state.

## Tech stack

TypeScript end-to-end · Node.js · Fastify · WebSocket (`ws`) · Vite · PixiJS ·
Zod · Vitest · pnpm workspaces. Toolchain pinned via `.mise.toml`.

Explicitly **not** now: ECS frameworks, Kafka, Redis, PostgreSQL, Kubernetes,
microservices. The seams for them are preserved, but adding them now slows down
validating the game.

## Repository layout

```
apps/
  server/        # Fastify + WebSocket + authoritative runtime
  client/        # Vite + PixiJS + DOM UI
packages/
  protocol/      # Network DTOs, Zod schemas, message IDs
  simulation/    # Pure movement/combat/domain math
  config/        # Game constants & balancing data
tools/           # Dev scripts, seed/debug commands
```

## Architectural rules (enforced across all plans)

1. Server is the single source of truth; client sends intentions only.
2. Protocol DTOs stay separate from internal domain objects.
3. Domain state is plain serializable objects in `Map`s, referenced by ID.
4. Core movement/combat is pure and unit-testable (worker-thread-ready later).
5. Long-duration systems use timestamps + scheduled events, not per-entity timers.
6. Deterministic seeded RNG in all simulation code — never `Math.random()`.
7. Balance values live in `@space/config`.
8. Pixi display objects never become game state; the renderer mirrors snapshots.
9. Visibility filtering (`getVisibleState(playerId)`) exists before the world grows.
10. Profiling counters added early.

Full list: [DESIGN.md §16](../DESIGN.md).

## Definition of done

See [DESIGN.md §19](../DESIGN.md). Summary: no client-owned authoritative state;
idle fleets cost ~0 server work; new trajectories discover future encounters;
only active battles tick; battles are deterministic per seed; ships are
data-driven procedurally-rendered grids; runs with zero image assets; the same
sim package is callable from handlers and tests; state resets safely on restart;
clean seams for persistence/auth/scale.

## Plan index

See [docs/README.md](../README.md) for live status. Plans 001–011 map 1:1 to
DESIGN.md Steps 0–10.
