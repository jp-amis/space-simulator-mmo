# 001 — Monorepo & Developer Loop

- **Status:** Done
- **Design step:** Step 0 — see [DESIGN.md](../DESIGN.md)
- **Design refs:** §2, §2.1, §19
- **Depends on:** Nothing (foundation plan)

## Goal
Stand up the pnpm workspace and a one-command dev loop so every later plan has a place to live and a way to run. This delivers the skeleton — `apps/server`, `apps/client`, and the three shared packages — plus strict TypeScript, Vitest, a `/health` endpoint and a client connection-status indicator. It matters because the whole loop (movement → encounter → combat) depends on shared contracts and a server/client that boot together; getting the seams right now is what keeps the prototype evolvable (§19).

## Scope
### In scope
- pnpm workspace with `apps/server`, `apps/client`, `packages/protocol`, `packages/simulation`, `packages/config`.
- Strict TypeScript, shared `tsconfig.base.json`, optional ESLint/formatter, Vitest.
- `pnpm dev` runs the Fastify/WebSocket server and the Vite client together.
- Fastify HTTP layer with a `/health` endpoint.
- Client boots (Vite + PixiJS scaffold) and shows a WebSocket connection-status indicator.

### Out of scope
- ID entry / player registry — [002](002_id_entry_and_player_registry.md).
- Pixi map, camera, procedural universe — [003](003_strategic_map_and_procedural_universe.md).
- Any domain state, commands or simulation logic — [004](004_fleet_domain_and_movement.md) and later.
- Persistence, auth, scaling, binary protocol (deferred by design, §17).

## Tasks
- [ ] Create pnpm workspace: `pnpm-workspace.yaml`, root `package.json`, `tsconfig.base.json`.
- [ ] Scaffold `apps/server` (`@space/server`): Node.js + Fastify + `ws`.
- [ ] Scaffold `apps/client` (`@space/client`): Vite + TypeScript + PixiJS.
- [ ] Scaffold `packages/protocol` (`@space/protocol`): network DTOs / schemas / message IDs (empty scaffold, Zod dep wired).
- [ ] Scaffold `packages/simulation` (`@space/simulation`): pure logic package (empty scaffold).
- [ ] Scaffold `packages/config` (`@space/config`): game constants / balancing data (empty scaffold).
- [ ] Configure strict TypeScript across all packages via shared base config.
- [ ] Configure Vitest for TS unit/integration tests.
- [ ] Add optional ESLint/formatter.
- [ ] Add `pnpm dev` script running server + Vite client concurrently.
- [ ] Add Fastify `/health` endpoint.
- [ ] Add client WebSocket connection-status indicator (DOM).

## Key types & signatures
```
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
```

Recommended stack (DESIGN §2): TypeScript end-to-end · Node.js · Fastify (HTTP) · WebSocket (`ws`) · Vite + TypeScript (client build) · PixiJS (rendering) · Zod (validation) · Vitest (tests) · pnpm workspaces (monorepo). Do **not** introduce ECS frameworks, Kafka, Redis, PostgreSQL, Kubernetes or microservices.

## Acceptance criteria
> Acceptance: one command starts both processes; browser connects to the development server.

- [ ] `pnpm dev` starts both server and client processes.
- [ ] Browser loads the client and connects to the dev server (WebSocket).
- [ ] `/health` responds.
- [ ] Connection-status indicator reflects connect/disconnect.

## Testing
No domain logic yet, so no §14.1 simulation cases apply. Verify the harness itself:
- Vitest runs green on an empty/placeholder test in each package (proves shared tsconfig + test runner wiring).
- Establishes the §14.2 integration seam: start server in-process, open a WebSocket, confirm it connects — the base later plans build `hello`/command/event tests on.

## Unresolved questions
- ESLint/formatter: include now or defer? (design says "if desired")
- Toolchain pin: `.mise.toml` per overview — confirm mise vs corepack for pnpm.
