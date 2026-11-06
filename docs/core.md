# Core

The Core (`src/core`) replays the recorded round through `ICore`. It imports only `src/contracts`; C# notes are in `docs/port-notes.md` ("Core"). Build it from parsed data:

```ts
const round = parseRound(roundJson);           // src/contracts/round.ts
const model = new RoundModel(round);
const schedule = new EventSchedule(round);
const core = new ReplayCore(model, schedule, parseTuning(tuningJson), seed);
```

## Clock (`clock.ts`)

- `TICK_RATE = 64`, `tickOf(t) = Math.round(t * 64)`, `tOf(tick) = tick / 64`.
- `RoundClock(clock0, bombTimerSec)` (`fromRound` reads 98.25 s and 40 s from `meta`):
  - `remaining(tick) = clock0 − tOf(tick)`.
  - `hudClock(tick)` is `m:ss` of `ceil(remaining)`, never below `0:00`. Tick 0 shows `1:39`.
  - `bombRemaining(tick, plantTick) = bombTimerSec − (tOf(tick) − tOf(plantTick))`.
  - `hudBomb` is that rounded to 0.1 s (half up), never below `0.0`.
  - `bombExplodeTick(plantTick) = plantTick + bombTimerSec × 64` (1761 + 2560 = 4321 here).

## Round model (`round-model.ts`)

- `players` holds all ten in id order, each with `team`, `startPos`, `startYaw` (as recorded, `null` except for eradicate), `hp`/`armor`/`helmet`, `kit`, `role`/`roles`, `pickups`, `deathTick` and `isHumanDefault`.
- `trackAt(id, t)` interpolates the 10 Hz samples linearly. It returns `null` before the first sample and after the last one. The off-grid samples are not used, so eradicate's track ends at 12.7 s even though he dies at 12.75 s. It returns `{pos, confidence, uncertainty}`: `confidence` is the less certain of the two bracketing samples, and `uncertainty` is the larger radius of those that have one (else `null`). This is the same rule the extractor uses when it resamples. `trackAtTick(id, tick)` is the same function, taking a tick.
- `deathTick(id)` is the kill-feed tick, or `null` for sp4rtan. cart's is 4442, the post-round kill. `isAlive(id, tick)` is true before that tick.
- `isObserved(id, t)` is true when `trackAt` is `observed`, meaning both bracketing samples were seen on camera or radar. It is false outside the track.

## Start state (`start-state.ts`)

`startActions(model, tuning)` returns the tick-0 setup. For each player, in id order:

1. `teleport {pos, yaw}`
2. `set_hp {hp, armor, helmet}`
3. One `give` per item: primary, secondary, each grenade (a duplicate grenade gets its own `give`), `c4`, `defuser`.
4. `set_weapon` to the primary, else the secondary, else `knife`.

Ammo:

- The weapon drawn at t = 0 gets the round's `kit.clip/reserve`.
- Any other gun gets `tuning.weapons[id].clip/reserve`. In this round that is only donk's glock, 20/120. A missing entry throws.
- Grenades, `c4` and `defuser` are given with 0/0.

Start yaw (`startYaw(model, id)` returns `{yaw, source}`). The first rule that applies wins:

| source | Rule | Who |
| --- | --- | --- |
| `recorded` | the round's `start.yaw` | eradicate (167.2) |
| `facing` | face the other member of a `FACING_PAIRS` pair. snarlbot kills incredibad 0.5 s in, and incredibad's spot was chosen to be in snarlbot's line of sight | snarlbot (−58.299), incredibad (121.701) |
| `motion` | bearing to the first track sample within the next 64 ticks (1.0 s) that is more than 8 units (2D) from the start | barely, cart, donk |
| `default` | 0 (east) when the track doesn't move that far in 1 s | lokier, snakelore, sp4rtan, zwomp |

Bearings are `atan2(dy, dx)` in degrees, in (−180, 180], rounded to 0.001°.

## Event schedule (`schedule.ts`)

`EventSchedule` is an immutable list of `ScheduledEvent`, a union on `type`. Every entry has a `tick`. The schedule is the recording as is: the human's own entries are included, and deciding which entries still apply once the human deviates is left to later tasks (B3/B4).

