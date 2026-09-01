# space-simulator-mmo

Web-first **space strategy MMO** prototype. Free-moving space fleets with
Travian/Subterfuge-style strategic pacing and automatic FTL-like modular-ship
combat. Authoritative Node.js server, in-memory state, zero art assets — all
visuals are procedural.

> Prototype constraints: no auth (free-text player ID), no persistence
> (in-memory, resets on restart), no image assets. See [docs/plans/000_overview.md](docs/plans/000_overview.md).

## Monorepo layout

```
apps/
  server/     @space/server    Fastify + WebSocket + authoritative runtime
  client/     @space/client     Vite + PixiJS + DOM UI
packages/
  protocol/   @space/protocol   Network DTOs, Zod schemas, message IDs
  simulation/ @space/simulation Pure movement/combat/domain math
  config/     @space/config     Game constants & balancing data
tools/        @space/tools      Dev scripts, seed/debug commands
docs/                           Design doc + numbered implementation plans
```

## Getting started

Toolchain (Node + pnpm) is pinned in [`.mise.toml`](.mise.toml).

```bash
mise install       # install Node + pnpm at the pinned versions
mise run install   # pnpm install  (or: pnpm install)
mise run dev        # run server + client together (or: pnpm dev)
```

Server: http://localhost:8080/health · Client: http://localhost:5173

### Common tasks

| Command | Does |
| --- | --- |
| `pnpm dev` | Run `@space/server` + `@space/client` in parallel |
| `pnpm build` | Build every workspace |
| `pnpm test` | Run Vitest across the repo |
| `pnpm typecheck` | Type-check every workspace |
| `pnpm lint` | Lint |
| `mise run kill` | Kill the running server (:8080) and client (:5173) |

## Docs

- **How to play** — in the app: click **📖 How to play** on the ID screen or **📖 Guide** in the top bar. Source: [`apps/client/src/guide.ts`](apps/client/src/guide.ts) (tutorial screenshots in `apps/client/public/guide/`)
- [docs/DESIGN.md](docs/DESIGN.md) — full design doc (source of truth)
- [docs/README.md](docs/README.md) — plan tracker with live status
- [docs/plans/](docs/plans/) — numbered implementation plans (map 1:1 to DESIGN §13 steps)

## License

Private / unlicensed (prototype).
