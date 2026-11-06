# P0b: movement calibration

## Goal

Measure the movement constants that a **locked bot driven by injected input** actually gets in CS2, the same path
REPLAY puppets use, and compare them with `data/tuning.json` (`movement.*` and the speed thresholds in `replay.*`).

Depends on: P0 (the run line below is checked), and step 1 of P1 (a locked bot moves at all).

## Setup

- `exec cs2probe`, `mp_restartgame 1`.
- **Run line:** Bombsite B, x = −1675, from y = 150 to y = 525, z = −168. This is a 300 × 425 flat area in
  `data/mirage-nav.json`. Before the first run, sweep `Trace.TraceHullShape` along the line (every 16 units). If
  anything is solid, move the line within the area.
- **Spare run line:** T Spawn, x from 1125 to 1375 at y = −240, z = −168 (250 units).
- `probe_spawn calib T -1675 150 -168 90 <weapon>` (yaw 90 = facing +y, along the line), then `probe_lock calib all`.
- `probe_log on p0b-<case>` around every case.

## Steps

1. **Cvars and VData.** In the console: `find accelerate`, `find friction`, `find stopspeed`, `find maxspeed`,
   `find walk`, `find duck`. Copy the output. Then `probe_vdata` for `weapon_knife`, `weapon_ak47`, `weapon_awp`,
   `weapon_ssg08`, `weapon_deagle`, `weapon_m4a1` (M4A4) and `weapon_glock`.
2. **Run, per weapon** (knife, ak47, awp, ssg08, deagle, m4a4): `probe_move calib 1 0 128`, then nothing for
   128 ticks (coast). Re-spawn at the start between repeats. Do 3 repeats.
3. **Walk:** the ak47 run with `WALK` held via `probe_press calib WALK 1 1 128` during the 128 move ticks. Try both
   bits, `1<<16` and `1<<17` (harness option), and record which one slows the bot.
4. **Crouch:** the same with `DUCK` held.
5. **Analog:** `probe_move calib 0.5 0 128` and `probe_move calib 0.25 0 128` (ak47).
6. **Strafe and diagonal:** `probe_move calib 0 1 128`. `side` uses Core's sign (+ = right) and the harness sends
   `leftMove = −side`; facing +y, right is +x, so expect motion toward +x. Then `probe_move calib 1 1 128`.
7. **Footsteps:** during the ak47 run, the walk run and the crouch run, log `player_footstep` and `player_sound`
   (`radius`, `step`) events for the bot.

## Analysis

Speed per tick, `v_n = |(vx, vy)|`, comes from the log.

- **Steady speed** `v_ss` = mean of `v_n` over move ticks 64–128.
- **Acceleration**: Source model `v_{n+1} = min(v_ss, v_n + a · v_ss · dt)`, where dt = 1/64. Fit `a` by least
  squares over the ramp-up ticks (`v_n < 0.95 v_ss`).
- **Friction**: model `v_{n+1} = max(0, v_n − max(v_n, s) · f · dt)`. Fit `f` from the coast ticks with
  `v_n > 2s`, then `s` from the tail. Start from the cvar values.
- **Latency**: ticks from the first `probe_move` tick to the first tick with `v_n > 1`.
- If the fit residual RMS is > 2 units/s, the model is wrong for CS2. Store the measured curve instead (fallback).

## Measurements

| Quantity | Unit | `tuning.json` key |
| --- | --- | --- |
| `v_ss` per weapon | units/s | `movement.runSpeedByWeapon.<w>` |
| fitted `a` (and the `sv_accelerate` cvar) | 1/s | `movement.svAccelerate` |
| fitted `f`, `s` (and the cvars) | 1/s, units/s | `movement.svFriction`, `movement.svStopSpeed` |
| walk `v_ss` / run `v_ss` (ak47) | ratio | `movement.walkFactor` |
| crouch `v_ss` / run `v_ss` (ak47) | ratio | `movement.crouchFactor` |
| (walk `v_ss` + run `v_ss`) / 2 | units/s | `replay.walkSpeedThreshold` |
| (crouch `v_ss` + walk `v_ss`) / 2 | units/s | `replay.crouchSpeedThreshold` |
| footstep `radius` while running; whether walk and crouch emit footsteps | units | `replay.hearingRangeUnits` |
| analog 0.5 and 0.25 `v_ss` / full `v_ss` | ratio | (adapter: does analog scale?) |
| strafe and diagonal `v_ss`, direction | units/s, deg | (adapter: side sign, diagonal clamp) |
| input latency | ticks | (P1, contract finding F8) |
| `DuckAmount` timeline through a crouch | 0..1 per tick | (Observe `crouching` threshold) |
| which bit is WALK | — | adapter button map |

## Pass / fail

- **PASS**: `v_ss` repeats within ±1 % across the 3 runs for every weapon; the model fits with residual RMS
  ≤ 2 units/s; WALK and DUCK each reduce speed; strafe direction matches the side sign (forward/side frame
  correct). The calibration *values* then go to `tuning.json`; they are not pass/fail.
- **FAIL**: the bot doesn't move, or speeds vary > 5 % between repeats.

## Fallback

- **No movement under lock:** go back to P1's fallback (fork or synthesized replay). Meanwhile, calibrate with a human
  client holding W, Shift and Ctrl, logged by `probe_log`. These numbers are still valid for `movement.*`.
- **Model doesn't fit:** store the measured ramp and coast as per-tick tables (propose a new `movement.accelCurve`
  key; this is an interface change for the C1 movement task, so raise it in a PR rather than editing `tuning.ts`
  here).
- **Analog doesn't scale speed:** Core controls speed only with WALK and DUCK. Record this, since `forward` and `side`
  then act as direction only.

## Record

Fill in the P0b section of `results.md` and the tuning-change table.