| type | Fields | From |
| --- | --- | --- |
| `pickup` | `id, weapon` | `players[].pickups` |
| `weapon_switch` | `id, weapon` | shots-CSV `switch` rows, plus `timelines.weapon` wherever the shown weapon changes to another known weapon. A timeline entry that repeats a CSV switch is dropped. |
| `shot` | `shooter, weapon, target, kind` (`shot`, `shot_kill`, `hit`) | shots-CSV rows with an exact time. `kill` rows (kill feed only, shot unknown) add nothing. |
| `burst` | `tick0, tick1, shooter, weapon, count, target` (`tick` = `tick0`) | shots-CSV count-only rows |
| `damage` | `attacker, victim, amount, armor` (null = not shown), `weapon, hitgroup, lethal` | `damage[]` and `kills[]` (see below) |
| `kill` | `killer, victim, weapon, headshot, assist, postRound` | `kills[]` |
| `utility` | `id, kind, throwPos` | `utility[]` |
| `plant` | `id, pos` | `bomb` (`carrier`, `plantTick`) |
| `defuse_start`, `defuse_end` | `id` | `bomb` ticks. `bomb` has no defuser id, so the id comes from the narrative `bomb` event at that tick (sp4rtan). |
| `radio`, `chat` | `id, text` | `radio[]` (callouts included), `chat[]` |

**Order.** Entries are sorted by `(tick, type order, actor id, build order)`. The actor is the shooter, attacker, killer or `id`. Type order (`SCHEDULE_TYPE_ORDER`):

`pickup, weapon_switch, shot, burst, damage, kill, utility, plant, defuse_start, defuse_end, radio, chat`

Inventory changes come first, so a shot on the same tick uses the new weapon. Then come fire and its consequences (lethal damage before its kill), then other actions, and talk last, because it never changes state.

**Queries.**

- `at(tick)`: entries whose `tick` equals `tick`. A burst counts at `tick0`.
- `between(tick0, tick1)`: both ends inclusive.
- `forPlayer(id)`: entries where the player is the actor, target, victim or assister.
- `ofType(type)`: entries of one type, typed.

**Lethal damage rule.** The schedule walks each victim's HP from their start HP, in tick order:

- A recorded hit that leaves HP above 0 is a normal `damage` entry (`lethal: false`, `hitgroup: chest`; the data has no hitgroups).
- A recorded hit whose amount is at least the HP left is the killing hit, so it gets no entry of its own. A kill of that victim by that attacker must follow, or the build throws.
- Every kill adds a `damage` entry with `lethal: true` on the kill-table tick:
  - `amount` is the HP left (start HP minus all earlier scheduled damage).
  - `armor` is the replaced hit's armor, else `null`.
  - `hitgroup` is `head` for a headshot kill, otherwise `chest`.
- A shot keeps its own tick even when the kill feed is a little later.

For donk this means:

- Shots and damage: 27 at 49.90 s, 34 at 50.00 s, 26 at 50.10 s.
- The `shot_kill` stays at 50.30 s (tick 3219).
- `round.json` also has a 13-damage `shots_csv` row at 50.30 s. Since it equals his HP left, it is the killing hit, and it moves to the kill tick: `damage` 13 (lethal) and `kill` at 50.35 s (tick 3222). donk is damaged once for those 13 HP, and his HP goes 100 → 73 → 39 → 13 → 0.

Other cases:

- lokier's 73 HP / 7 armor hit on cart at 18.50 s is a normal entry. Gating it on where the human is belongs to B4.
- The build throws `ScheduleError` on inconsistent data: damage after a death, two killing hits, a kill whose killer is not the one who landed the killing hit, or a killing hit with no kill.

## ReplayCore (`replay-core.ts`)

`new ReplayCore(model, schedule, tuning, seed)` implements `ICore`.

`step(o)`:

1. On the first step after `start` or `restart`, it emits `startActions` and resets every pawn's status to `REPLAY` since that tick. Before any `start` it emits no setup.
2. Status for all ten pawns, in id order: `DEAD` from the tick the observe first shows `alive: false`, otherwise `REPLAY`. `trigger` is `null`, and `sinceTick` is the tick the mode began (0 before the first start). The human's pawn is reported the same way; B4 should decide what mode the human's pawn reports.
3. **Hook `scheduledActions(o, actions)`**, for B3: append this tick's event actions (from `schedule.at(o.tick)`) after the setup. B1 adds none.
4. **Hook `pawnInput(pawn, o)`**, for B2: called once per alive pawn that isn't `o.human`, in id order. B1 returns a neutral input: forward 0, side 0, the pawn's current yaw and pitch, no buttons.

`control(c)`:

- `start` and `restart` reset the state and arm the setup. `paused` and `speed` carry over.
- `pause {paused}` and `speed {x}` are stored; `x` must be positive. The driver does the actual pausing and pacing: Core doesn't stop stepping by itself.
- `seek`, `checkpoint` and `rewind` throw "not implemented until B5".

`snapshot()` / `restore()` save and restore the Core's own state (`setupPending`, `startTick`, `lastTick`, `paused`, `speed`, and each pawn's mode and since tick) together with the seed. Restoring checks that the seed matches.

`rng` is a seeded `Rng` that nothing draws from yet. Draw through `rng.fork(label)`, keyed by tick and id, so the snapshot never needs the PRNG state.
