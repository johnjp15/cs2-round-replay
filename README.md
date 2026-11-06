# cs2-round-replay

A browser-based 2D top-down replay of one Counter-Strike 2 round on Mirage, in which a human plays one player and the other nine are bots following their recorded paths. The decision logic (Core) is engine-agnostic and written in portable TypeScript so it can later be ported to C# and driven by CS2 itself.

## Layout

| Path | What lives there |
| --- | --- |
| `src/contracts/` | Shared types, seeded PRNG (`rng.ts`), tuning loader (`tuning.ts`). Imports nothing else from `src/`. |
| `src/core/` | Engine-agnostic replay brain (ICore). May import only `src/contracts`. No `Date` / `Math.random`. |
| `src/sim2d/` | 2D top-down engine/host (IHost). May import only `src/contracts`. |
| `src/app/` | Browser shell (`main.ts`): wires everything together. May import anything. |
| `index.html` | Page entry for Vite. |
| `data/` | Round data and `tuning.json` (all tunable numbers). |
| `tests/` | Vitest tests. |
| `tools/` | Node scripts (extraction, log tools). |
| `docs/` | Project rules and specs. |
| `logs/` | Local session logs (gitignored). |

Import boundaries and the no-`Date`/no-`Math.random` rule are enforced by ESLint (`eslint.config.js`).

## Run

Requires Node 22.

```sh
npm i            # install (CI uses npm ci)
npm run dev      # dev server at http://localhost:5173
npm test         # Vitest
npm run lint     # ESLint, incl. import boundaries
npm run typecheck
npm run build    # static build to dist/ (npm run preview to serve it)
```

## Docs

Read [`docs/conventions.md`](docs/conventions.md) (stack, units, time, determinism, definition of done) and [`docs/contracts.md`](docs/contracts.md) (the Core ↔ engine interface) before starting a task. [`docs/round-data.md`](docs/round-data.md) describes `data/round.json` and how to regenerate it. [`docs/core.md`](docs/core.md) describes the Core: round model, clock, start state, event schedule and `ReplayCore`. [`docs/nav.md`](docs/nav.md) covers the nav mesh and [`docs/movement.md`](docs/movement.md) the 2D movement model and `Sim2DHost`.
