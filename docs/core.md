# Core

The Core (`src/core`) replays the recorded round through `ICore`. It imports only `src/contracts`; C# notes are in `docs/port-notes.md` ("Core"). Build it from parsed data:

```ts
const round = parseRound(roundJson);           // src/contracts/round.ts
const model = new RoundModel(round);
const schedule = new EventSchedule(round);
const walk = new NavWalkQuery(nav);            // src/sim2d/walk-query.ts (CS2: a nav/trace query)
const core = new ReplayCore(model, schedule, parseTuning(tuningJson), seed, walk);
```

Without the `walk` argument (or with `null`) the puppets are off and every REPLAY pawn holds still, as in B1. Tests with fake hosts that don't model the map use that.

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
- `yawTrack(id)` is the recorded yaw (20 Hz while a camera POV follows the player, with gaps; empty for players never on camera: only barely, cart, donk and eradicate have any).

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

- lokier's 73 HP / 7 armor hit on cart at 18.50 s is a normal entry. With cart as the human it becomes B4's scheduled encounter ("Divergence"), time-shifted to when Lokier actually sees him.
- The build throws `ScheduleError` on inconsistent data: damage after a death, two killing hits, a kill whose killer is not the one who landed the killing hit, or a killing hit with no kill.

## ReplayCore (`replay-core.ts`)

`new ReplayCore(model, schedule, tuning, seed, walk = null, options = null)` implements `ICore`. `options` is `{divergence: boolean}` (default on); off gives the B2/B3 puppets alone, for the human-bot's shadow puppet.

`step(o)`:

