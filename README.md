# cs2-round-replay

A browser-based 2D top-down replay of one Counter-Strike 2 round on Mirage, in which a human plays one player and the other nine are bots following their recorded paths. The decision logic (Core) is engine-agnostic and written in portable TypeScript so it can later be ported to C# and driven by CS2 itself.

## Run it

Requires Node 22.

```sh
npm ci
npm run dev        # then open http://localhost:5173
```

You play cart: WASD moves relative to the screen (W = up on the map), the mouse aims, click fires,
Shift walks, Ctrl or C crouches, R reloads, E uses, and 1–5 switch weapons. Press **Start**; the bar
under the map has Pause, Restart, speed 0.25–4×, Spectate (no human) and the log/trace downloads.
On a phone it starts in spectate mode. To serve the static build, run `npm run build && npm run preview`
(http://localhost:4173). To try it on a phone on the same network, run `npm run dev -- --host` and open
the Network URL it prints. Details: [`docs/app.md`](docs/app.md).

## Layout

| Path | What lives there |
| --- | --- |
| `src/contracts/` | Shared types, seeded PRNG (`rng.ts`), tuning loader (`tuning.ts`). Imports nothing else from `src/`. |
| `src/core/` | Engine-agnostic replay brain (ICore). May import only `src/contracts`. No `Date` / `Math.random`. |
| `src/sim2d/` | 2D top-down engine/host (IHost). May import only `src/contracts`. |
| `src/app/` | Browser app: `Session` driver, 64 Hz loop, input mapping, debug renderer; `main.ts` is the page entry. May import anything. |
| `index.html` | Page entry for Vite. |
| `data/` | Round data and `tuning.json` (all tunable numbers). |
| `tests/` | Vitest tests. |
| `tools/` | Node scripts (extraction, log tools). |
| `docs/` | Project rules and specs. |
| `logs/` | Local session logs (gitignored). |

Import boundaries and the no-`Date`/no-`Math.random` rule are enforced by ESLint (`eslint.config.js`).

## Commands

```sh
npm i                  # install (CI uses npm ci)
npm run dev            # dev server at http://localhost:5173
npm test               # Vitest
npm run lint           # ESLint, incl. import boundaries
npm run typecheck
npm run build          # static build to dist/ (npm run preview to serve it)
npm run bench:session  # cost of one Session.step() over a full round (docs/app.md)
npm run check:browser  # after build: headless Chromium screenshots, fps and ticks/s (docs/app.md)
npm run ghost          # whole round with no human: logs/ghost-round.jsonl + logs/ghost-trace.json, prints the tracking table
```

## Docs

Read [`docs/conventions.md`](docs/conventions.md) (stack, units, time, determinism, definition of done) and [`docs/contracts.md`](docs/contracts.md) (the Core ↔ engine interface) before starting a task. [`docs/round-data.md`](docs/round-data.md) describes `data/round.json` and how to regenerate it. [`docs/core.md`](docs/core.md) describes the Core: round model, clock, start state, event schedule and `ReplayCore`. [`docs/nav.md`](docs/nav.md) covers the nav mesh and [`docs/movement.md`](docs/movement.md) the 2D movement model and `Sim2DHost`, and [`docs/combat.md`](docs/combat.md) its weapons, damage, grenades and sounds. [`docs/app.md`](docs/app.md) covers the browser app: `Session`, the game loop, controls and performance.
