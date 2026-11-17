# Demo coach

The plan is [`docs/coach-plan.md`](../coach-plan.md); the data contracts are in [`contracts.md`](contracts.md).
K0 built the foundation: the contracts, the native Node parser adapter, ingest (rounds, sides, scores, economy,
scoreboard reconciliation), the CLI and the page skeleton. K2 added the analysis framework, the combat tables and
the aim and movement detectors: [`mechanics.md`](mechanics.md).

## Layout

| Path | What |
| --- | --- |
| `src/coach/model/` | `raw.ts` (`RawDemo`), `items.ts` (canonical item names), `raw-codec.ts` (binary container), `match.ts` (`Match`), `report.ts` (`Finding`, `MatchReport`) |
| `src/coach/ingest/` | `ingestMatch` (RawDemo → Match), `rounds.ts` (segmentation), `access.ts` (accessors), `validate.ts` (reconciliation) |
| `src/coach/tuning.ts`, `data/coach/tuning.json` | ingest's and the replay's thresholds |
| `src/coach/analyze/`, `metrics/`, `detect/`, `derive/<area>/`, `report/format.ts`, `data/coach/tuning/<area>.json` | the analysis (Contract 3) and per-area tunables ([`mechanics.md`](mechanics.md), [`utility.md`](utility.md)) |
| `src/coach/derive/sight/`, `data/coach/tuning/sight.json` | line of sight between players, duels, crosshair placement, time to damage, habits, death context ([`sight.md`](sight.md)) |
| `src/coach/report/replay.ts` | replay tracks for the 2D viewer |
| `src/coach-parser/`, `crates/coach-parser/` | the browser parser: demoparser2's Rust core as WebAssembly in a worker ([`parser.md`](parser.md)) |
| `src/coach-app/`, `coach/index.html`, `vite.coach.config.ts` | the page (Preact), built to `dist-coach/`: pipeline worker, library, player picker, match page, 2D replay ([`app.md`](app.md)) |
| `tools/coach/` | `coach.ts` (CLI), `parse-node.ts` (native adapter), `fetch-test-demo.ts`, `make-fixture.ts` |
| `tests/coach/` | unit tests (`synth.ts` builds synthetic RawDemos), the fixture test, the full-demo test |
| `local/demos/`, `local/coach-cache/` | demos and parsed caches (gitignored; never commit a demo) |

Import rules (ESLint): `src/coach` may import only `src/contracts`, `src/engine`, `src/sim2d` and itself, and uses no
`Date`, `performance` or `Math.random`; `src/coach-parser` (K1) may import only `src/coach/model`; `src/coach-app`
may import anything.

## CLI

```sh
npm run coach:fetch-test-demo                       # local/demos/test_demo.dem (pinned URL, SHA-256 checked)
npm run coach -- parse local/demos/test_demo.dem    # native parse → local/coach-cache/<sha256>.craw; prints time and peak RSS
npm run coach -- inspect local/demos/test_demo.dem  # header, rounds (sides, winner, reason, economy), scoreboard, reconciliation
npm run coach -- inspect tests/coach/fixtures/test-demo-r4.craw.gz   # a .craw / .craw.gz directly
npm run coach -- report local/demos/test_demo.dem --user A1          # top fixes, evidence, lobby table; JSON in local/coach-reports/
```

`inspect` uses the cache when it exists (`--fresh` parses again) and exits 1 when the scoreboard does not reconcile.
Demos may be `.dem`, `.dem.bz2`, `.dem.zst` or `.dem.gz`. The output prints player names: it is for your terminal,
not for commits.

## Page

```sh
npm run dev:coach       # dev server; open the printed URL
npm run build:coach     # dist-coach/
npm run preview:coach
```

The page takes a `.craw` / `.craw.gz` today (and demos once K1's parser is in the build), analyzes it in a worker,
keeps the result in a local library and replays every round in 2D. See [`app.md`](app.md).

## Tests

`npm test` runs `tests/coach/` with the rest. The fixture `tests/coach/fixtures/test-demo-r4.craw.gz` (0.7 MB) is the
public test demo with every event, the full tick grid of round 4 and only the rows ingest reads from the other rounds,
players renamed `T1`…`T5` / `CT1`…`CT5` by starting side and given fake Steam IDs. Rebuild it with
`npx tsx tools/coach/make-fixture.ts` after a contract change. `tests/coach/full-demo.test.ts` parses the whole test
demo when `local/demos/test_demo.dem` exists and skips otherwise (CI).
