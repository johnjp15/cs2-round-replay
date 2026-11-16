# cs2-round-replay

A browser-based 2D top-down replay of one Counter-Strike 2 round on Mirage, in which a human plays one player and the other nine are bots following their recorded paths. The decision logic (Core) is engine-agnostic and written in portable TypeScript so it can later be ported to C# and driven by CS2 itself.

## Run it

Requires Node 22.

```sh
npm ci
npm run dev        # then open http://localhost:5173
```

Press **Start** and the round plays exactly as recorded. **Take control of cart** (or E) at any moment and you
play him from there: WASD moves relative to the screen (W = up on the map), the mouse aims, click fires,
Shift walks, Ctrl or C crouches, Space jumps, R reloads, E uses, and 1–5 switch weapons; Restart (or a rewind to
before it) is watching again. Cart never fires by himself once you play him, but his recorded duels resolve like the
tape when you shoot in them: fire at Lokier from the Apartments window and he dies on the tape's 18.80 s, while
anywhere else your bullets are real ([`docs/core.md`](docs/core.md) "Recorded duels of the human"). The bar under the map has Pause, Restart, speed 0.25–4×, the view toggles, Take
control of cart and the log/trace downloads (`?human=cart` plays him from the start).
F follows cart, G shows his recorded position (the ghost), T everyone's recorded path, Tab the status
panel; the wheel zooms, dragging pans and a double-click shows the whole map.
**Scenarios** (H3, [`docs/scenarios.md`](docs/scenarios.md)): `?scenario=mirage-5v5` or `?scenario=dust2-5v5` in the 3D page (`npm run dev:3d`; the bar's Scenario and Map pickers) is free play, every bot live on CS2's nav, on Mirage or CS2's Dust II (map packages built from awpy-data by `tools/build-map.ts`, [`docs/maps.md`](docs/maps.md)); `npm run harness3d -- --game <name>` plays one headless.
On a phone you watch (there are no touch controls for playing). To serve the static build, run `npm run build && npm run preview`
(http://localhost:4173). To try it on a phone on the same network, run `npm run dev -- --host` and open
the Network URL it prints. Details: [`docs/app.md`](docs/app.md).

## The 3D sim (H1)

A second app, the same round in first person on CS2's own Mirage geometry: `npm run dev:3d`, `npm run build:3d`,
`npm run build:single:3d` (the page for `johnjp15.github.io/cs2/sim3d/`), `npm run harness3d` (the round headless in
the 3D engine), `npm run check:browser:3d`. It starts watching (third person, a player's eyes, or a free camera; V,
Z / X); E takes control of cart: mouse look with CS2's sensitivity and FOV, WASD, Space, Ctrl, Shift, mouse 1 / 2,
R, 1–5, E. Engine: [`docs/sim3d.md`](docs/sim3d.md); app: [`docs/app3d.md`](docs/app3d.md); plan:
[`docs/sim3d-plan.md`](docs/sim3d-plan.md).

## Layout

| Path | What lives there |
| --- | --- |
| `src/contracts/` | Shared types, seeded PRNG (`rng.ts`), tuning loader (`tuning.ts`). Imports nothing else from `src/`. |
| `src/core/` | Engine-agnostic replay brain (ICore). May import only `src/contracts`. No `Date` / `Math.random`. |
| `src/sim2d/` | 2D top-down engine/host (IHost). May import only `src/contracts`. |
| `src/engine/` | H1+: pure CS2 mechanics any host can use (hitboxes; H2: weapons). May import only `src/contracts`. |
| `src/sim3d/` | H1: the 3D engine/host (Sim3DHost: 3D hitscan, hitboxes, mesh sight). May import `src/contracts`, `src/engine`, `src/sim2d`. |
| `src/app3d/`, `sim3d/index.html` | H1: the 3D page (Three.js view, first-person controls, HUD). May import anything. |
| `src/app/` | Browser app: `Session` driver, 64 Hz loop, input mapping, canvas renderer, HUD and camera; `main.ts` is the page entry. May import anything. |
| `index.html` | Page entry for Vite. |
| `data/` | Round data and `tuning.json` (all tunable numbers). |
| `tests/` | Vitest tests. |
| `tools/` | Node scripts (extraction, log tools, the headless harness). |
| `fixtures/` | Golden fixtures for the C# port (`golden/`: logged rounds, walk oracles, `manifest.json`) and human input scripts (`scripts/`). |
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
npm run build:single   # one self-contained page, dist-single/index.html, for johnjp15.github.io/cs2/sim/ (docs/deploy.md)
tools/pages/deploy.sh ~/path/to/johnjp15.github.io   # lock both sim pages into a Pages checkout (needs CS2_PASSWORD; CI's deploy job does this on main)
npm run check:locked -- --web-apps ~/path/to/web-apps   # the whole locked cs2 site end to end with a throwaway password, in a temp copy
npm run bench:session  # cost of one Session.step() over a full round (docs/app.md)
npm run check:browser  # after build: headless Chromium screenshots, fps and ticks/s (docs/app.md)
npm run ghost          # whole round with no human: logs/ghost-round.jsonl + logs/ghost-trace.json, prints the tracking table
npm run scripted       # the same round with B3's checks: logs/scripted-round.jsonl + logs/scripted-trace.json, prints kills, HP, shot ticks, latency
npm run harness -- --human cart --script fixtures/scripts/cart-idle.json --until 20 --out logs/idle
                       # headless harness (the app's Session in Node): log.jsonl, trace.json, summary.json (docs/golden.md)
npm run harness -- --takeover 18.6   # watch the round, take control of cart at 18.6 s (G4; he then stands still)
npm run fixtures:update  # regenerate the golden fixtures for the C# port after an intended behaviour change (docs/golden.md)
npm run extract:vismask  # rebuild data/mirage-vismask.json (the sight mask: walls and cover) from the radar; logs/vismask-debug*.png
npm run vision         # the labelled vision set against the sight mask (docs/vision.md); logs/vision-labels.png
```

## Docs

Read [`docs/conventions.md`](docs/conventions.md) (stack, units, time, determinism, definition of done) and [`docs/contracts.md`](docs/contracts.md) (the Core ↔ engine interface) before starting a task. [`docs/round-data.md`](docs/round-data.md) describes `data/round.json` and how to regenerate it. [`docs/core.md`](docs/core.md) describes the Core: round model, clock, start state, event schedule and `ReplayCore`. [`docs/nav.md`](docs/nav.md) covers the nav mesh and [`docs/movement.md`](docs/movement.md) the 2D movement model and `Sim2DHost`, and [`docs/combat.md`](docs/combat.md) its weapons, damage, grenades, sounds, bomb, round rules and pawn collision; [`docs/vision.md`](docs/vision.md) covers sight (the radar mask, `sees`) and [`docs/ai.md`](docs/ai.md) the LIVE AI. [`docs/app.md`](docs/app.md) covers the browser app: `Session`, the game loop, controls and performance. [`docs/deploy.md`](docs/deploy.md) covers publishing it on the password-locked johnjp15.github.io/cs2/sim/. [`docs/golden.md`](docs/golden.md) covers the headless harness, the golden master, the port fixtures and the replay contract for the C# port.
