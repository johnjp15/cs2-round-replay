# P5: REPLAY → LIVE handoff

## Goal

Unlock a puppet in the middle of a walk. It carries on to its next waypoint through CS2-Bot-Nav without a visible
hitch, and engages a visible enemy. Movement-doc item 5. Also measures `ai.reactionSec`.

Depends on: P1 (a working follower) and P2 (so the puppet's view faces its walk direction at handoff).

## Background (why this can fail)

- Bot-Controller's All lock supersedes `CCSBot::Update` entirely
  ([BotController.cpp](https://github.com/XBribo/CS2-Bot-Locker/blob/71319b0477ec688f8bdc2fe0633ef992a7cd700a/src/features/controller/BotController.cpp)),
  so the bot's perception (`IsEnemyVisible`, `Enemy`) is stale when it is unlocked.
- CS2-Bot-Nav re-calls native `CCSBot::MoveTo` every 0.1 s and auto-releases within 40 units of the goal
  ([BotNav.cs](https://github.com/ed0ard/CS2-Bot-Nav/blob/0d1d04f8eb748e3434462d2a799ca89ab299e583/BotNav.cs)).
  Repeated `MoveTo` calls may pull an attacking bot back into a move state.

## Setup

- `exec cs2probe`, `mp_restartgame 1`.
- Puppet: `probe_spawn eradicate T -731 567 -82 167.2 weapon_ak47`, `probe_lock eradicate all`, following
  `eradicate-0-10.csv` (from P1) with the P2 view route set to the walk direction.
- Waypoints after the handoff, at t = 5 s: the track samples at t = 6, 7, 8, 9, 10 s (from the CSV).
- Enemy: `probe_spawn zwomp CT <a point ~800 units from the t = 8 s sample, with line of sight to it> 0 weapon_m4a1`.
  Pick it with `Trace.TraceEndShape` from the t = 8 sample's eye height. Make the enemy stand still with
  `BotNav.Hold`, and set `probe_block zwomp eradicate on` so the puppet survives to be measured. A connected human can
  be the enemy instead (variant H).
- `probe_log on p5-<variant>`.

## Steps

1. Run the follower; on probe tick 320 (t = 5 s) do the handoff: `CancelUsercmdMovement`, then `Unlock(slot, All)`,
   then `BotNav.SetGoal(slot, wp1, Fastest)`. All three happen on the same tick.
2. Chain the waypoints: when `IsControlled(slot)` turns false, or the bot is within 40 units of the goal,
   `SetGoal(next)`. After the last one, `Release`.
3. **Variant a:** keep Bot-Nav goals active through the contact.
4. **Variant b:** call `BotNav.Release(slot)` on the first tick the enemy is visible, judged by our trace from P6 or
   by native `IsEnemyVisible`.
5. **Perception check:** log `IsEnemyVisible`, `Enemy`, `LastSawEnemyTimestamp` and `IsAttacking` from 64 ticks
   before the handoff to 192 ticks after.
6. Repeat each variant 5 times. If a human is available, run variant H once.

## Measurements

| Quantity | Unit | `tuning.json` key |
| --- | --- | --- |
| speed over handoff ticks −32..+64: minimum, and ticks below 50 % of pre-handoff speed | units/s, ticks | — |
| path deviation from the straight waypoint polyline (max) | units | — |
| waypoint arrival ticks; any skipped or stuck (`IsStuck`) | ticks | — |
| first enemy-visible tick (our trace) → first `IsEnemyVisible` → first `weapon_fire` at the enemy | ticks → s | `ai.reactionSec` |
| angle between the first shot (impact − eye) and the enemy's chest | deg | `ai.aimErrorDeg` (optional) |
| variant a: does the bot stop firing or turn away when `MoveTo` is re-issued? (count interruptions) | count | — |

## Pass / fail

- **PASS** needs all four in at least one variant, 5 of 5 runs:
  - speed never drops below 50 % of the pre-handoff speed for more than 8 ticks (0.125 s) after the handoff;
  - every waypoint is reached within 40 units, in order, with no stuck or jump episodes;
  - the first shot at the visible enemy comes within 1.0 s of first visibility;
  - no shots at nothing.

  Record which variant passed; variant b is expected.
- **FAIL**: a stall longer than 0.25 s, waypoints skipped, or no engagement within 2 s.

## Fallback

- **Stall at unlock:** keep injecting forward/side toward wp1 for a few ticks after `Unlock` and before
  `SetGoal`. Or call `SetGoal` one tick before unlocking (the goal is set while still locked).
- **Bot-Nav wanders or stalls:** drop Bot-Nav for LIVE movement. Keep injecting our own path-following (2D nav, or
  CS2's nav via `CCSNavArea`) until contact, then unlock fully.
- **Perception too slow** (reaction > 1 s because it starts stale): fork Bot-Controller with a lock that supersedes
  only the movement and aim parts of `Update` and keeps perception, as DemoTracer's runtime does ("Native AI
  continues perception during replay so it is ready for handoff",
  [dtr-controller README](https://github.com/unicbm/demotracer/blob/1a44ca9b8c9fda5482bb327763f658ccfa7cbdf7/server/runtime/dtr-controller/README.md)).

## Record

Fill in the P5 section of `results.md` and the tuning-change table.
