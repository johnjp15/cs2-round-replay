# P1: a locked bot follows a 10 Hz track

## Goal

A bot under Bot-Controller's All lock moves with injected forward/side only (real key presses, no teleports) and
holds a recorded 10 Hz track to within ~24 units over 10 s. Movement-doc item 1.

Depends on: P0. Step 6 uses the view route from P2 if it is ready; skip that step otherwise.

## Setup

- `exec cs2probe`, `mp_restartgame 1`.
- Export the tracks on the workstation and upload them to `addons/counterstrikesharp/data/cs2probe/`:
  ```sh
  jq -r '.tracks.eradicate.samples[] | select(.t <= 10) | [.tick,.t,.x,.y,.z] | @csv' data/round.json > eradicate-0-10.csv   # 101 rows, observed, flat, 631 units, peak 220 u/s
  jq -r '.tracks.eradicate.yaw[] | select(.t <= 10) | [.tick,.t,.deg] | @csv' data/round.json > eradicate-yaw-0-10.csv     # 201 rows, 20 Hz
  jq -r '.tracks.snarlbot.samples[] | select(.t <= 10) | [.tick,.t,.x,.y,.z] | @csv' data/round.json > snarlbot-0-10.csv     # ramp, z −264 → −176
  ```
- `probe_spawn eradicate T -731 567 -82 167.2 weapon_ak47`, then `probe_lock eradicate all`.
- `probe_spawn snarlbot T 800 -1120 -264 <yaw toward the second sample> weapon_ak47`, then `probe_lock snarlbot all`.

## REPLAY follower (what `probe_track` does each tick n, t = n / 64)

1. `target = lerp(track, t + lookahead)` and `now = lerp(track, t)`, both 2D.
2. `d = target − pos`. If |d| < 2: forward = side = 0. Otherwise, in the movement frame (the yaw the usercmd uses;
   without P2 this is the bot's fixed spawn yaw) `f = d·ĥ`, `s = d·r̂`, scaled so that `max(|f|, |s|) = min(1, |d| / 8)`.
3. Hold `WALK` when the track speed `|track(t + 0.1) − track(t)| / 0.1` is below `replay.walkSpeedThreshold` (120).
4. **Nudge** (only when `nudgeOn`): if `e = |now − pos| > driftNudgeUnits`, add a velocity of magnitude
   `min(4 · e, 120)` units/s toward `now`, using `pawn.Teleport(null, null, v + Δv)`. Count the ticks this happens.
5. **Snap**: if `e > driftSnapUnits`, `pawn.Teleport(now, null, null)`. No human is present, so the "unseen" rule
   always passes here. Count the snaps.
6. `UpdateUsercmdMovement(slot, token, f, −s)`.

## Steps

1. **Smoke test:** `probe_move eradicate 1 0 64`. The bot must move more than 100 units. Record the latency (ticks
   from the first move tick to the first tick with speed > 1).
2. **Pure input:** `probe_track eradicate eradicate-0-10.csv 0.15 24 96 0`, with nudges off (snaps still count but
   should not happen). Repeat 3 times.
3. **With nudges:** `probe_track eradicate eradicate-0-10.csv 0.15 24 96 1`, 3 times.
4. **Lookahead sweep** (nudges on): 0.10, 0.20, 0.25.
5. **Ramp:** `probe_track snarlbot snarlbot-0-10.csv 0.15 24 96 1`, 3 times.
6. **Turning view** (only if P2 has a route): as step 3, but each tick also set the view yaw from
   `eradicate-yaw-0-10.csv` and compute f/s in that rotating frame. Repeat 3 times.

## Measurements

| Quantity | Unit | `tuning.json` key |
| --- | --- | --- |
| e(t) = 2D \|pos(t) − track(t)\|: mean, p95, max per run | units | `replay.driftNudgeUnits` (p95 of pure input) |
| \|z error\| max (snarlbot ramp) | units | — |
| nudge ticks, snap count per run | count | `replay.driftSnapUnits` |
| best lookahead (lowest p95, nudges on) | s | `replay.lookaheadSec` |
| input latency | ticks | contract finding F8 |
| final error at t = 10 s | units | — |
| server CPU for the follower (Stopwatch per tick) | µs | — |

## Pass / fail

- **PASS**: eradicate with nudges on: p95 ≤ 24, max ≤ 48 and 0 snaps in 3 of 3 runs. snarlbot (ramp):
  p95 ≤ 32 and 0 snaps. Pure input (step 2) is informational: p95 ≤ 48 is a good sign.
- **PARTIAL**: PASS without the turning-view case, or snarlbot needs nudges > 20 % of ticks.
- **FAIL**: the bot doesn't move under the lock (step 1), or p95 > 48 with nudges on.

## Fallback

1. **Velocity steering:** each tick set `AbsVelocity` (via `Teleport` velocity) to `(target − pos) / lookahead`,
   clamped to run speed, and keep injecting keys so the animation still matches.
2. **Synthesized replay:** build per-tick `ReplayTick` pre/post snapshots (64 Hz, interpolated from the track) and
   `ReplayCommandFrame` (forward/left move, view, buttons), then `LoadReplay` + `StartReplay`. Positions become exact,
   but the puppet becomes kinematic and per-tick Core input is lost (see `cs2-adapter.md`, finding 2).
3. **No movement under the All lock:** first check that `StartUsercmdMovement` returned a positive token. It
   returns −1 when the `PlayerRunCommand` hook is not active or a replay owns the slot. Also check `bc_status` and
   the server log for "record/replay unavailable" warnings. If the hooks are fine and the bot still doesn't move, fork
   Bot-Controller (P2's route B needs the same toolchain).

## Record

Fill in the P1 section of `results.md` (one row per run) and the tuning-change table.
