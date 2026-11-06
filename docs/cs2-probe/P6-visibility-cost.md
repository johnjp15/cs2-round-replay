# P6: visibility traces: cost and correctness

## Goal

Computing `sees` with eye-to-eye traces for 10 bots × 5 enemies on every tick costs little server frame time. Also
check that our traces agree with native bot perception, including through smoke. Movement-doc item 6.

Depends on: S0. The FOV fit (step 5) uses the P2 route if available.

## Setup

- `exec cs2probe`, `mp_restartgame 1`.
- Ten bots at the recorded positions at t = 12 s (a realistic mix of sight lines). incredibad is dead by then, so
  use his start position:
  ```sh
  jq -r '.tracks | to_entries[] | .key as $id | .value.samples[] | select(.t == 12) | [$id,.x,.y,.z] | @csv' data/round.json
  # barely −788 617 −81, cart −672 589 −81, donk −435 611 −80, eradicate −1123 657 −80, lokier −2387 815 −127,
  # snakelore 133 −1710 −169, snarlbot 273 −1517 −176, sp4rtan −505 −1460 −81, zwomp −1180 −500 −168; incredibad 905 −1290 −109
  ```
  `probe_spawn` each on its team. Lock all for steps 1–4 (static); unlock all for step 5.
- **Trace definition** (`probe_sees`), for each ordered pair (a, b) with b an enemy of a:
  - eye(p) = `AbsOrigin + ViewOffset`;
  - `Trace.TraceEndShape(eye(a), eye(b), ignore = a, options: InteractsWith = Masks.Shot)`. Visible if
    `!DidHit()` or `HitEntity()` is b's pawn;
  - then the FOV test: angle between a's eye forward and `eye(b) − eye(a)` ≤ `ai.fovDeg / 2`;
  - then the smoke test: the segment misses every active smoke sphere. Centre from `smokegrenade_detonate`, removed
    on `smokegrenade_expired`. Radius 144 units is the CS:GO value and a hypothesis here.
- **Timing:** a `Stopwatch` around the whole `probe_sees` block per tick (µs). The wall-clock interval between
  consecutive `OnTick` calls detects tick overruns. `pidstat -p $(pgrep -f linuxsteamrt64/cs2) 1` gives process CPU.
  Engine `stats`/`perf` output is optional, if the commands exist.

## Steps

1. **Baseline:** 120 s with `probe_sees off`. Record the tick-interval p50/p99/max and CPU %.
2. **Required load:** 120 s, 10 × 5 = 50 traces per tick (`probe_sees on enemies 1`).
3. **All pairs:** 120 s, 90 traces per tick (`probe_sees on all 1`).
4. **Multi-ray:** 120 s, 4 rays per pair (head, chest, pelvis, feet: eye, origin + 48, + 32, + 8): 200 traces per
   tick.
5. **Agreement:** unlock all bots (native AI on), 120 s of normal play with `probe_sees on enemies 1`. Every tick,
   compare trace `sees` (a, b) with native `a.Bot.IsEnemyVisible && a.Bot.Enemy == b`. Sweep `fovDeg` over 90, 106,
   120 and 180 offline and keep the one with the best agreement.
6. **Smoke:** place two locked bots 600 units apart with a clear line, then make a third bot throw a smoke between
   them (or spawn one on that line). Log trace `sees` with and without the smoke-sphere test, plus native
   `IsEnemyVisible` on an unlocked copy of the pair. Log `smokegrenade_detonate` → `smokegrenade_expired` ticks.
7. **Molotov:** one bot throws a molotov. Log `inferno_startburn` → `inferno_expire` ticks.

## Measurements

| Quantity | Unit | `tuning.json` key |
| --- | --- | --- |
| trace block time per tick: p50, p99, max (steps 2–4) | µs | — |
| tick interval p99 and max: baseline vs load | ms | — |
| CPU %: baseline vs load | % | — |
| agreement (trace vs native) outside smoke | % of pair-ticks | — |
| best-agreement FOV | deg | `ai.fovDeg` |
| raw trace sees through smoke (yes/no), with the sphere test (yes/no), native (yes/no) | — | — |
| smoke lifetime | s | `grenades.smokeSec` |
| molotov burn time | s | `grenades.molotovSec` |

## Pass / fail

- **PASS** needs all three:
  - step 2: p99 trace block ≤ 1.0 ms per tick (6.4 % of the 15.625 ms tick), with no rise in tick-interval p99 above
    baseline + 1 ms;
  - step 4: p99 ≤ 2.0 ms;
  - step 5: agreement ≥ 95 % outside smoke.
- **Report:** whether raw traces see through smoke. A "yes" confirms we need the sphere test, which is a contract
  note (finding F5).
- **FAIL**: p99 > 2 ms at 50 traces, or agreement < 85 %.

## Fallback

- **Too slow:** cull before tracing (distance > 4000, or behind both players' FOV), and trace each pair every 4th
  tick round-robin (16 Hz) with hysteresis on `sees`.
- **Agreement low:** use native perception for LIVE bots and traces only for REPLAY bots, and investigate eye height
  and mask.
- **Smoke spheres disagree with native:** fit the radius from step 6, or use native perception only.

## Record

Fill in the P6 section of `results.md` and the tuning-change table.