1. On the first step after `start` or `restart`, it emits `startActions`, resets every pawn's status to `REPLAY` since that tick, resets every puppet controller to the pawn's start yaw and the scripted events' state, and then (B3) emits the round-start `block_damage` actions (see "Scripted events"). Before any `start` it emits no setup.
2. Status for all ten pawns, in id order: `DEAD` from the tick the observe first shows `alive: false`; `HUMAN` for the living pawn `observe.human` names (B4); otherwise `LIVE` stays `LIVE` (set by B4's triggers through `setPawnMode`) and anything else is `REPLAY`. `trigger` is the trigger that made the pawn LIVE (B4, see "Divergence"), else `null`, and `sinceTick` is the tick the mode began (0 before the first start).
3. **Divergence** (B4, not on the setup step): `Divergence.step` runs the triggers and the scheduled encounters, appends their actions (`unblock_damage`, `set_mode`, logs; an encounter's `block_damage` and scripted `damage`) and returns the pawns that go LIVE, which `setPawnMode` switches before B3 sees the modes. On the setup step `Divergence.setup` replaces the recorded shot of an active encounter.
4. **`scheduledActions(o, actions)`** (B3): appends this tick's scripted actions after the setup (`ScriptedEvents.actions`: damage, weapons, grenade selection, plant / defuse fallbacks, drop logs).
5. **`pawnInput(pawn, o, actions)`** (B2): called once per REPLAY pawn (alive, not `o.human`, mode `REPLAY`), in id order. It returns the puppet's input and may append a snap (`teleport` + `log`) to `actions`, after the setup and scheduled actions. On the setup step every REPLAY pawn (puppets on or off) gets a neutral input at the yaw of its setup `teleport`: that observe predates the teleports, and the engine applies the input yaw after them, so echoing the observed (pre-setup) yaw would turn every pawn back to 0. Without puppets (no `walk`) the input is otherwise neutral: forward 0, side 0, the pawn's current yaw and pitch, no buttons. See "Puppets" below.
6. **`scriptedInput(input, pawn, o, prevYaw)`** (B3): layers the scripted look (aim, defuse, grenade pitch) and buttons (`ATTACK`, `USE`) on that input, except on the setup step, and writes the commanded yaw back to the puppet's state. `prevYaw` is the puppet's commanded yaw before this tick's movement input (the observed yaw without puppets).

`control(c)`:

- `start` and `restart` reset the state and arm the setup. `paused` and `speed` carry over.
- `pause {paused}` and `speed {x}` are stored; `x` must be positive. The driver does the actual pausing and pacing: Core doesn't stop stepping by itself.
- B5: `checkpoint {id}` and `seek {t}` are checked (a non-empty id; seconds ≥ 0) and change nothing: checkpoints and seeking are the driver's work (a checkpoint stores `snapshot()`, a seek steps every tick as usual). `rewind {id}` arms a **resync**: the driver has restored this Core to the checkpoint and the engine couldn't be (no snapshot capability), so the next step puts the engine back first. See "Checkpoints, rewind, summary".

`snapshot()` / `restore()` save and restore the Core's own state (`setupPending`, `setupThisStep`, `startTick`, `lastTick`, `paused`, `speed`, each pawn's mode, trigger, since tick and (B5) `everLive`, the armed `resync`, each puppet's `PuppetState`, the scripted events' `ScriptState`, (B4) the `DivergenceState` and (B5) the loadout ledger) together with the seed. Restoring checks that the seed matches. Every stored number is already canonical (yaw to 0.001°, `behind` to 6 decimals), so a restore continues exactly. A snapshot from before B5 restores with an empty ledger.

`puppet(id)` returns a pawn's `PuppetController` (or null without puppets) and `snapCount` the snaps since the last start. `script` is the `ScriptedEvents` (its `plan` and `state`), `divergence` the B4 `Divergence` (its `index`, `encounters` and `state`), `modeOf(id)` a pawn's Core mode, `triggerOf(id)` its trigger, and the protected `setPawnMode(id, mode, tick, trigger)` is what the triggers switch through.

`rng` is a seeded `Rng` that nothing draws from yet. Draw through `rng.fork(label)`, keyed by tick and id, so the snapshot never needs the PRNG state.

## Puppets (`puppet.ts`)

A puppet is a REPLAY pawn driven along its recorded track with **per-tick inputs only** (`forward`, `side`, `yaw`, `pitch`, `buttons`), the way CS2 bots will be driven through usercmd injection. It never sets a position, except for an unseen snap at a teleport point. Not driven: the human's pawn, DEAD pawns and (B4) LIVE pawns.

### WalkQuery

Wall-aware steering needs "can a pawn walk straight from a to b?". The Core can't import an engine, so the engine passes a `WalkQuery { isWalkableLine(a, b) }` (`src/contracts/walk.ts`) to the `ReplayCore` constructor. The 2D sim's is `NavWalkQuery` (`src/sim2d/walk-query.ts`, `NavMesh.segmentWalkable`, 2D). In CS2 it becomes a nav-mesh raycast or a hull trace (`docs/port-notes.md`).

### Track preprocessing (`PuppetTrack`)

`PuppetTrack.fromModel(model, schedule, tuning, id)` turns the 10 Hz samples into a physically followable reference. `raw` keeps the recording untouched (the golden master compares against it); `ref` is the reference.

- A step between two samples is **over-speed** when its 2D speed exceeds `spikeSpeedFactor` (1.6) × the run speed of the weapon the recording shows at either sample (kit, then scheduled `weapon_switch`es; AK 215 → 344 u/s, AWP 200 → 320, deagle 230 → 368).
- **Spike**: at an over-speed step into sample i, if for some j ≥ i with t[j+1] − t[i−1] ≤ `spikeMaxSec` (0.5 s) the step out of j is over-speed too and the bridge i−1 → j+1 is not, then samples i..j are an excursion that comes back. They are replaced by linear interpolation between i−1 and j+1 (smallest such j). For one sample this is "implied speed from both neighbours too high, and the neighbours agree".
- **Discontinuity**: otherwise the run of consecutive over-speed steps from i is a jump that doesn't come back. It stays in the reference and becomes a teleport point.
- **Teleport window** per event: a discontinuity opens at the start of its *last* over-speed step (so a long infeasible stretch gets one snap at its end, not one per stretch of it); a spike opens at the sample before it. Both close `teleportWindowSec` (1 s) after the event's last sample. `isTeleportPoint(tick)` is true inside any window.
- **Button plan**: per tick, `movementButtons` of the recorded speed |ref(t + lookahead) − ref(t)| / lookahead: nothing below `standSpeedThreshold` (20 u/s, the 10 Hz tracking noise), DUCK below `crouchSpeedThreshold` (60), WALK below `walkSpeedThreshold` (120), never both (crouch-moving is silent anyway, and WALK + DUCK caps an AK at 38 u/s, below the crouch threshold). WALK / DUCK stretches shorter than `buttonMinSec` (0.25 s) are dropped, so a pawn doesn't crouch for a few ticks at every start and stop. Buttons only cap speed, so this never costs tracking.
- `summary()` lists the spikes, discontinuities and teleport points; `describeEvent(e)` prints one; `npm run ghost` prints them all.

What it finds in `data/round.json` (no real spike survives the "comes back" test; most "spikes" C1 saw are jumps forward along the path):

| player | event | kind | what |
| --- | --- | --- | --- |
| barely | 44.70–44.80 s | discontinuity | Tunnel Stairs → Catwalk, 89 u across, dz +154, 890 u/s |
| barely | 45.20–45.30 s | discontinuity | 91 u in 0.1 s on Catwalk (910 u/s) |
| cart | 12.80–13.00 s | discontinuity | 137 u in 0.2 s (709 u/s) |
| cart | 14.20–14.50 s | discontinuity | 217 u in 0.3 s (1,084 u/s), then walks at 41 u/s |
| cart | 15.80–15.90 s | discontinuity | 46 u (463 u/s) |
| cart | 21.00–21.10 s | discontinuity | Balcony drop, dz −104 (391 u/s) |
| cart | 22.30–22.40 s, 22.80–22.90 s | discontinuity | 50 u (502 u/s), 60 u (602 u/s) |
| donk | 13.40–13.60, 14.30–14.50, 18.60–18.80 s | discontinuity | AWP (cap 200), 361–406 u/s: the sustained over-speed |
| eradicate | 11.20–11.30 s | discontinuity | 43 u (430 u/s) |
| snarlbot | 16.00–16.10 s | discontinuity | 39 u (388 u/s) |
| sp4rtan | 17.90–18.10 s | spike | 1 sample (18.0 s) repaired: 494 / 455 u/s in and out, bridge 331 u/s |
| sp4rtan | 18.10–19.60 s | discontinuity | inferred loop through Bombsite A at ~700 u/s for 1.5 s (3 × the deagle's 230) |

CTs other than sp4rtan (incredibad, lokier, snakelore, zwomp) have none.

### Per tick (`PuppetController.input(pawn, observe, tick)`)

1. **Outside the track** (before its first sample, or more than `holdLastPositionSec` = 0.25 s after its last): neutral input, yaw held. Until then the reference is clamped to the last sample, so the pawn holds its last position through the ~0.05 s between a track's end and the kill-feed death (eradicate, snarlbot, barely, donk).
2. **Drift**: ref = reference at t; behind = |pawn − ref| (2D).
3. **Snap** when behind > `driftSnapUnits` (96) **and** no human sees the pawn (the human pawn's `sees`; `observe.human === null` = nobody) **and** a teleport window not used yet is open at this tick: `teleport {pos: ref, yaw: current}`, then `log {info, "puppet <id>: snap to track at tick <k>, <n> u behind (<kind> at ticks <a>-<b>)"}`. One snap per teleport point. The input below is then computed from ref. A pawn a human sees is never teleported. Snaps are counted in `PuppetState.snaps` and `ReplayCore.snapCount`.
4. **Lookahead**: ahead = reference at t + `lookaheadSec` (0.15 s), before = at t − 0.15 s.
5. **Yaw**: the recorded yaw when known (two yaw samples ≤ 0.1 s apart bracket t; shortest-arc interpolation), else the heading of motion (bearing from before to ahead) while the recorded speed is ≥ `standSpeedThreshold`, else held. The commanded yaw turns toward that by at most `maxTurnRateDegPerTick` (12°). The recorded POV yaw never turns faster than 11.7°/tick, so recorded yaw is followed exactly; the limit only smooths motion headings and the switch between the two sources. Yaw is in (−180, 180], rounded to 0.001°. Pitch is 0 (B3 aims).
6. **Buttons**: the plan, or none while behind > `driftNudgeUnits` (24): run to catch up.
7. **Steer** at ahead if `isWalkableLine(pawn, ahead)`; otherwise at the latest reference point before it, back to `steerFallbackSec` (2 s) ago, that is in walkable line (C1's wall-aware rule); ahead if none is.
8. **Speed**: wish speed = min(cap, |ahead − pawn| / lookahead), cap = run speed of the held weapon (observed) × WALK / DUCK factors. A pawn on the reference then gets exactly the recorded velocity, and lag is fed back with gain 1 / lookahead.
9. **Stick**: the steer direction in the frame of this tick's yaw: forward = dot(dir, (cos yaw, sin yaw)), side = dot(dir, (sin yaw, −cos yaw)) (+side = strafe right), scaled by wish speed / cap and rounded to 6 decimals. **B3:** forward/side are relative to `yaw`, so aim through `withLook(input, yaw, pitch)` (which re-expresses the stick) and write the commanded yaw back to `puppet(id).state.yaw` so the turn limit continues from it.

### Ghost round (`tests/golden-round.test.ts`, `npm run ghost`)

The whole round with **no human**: `ReplayCore` (B1 + puppets + B3's scripted events) drives all ten pawns in `Sim2DHost` (`act = core.step(observe)`, `host.apply(act)`, `host.tick()`; since E1 the driver is the headless harness, `runHarness` in `tools/harness.ts`, which runs the app's `Session`; `docs/golden.md`). Each pawn is measured up to its recorded death tick (or last sample), where B3 also kills it, and is no longer driven after its track plus the hold. Errors are 2D, against the **raw** recording at every 10 Hz sample, with the pawn position interpolated between the ticks around the sample time (positions taken after each tick's actions, so the tick-0 setup counts). "ticks > 24 behind" is the share of measured ticks more than 24 units from the raw track. `npm run ghost` writes `logs/ghost-round.jsonl` and `logs/ghost-trace.json` (`toReplayTrace`, for the replay page; snaps appear as `info` events).

**2D model values; compare against the CS2 probe.** 4,517 ticks, digest `e9a228d9` (with B3, C3, C4's sight mask and F's cover; `e6c2be70` before F, `0fb55e23` before C4: real `sees`, grenades clamped by the mask and cover change the Observe stream, not the positions, the snaps or the Core's acts).

| player | team | observed n | RMS | max (at t) | est./inf. n | RMS | max (at t) | inferred RMS | radius (min–max) | snaps (t) | ticks > 24 behind |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| barely | T | 588 | 12.9 | 92 (45.3 s) | 1 | 11.7 | 12 (27.9 s) | – | – | 1 (44.98) | 8.4 % |
| cart | T | 683 | 13.5 | 93 (13.0 s) | 12 | 13.9 | 36 (13.4 s) | – | – | 2 (14.41, 21.09) | 6.3 % |
| donk | T | 504 | 11.1 | 94 (14.4 s) | 0 | – | – | – | – | 1 (14.42) | 3.5 % |
| eradicate | T | 128 | 5.7 | 32 (11.3 s) | 0 | – | – | – | – | 0 | 1.6 % |
| incredibad | CT | 0 | – | – | 6 | 0.0 | 0 (0.0 s) | 0.0 | 260 | 0 | 0.0 % |
| lokier | CT | 17 | 4.2 | 8 (18.0 s) | 172 | 1.4 | 8 (17.3 s) | 1.4 | 110–140 | 0 | 0.0 % |
| snakelore | CT | 5 | 0.0 | 0 (12.0 s) | 120 | 0.0 | 0 (0.0 s) | 0.0 | 220 | 0 | 0.0 % |
| snarlbot | T | 48 | 13.8 | 33 (14.4 s) | 131 | 4.5 | 20 (10.3 s) | – | – | 0 | 4.9 % |
| sp4rtan | CT | 87 | 29.2 | 149 (58.6 s) | 617 | 41.7 | 450 (19.4 s) | 43.0 | 120–320 | 2 (18.20, 19.50) | 5.5 % |
| zwomp | CT | 4 | 4.4 | 8 (43.9 s) | 439 | 3.3 | 17 (35.9 s) | 3.3 | 240–450 | 0 | 0.0 % |

The test asserts: observed RMS < 24 for every T; inferred RMS < the smallest uncertainty radius of that CT's inferred samples; exactly the six snaps below, each at a teleport point and logged once; the log replays identically through a fresh Core and (E1) equals the committed fixture `fixtures/golden/round-nohuman.jsonl.gz` byte for byte (`docs/golden.md`).

**What B3 changed** (B2 alone: digest `1fac160b` on the same `main`): the aim and grenade looks go through `withLook`, so the paths hardly move. cart 13.7 → 13.5 and donk 11.3 → 11.1 RMS (holding a grenade for a second raises the speed cap), sp4rtan 23.5 → 29.2 (the AK, above), and barely's one estimated sample at 27.9 s 0.7 → 11.5 units, because he stands still for the plant until 27.52 s while the recording has him walk off at 27.5 s (11.7 with C3, whose plant locks his movement). Every other cell is unchanged, with and without C3.

**Snaps (6)**, all unseen (no human), each at a teleport point:

| player | tick (t) | behind | window |
| --- | --- | ---: | --- |
| cart | 922 (14.41 s) | 124 u | discontinuity 14.20–14.50 s |
| donk | 923 (14.42 s) | 97 u | discontinuity 13.40–13.60 s (window to 14.6 s); the over-speed continues to 14.5 s |
| sp4rtan | 1165 (18.20 s) | 96 u | spike 17.90–18.10 s (start of the inferred loop) |
| sp4rtan | 1248 (19.50 s) | 430 u | discontinuity 18.10–19.60 s (end of the loop) |
| cart | 1350 (21.09 s) | 97 u | discontinuity 21.00–21.10 s (Balcony drop) |
| barely | 2879 (44.98 s) | 98 u | discontinuity 44.70–44.80 s (Tunnel Stairs → Catwalk) |

Compared with C1's wall-aware pursuit (no snaps): cart 21.2 → 13.7, donk 17.5 → 11.3, barely 68.4 → 12.9. With snapping disabled (`driftSnapUnits` = 10⁹) the same controller gives barely 69.0 and sp4rtan 1,751 (observed): without the snaps, barely has to go round by Tunnel after the level change, and sp4rtan gets stuck for good on the A stairs at (−525, −1422) at 18.0 s, because the inferred track races off through Bombsite A at ~700 u/s and no reference point of the last 2 s is in walkable line. Snaps are what make those two followable.

**What remains, by cause:**

- **sp4rtan, inferred 18.0–19.6 s**: the loop at 3 × his run speed. The pawn falls up to 450 units behind (radius 200 there) until the 19.50 s snap. Physics are not loosened for it.
- **sp4rtan, 57.6–59.1 s**: his inferred track runs 320–340 u/s for 1 s, 1.46 × the deagle's 230 (below the 1.6 spike factor, so not a teleport point). The pawn falls 149 units behind, and the first observed samples after it (58.6–59.1 s) carry that lag; it catches up by 59.2 s. With B3 he carries the AK (215) he picks up at 19.6 s, as in the recording: before B3 he kept the deagle (230), and this stretch gave 131 units and an observed RMS of 23.5 instead of 29.2.
- **cart 13.0 s, barely 45.3 s** (max errors 93 and 92): jumps where the drift peaks just under 96, so the pawn catches up physically. **donk 14.4 s** (94): the sample just before his snap at 14.42 s.

### Tunables (`data/tuning.json` → `replay`)

| Key | Value | Meaning |
| --- | --- | --- |
| `lookaheadSec` | 0.15 | Steer at the reference this far ahead; also the speed window and the P-gain (1 / lookahead). |
| `driftNudgeUnits` | 24 | More than this behind (2D): no WALK / DUCK. |
| `driftSnapUnits` | 96 | More than this behind, unseen, in a teleport window: snap. |
| `walkSpeedThreshold` | 120 | WALK below this recorded speed (u/s). Note the AK walk cap is 111.8, so 112–120 u/s stretches lag slightly until the nudge releases WALK. |
| `crouchSpeedThreshold` | 60 | DUCK below this recorded speed (and at or above `standSpeedThreshold`). |
| `maxTurnRateDegPerTick` | 12 | Yaw turn limit. |
| `spikeSpeedFactor` | 1.6 | **new.** Over-speed = faster than this × the recorded weapon's run speed. |
| `spikeMaxSec` | 0.5 | **new.** A spike must come back within this long; else it is a discontinuity. |
| `teleportWindowSec` | 1 | **new.** A snap is allowed until this long after a teleport point. |
| `holdLastPositionSec` | 0.25 | **new.** Hold the last position this long after the track ends, then neutral input. |
| `standSpeedThreshold` | 20 | **new.** Below this recorded speed: standing (no buttons, yaw held). 10 Hz integer positions jitter at 10–30 u/s. |
| `buttonMinSec` | 0.25 | **new.** Shorter WALK / DUCK stretches of the plan are dropped. |
| `steerFallbackSec` | 2 | **new.** How far back the wall-aware rule looks for a reference point in walkable line. |
| `hearingRangeUnits`, `outliveGraceSec` | 1500, 3 | Not used by B2; B4's gunfire and outlived triggers ("Divergence"). |

### Known limits

- **No path query.** If no reference point of the last 2 s + lookahead is in walkable line, the pawn pushes at the lookahead point and can stay stuck. Recovery then depends on a teleport window (see sp4rtan above). A `WalkQuery.path` (nav A*) would fix this; a stuck-pawn snap would need a policy decision, because snaps are restricted to teleport points.
- **Snap visibility** checks only whether the human sees the pawn now, not whether the destination is in view. `Sim2DHost` reports `sees: []`, so in the 2D sim every pawn is unseen until the host computes `sees`.
- **Drift is 2D.** A pawn on the wrong level right under its track counts as on track. barely's level change snaps 0.18 s after the jump (98 u at 44.98 s), because the 2D gap at the jump is only 89 u.

## Scripted events (`scripted.ts`, `aim.ts`)

B3 makes the REPLAY puppets act the recording: they aim and shoot on the recorded ticks, switch and pick up weapons, throw their utility, plant and defuse, and the recorded damage and kills are applied exactly. Everything goes through `inputs` (yaw, pitch, `ATTACK`, `USE`) or contract `actions`, so the same Core can drive CS2 bots through usercmd injection.

- `ScriptPlan` (built once from the schedule and tuning) turns the schedule into act ticks: fire items, aim engagements, damage, inventory changes, utility, plant and defuse. It depends only on the data, not on the human.
- `ScriptedEvents` applies it per tick: `blockActions` on the setup step, `actions` (from `scheduledActions`) every step, and `input` on top of each puppet's movement input (from `scriptedInput`). Its `ScriptState` (bomb events seen, decisions made) is in the Core snapshot.

### Latency and "the tick an event lands on"

An event *lands* on tick t when it is in the Observe whose `tick` is t (that is what the Core, the app and `toReplayTrace` see). The driver runs observe(k) → `core.step` → `host.apply(act)` → `host.tick()`, and the engine's tick k emits its events into observe(k + 1). Measured in `Sim2DHost` (`measureLatency` in `tools/scripted-round.ts`, asserted in `tests/golden-round.test.ts`):

| what | from | to | latency |
| --- | --- | --- | ---: |
| input | `ATTACK` in the Act of tick k | `shot` event | 1 tick |
| action | `damage` action in the Act of tick k | `damage` (and `death`) event | 1 tick |
| action | `set_weapon` in the Act of tick k | Observe shows the weapon | 1 tick |

The Core sends every scripted input `inputLatencyTicks` (1) early and every scripted action `actionLatencyTicks` (1) early, so its effect lands on the recorded tick. In CS2 the input latency is measured by probe P3 (findings F7, F8 in `docs/cs2-adapter.md`); set the two keys from it.

C3's docs and tests (`docs/combat.md`, `tests/bomb.test.ts`) count an event at the engine tick that *processed* it, one less than the observe tick used here. `RoundObs.endTick` and `bomb.plantTick` are processed ticks too: the defuse's `round_end` is in observe 4275 with `endTick` 4274.

### Aim

- **Engagements.** Every fire item with a target gives an aim window [first press − `preAimSec`, last press], and every damage entry one at [its tick − input latency − `preAimSec`, its tick − input latency] (act ticks). A shooter's overlapping or touching windows at the same target merge into one engagement (`plan.engagements`).
- **Band.** `head` if a merged damage entry is a headshot (lokier → eradicate, cart → lokier, sp4rtan → barely), else `chest`.
- **Look.** Each tick of an engagement the yaw turns toward the bearing to the target's **observed** position and the pitch toward the band's point (`aimPitchAt`: eye at `pos.z + damage.eyeHeight` or `crouchEyeHeight`, band at `pos.z + damage.bandHeights[band]`, scaled for a crouched target; the shooter counts as crouched when its input holds `DUCK`). Both turn at most `aimTurnRateDegPerTick` (30°) from the last commanded yaw and the observed pitch. The look is applied with `withLook`, so the pawn keeps moving the same way, and the yaw is written back to the puppet: between engagements B2's movement yaw takes over from there (at 12°/tick).
- When a shooter has two engagements at once, it aims in the one that ends first.
- `aim.ts` repeats the 2D hitscan's band geometry (the Core can't import `src/sim2d`); a test checks the two agree. The opening duel: snarlbot aims from tick 9 and faces incredibad (within 0.01°) from tick 11, well before the kill at tick 32.

### Firing

- **Sprays.** A shooter's consecutive `shot` entries with one **automatic** gun (`weapons.*.automatic`) at one target, each at most `sprayGapFactor` (1.5) cycles (60 / rpm) after the previous, are one spray: `ATTACK` is held and the engine sets the cadence (F7). The Core models the engine's fire rule (`simulateHolds`: a held AK fires at 0, 7, 13, 20, 26, 32, … ticks after the press) and picks the hold that lands the shots closest to the recorded ticks (`fitSpray`): the start is shifted by 0, −1, +1, −2 or +2 ticks from the first shot − latency. If no single hold gets every shot within a tick, it also tries two holds (split before each shot), which re-phases the cadence. That happens once: cart's post-round spray has shots at 69.2 s and 69.267 s, 4 ticks apart, faster than the AK allows; two holds (4393–4413, 4420–4433) land all seven within a tick.
- **Taps.** Semi-automatic guns (deagle, awp, ssg08, glock) and isolated shots press `ATTACK` on the shot tick − latency and release it on the next tick.
- **Bursts** (count only, no exact ticks). With a related kill (the shooter's first kill in the window, of the burst's target if it names one): an automatic gun holds a spray whose last shot lands on the kill tick; a semi-automatic one taps `count` times one cycle apart, the last on the kill tick. Without one: `count` taps evenly through the window (tap k at tick0 + ⌊(k + ½) × span / count + ½⌋). barely: 7 shots ending on the 44.20 s kill of Zwomp (hold 2789–2828), then 11 taps through 49.40–50.83 s; donk: one AWP shot in the middle of 37.25–49.40 s.
- **Implied shots.** A kill with no recorded shot or burst of that killer at that victim (kill feed only: snarlbot ×2, sp4rtan's deagle kill of snarlbot, the post-round kill of cart) gets one tap landing on the kill tick, so the kill has its shot and sound.
- While the script has a grenade or the c4 out, only the grenade's own `ATTACK` is pressed.

All 33 recorded exact-time shots land within a tick (20 exactly), and every gun fires exactly the rounds the HUD shows (cart 30 → 6, barely 30 → 12, donk's AWP 10 → 8).

### Damage

- **Blocks.** On the setup step the Core sends `block_damage` for every ordered pair of enemies that are both REPLAY (neither is the human), so the engine's own bullets and grenades between puppets do no damage: the recorded damage is scripted. Each such puppet is also blocked on itself (attacker = victim): in the first run donk's molotov burned him for 40 HP and barely's HE took 34, because the throws are guesses and the recording has no self-damage. Friendly fire is off, so teammates need no block. No human: 50 + 10 blocks; human cart: 40 + 9.
- **Emission tick.** `Sim2DHost` queues a `damage` action in `apply()` and applies it in the next `tick()` (after shots and grenades), so its `damage` / `death` events land one tick later. The Core sends each schedule `damage` entry at **its tick − `actionLatencyTicks`** (tick − 1), and the events land exactly on the schedule tick. `armor` is the recorded armor (cart's 7 at 18.5 s) or 0 when the recording doesn't show it; `lethal` entries take all remaining HP.
- **Drops.** A damage entry whose attacker or victim is dead (observed `alive: false`) or LIVE at its emission tick is dropped with one `info` log (`script: dropped damage sp4rtan -> donk (27 hp at tick 3194): donk is dead`).

### The human

When `observe.human` is a pawn (normally cart):

- the Core sends it no input, no weapon change, no grenade, plant or defuse;
- no scripted damage to or from it at the recorded tick (one `debug` log per skipped entry: lokier's 73 on cart, cart's kill of lokier, sp4rtan's post-round kill of cart). B4 plays Lokier's hit on cart as a time-shifted, gated scheduled encounter ("Divergence");
- no `block_damage` pair involves it, so its fights are real: puppets still aim and shoot at the human, and the engine decides those hits.

With `human === null` (the golden master) cart is a puppet like everyone else.

### Drops and decisions

A fire item or engagement is decided once, on the first tick it is active (`ScriptState.decisions`): it is dropped if its shooter is the human (silently) or if its shooter or target is dead or LIVE then (one `info` log per fire item, e.g. `script: dropped sp4rtan ak47 spray at donk (5 shots from tick 3192): donk is dead`). Once started, it runs to its end: cart keeps firing at Lokier for 0.2 s after the 18.8 s kill, as recorded. A dropped engagement doesn't aim. A LIVE pawn gets no input at all.

### Weapons

- `weapon_switch` → `set_weapon`, and `pickup` → `give` (with the gun's tuning clip / reserve) then `set_weapon`, both at the recorded tick − action latency. A pickup and a switch to the same weapon on one tick (sp4rtan's AK at 19.6 s) send one `set_weapon`. The new weapon's deploy time applies (AK 1 s).
- donk: Glock at 49.93 s and back to the AWP at 50.083 s. The switch back is only in the note of the shots CSV's switch row; `tools/extract-round.ts` now writes both switches into `timelines.weapon.donk` (`docs/round-data.md`), and the schedule takes the second from there.
- cart: knife at 59.6 s and the AK again at 63.5 s (the weapon timeline).

### Utility

For each `utility` entry (throw tick U): `set_weapon <grenade>` at U − latency − `throwHoldSec` − the grenade deploy (`grenades.deploySec`); `ATTACK` held for `throwHoldSec` (0.25 s, the pin pull); released at U − latency, which throws; then `set_weapon` back to the weapon the recording shows (if the pawn holds something else, e.g. cart's second smoke). During the hold and the release the pitch is `throwPitchDeg` (−10°, slightly up) and the yaw is the puppet's current facing. **The landing spots are not in the data, so this is a guess and purely cosmetic**: several 2D grenades hit a wall a few units in front of the thrower.

### Plant and defuse

- **barely** (plant tick 1761): `set_weapon c4` one c4 deploy (`damage.defaultDeploySec`, 1 s) before the USE window (C3's engine needs no deploy for the c4; a CS2 draw does); `USE` and no stick (no forward, side, `WALK` or `DUCK`) from `plantTick − round(plantSec × 64) − input latency` (1555) to `plantTick` (1761), released as soon as a `bomb` event with phase `planted` arrives. If none has arrived by `plantTick + plantFallbackTicks` (1764), the Core sends `plant {id, pos}` and logs it. After the plant (event or fallback) it draws the recorded weapon again (AK) if the pawn still holds something else; C3's engine already draws it, so in the 2D sim the Core sends nothing.
- **sp4rtan** (defuse 3955 → 4275): looks at the bomb (yaw and pitch, at the aim turn rate) from `preAimSec` before the USE window; `USE` and no stick from `defuseStart − input latency` (3954) to the scheduled defuse end (4275), released on a `defused` or `exploded` event. If the engine hasn't reported `defuse_start` by `defuseStart + defuseFallbackTicks` (3957), the Core sends `defuse_start {id}` and logs it.
- Neither is scripted for the human's pawn, nor for a dead or LIVE one. The Core never sends `end_round`: the engine ends the round (C3: on the defuse, `round_end {CT, bomb_defused}`).
- **With C3's engine** (`docs/combat.md`, "Bomb and round rules"): barely's USE starts the plant on engine tick 1555 inside Bombsite B; it completes 205 ticks later, on engine tick 1760, so `planted` lands on observe tick **1761**, and USE is released there (held 1555–1760). sp4rtan's defuse (kit, 320 ticks) starts on engine tick 3954, so `defuse_start` lands on **3955** and `defused` with `round_end {CT, bomb_defused}` on **4275** (USE held 3954–4274). Neither fallback fires. The round ends 12 – 15 with 0.71875 s on the bomb timer (the recording: "defused with 0.72 s left"), and the post-round kill on cart at 4442 still happens.

### Results (golden master, `npm run scripted`, `tests/golden-round.test.ts`)

4,517 ticks, digest `e9a228d9` (with C4's sight mask and F's cover; `e6c2be70` before F, `0fb55e23` before C4, `7e3523a6` before C3), identical on a second run and on replay. F's cover changes only `sees` (123 lines; `docs/golden.md`, History). C4 changed only the Observe stream: `sees` is real (2,063 of the 4,517 observes differ in it), and 10 grenade pops moved or changed tick because throws now stop at the sight mask's walls instead of nav holes; every Core act, position, kill, HP change, shot tick, the plant and the defuse are byte-identical. The driver passes the round's score (CT 11 – T 15) and clock (98.25 s) to `Sim2DHost`, like the Session.

| t (s) | killer → victim | weapon | HS | recorded tick | `death` event | Δ |
| ---: | --- | --- | --- | ---: | ---: | ---: |
| 0.50 | snarlbot → incredibad | ak47 | | 32 | 32 | 0 |
| 12.40 | snarlbot → snakelore | ak47 | | 794 | 794 | 0 |
| 12.75 | lokier → eradicate | ssg08 | yes | 816 | 816 | 0 |
| 17.85 | sp4rtan → snarlbot | deagle | | 1142 | 1142 | 0 |
| 18.80 | cart → lokier | ak47 | yes | 1203 | 1203 | 0 |
| 44.20 | barely → zwomp | ak47 | | 2829 | 2829 | 0 |
| 50.35 | sp4rtan → donk | ak47 | | 3222 | 3222 | 0 |
| 58.85 | sp4rtan → barely | ak47 | yes | 3766 | 3766 | 0 |
| 69.40 | sp4rtan → cart | ak47 | | 4442 | 4442 | 0 |

| event | recorded tick | observe tick | Δ |
| --- | ---: | ---: | ---: |
| `bomb planted` (barely, by USE) | 1761 | 1761 | 0 |
| `bomb defuse_start` (sp4rtan, by USE) | 3955 | 3955 | 0 |
| `bomb defused` (sp4rtan) | 4275 | 4275 | 0 |
| `round_end` CT `bomb_defused` (once; score 12 – 15) | 4275 | 4275 | 0 |

HP: donk 100 → 73 (3194) → 39 (3200) → 13 (3206) → 0 (3222); cart 100/100 → 27/93 (1184) → 0 (4442); snarlbot 44 from the setup; nobody else is hurt before their kill, and sp4rtan ends on 100. Shots: all 33 recorded exact-time shots land within a tick (Δ −1: 5, 0: 20, +1: 8; none further). Per shot: `npm run scripted`. No fallback, no `script:` log, and no action the host leaves unhandled.

**Collision** (C3: enemies solid, centres ≥ 32 apart): no puppet is body-blocked at any tick (`GhostRun.bodyBlocks`, from `host.blockedBy`, is empty; asserted). Against the same run without C3, positions differ by at most 1.7 units (sp4rtan after the defuse lock, barely around the plant lock) and nobody's distance to the recorded track grows by more than 0.2 units, so no kill, shot or HP tick moves.

### Tunables (`data/tuning.json` → `replay`, B3)

| Key | Value | Meaning |
| --- | --- | --- |
| `preAimSec` | 0.35 | Aim at the target from this long before the first shot of an engagement (and at the bomb before a defuse). |
| `aimTurnRateDegPerTick` | 30 | Yaw and pitch limit while aiming. |
| `inputLatencyTicks` | 1 | Act → Observe latency of inputs (`shot` events); scripted inputs are sent this early. CS2: probe P3. |
| `actionLatencyTicks` | 1 | Act → Observe latency of actions (`damage`, `set_weapon`, `give`); scripted actions are sent this early. |
| `sprayGapFactor` | 1.5 | Consecutive shots at most this many cycles apart are one spray. |
| `throwPitchDeg` | −10 | Grenade throw pitch (a guess; landings are unknown). |
| `throwHoldSec` | 0.25 | `ATTACK` held before the release that throws (pin pull). |
| `plantFallbackTicks` | 3 | No `planted` event this long after the recorded plant tick: `plant` action. |
| `defuseFallbackTicks` | 2 | No `defuse_start` event this long after the recorded defuse start: `defuse_start` action. |

### Known limits

- **2D line of sight.** The damage is scripted, so whether a bullet hits doesn't matter here, but it shows where the 2D map differs: the aim is right (yaw within 0.3°, the intended band), yet 6 of the 13 fire items with a target didn't reach it through the 2D nav line of sight. With C4's sight mask (`docs/vision.md`, `npx tsx tools/vision-shots.ts`) 9 of 13 have sight at a shot and 10 get an engine hit (`host.combatLog()` lists them as blocked hits): cart ↔ Lokier through the Apartments window now reach. Still blocked: snarlbot → incredibad (incredibad's inferred spot; the hit still lands on his circle), sp4rtan → snarlbot (inferred route), barely → Zwomp (barely's recorded spot is a level too low) and sp4rtan → barely (a B-site pillar, ~25 units). In CS2 these become real traces.
- **No spread or recoil** in 2D; in CS2 a sprayed AK drifts, which only matters for the human's real fights (puppet damage is scripted).
- **Grenades** are thrown blind (see Utility). Self-damage is blocked; a teammate would be hurt only with friendly fire on.
- **Plant and defuse** rely on the engine's rules (C3 in 2D, the game in CS2); the fallbacks cover an engine that doesn't plant or report the defuse start, not one that interrupts a defuse (a `defuse_stop` is not retried).

## Divergence (`divergence.ts`, B4)

By default the round replays exactly. When the human does something different, only the puppets whose world actually changed go **LIVE** (the engine's AI drives them, carrying their recorded intent as a goal), and everyone else keeps replaying. A puppet follows its recording until something happens that its recorded self never experienced; divergence spreads only through cause and effect from an **off-script** pawn (the human, or a LIVE pawn): damage, sight, gunfire, a body block. Modes go one way: REPLAY → LIVE → DEAD; a LIVE pawn never returns to REPLAY, and the human never goes LIVE. A cancelled event alone changes nothing: B3 drops the shots and damage whose other side is dead or LIVE and the puppet carries on replaying (barely's 44.2 s kill of an already dead Zwomp).

### Triggers (checked every tick, pure functions)

Every alive REPLAY puppet that isn't the human, in id order, the first that applies (modes as at the start of the tick, so cascades take a tick each):

| # | trigger (`status.trigger`) | fires when | log (`<id> LIVE: …; goal <role>, <n> waypoints`) |
| --- | --- | --- | --- |
| 1 | `damage` (`damageTrigger`) | a `damage` event on it from the human or a LIVE pawn (any weapon; world and self damage don't count) | `hit by cart (27 hp, ak47)` |
| 2 | `sighting` (`sightingTrigger`) | its `sees` holds an off-script enemy that the recording doesn't have it engaging or sighting then (`ExpectedEncounters.saw`); not the human while he is **on course** (within `offCourseUnits` of his recorded track: then he is the recording, exactly as two puppets seeing each other is no divergence); not a pair a scheduled encounter owns | `sees cart (the human), not in the recording` |
| 3 | `gunfire` (`gunfireTrigger`) | a `shot` sound from an off-script enemy within `hearingRangeUnits` (2D, as the AI hears) that isn't recorded fire of that shooter (`ExpectedEncounters.fired`, shifted by a started encounter: cart's late shots at Lokier) | `heard donk fire 1387 u away` |
| 4 | `outlived` (`outlivedTrigger`) | alive `outliveGraceSec` (3 s) or more after its recorded death (kill feed) | `outlived recording (+3.0 s)` |
| 5 | `blocked` (`blockedTrigger`) | the human sees it, a solid pawn touches it on the side of its puppet reference (`blockingPawn`: centres within 2 × `collision.pawnRadius` + `contactSlackUnits`, the direction within 90° of the way back to its track), and either the contact has *added* more than `offCourseUnits` to its drift (pushed), or it has stood in the contact (slower than `standSpeedThreshold`) for `blockedSec` while more than `offCourseUnits` off course (held). Counting only the added drift keeps a puppet that already lags its track (sp4rtan's fast inferred one) from switching at a touch. Inferred from positions and velocities: `host.blockedBy` is a debug hint the Core can't use, and neither engine pushes players | `blocked by cart, held 110 u off course, seen by cart` |
| — | `encounter` | a scheduled encounter's gate fails (below) | `encounter lokier -> cart at tick 1191: cart not in sight` |

Teammates only matter through damage (friendly fire is off) and, with `collision.solidTeammates`, body blocks: a T doesn't go LIVE because he sees or hears the human, his teammate. The checks don't run on the setup step (that observe predates the setup; everyone stands at the origin).

**The switch.** In the same Act: `unblock_damage` for every pair involving the pawn that B3 blocked (its self pair, then both directions with every enemy that is neither the human nor LIVE, dead ones included; plus an encounter's standing block), then `set_mode {id, mode: LIVE, goal}`, then the `log` line. The pawn gets no Core input from that tick on; the engine's AI first moves it in that tick's `tick()`. B3 drops whatever the plan still had for it (`script: dropped … : <id> is LIVE`).

### Expected encounters (`ExpectedEncounters`)

Built once from the schedule and `round.json` `sightings[]`:

- **Pairs** (symmetric: in a recorded engagement both sides count as seeing each other): every `shot` and `burst` with a target (the burst over its whole window), every `damage` and `kill` (attacker, victim), every `sightings[]` entry (`who` with each player its free-text `by` names: "eradicate's radar" → eradicate, "cart / barely" → barely, cart; `RoundModel.sightings`). `saw(a, b, tick)`: some span of the pair within `expectedSightingWindowSec` (2 s) of the tick.
- **Fire**: every `shot`, `burst` (its window) and `kill` (a kill implies a shot) by its shooter. `fired(shooter, target, tick, shift)`: some span within `expectedGunfireWindowSec` (2 s) of `tick − shift`.

### Scheduled encounters: Lokier on B (`EncounterPlan`, `EncounterState`)

Every non-lethal recorded hit on the default human by an enemy is a scheduled encounter, active while that player is the human: here exactly one, Lokier's 73 HP / 7 armor SSG 08 hit on cart at 18.50 s, from the 17.45 s sighting (the time shift's origin), with cart's recorded spot at the hit, (−1764, 800) at the Apartments window. It is time-shifted, not divergence:

- **Setup**: B3's recorded tap and aim of that hit are suppressed (`ScriptedEvents.suppress`), and from the recorded aim's start (tick 1161) Lokier **holds the angle** on the spot (a B3 `HoldItem`: he looks at chest height there whenever no engagement is active), after replaying to his track's end on B and holding there.
- **waiting → seen**: the first tick Lokier (REPLAY) has cart in `sees` within `humanSpotToleranceUnits` (192) of the spot. The hit is due `encounterDelaySec` (1 s) later; Lokier aims at cart's chest from now (a run-time B3 engagement). Logged with the shift against the recording.
- **seen → fired**, on the hit's act tick, if the **gate** passes (Lokier still REPLAY, cart in his `sees` and within the tolerance of the spot): `block_damage lokier → cart` (the scripted hit replaces the engine's bullet), the tap (a run-time B3 fire item: the shot and its sound are real) and the recorded `damage` (73 / 7, chest), landing on the due tick. The block is lifted when Lokier's shot is seen, or when he goes LIVE. If the gate fails, Lokier goes LIVE (`encounter`) and fights.
- **done**: when Lokier or cart dies or Lokier leaves REPLAY. Cart kills Lokier for real, whenever that happens (B3 skips the recorded kill: the human isn't scripted). If he is still alive at 18.80 + 3 s, he has outlived his recording (trigger 4): LIVE, `hold` on B with the SSG 08, no forced death; the Ts walking onto the site then see a live enemy.
- **Sightings it owns** (`encounterOwnsSighting`): during `seen` always (the gate decides), and while `waiting` or `fired` only with cart at the spot. Seen anywhere else, cart is judged by trigger 2 (on course, a recorded pair ±2 s, else LIVE): rushing the window 9 s early is fine, walking up to Lokier on B after the hit isn't.

Sp4rtan's post-round kill on cart stays real, if it happens (B3: an implied tap, the engine decides).

### Goals (`liveIntent`, `liveGoal`)

`set_mode` LIVE carries `{route, role, hold}`. **Route**: the pawn's remaining recorded track from now to the role's anchor tick (its own position first), thinned with Ramer–Douglas–Peucker at `routeThinUnits` (64) to the decision points (corners, doorways), without the first point and without a last point equal to `hold`; empty once the anchor has passed (an outlived pawn walks straight to its hold spot). **Role and hold**, by team, `observe.round` and the player's `roles`:

| who | role | anchor / hold |
| --- | --- | --- |
| T, bomb not planted | `plant` for the c4 carrier (barely), else `take_site` | the recorded plant (27.52 s); the carrier holds the recorded bomb position, the others their recorded spot then |
| T, bomb planted | `guard_bomb` | the recorded post-plant stay (`dwellSpot`: the longest run of samples within `dwellUnits` of its first): barely (−818, 360) on the Tunnel / underpass stairs from 37.4 s, donk (−1556, 781) in the Apartments from 28.5 s ("scoped east"). The AI moves a spot more than `ai.guardMaxUnits` from the bomb to a ring point with sight to it |
| CT `flank_then_retake` (sp4rtan) | `retake`, `defuse` once planted | his recorded defuse start (61.8 s): the flank via T side and the Apartments to B |
| CT `rotate_b` (zwomp) | `rotate` | the end of his track (Mid, underpass, Catwalk) |
| CT `hold_a` / `hold_b` (incredibad, snakelore, lokier) | `hold` | the end of the track (lokier: his last sample on B, (−2145.8, 432.2)) |

The C4 AI faces a holding pawn toward the enemy's approach from their spawn; the Core doesn't steer that.

### The human's pawn

`status` reports the human's living pawn as **`HUMAN`** (`MODES` gained it; status only, `set_mode` still takes `REPLAY | LIVE`; `trigger` null), DEAD once dead. With `human === null` it never appears, so the golden master was byte-identical (`e6c2be70` then; `e9a228d9` since F's cover). The renderer's badge reads it ("YOU").

### Tunables (`data/tuning.json` → `replay`, B4)

| Key | Value | Meaning |
| --- | --- | --- |
| `expectedSightingWindowSec` | 2 | A recorded pair counts as seeing each other this long around its spans. |
| `expectedGunfireWindowSec` | 2 | A shot is recorded fire this long around the shooter's recorded fire. |
| `encounterDelaySec` | 1 | A scheduled encounter's hit lands this long after the shooter first sees the human at the spot (recorded: 17.45 → 18.50 s). |
| `humanSpotToleranceUnits` | 192 | The human is at an encounter's spot within this (2D). |
| `routeThinUnits` | 64 | LIVE route thinning tolerance. |
| `offCourseUnits` | 64 | Off course: the human beyond it is off script; a body block must push a puppet this much further (or hold it beyond it). |
| `contactSlackUnits` | 4 | Body contact: centres within 2 × `collision.pawnRadius` + this. |
| `blockedSec` | 0.25 | Held in contact this long (slower than `standSpeedThreshold`) counts as blocked. |
| `dwellUnits` | 64 | Radius of a "stay" for the post-plant guard spot. |

### Scenarios (`tests/scenarios.test.ts`, `fixtures/scenarios/*.json`)

Played by the human-bot (`tools/human-bot.ts`: `followRecording`, `walkTo`, `aimAt`, `fire`, `holdStill`, `throw`, setup `teleport`; `npm run harness -- --scenario <file>` prints the timeline). Seed 1, deterministic. Shared invariant: a puppet nothing touched replays exactly; on every tick it is REPLAY (and not body-blocked) it is within 0.01 units of the no-human golden master's position (measured: 0.0005 at most, in every scenario). Where a LIVE fight's winner depends on the toy AI, the tests assert the triggers and print the winner. The recorded opening (snarlbot's kills of incredibad and snakelore, Lokier's of eradicate, sp4rtan's of snarlbot) is the same in all but `cart-dies` and is left out.

**1. No-op guard.** Golden no-human round: no switch, no `set_mode`, no `HUMAN`. `cart-follows-recording`: **no switch** (F; before F exactly one). Lokier sees cart at 10.9 s down the corridor from Truck, but cart is on course (no divergence). The encounter starts when he sees cart at the window at 17.63 s (+0.2 s); cart's real AK headshot kills him at 18.50 s, before the hit due at 18.63 s, so cart keeps 100 HP (E1's re-check: with C4's sight mask cart's bullets do reach Lokier through the Apartments window, 0.3 s before the recorded kill, because 2D has no spread). Everything then replays to the end. Cart's recorded spray at the defusing sp4rtan (65.9–66.9 s) hit nothing on the tape; until F the follow script aimed it at sp4rtan with B3's aim, and with no spread and no box on the line (`docs/vision.md`, "Cart's spray") it hit him for real at 65.91 s (sp4rtan LIVE, T elimination 11 – 16, the bomb killing cart at 67.52 s). The follow script now looks where cart's recorded view does on the shots the tape shows missing (`tools/follow-aim.ts`, `docs/golden.md`), 17–22° off sp4rtan:

| t (s) | event |
| ---: | --- |
| 17.63 | encounter: cart in sight at the spot (+0.2 s), hit due 18.63 s |
| 18.50 | cart kills lokier (AK, HS); encounter over |
| 27.52, 44.20, 50.34, 58.84, 61.80 | plant, barely → zwomp, sp4rtan → donk, sp4rtan → barely, defuse start: as recorded |
| 65.9–66.9 | cart's spray at the defuser: 11 shots, no hit (as the tape) |
| 66.80 | sp4rtan defuses: round_end CT bomb_defused, 12 – 15, 0.72 s on the bomb (the tape: 0.72 s) |
| 69.41 | sp4rtan's post-round shot (B3's single implied tap) hits cart for 27; he ends on 73 HP (the tape: killed; the kill shot's timing is masked by cart's own spray) |

**2. `lokier-late`**: cart follows to 16.6 s, holds back in the Apartments, peeks at 19.5 s, waits for the hit, fires; then walks his recorded way to Shop and follows again.

| t (s) | event |
| ---: | --- |
| 20.14 | encounter: cart in sight at the spot (+2.7 s), hit due 21.14 s |
| 21.14 | scripted hit 73 / 7 (cart 27 HP / 93 armor) |
| 21.42 | cart kills lokier (AK, HS, real), 2.63 s after the recorded kill |
| 27.52 – 61.80 | plant, Zwomp, donk, barely kills, defuse start: on the golden master's ticks |
| 66.80 | sp4rtan defuses: CT bomb_defused, 12 – 15 (no switch: cart's spray misses as in the follow run; F. Before: sp4rtan LIVE at 65.91 s, hit by cart, killed cart at 66.19 s and died in the explosion, T bomb_exploded 11 – 16) |
| 69.41 | sp4rtan kills cart (27 HP) after the round, as recorded |

**3. `never-peeks`** (cart stands in Back Alley all round):

| t (s) | event |
| ---: | --- |
| 21.80 | **lokier LIVE: outlived recording (+3.0 s)** → `hold`, route [], hold his last sample on B |
| 21.81 | **barely LIVE: sees lokier (LIVE), not in the recording** → `plant` |
| 22.17 | barely kills lokier (real; donk, dwelling in the Apartments, never saw him) |
| 28.41 | barely plants (AI) |
| 40.06 | **sp4rtan LIVE: sees cart (the human)** on his flank → `defuse`; 40.58 sp4rtan kills cart |
| 43.41, 49.97 | barely kills zwomp, sp4rtan kills donk (real fights; 43.33 s before F's cover) |
| 59.61 | barely kills sp4rtan: round_end T elimination, 11 – 16 |
| 59.6 – 68.4 | the bomb still ticks: barely (LIVE) leaves its blast and survives it (F; before, the explosion at 68.41 s killed him) |

**4. `mid-zwomp`** (cart follows to 29.7 s, then is teleported into Middle):

| t (s) | event |
| ---: | --- |
| 29.72 | **zwomp LIVE: sees cart (the human)** |
| 29.73 | cart kills zwomp (AK, HS) |
| 43.58, 44.19 | `script: dropped barely ak47 burst at zwomp (7 shots from tick 2789): zwomp is dead`, and the lethal damage; barely keeps replaying |
| 50.34 – 66.80 | as recorded; sp4rtan was at least 1,785 u from cart's shots (hearing range 1,500), so he stays REPLAY; CT bomb_defused, 12 – 15 |

**5. `flank-sp4rtan`** (cart follows to 44.6 s, then waits in Back Alley):

| t (s) | event |
| ---: | --- |
| 44.61 | **sp4rtan LIVE: sees cart (the human)**; 44.63 cart kills him (HS): round_end T elimination, 11 – 16 (no CT left) |
| 49.83 – 58.83 | sp4rtan's shots and damage on donk and barely dropped (`sp4rtan is dead`) |
| 53.34 | **donk LIVE: outlived recording (+3.0 s)** → `guard_bomb`; the round is over, so he leaves the blast at once (F) |
| 61.84 | **barely LIVE: outlived recording (+3.0 s)** → `guard_bomb`, leaves the blast too |
| 67.52 | the bomb explodes: donk is 1,826 units away (100 HP), barely 1,564 (74 HP); both live. Before F the 2D AI stayed by the bomb and both died |

**6. `cart-dies`** (cart teleported to the window at 8 s, 9.5 s early, never fires):

| t (s) | event |
| ---: | --- |
| 8.02 | encounter: cart in sight at the spot (−9.4 s), hit due 9.02 s |
| 9.02 | scripted hit 73 / 7 (cart 27 HP) |
| 10.38 | cart walks off the window: **lokier LIVE: sees cart (the human), not in the recording** |
| 10.81 | **donk LIVE: sees lokier (LIVE)** |
| 10.84 | lokier kills cart (SSG 08, real) |
| 11.30 | donk kills lokier; **zwomp LIVE: heard donk fire 1387 u away** |
| 15.75 | **eradicate LIVE: outlived recording (+3.0 s)** (Lokier's 12.75 s kill was dropped) |
| 17.84, 27.52 | sp4rtan kills snarlbot, barely plants: as recorded (untouched puppets) |
| 30.81 | **barely LIVE: sees zwomp (LIVE)**; 31.09 kills him (30.59 / 30.91 before F's cover: a box hid zwomp a little longer) |
| 52.84 | **sp4rtan LIVE: sees donk (LIVE)**; 53.19 donk kills him: T elimination, 11 – 16 |
| 67.52 | the bomb explodes; barely, donk and eradicate (LIVE) have left its blast and live (F; before, all three died) |

**7. `block-barely`**: cart stands in barely's path in the Apartments corridor, looking at him. Teammates aren't solid (`collision.solidTeammates` false, `mp_solid_teammates 0`): barely walks through, never blocked, never off course; no switch to 21.5 s. **7b. `block-sp4rtan`**: cart (teleported at 57 s) stands in sp4rtan's way to the bomb. The pair is recorded in sight on B from 58.6 s (no sighting trigger); sp4rtan is held in contact from 58.9 s and goes **LIVE: blocked by cart, held 110 u off course, seen by cart** at 59.16 s, then kills cart (59.70 s) and starts the defuse LIVE (61.09 s).

**8. `smoke-window`**: cart smokes the window from the Apartments at 15 s and walks to his recorded spot: within the spot tolerance from 18.0 s (on the spot from 19.0 s), over the recorded hit at 18.50 s, unseen. No encounter starts until he steps west out of the smoke: in sight at 20.02 s (+2.6 s), the hit at 21.02 s, cart kills Lokier at 21.28 s; no switch.

### Known limits

- **2D sight**: the sight mask's window over B is the whole Apartments wall, and Truck sees down the whole corridor (Lokier sees cart at 7–11 s in several runs), so sighting-driven divergence is wider in 2D than it would be in CS2. Expected spans are per pair and time, not position.
- **Toy AI**: LIVE fights are the C4 bot's; a 2D LIVE Lokier at 1,750 u rarely lands a hit. Since F it leaves the bomb's blast after the round and gives up a defuse that can't finish (`docs/ai.md`).
- **No spread**: a scripted human's recorded shots hit wherever they are aimed; the follow script aims the shots the tape shows missing where cart's recorded view was (`tools/follow-aim.ts`). The human-bot's `followRecording` does the same.
- **Encounters** exist only for the default human (cart); with another human pawn there are none.

## Checkpoints, rewind, summary (B5)

Players retry moments ("rewind 10 s and take the duel differently") and compare their run with the recording at the end. The Core will run in CS2, where the engine can't be snapshotted, so rewind has two paths, chosen by the host's **capabilities** (`IHost.capabilities()`, contract finding F6): `{snapshot, seek, speed}`. `Sim2DHost` has all three; the CS2 adapter none.

### Checkpoints (`checkpoints.ts`, the driver)

A checkpoint is taken **between two steps**, before the step of `tick`, and holds: the Core's `snapshot()`, the host's snapshot (with the capability, else null), the observe that step sees (canonical), the SessionLog's length, its resync `hazards` and the driver's own bits (Session: controls not yet logged, queued weapon slots, pause, speed). `CheckpointStore` (portable plain data, for the C# driver too) keeps the last `replay.checkpointMax` (16), oldest out first; adding an id again replaces it; `atOrBefore(tick, safe)` picks a rewind target; a rewind drops every checkpoint after its tick.

- **Automatic** before the step of every multiple of `replay.checkpointSec` (5 s = 320 ticks): 0, 5, …, 70 s, 15 in the round. **On demand**: `checkpoint {id}`.
- **Not logged and changes nothing**: the golden master with checkpoints on is still the fixture's digest (`e6c2be70` when B5 landed, `e9a228d9` since F's cover; `tests/rewind.test.ts` reads it from the manifest).
- **Memory** (measured, golden round): 15 checkpoints, 233 K JSON chars: Core 57 K (3.8 K each), host 134 K (8.9 K), observe 41 K (2.7 K), 15.5 K per checkpoint. The SessionLog itself is ~17 MB.
- **Hazards** (`ReplayCore.checkpointHazards(o)`, `resyncHazards`): a defuse in progress (`round.bomb.defuser` while planted) or the scripted plant's USE window open (`ScriptPlan.plant`, planter on script). A resync can't restore either (see below), so a driver without snapshots skips such checkpoints: in the round 25 s (barely planting, 1555–1761) and 65 s (sp4rtan defusing, 3954–4274) are skipped (20 s and 60 s are used instead). A plant by the human or a LIVE pawn isn't visible to the Core.

### Exact rewind (host snapshot)

Restore the host and the Core from the checkpoint, put back the driver bits and cut the log back to the checkpoint's length. Nothing is logged: the log stays one straight run that replays, and given the same inputs what follows is byte-identical. Rewinding across a REPLAY → LIVE switch restores the engine's mode, AI state and damage blocks with it.

Measured (`tests/rewind.test.ts`): run to 40 s, checkpoint, run to 60 s, rewind, run to 60 s again: the 1,281 lines from the checkpoint are byte-identical, with no human and with the flank-sp4rtan human-bot (inputs and its scenario teleport replayed; sp4rtan's switch at 44.61 s and donk's at 53.34 s are undone: both REPLAY, alive, blocked again), and the no-human round finished after the rewind has the golden digest.

### Resync rewind (no host snapshot: CS2)

The driver restores the Core's snapshot, cuts the log back, sends the Core `rewind {id}` (logged) and feeds the **checkpoint's observe** to the next step instead of the engine's. That step's Act starts with `resyncActions` (`resync.ts`) and then is exactly the checkpoint step's Act, so the log stays a straight run (one line with the `rewind` control and the resync prefix) and **replays** through a fresh Core (`replay()`, tested). The prefix, a pure function of that observe and the Core's state:

1. `set_round {tick, round}` (new action): the engine's clock becomes the checkpoint tick (its next observe reports tick + 1) and its round state the checkpoint's: score, winner / reason / end tick, the bomb (carried, dropped where, planted on which tick, so the timer and the beeps; defused; exploded). 2D: `Sim2DHost` relabels its tick, drops grenades in flight, smokes and fires, and moves per-pawn timers (weapon, flash, footsteps) by the same amount, as CS2 game-time timers would keep running; CS2: the adapter's tick base, the round start time, `planted_c4`'s `C4Blow`.
2. For every **living** pawn, in id order: `set_hp {hp, armor, helmet}` (a dead pawn comes back), `teleport {pos, yaw}`, `strip` (new action: everything but the knife), one `give` per ledger item with its clip / reserve, `set_weapon` (the observed weapon), and for every pawn but the human `set_mode` REPLAY, or LIVE with a fresh `liveGoal` from there. A pawn dead at the checkpoint is dead now too and gets nothing.
3. `block_damage` / `unblock_damage` for **every** self pair and ordered enemy pair: blocked when neither pawn is the human or was ever LIVE (`everLive`), plus a scheduled encounter's standing block. 50 + 10 actions.
4. `log {info, "rewind <id>: resync to tick <k>, <n> pawns placed, <m> LIVE, <b> blocked pairs"}`.

So rewinding across a LIVE switch returns the pawn to REPLAY in both paths (B4's note: the engine is told again).

**Not restored** (no contract action; CS2 can't either): **velocity** (a teleport stops the pawn; it catches up through the puppet's feedback), **grenades in flight** and active **smokes and fires** (dropped; an in-flight grenade is still in the ledger, so its thrower gets it back), **bomb progress** (a plant or defuse in progress starts again: hence the hazards), weapon timers (reload, deploy, fire cadence), flashes in progress, and the LIVE AI's memory and random draws (a LIVE fight after a resync can go another way). A round that ended stays ended in CS2 (the 2D `set_round` takes it back).

**The loadout ledger** (`loadout.ts`). Observe shows only the held weapon, so the Core keeps every pawn's items with clip and reserve: from its own `give` / `strip` actions, the held gun's ammo in every observe (ammo only changes while held), the c4 from `round.bomb`, and grenade pops (`sound` kind `grenade`, the only trace of a throw): a pawn that stops holding a grenade has maybe thrown it (a release); a pop takes the oldest release within `releaseWindowTicks` (longest fuse or flight + 1 s, 206 ticks) whose kind it still has, else its last-held grenade, else its first. Measured over the golden round: on all 22,753 living pawn-ticks the ledger equals the engine's inventory with ammo, except for a pawn's own grenade in flight (686 pawn-ticks), which the ledger still has. A human who draws and puts away grenades just before a throw can fool the release rule.

**Measured** (no human, snapshots forced off; `tests/rewind.test.ts`, worst |Δ| against the straight run):

| rewind | checkpoint | kills, bomb, round end after it | Δ | LIVE | drift RMS / max (worst pawn) |
| --- | --- | --- | ---: | --- | --- |
| 60 → 40 s | 40 s | 7 (barely → zwomp … defuse, round end, post-round kill) | 0 ticks | none | zwomp 7.4 / 22.6 u (running at the checkpoint), sp4rtan 3.4 / 19.4, donk 0.3 / 1.8, others < 0.1 |
| 30 → 20 s | 20 s (25 s is mid-plant) | 8 (the plant included) | 0 | none | cart 5.9 / 65.3 u (his Balcony-drop snap comes 0.13 s later), sp4rtan 4.1 / 27.1, donk 4.6 / 25.8, barely 3.1 / 18.6 |
| 70 → 60 s | 60 s (65 s is mid-defuse) | 4 (defuse start, defuse, round end CT 12 – 15 again, post-round kill) | 0 | none | cart 0.8 / 4.2 u, sp4rtan 0.2 / 1.7 |

The drift comes from the lost velocity at the checkpoint and closes within about a second; no scripted event moves. With a human (never-peeks, 23 s → 20 s): Lokier (dead) and barely (LIVE) are REPLAY again, alive and blocked again, and switch again on the same ticks (1395, 1396); the LIVE fight after that went another way (donk heard it and went LIVE too), as expected without the AI's state.

### Seek

- **Forward** steps tick by tick as fast as possible (the driver, without rendering; the app slices it per animation frame). Triggers see every observe.
- **Backward** = rewind to the latest checkpoint at or before t (resync: one without hazards), then forward.
- The driver replays what the human did on ticks he already played (Session: his inputs and weapon slots by tick, "the tape"), so seek back and forth lands where a straight run would, byte for byte (tested with lokier-late: 50 s → 33 s → 45 s → 20.5 s). Playing live discards the tape.
- Without the `seek` capability (CS2) a seek ahead is refused and a seek back ends at the checkpoint (play on in real time). Without `speed`, the `speed` control is refused.

### End-of-round summary (`summary.ts`)

`summarize(model, log, {player, sameTicks})` is a pure function of `RoundModel` (B5 added `kills`, the kill feed) and a SessionLog (or its parsed lines), returning `RoundSummary` (`src/contracts/summary.ts`):

- **Result** from the log's `round_end` against the recording (`recordedResult`: winner from `meta.score` → `scoreAfter`, reason from `bomb`: CT `bomb_defused` at tick 4275, 12 – 15).
- **Kills**: each recorded kill against the run's `death` events: `same` (same killer and victim within `sameTicks`, 2), `shifted` (Δt), `missed` (didn't happen, with why: the victim already dead, the killer dead, the victim died later to someone else, or survived), `pending` (the log ends before it: the overlay opens before the 69.4 s post-round kill), and every other death `new` (`killer` null = the bomb).
- **LIVE switches**: status mode LIVE starting on its tick, with the trigger and the reason from the Core's `<id> LIVE: <reason>; goal …` log line.
- **Player stats** (the human's pawn, else cart): kills, damage dealt (HP removed from others) and taken, seconds alive, RMS 2D distance from his recorded track over the ticks alive with a recorded position.
- **Bomb**: plant, defuse or explosion ticks, and the margin (timer left at the defuse; negative: the defuse in progress at the explosion needed that much more).
- **Headline** by verdict: `tape` "Played it like the tape: CT defuse, 0.72 s left"; `same_result` "Same result, different round: CT defuse, 0.41 s left (recorded 0.72 s); 3 kills changed"; `changed` "You changed history: Ts win by elimination (recorded: CT defuse)" ("History changed" when spectating); `unfinished` "Round still on (recorded: CT defuse)". Times are written from integer arithmetic (`fixed2`), not `toFixed`.

| run | headline | kills | switches | cart |
| --- | --- | --- | --- | --- |
| golden (no human) | Played it like the tape: CT defuse, 0.72 s left | all 9 `same`, Δ 0 | none | watched; 1 kill, 100 dealt, 100 taken, alive 69.39 s, died 69.41 s, RMS 13.9 u |
| follow run (`cart-follows-recording.json`, F) | Same result, different round: CT defuse, 0.72 s left; 2 kills changed | 7 `same`; cart → lokier `shifted` −0.30 s (2D has no spread); sp4rtan → cart `missed` ("didn't happen: cart survived": the one implied post-round shot takes him to 73 HP) | none | you; 1 kill, 100 dealt, 27 taken, alive the whole round, RMS 21.0 u |
| flank-sp4rtan (B4 #5) | You changed history: Ts win by elimination (recorded: CT defuse) | 5 `same`; cart → lokier `shifted` −0.30 s; **new** cart → sp4rtan 44.63 s (HS); sp4rtan → donk, → barely, → cart `missed` ("sp4rtan was dead (44.63 s)"); the bomb kills nobody (F: the LIVE guards leave its blast; before F, **new** bomb → barely and → donk 67.52 s) | sp4rtan sighting 44.61 s, donk outlived 53.34 s, barely outlived 61.84 s | you; 2 kills, 200 dealt, 41 taken, alive the whole round, RMS 1,145 u (he waited in Back Alley) |

Summarizing the whole round's log takes ~250 ms in Node and ~80 ms in Chrome (it parses every line).
