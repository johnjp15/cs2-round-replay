# 3D app frame-time benchmarks (P1)

`npm run build:3d && npm run bench:3d` (tools/bench-app3d.ts, Playwright on port 4182). It loads one page per scenario
(src/app3d/bench3d.ts, `?bench=<name>`). `--dir <build>` benches another build: the "before" column is the build of
6728352, which already has #32's round-end fix. All times are main-thread ms per frame, p50 unless stated otherwise.

**Sandbox caveat.** These numbers come from headless Chromium with **software WebGL** (lavapipe) on **2 shared
cores**, with a machine load of 12–20 (other agents' test suites) during every run.

- The p95 and p99 tails, and the scenarios timed by the wall clock (`watch-*-raf/-uncapped/-loop`, `fp-1x-uncapped`),
  mostly measure that contention. When the software GPU runs at 2–4 fps, each wall-clock frame owes 16–30 sim ticks,
  so its "sim" phase is many ticks rather than one.
- The **synthetic-clock** scenarios (`*-120hz`, `watch-1x-480hz`) are the ones to compare. The page's clock advances
  by 1/120 s or 1/480 s per frame however long the frame takes, so every frame does the same work as on a real
  120 Hz or 480 Hz display.

## Round end (PR #32)

5 s of round time at a synthetic 120 Hz, watching:

| scenario | frame p50 | mean | HUD p50 | heap / frame |
| --- | ---: | ---: | ---: | ---: |
| in the round (before the fix) | 1.40 | 2.2 | 0.10 | 120 KB |
| after `round_end`, before the fix | **82.2** | **88.9** | **78.5** | **9.1 MB** |
| after `round_end`, after the fix | 1.45 | 4.8 | 0.15 | 139 KB |

Files: `2026-11-07-roundend-{before,after}.json`.

## P1 performance work: before (6728352) → after

| scenario | frame p50 | input | sim | scene | render | HUD | draw calls | heap KB/frame |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| inround-5s-120hz, before | 1.375 | 0.005 | 0.395 | 0.025 | 0.640 | 0.145 | 40 | 101 |
| inround-5s-120hz, after | 1.495 | 0.010 | 0.515 | 0.030 | **0.555** | 0.160 | **14** | 97 |
| postend-5s-120hz, before | 1.930 | 0.005 | 0.350 | 0.040 | 0.880 | 0.175 | 32 | 143 |
| postend-5s-120hz, after | 1.915 | 0.015 | 0.480 | 0.045 | **0.680** | 0.205 | **6** | 124 |
| watch-1x-480hz, after | **0.765** (1307 fps-eq) | 0.005 | 0.005 | 0.030 | 0.595 | **0.065** | 15 | 63 |
| watch-1x-raf (vsync loop), before | 23.0 | 0.015 | 16.3 | 0.035 | 1.720 | 0.335 | 63 | 1500 |
| watch-1x-raf (vsync loop), after | 25.4 | 0.015 | 16.3 | 0.040 | **1.065** | 0.430 | **14** | 1519 |

- The world is 2 draw calls instead of ~40 (the tiles joined), so the render CPU is down 15–40 %.
- The "sim" differences of ±0.12 ms are noise: the sim is unchanged, and so are the run digests.
- At 480 Hz the HUD costs 0.065 ms a frame. It is updated once per tick, not 7.5 times.
- The sim per tick is 0.7 ms p50 here, under load. A headless Node profile of the whole round puts ~40 % of a tick in
  serializing the session log and the observe (`stableStringify` / `canonicalize`, src/contracts/json.ts), ~18 % in
  movement (`moveAll`), ~13 % in building the observe (sight), and ~20 % in the replay core.

## What to expect on an M-series Mac

Single-thread speed is roughly 3–5× this loaded sandbox core. So expect:

- about **0.2–0.4 ms** of main-thread time per frame when the frame runs no tick, and about **0.4–0.6 ms** when it
  runs one. That is a meter reading of roughly 2000–4000 fps-equivalent.
- about **0.15–0.25 ms** per sim tick.

With **Uncapped**, the loop will run thousands of frames a second. A 120 Hz ProMotion display shows 120 of them,
each drawn from the newest mouse input. Run `…/sim3d/?bench=1` in Chrome and in Safari on the Mac for the real
numbers, and commit them here next to these.
