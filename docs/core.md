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

- lokier's 73 HP / 7 armor hit on cart at 18.50 s is a normal entry. With cart as the human it becomes B4's scheduled encounter ("Divergence"), time-shifted to when Lokier actually sees him (G5: on the recorded tick when cart is on course then), and cart's kill of Lokier at 18.80 s becomes the outcome of G5's recorded duel ("Recorded duels of the human").
- The build throws `ScheduleError` on inconsistent data: damage after a death, two killing hits, a kill whose killer is not the one who landed the killing hit, or a killing hit with no kill.

## ReplayCore (`replay-core.ts`)

`new ReplayCore(model, schedule, tuning, seed, walk = null, options = null)` implements `ICore`. `options` is `{divergence: boolean, rejoin?: boolean}` (both default on); divergence off gives the B2/B3 puppets alone, for the human-bot's shadow puppet; `rejoin: false` gives B4's one-way modes (G1's rejoin needs divergence and a `walk`).

`step(o)`:

1. On the first step after `start` or `restart`, it emits `startActions`, resets every pawn's status to `REPLAY` since that tick, resets every puppet controller to the pawn's start yaw and the scripted events' state, and then (B3) emits the round-start `block_damage` actions (see "Scripted events"). Before any `start` it emits no setup.
2. Status for all ten pawns, in id order: `DEAD` from the tick the observe first shows `alive: false`; `HUMAN` for the living pawn `observe.human` names (B4); otherwise `LIVE` stays `LIVE` (set by B4's triggers through `setPawnMode`) and anything else is `REPLAY`. `trigger` is the trigger that made the pawn LIVE (B4, see "Divergence"), `rejoin` for a REPLAY pawn that came back to its recording (G1), else `null`, and `sinceTick` is the tick the mode began (0 before the first start).
   - **G4: takeover.** Not on the setup step: if `observe.human` is not the last step's human, `humanChanged` lifts the new human's damage blocks, logs the takeover and activates his scheduled encounters (or, a release, makes the old one LIVE), after any resync prefix and before the triggers. See "Takeover".
3. **Divergence** (B4, not on the setup step): `Divergence.step` runs the triggers and the scheduled encounters, appends their actions (`unblock_damage`, `set_mode`, logs; an encounter's `block_damage` and scripted `damage`) and returns the pawns that go LIVE, which `setPawnMode` switches before B3 sees the modes. On the setup step `Divergence.setup` replaces the recorded shot of an active encounter. Then (G1) **`Rejoin.step`** looks at every LIVE pawn with the modes after those switches: it may send an approach (`set_mode` LIVE with role `rejoin`) or switch the pawn back (`block_damage`s, reconciliation, `set_mode` REPLAY, log), and `setPawnMode` makes the returned pawns REPLAY (trigger `rejoin`) before B3 sees the modes; the puppet's commanded yaw restarts from the observed one. See "Rejoin". Then (G5) **`HumanDuels.step`**, with the modes after those switches: the human's recorded duels (their `block_damage` / `unblock_damage`, the recorded outcome of his shots as scripted `damage`, logs). See "Recorded duels of the human".
4. **`scheduledActions(o, actions)`** (B3): appends this tick's scripted actions after the setup (`ScriptedEvents.actions`: damage, weapons, grenade selection, plant / defuse fallbacks, drop logs).
5. **`pawnInput(pawn, o, actions)`** (B2): called once per REPLAY pawn (alive, not `o.human`, mode `REPLAY`), in id order. It returns the puppet's input and may append a snap (`teleport` + `log`) to `actions`, after the setup and scheduled actions. On the setup step every REPLAY pawn (puppets on or off) gets a neutral input at the yaw of its setup `teleport`: that observe predates the teleports, and the engine applies the input yaw after them, so echoing the observed (pre-setup) yaw would turn every pawn back to 0. Without puppets (no `walk`) the input is otherwise neutral: forward 0, side 0, the pawn's current yaw and pitch, no buttons. See "Puppets" below.
6. **`scriptedInput(input, pawn, o, prevYaw)`** (B3): layers the scripted look (aim, defuse, grenade pitch) and buttons (`ATTACK`, `USE`) on that input, except on the setup step, and writes the commanded yaw back to the puppet's state. `prevYaw` is the puppet's commanded yaw before this tick's movement input (the observed yaw without puppets).

`control(c)`:

- `start` and `restart` reset the state and arm the setup. `paused` and `speed` carry over.
- G4: `take_control {id}` is checked (a player id) and changes nothing: the engine hands the pawn over and the Core sees it in the next observe's `human` ("Takeover").
- `pause {paused}` and `speed {x}` are stored; `x` must be positive. The driver does the actual pausing and pacing: Core doesn't stop stepping by itself.
- B5: `checkpoint {id}` and `seek {t}` are checked (a non-empty id; seconds ≥ 0) and change nothing: checkpoints and seeking are the driver's work (a checkpoint stores `snapshot()`, a seek steps every tick as usual). `rewind {id}` arms a **resync**: the driver has restored this Core to the checkpoint and the engine couldn't be (no snapshot capability), so the next step puts the engine back first. See "Checkpoints, rewind, summary".

`snapshot()` / `restore()` save and restore the Core's own state (`setupPending`, `setupThisStep`, `startTick`, `lastTick`, `paused`, `speed`, each pawn's mode, trigger, since tick, (B5) `everLive` and (G1) `blocksLifted`, the armed `resync`, (G4) the last step's `human` (a snapshot from before G4: the pawn whose status is HUMAN), each puppet's `PuppetState`, the scripted events' `ScriptState`, (B4) the `DivergenceState`, (B5) the loadout ledger, (G1) the `RejoinState` list and (G5) the `DuelState` list) together with the seed. Snapshots from before G5 restore with every duel afresh; snapshots from before G1 restore with no rejoin state (a LIVE pawn's calm clock starts afresh), no LIVE spans and `blocksLifted` = `everLive`. Restoring checks that the seed matches. Every stored number is already canonical (yaw to 0.001°, `behind` to 6 decimals), so a restore continues exactly. A snapshot from before B5 restores with an empty ledger.

`puppet(id)` returns a pawn's `PuppetController` (or null without puppets) and `snapCount` the snaps since the last start. `script` is the `ScriptedEvents` (its `plan` and `state`), `divergence` the B4 `Divergence` (its `index`, `encounters` and `state`), `duels` the G5 `HumanDuels` (its `duels` and `state`), `modeOf(id)` a pawn's Core mode, `triggerOf(id)` its trigger, and the protected `setPawnMode(id, mode, tick, trigger)` is what the triggers switch through.

`rng` is a seeded `Rng` that nothing draws from yet. Draw through `rng.fork(label)`, keyed by tick and id, so the snapshot never needs the PRNG state.

## Puppets (`puppet.ts`)

A puppet is a REPLAY pawn driven along its recorded track with **per-tick inputs only** (`forward`, `side`, `yaw`, `pitch`, `buttons`), the way CS2 bots will be driven through usercmd injection. It never sets a position, except for an unseen snap at a teleport point. Not driven: the human's pawn, DEAD pawns and (B4) LIVE pawns.

### WalkQuery

Wall-aware steering needs "can a pawn walk straight from a to b?". The Core can't import an engine, so the engine passes a `WalkQuery { isWalkableLine(a, b), pathLength(a, b) }` (`src/contracts/walk.ts`; `pathLength` is G1's, for the rejoin planner only) to the `ReplayCore` constructor. The 2D sim's is `NavWalkQuery` (`src/sim2d/walk-query.ts`, `NavMesh.segmentWalkable`, 2D). In CS2 it becomes a nav-mesh raycast or a hull trace (`docs/port-notes.md`).

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
5. **Yaw**: the recorded yaw when known (two yaw samples ≤ 0.1 s apart bracket t; shortest-arc interpolation), else the heading of motion (bearing from before to ahead) while the recorded speed is ≥ `standSpeedThreshold`, else held. The commanded yaw turns toward that by at most `maxTurnRateDegPerTick` (12°). The recorded POV yaw never turns faster than 11.7°/tick, so recorded yaw is followed exactly; the limit only smooths motion headings and the switch between the two sources. Yaw is in (−180, 180], rounded to 0.001°. **V2** (`docs/viewfit.md`): "recorded" is first the view fitted to the video (`Track.view`, `PuppetTrack.recordedViewAt`: two `source: 'video'` samples ≤ 0.1 s apart, shortest-arc yaw, linear pitch), then the radar yaw; a scoped rifle (AWP, SSG 08) slower than `walkSpeedThreshold` holds its angle instead of turning to its heading (an AWPer walking or crouch-walking holds an angle). **Pitch**: the fitted pitch while known; held while watched without one (the fit failed: radar fallback); level (0) otherwise; turned from the observed pitch at the same 12°/tick (no new state: B3's aim also starts from the observed pitch). B3's aim overrides both during engagements, as before.
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

### Jumps (G3)

A track sample can carry `jump: 'plain' | 'crouch'` (the snapped 3D tracks mark where a puppet has to jump; the
current tracks need none, `docs/geometry.md`). `PuppetTrack.takeoffs` lists them. From `jumpWindowSec` (0.5 s) before
the take-off sample's tick to as long after the landing sample's, a puppet on the ground within `jumpReachUnits` (24)
of the take-off spot presses JUMP once: at once if it runs within about 25° of the take-off → landing bearing, else
it eases to the take-off spot and jumps from nearly standing (the snapping checks jumps from standing). Then it steers
at the landing sample, holding DUCK in the air for a crouch jump, until it is on the ground near the landing (or the
window is over). Each take-off is used once (`PuppetState.usedJumps`). Tested with synthetic tracks
(`tests/puppet.test.ts`).

### Snaps on CS2 Mirage (G3)

With 3D movement on the snapped tracks the golden master snaps 11 times instead of main's 6
(`tests/golden-round.test.ts` lists them). A puppet only snaps inside a teleport window (an over-speed stretch of its
track) when it is more than `driftSnapUnits` (96) behind and the human doesn't see it.

| Snap | Same as on main? | Cause |
| --- | --- | --- |
| cart 920 | main's cart 922 | the recording's own discontinuity |
| sp4rtan 1171 | main's sp4rtan 1165 | the recording's spike (inferred CT positions) |
| sp4rtan 1229, 1245 | main's sp4rtan 1248 | the same inferred 700 u/s stretch, split in two by the snapping |
| cart 1393 | main's cart 1350 | the recording's discontinuity, reached later |
| barely 2880 | main's barely 2879 | the recording's jump back up from the underpass |
| snarlbot 633 | new | T ramp: the 2020 z is 80 above CS2's floor there; the track rejoins the recording's floor in one step |
| donk 1344 | new (main's donk 923 is gone) | Apartments: CS2 raises the floor 32 units where the 2020 floor is flat; the track gets onto it in one step (a jump would do it: the snapping's detours have no jumps yet) |
| cart 1880, 4114 | new | A site: the recording walks through a box CS2 has; the snapping finds no way round in time |
| barely 2299 | new, on purpose | the recording drops from B short's corridor into the underpass (35.1 s); CS2 has no way down near by, so the track restarts on the recording's floor (keeping barely out of Mid's sight, as on main) |

Fixable later: the A-site box (a wider detour search), the Apartments step (detours with jumps) and the split
sp4rtan stretch; the floor mismatches are recording error against CS2's floors.

### The plant in never-peeks (G3)

`never-peeks` (and `cart-goes-a`, `miss-lokier-shop`) plant at 1768 instead of the tape's 1761, so the round ends
with 0.83 s on the bomb instead of 0.72. barely goes LIVE on the Balcony when he sees the outlived Lokier (21.8 s) and
kills him; on CS2 Mirage the 2020 drop under the Apartments window (x ≈ −1850) is a wall, so his LIVE leg leaves the
Balcony by its west end, and the B-site box the recording walks through is in his way to the plant spot. When he
rejoins (1483, 203 units off his track) G1's plant shift finds him 7 ticks short of the recorded USE start and starts
the plant at 1562 instead of 1555. Everything else is on the tape's ticks.

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
- **Only at what it sees (G6).** The yaw and pitch track the target's body only while the target is in the shooter's `sees` (the engine's report on that observe: eye to the target's aim points on the CS2 mesh, FOV, smoke, flash; `docs/vision.md`). Otherwise the shooter holds the **pre-aim on the recorded spot**: the band's point over the target's recorded feet where the engagement's next shot or hit lands (`Engagement.spots`: one per merged window, its last act tick and the target's recorded position one input latency later, clamped to the track's ends; `aimSpotAt` takes the first spot still ahead, else the last), at the same turn rate. So nobody tracks a target through a wall; the target walks into the pre-aim and the tracking starts on the first tick it is seen. Run-time engagements (B4's encounter aim) have no spots: out of sight the shooter keeps its hold (Lokier's angle on the window). The recorded damage still lands on its tick (the tape is the truth); a bullet fired at a wall ends at the wall (no engine damage between puppets anyway), and the engine logs each scripted hit whose eye-to-victim line is blocked (`script: scripted hit through geometry`, `docs/vision.md`). In the no-human round only the look changes (fixtures: positions by ≤ 4e-5 units, the rotated stick's rounding; no kill, damage, `sees` or bomb event moves).
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
- **G1: non-lethal stays non-lethal.** A recorded non-lethal hit on a pawn that has less HP than the tape at that point (a rejoined pawn hurt while LIVE) takes it down to 1 HP instead of killing it, so its death comes with the recorded kill. Never applies when nobody leaves the tape (the schedule's HP walk keeps every non-lethal hit below the HP left).

### The human

When `observe.human` is a pawn (normally cart):

- the Core sends it no input, no weapon change, no grenade, plant or defuse: he never fires by himself;
- no scripted damage to or from it at the recorded tick (one `debug` log per skipped entry: lokier's 73 on cart, cart's kill of lokier, sp4rtan's post-round kill of cart). B4 plays Lokier's hit on cart as a time-shifted, gated scheduled encounter ("Divergence"); G5 plays cart's kill of Lokier as the outcome of his own shots in their recorded duel ("Recorded duels of the human");
- no B3 `block_damage` pair involves it, so its fights are real: puppets still aim and shoot at the human, and the engine decides those hits. The exception (G5) are his recorded duels: while he is in one, his bullets on its target are blocked and resolved like the tape.

With `human === null` (the golden master) cart is a puppet like everyone else. G4: every rule above tests `observe.human` on the tick it applies, so from a mid-round takeover on they apply to him; the blocks he had as a puppet are lifted on the takeover tick ("Takeover").

### Drops and decisions

A fire item or engagement is decided once, on the first tick it is active (`ScriptState.decisions`): it is dropped if its shooter is the human (silently) or if its shooter or target is dead or LIVE then (one `info` log per fire item, e.g. `script: dropped sp4rtan ak47 spray at donk (5 shots from tick 3192): donk is dead`). Once started, it runs to its end: cart keeps firing at Lokier for 0.2 s after the 18.8 s kill, as recorded. A dropped engagement doesn't aim. A LIVE pawn gets no input at all.

**G1: what falls while a pawn is LIVE.** `ScriptState.liveSpans` keeps every LIVE period `[from, to)` (to = the rejoin tick, null while LIVE). Only what falls inside one is lost; everything the plan has for the pawn after its rejoin runs as usual (each item is decided on its own first active tick, damage on its emission tick, inventory and utility on their ticks):

- a fire item or engagement it was in the middle of when it went LIVE (started before, still running after the rejoin) does not resume;
- a grenade throw whose window (draw to restore) overlaps a LIVE period is skipped whole (no draw, no ATTACK on the gun it holds, no restore);
- a pickup made while LIVE is given at the rejoin (reconciliation, "Rejoin");
- the plant and defuse fallbacks: no `plant` for a planter who was LIVE in the USE window, and no `defuse_start` when the round shows the bomb planted further than `bomb.defuseRange` from the defuser (a LIVE T may have planted it elsewhere); neither guard changes a run where nobody leaves the tape.

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

- **2D line of sight.** The damage is scripted, so whether a bullet hits doesn't matter here, but it shows where the 2D map differs: the aim is right (yaw within 0.3°, the intended band), yet 6 of the 13 fire items with a target didn't reach it through the 2D nav line of sight. With C4's sight mask (`docs/vision.md`, `npx tsx tools/vision-shots.ts`) 9 of 13 have sight at a shot and 10 get an engine hit (`host.combatLog()` lists them as blocked hits): cart ↔ Lokier through the Apartments window now reach. Still blocked: snarlbot → incredibad (incredibad's inferred spot; the hit still lands on his circle), sp4rtan → snarlbot (inferred route), barely → Zwomp (barely's recorded spot is a level too low) and sp4rtan → barely (a B-site pillar, ~25 units). In CS2 these become real traces. G6: on the CS2 mesh, 9 recorded hits and kills land while the attacker's eye-to-victim line is blocked (the audit list in `docs/vision.md`, "Scripted hits through geometry"): the recording's positions conflict with the mesh there.
- **No spread or recoil** in 2D; in CS2 a sprayed AK drifts, which only matters for the human's real fights (puppet damage is scripted, and so, G5, is the outcome of his shots in his recorded duels).
- **Grenades** are thrown blind (see Utility). Self-damage is blocked; a teammate would be hurt only with friendly fire on.
- **Plant and defuse** rely on the engine's rules (C3 in 2D, the game in CS2); the fallbacks cover an engine that doesn't plant or report the defuse start, not one that interrupts a defuse (a `defuse_stop` is not retried).

## Divergence (`divergence.ts`, B4)

By default the round replays exactly. When the human does something different, only the puppets whose world actually changed go **LIVE** (the engine's AI drives them, carrying their recorded intent as a goal), and everyone else keeps replaying. A puppet follows its recording until something happens that its recorded self never experienced; divergence spreads only through cause and effect from an **off-script** pawn (the human, or a LIVE pawn): damage, sight, gunfire, a body block. A cancelled event alone changes nothing: B3 drops the shots and damage whose other side is dead or LIVE and the puppet carries on replaying (barely's 44.2 s kill of an already dead Zwomp).

**Modes** (G1): REPLAY → LIVE (a trigger below, or G4's `released`: the human let go of the pawn without a rewind) → REPLAY again once the reason is gone (**rejoin**, below: calm, still alive on the tape, its state fits the recorded future) → LIVE again if something new reaches it, and so on; DEAD ends it. A pawn with no tape left (outlived) stays LIVE. The human is never LIVE or REPLAY. Before G1 modes went one way (REPLAY → LIVE → DEAD): one small deviation by the human (cart idle in Back Alley) cascaded through the rest of the round (never-peeks ended in a T win instead of the recorded CT defuse).

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

**The switch.** In the same Act: `unblock_damage` for every pair involving the pawn that B3 blocked (its self pair, then both directions with every enemy that is neither the human nor LIVE, dead ones included; plus an encounter's standing block), then `set_mode {id, mode: LIVE, goal}`, then the `log` line. The pawn gets no Core input from that tick on; the engine's AI first moves it in that tick's `tick()`. B3 drops whatever the plan has for it while it is LIVE (`script: dropped … : <id> is LIVE`); G1 brings it back ("Rejoin").

### Expected encounters (`ExpectedEncounters`)

Built once from the schedule and `round.json` `sightings[]`:

- **Pairs** (symmetric: in a recorded engagement both sides count as seeing each other): every `shot` and `burst` with a target (the burst over its whole window), every `damage` and `kill` (attacker, victim), every `sightings[]` entry (`who` with each player its free-text `by` names: "eradicate's radar" → eradicate, "cart / barely" → barely, cart; `RoundModel.sightings`). `saw(a, b, tick)`: some span of the pair within `expectedSightingWindowSec` (2 s) of the tick.
- **Fire**: every `shot`, `burst` (its window) and `kill` (a kill implies a shot) by its shooter. `fired(shooter, target, tick, shift)`: some span within `expectedGunfireWindowSec` (2 s) of `tick − shift`.

### Scheduled encounters: Lokier on B (`EncounterPlan`, `EncounterState`)

Every non-lethal recorded hit on the default human by an enemy is a scheduled encounter, active while that player is the human (G4: from a takeover on, by the takeover's time: "Takeover"; while nobody plays it only notes when the shooter first sees the puppet at the spot, `puppetSightTick`): here exactly one, Lokier's 73 HP / 7 armor SSG 08 hit on cart at 18.50 s, from the 17.45 s sighting (the time shift's origin), with cart's recorded spot at the hit, (−1764, 800) at the Apartments window. It is time-shifted, not divergence:

- **Setup**: B3's recorded tap and aim of that hit are suppressed (`ScriptedEvents.suppress`), and from the recorded aim's start (tick 1161) Lokier **holds the angle** on the spot (a B3 `HoldItem`: he looks at chest height there whenever no engagement is active), after replaying to his track's end on B and holding there.
- **waiting → seen**: the first tick Lokier (REPLAY) has cart in `sees` within `humanSpotToleranceUnits` (192) of the spot. **G5: on course then** (`onCourse`: within `offCourseUnits` of his recorded track at that tick, so he is the recording, as for trigger 2) the hit is due on its **recorded tick** (18.50 s, 1184) if that is at least one latency ahead (`encounterShotTick`): tape-like play gets the tape's hit whatever tick the engine's sight catches him on (the 2D sight sees the follow run's cart at 17.59 s, tick 1126, when he comes within 192 u of the spot; the recording's sighting is 17.45 s, 211 u out). Otherwise (early, late, or at the spot off his track) the hit is due `encounterDelaySec` (1 s) later, as in B4. Lokier aims at cart's chest from now (a run-time B3 engagement). Logged with the shift against the recording (and `(on course: the recorded tick)`).
- **seen → fired**, on the hit's act tick, if the **gate** passes (Lokier still REPLAY, cart in his `sees` and within the tolerance of the spot): `block_damage lokier → cart` (the scripted hit replaces the engine's bullet), the tap (a run-time B3 fire item: the shot and its sound are real) and the recorded `damage` (73 / 7, chest), landing on the due tick. The block is lifted when Lokier's shot is seen, or when he goes LIVE. If the gate fails, Lokier goes LIVE (`encounter`) and fights.
- **done**: when Lokier or cart dies or Lokier leaves REPLAY. B3 skips the recorded kill (cart is the human: he never fires by himself); G5: cart's own shots at Lokier from the window are the **recorded duel** this encounter opens (shifted with its hit), so if he fires on Lokier there the recorded kill lands like the tape (18.80 s plus the shift), and outside it his bullets are real ("Recorded duels of the human"). If Lokier is still alive at 18.80 + 3 s, he has outlived his recording (trigger 4): LIVE, `hold` on B with the SSG 08, no forced death; the Ts walking onto the site then see a live enemy.
- **Sightings it owns** (`encounterOwnsSighting`): during `seen` always (the gate decides), and while `waiting` or `fired` only with cart at the spot. Seen anywhere else, cart is judged by trigger 2 (on course, a recorded pair ±2 s, else LIVE): rushing the window 9 s early is fine, walking up to Lokier on B after the hit isn't.

Sp4rtan's post-round kill on cart stays real, if it happens (B3: an implied tap, the engine decides). G5: cart's sprays at sp4rtan (the defuse, after the round) are recorded duels whose outcome is no damage.

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

`status` reports the human's living pawn as **`HUMAN`** (`MODES` gained it; status only, `set_mode` still takes `REPLAY | LIVE`; `trigger` null), DEAD once dead; G4: from the takeover tick (`sinceTick`), REPLAY before it. With `human === null` it never appears, so the golden master was byte-identical (`e6c2be70` then; `e9a228d9` since F's cover). The renderer's badge reads it ("YOU").

### Tunables (`data/tuning.json` → `replay`, B4)

| Key | Value | Meaning |
| --- | --- | --- |
| `expectedSightingWindowSec` | 2 | A recorded pair counts as seeing each other this long around its spans. |
| `expectedGunfireWindowSec` | 2 | A shot is recorded fire this long around the shooter's recorded fire. |
| `encounterDelaySec` | 1 | A scheduled encounter's hit lands this long after the shooter first sees the human at the spot (recorded: 17.45 → 18.50 s). |
| `humanSpotToleranceUnits` | 192 | The human is at an encounter's spot within this (2D). |
| `routeThinUnits` | 64 | LIVE route thinning tolerance. |
| `offCourseUnits` | 64 | Off course: the human beyond it is off script; a body block must push a puppet this much further (or hold it beyond it); G1: a LIVE pawn this close to its tape (now, or up to `steerFallbackSec` ago) may switch back to REPLAY. |
| `contactSlackUnits` | 4 | Body contact: centres within 2 × `collision.pawnRadius` + this. |
| `blockedSec` | 0.25 | Held in contact this long (slower than `standSpeedThreshold`) counts as blocked. |
| `dwellUnits` | 64 | Radius of a "stay" for the post-plant guard spot. |

### Rejoin: LIVE → REPLAY (`rejoin.ts`, G1)

A pawn that went LIVE because of something off-script goes back to its recording once that reason is gone, so the rest of the round plays out as recorded: CS2 bots would have to do it the same way, so it is done with the same means (a LIVE goal for the engine's AI, then per-tick inputs; never a teleport, never faster than the weapon runs). `Rejoin.step` runs every tick after the triggers, for every LIVE pawn (not the human), in id order:

| # | rule | detail |
| --- | --- | --- |
| 1 | **unrest** (`unrestReason`) restarts the calm clock | this tick it was hit by anyone (world and self damage don't count); it fired a shot itself; an alive enemy is in its `sees` that isn't the recording: off script (LIVE, or the human off course) or a REPLAY enemy the recording doesn't have it engaging or seeing around now (`ExpectedEncounters.saw`); the human on course and a pair a scheduled encounter owns are the recording, as for trigger 2; or it heard off-script enemy gunfire that isn't recorded fire (trigger 3's rule) |
| 2 | **hysteresis** | LIVE for at least `rejoinMinLiveSec` (1 s) and calm for `rejoinCalmSec` (1 s): it can't flicker |
| 3 | **busy** (`busyReason`) | not while defusing (`round.bomb.defuser`), nor holding the c4 (the LIVE AI plants or is about to) unless the Core drew it for the approach (rule 7) |
| 4 | **fits its recorded future** at the rejoin tick k (`fitsAt`) | the recording keeps it alive and tracked until k + `rejoinMinTapeSec` (1 s): an outlived pawn (Lokier) has no tape and stays LIVE; **the planter** with the bomb unplanted must carry it and k ≤ the recorded plant tick (the plant can't happen twice: once the bomb is planted, by him as AI or anyone, the scripted plant is moot because `ScriptState.plantedTick` is set); **the defuser** with the bomb planted needs it within `bomb.defuseRange` of his recorded defuse spot and k ≤ the scripted USE start; nobody once the round is over with the bomb still ticking (the AI is leaving the blast) |
| 5 | **switch** (REPLAY) | on the first tick 1–4 hold and the pawn is within `offCourseUnits` (64, 2D) of its puppet reference now or of where it was up to `steerFallbackSec` (2 s) ago (`lagTicks`, every 4 ticks back): on the tape's route, at most as late as the puppet's wall-aware catch-up can follow. The puppet's catch-up (run speed, steering back to the latest reference point in walkable line) absorbs the rest |
| 6 | **approach** otherwise (`plan`) | the earliest sample of its reference track after now, up to `rejoinHorizonSec` (15 s) ahead, that fits (4) and that it can reach in time: walk length (straight if `isWalkableLine`, else `WalkQuery.pathLength`) ≤ run speed of the held weapon × `rejoinSpeedFactor` (0.85) × (time to it − `rejoinLeadSec`, 0.25 s); the straight line is checked first, at most 32 path queries per plan. Sent as `set_mode {id, LIVE, goal {route: [], role: 'rejoin', hold: that point}}`: the engine's AI runs there and still fights what it meets (docs/ai.md); the switch (5) usually comes on the way |
| 7 | **chase** when nothing is reachable in time | the furthest fitting sample of the horizon, if its walk is not a detour (≤ the distance to the reference + the tape's own length from there + `offCourseUnits`; the 2D nav has no one-way drops, so it walks round what the tape drops down); checked again every `rejoinRetrySec` (0.5 s) for a point reachable in time. A pawn that trails a track running at about its own speed (sp4rtan after a fight) thus runs after it instead of walking its old goal. **Never for an objective pawn** (the planter with the bomb unplanted, the defuser with it planted): its LIVE AI keeps the objective unless a point is reachable in time. The planter on an approach into his plant window draws the c4 on the way (from the recorded draw tick on; again after a fight), as the tape has him doing |
| 8 | **re-plan, give up** | an approach is planned again when the calm was broken after it or `rejoinLateSec` (1 s) after its tick; if no point fits or is reachable then, the pawn gets its regular LIVE goal back (`set_mode` LIVE with `liveGoal`, log `<id> rejoin: gave up, …`); a plan that found nothing waits `rejoinRetrySec` |
| 9 | **cycles** | a rejoined pawn is a REPLAY puppet like any other: B4's triggers apply and may make it LIVE again (barely in never-peeks: LIVE, back, LIVE again when he hears sp4rtan fight cart, back) |

**The switch** sends, in this order in the Act, after the triggers' actions and before B3's:

1. `block_damage` for the pairs B3 blocked at the round start and the LIVE switch lifted: its self pair, then both directions with every enemy that is neither the human nor has its own blocks lifted (LIVE, or dead since it was LIVE), dead puppets included; a pawn rejoining earlier in the same tick counts as back. Invariant (tested over whole runs): an enemy or self pair is blocked exactly when neither pawn is the human or has its blocks lifted.
2. **Reconciliation**: a `give` (tuning clip / reserve) for each pickup the plan made while it was LIVE that the loadout ledger doesn't show (sp4rtan's AK at 19.6 s if he was LIVE then), then `set_weapon` to the weapon the recording shows at this tick (`recordedWeaponAt`) if it holds something else, or the c4 for a planter back after the recorded draw tick. **The planter back before the recorded plant**: the scripted USE starts when the c4 is deployed (drawn on the approach, on the recorded draw tick, or now: `deployTicksOf('c4')`) and he can be at the recorded spot (the shorter of the straight / nav walk and the walk back along the tape, at run speed), never before the recorded USE start; later than that, the whole plant (USE window and fallback) runs that much late (`ScriptedEvents.shiftPlant`, logged `script: plant by barely runs 0.7 s late …`). Ammo and HP are not reconciled: the scripted damage doesn't depend on ammo, and a non-lethal scripted hit on a pawn with less HP than the tape leaves it at 1 HP ("Scripted events" → Damage).
3. `set_mode {id, mode: REPLAY, goal: null}` and the log line `<id> REPLAY: rejoined at tick <k>, <n> u from its track[ (<x.x> s behind it)], after <y.y> s LIVE (<trigger>)`. An approach logs `<id> rejoin: heading for|chasing its track at tick <k> (+x.x s), <n> u by nav; goal rejoin`.

From that tick the pawn's status is `REPLAY` with trigger `rejoin` (the HUD's status panel shows it; during an approach the LIVE pawn's aiDebug line shows role `rejoin` and behaviour `rejoining`), it gets the puppet's input again, and B3 runs everything its plan has after the rejoin tick ("Scripted events" → Drops and decisions, G1). A resync rewind (B5) restores the blocks from `blocksLifted` and gives an approaching pawn its rejoin goal back.

**State** (`RejoinState`, one per LIVE pawn, in the Core snapshot): `liveSince`, `trigger`, `calmSince`, the `target` in force (`tick`, `pos`, `plannedTick`, `pathUnits`, `chase`), `nextPlanTick`, `drawTick` (the c4 drawn for the approach). Plain data, integer ticks.

#### Tunables (`data/tuning.json` → `replay`, G1; validated in `parseTuning`)

| Key | Value | Meaning |
| --- | ---: | --- |
| `rejoinCalmSec` | 1 | Calm (no unrest) this long before a LIVE pawn may head back or switch. |
| `rejoinMinLiveSec` | 1 | LIVE at least this long (hysteresis). |
| `rejoinMinTapeSec` | 1 | The recording keeps the pawn alive and tracked this long after the rejoin tick. |
| `rejoinSpeedFactor` | 0.85 | A point is reachable when its walk ≤ this × run speed × the time left (0 < f ≤ 1). |
| `rejoinLeadSec` | 0.25 | Taken off the time left before that check (reaction, acceleration, the AI easing off). |
| `rejoinHorizonSec` | 15 | How far ahead along its track the planner looks. |
| `rejoinLateSec` | 1 | An approach not done this long after its target tick is planned again. |
| `rejoinRetrySec` | 0.5 | Wait after a plan that found nothing; a chase is re-checked this often. |
| (`offCourseUnits`, `steerFallbackSec`) | 64, 2 | The switch tolerance and how late (behind its tape) the switch may be. |

`parseTuning` requires all eight and checks the ranges (times ≥ 0, horizon and retry > 0, the speed factor in (0, 1]).

#### Results: never-peeks (cart idle in Back Alley all round; `tests/rejoin.test.ts`)

| event | recorded | B4 alone (before G1) | with rejoin |
| --- | ---: | ---: | ---: |
| lokier LIVE: outlived (cart never shot him) | – | 21.80 | 21.80 (stays LIVE: no tape) |
| barely LIVE: sees lokier; kills him | – | 21.81; 22.17 | 21.81; 22.17 |
| barely REPLAY (160 u, 0.6 s behind his tape) | – | never | 23.19 |
| barely plants | 27.52 | 28.41 (AI) | **27.52** |
| sp4rtan LIVE: sees cart; kills him | – | 40.06; 40.58 | 40.06; 40.58 |
| barely LIVE: hears sp4rtan fire (1,372 u) | – | – | 40.27 |
| sp4rtan REPLAY (72 u) / barely REPLAY again (92 u, after a 1.2 s approach) | – | never | 41.59 / 42.33 |
| barely kills Zwomp | 44.20 | 43.41 (AI) | **44.20** |
| sp4rtan kills donk | 50.35 | 49.97 (AI) | **50.34** (tick 3222, the golden master's) |
| sp4rtan kills barely (HS) | 58.85 | – (barely kills sp4rtan at 59.61: T elimination) | **58.84** (tick 3766) |
| sp4rtan's kit defuse | 66.80 | – | **66.80**: CT bomb_defused 12 – 15, 0.72 s on the bomb |

Every event that doesn't involve cart is on the golden master's observe tick. With `rejoin: false` the run is B4's byte for byte (digest `b424522f`). The puppets catch up after the switch: barely within 24 u in 0.88 s, sp4rtan in 2.3 s; nothing teleports and nothing runs above its weapon's run speed (beyond the engine's own ≤ 5 % acceleration transients) from a LIVE switch to 2 s after the rejoin.

#### Known limits

- **2D nav: no one-way drops** (`docs/nav.md`): the LIVE AI and `pathLength` walk round what the tape drops down (Balcony → B). Variant of `miss-lokier-shop` with cart hiding at (−1450, 760): Lokier, still alive, sees him through the sight mask's over-wide Apartments window at 21.02 s and goes LIVE; barely meets him at the window *before* his recorded drop, kills him at 21.48 s, and his LIVE AI walks round by Back Alley and Tunnel Stairs (3,192 u by nav): no point is reachable in time, the planter never chases, so the AI plants at 36.67 s (+9.15 s); he rejoins at 41.97 s and from then on every event is the tape's (Zwomp 44.20, donk 50.34, barely 58.84, defuse 66.80, CT win with 9.88 s on the bomb). In CS2 the bot drops from the Balcony.
- **Late planter.** A planter back after the recorded draw tick plants late by the c4's deploy (1 s, `damage.defaultDeploySec`, which CS2 needs; the 2D engine doesn't) unless the approach drew it: in never-peeks it did, so the plant is on the tape.
- **No late defuse**: a defuser who can't be back by his scripted USE start stays LIVE and defuses as AI.
- **Lagging switch**: a pawn may rejoin up to 2 s behind its tape; until the puppet catches up its scripted shots aim from where it is (the damage is scripted, so kills land on the tape's ticks), and a puppet snap at a teleport point can still happen (B2's rule).
- **The recording's own sightings** decide "unexpected enemy in sight" (2 s windows per pair, not positions): a LIVE pawn that runs into a REPLAY enemy the tape doesn't pair it with stays LIVE and the AI fights it.

### Scenarios (`tests/scenarios.test.ts`, `fixtures/scenarios/*.json`)

Played by the human-bot (`tools/human-bot.ts`: `followRecording`, `walkTo`, `aimAt`, `fire`, `holdStill`, `throw`, setup `teleport`; `npm run harness -- --scenario <file>` prints the timeline). Seed 1, deterministic. Shared invariant: a puppet nothing touched replays exactly; on every tick it is REPLAY (and not body-blocked, and, G1, not LIVE yet: a rejoined pawn catches up from where its LIVE self left it) it is within 0.01 units of the no-human golden master's position (measured: 0.0005 at most, in every scenario). Where a LIVE fight's winner depends on the toy AI, the tests assert the triggers and print the winner. The recorded opening (snarlbot's kills of incredibad and snakelore, Lokier's of eradicate, sp4rtan's of snarlbot) is the same in all but `cart-dies` and is left out.

**1. No-op guard.** Golden no-human round: no switch, no `set_mode`, no `HUMAN`. `cart-follows-recording`: **no switch** (F; before F exactly one), and since G5 **the tape**: "Played it like the tape: CT defuse, 0.72 s left", every kill on the golden master's tick. Lokier sees cart at 10.9 s down the corridor from Truck, but cart is on course (no divergence). The encounter starts when he sees cart at the window at 17.59 s, on course, so the hit is due on the recorded tick; cart is in the recorded duel from then (his bullets on Lokier blocked). Before G5 cart's real AK headshot killed Lokier at 18.50 s, before the hit (due 1 s after the sighting, 18.59 s), so cart kept 100 HP and survived sp4rtan's post-round shot ("2 kills changed"; 2D has no spread, so the first bullet of the spray was a headshot). Cart's recorded spray at the defusing sp4rtan (65.9–66.9 s) hit nothing on the tape; until F the follow script aimed it at sp4rtan with B3's aim, and with no spread and no box on the line (`docs/vision.md`, "Cart's spray") it hit him for real at 65.91 s (sp4rtan LIVE, T elimination 11 – 16, the bomb killing cart at 67.52 s). The follow script looks where cart's recorded view does on the shots the tape shows missing (`tools/follow-aim.ts`, `docs/golden.md`), 17–22° off sp4rtan; since G5 that spray (and the post-round one) is a recorded duel with no damage anyway:

| t (s) | event |
| ---: | --- |
| 17.59 | encounter: cart in sight at the spot (+0.1 s), on course: hit due on the recorded tick, 18.50 s; duel cart → lokier from here |
| 18.50 | Lokier's scripted hit 73 / 7 (cart 27 HP / 93 armor); cart's first shot would hit Lokier (head): blocked |
| 18.78 | duel: his spray is on Lokier through the recorded kill (on target at 18.50 s, still firing at 18.70 s) |
| 18.80 | cart kills lokier (AK-47, HS; the duel's scripted kill, tick 1203); encounter and duel over; his 4th shot (18.81 s) hits a dead Lokier, as the puppet's does |
| 27.52, 44.20, 50.34, 58.84, 61.80 | plant, barely → zwomp, sp4rtan → donk, sp4rtan → barely, defuse start: as recorded |
| 65.55–66.92 | duel cart → sp4rtan (defusing): 11 shots, none would hit, no damage (as the tape) |
| 66.80 | sp4rtan defuses: round_end CT bomb_defused, 12 – 15, 0.72 s on the bomb (the tape: 0.72 s) |
| 68.30–69.30 | duel cart → sp4rtan (post-round): 7 shots, no damage |
| 69.41 | sp4rtan's post-round shot (B3's single implied tap) kills cart (27 HP), tick 4442, as recorded |

**2. `lokier-late`**: cart follows to 16.6 s, holds back in the Apartments, peeks at 19.5 s, waits for the hit, fires; then walks his recorded way to Shop and follows again.

| t (s) | event |
| ---: | --- |
| 20.14 | encounter: cart in sight at the spot (+2.7 s), off course (his recording is at the Balcony end of the window by then): hit due 1 s later, 21.14 s; G5: the recorded duel from here, shifted +2.64 s with the hit |
| 21.14 | scripted hit 73 / 7 (cart 27 HP / 93 armor) |
| 21.44 | cart kills lokier (AK-47, HS): G5's duel lands the recorded kill on its shifted tick (18.80 + 2.64 s; his first shot, at 21.42 s, would hit and he is still firing); before G5 that first shot killed him for real a tick earlier |
| 27.52 – 61.80 | plant, Zwomp, donk, barely kills, defuse start: on the golden master's ticks |
| 66.80 | sp4rtan defuses: CT bomb_defused, 12 – 15 (no switch: cart's spray misses as in the follow run; F. Before: sp4rtan LIVE at 65.91 s, hit by cart, killed cart at 66.19 s and died in the explosion, T bomb_exploded 11 – 16) |
| 69.41 | sp4rtan kills cart (27 HP) after the round, as recorded |

**3. `never-peeks`** (cart stands in Back Alley all round; John's case, "Rejoin" → Results):

| t (s) | event |
| ---: | --- |
| 21.80 | **lokier LIVE: outlived recording (+3.0 s)** → `hold`, route [], hold his last sample on B; no tape left, so he never rejoins |
| 21.81 | **barely LIVE: sees lokier (LIVE), not in the recording** → `plant` |
| 22.17 | barely kills lokier (real; donk, dwelling in the Apartments, never saw him) |
| 23.19 | **barely REPLAY: rejoined** (160 u, 0.6 s behind his tape) |
| 27.52 | barely plants (scripted, on the tape's tick) |
| 40.06 | **sp4rtan LIVE: sees cart (the human)** on his flank → `defuse`; 40.27 **barely LIVE: heard sp4rtan fire**; 40.58 sp4rtan kills cart |
| 41.59, 42.33 | **sp4rtan REPLAY**, **barely REPLAY** again (after a 1.2 s approach) |
| 44.20, 50.34, 58.84 | barely kills zwomp, sp4rtan kills donk and barely (HS): scripted, on the tape's ticks |
| 61.80 – 66.80 | sp4rtan defuses with the kit: round_end CT bomb_defused, 12 – 15, 0.72 s on the bomb |

Before G1: barely and sp4rtan stayed LIVE, barely planted at 28.41 (AI), killed zwomp at 43.41, sp4rtan killed donk at 49.97 and barely killed sp4rtan at 59.61: T elimination, 11 – 16; the bomb exploded at 68.41 s with barely (LIVE) out of its blast.

**4. `mid-zwomp`** (cart follows to 29.7 s, then is teleported into Middle):

| t (s) | event |
| ---: | --- |
| 29.72 | **zwomp LIVE: sees cart (the human)** |
| 29.73 | cart kills zwomp (AK, HS) |
| 43.58, 44.19 | `script: dropped barely ak47 burst at zwomp (7 shots from tick 2789): zwomp is dead`, and the lethal damage; barely keeps replaying |
| 50.34 – 66.80 | as recorded; sp4rtan was at least 1,785 u from cart's shots (hearing range 1,500), so he stays REPLAY; CT bomb_defused, 12 – 15 (G1: unchanged, zwomp dies a tick after going LIVE) |

**5. `flank-sp4rtan`** (cart follows to 44.6 s, then waits in Back Alley):

| t (s) | event |
| ---: | --- |
| 44.61 | **sp4rtan LIVE: sees cart (the human)**; 44.63 cart kills him (HS): round_end T elimination, 11 – 16 (no CT left) |
| 49.83 – 58.83 | sp4rtan's shots and damage on donk and barely dropped (`sp4rtan is dead`) |
| 53.34 | **donk LIVE: outlived recording (+3.0 s)** → `guard_bomb`; the round is over, so he leaves the blast at once (F) |
| 61.84 | **barely LIVE: outlived recording (+3.0 s)** → `guard_bomb`, leaves the blast too |
| 67.52 | the bomb explodes: donk is 1,826 units away (100 HP), barely 1,564 (74 HP); both live. Before F the 2D AI stayed by the bomb and both died. G5: cart dies in it, in Back Alley on 27 HP (his recording up to 44.6 s now takes Lokier's hit at 18.50 s and kills him in the duel at 18.80 s; before G5 his real headshot at 18.50 s came first and he kept 100 HP) |

**6. `cart-dies`** (cart teleported to the window at 8 s, 9.5 s early, never fires):

| t (s) | event |
| ---: | --- |
| 8.02 | encounter: cart in sight at the spot (−9.4 s), hit due 9.02 s |
| 9.02 | scripted hit 73 / 7 (cart 27 HP) |
| 10.38 | cart walks off the window: **lokier LIVE: sees cart (the human), not in the recording** |
| 10.81 | **donk LIVE: sees lokier (LIVE)** |
| 10.84 | lokier kills cart (SSG 08, real) |
| 11.30 | donk kills lokier; **zwomp LIVE: heard donk fire 1387 u away** |
| 12.31, 13.22 | G1: **donk REPLAY** (15 u from his tape), **zwomp REPLAY** (after a 0.9 s approach) |
| 15.75 | **eradicate LIVE: outlived recording (+3.0 s)** (Lokier's 12.75 s kill was dropped): no tape, he stays LIVE |
| 17.84, 27.52 | sp4rtan kills snarlbot, barely plants: as recorded (untouched puppets) |
| 44.20, 50.34 | barely kills zwomp, sp4rtan kills donk: on the tape's ticks again (before G1: barely killed a LIVE zwomp at 31.09 s) |
| 57.84 | **sp4rtan LIVE: hit by eradicate** on B; 58.05 eradicate kills him: T elimination, 11 – 16 (before G1: donk killed sp4rtan at 53.19 s) |
| 61.84, 67.52 | barely LIVE (outlived); the bomb explodes, barely and eradicate (LIVE) have left its blast and live (F) |

**7. `block-barely`**: cart stands in barely's path in the Apartments corridor, looking at him. Teammates aren't solid (`collision.solidTeammates` false, `mp_solid_teammates 0`): barely walks through, never blocked, never off course; no switch to 21.5 s (G1: unchanged, the scenario ends before anyone goes LIVE). **7b. `block-sp4rtan`**: cart (teleported at 57 s) stands in sp4rtan's way to the bomb. The pair is recorded in sight on B from 58.6 s (no sighting trigger); sp4rtan is held in contact from 58.9 s and goes **LIVE: blocked by cart, held 110 u off course, seen by cart** at 59.16 s, then kills cart (59.70 s). G1: **sp4rtan REPLAY** at 60.72 s (35 u) and the scripted defuse starts on the tape's tick, 61.80 s (before: a LIVE defuse from 61.09 s).

**8. `smoke-window`**: cart smokes the window from the Apartments at 15 s and walks to his recorded spot: within the spot tolerance from 18.0 s (on the spot from 19.0 s), over the recorded hit at 18.50 s, unseen. No encounter starts until he steps west out of the smoke: in sight at 20.11 s (+2.6 s), the hit at 21.11 s, cart kills Lokier at 21.41 s (G5: the duel's kill on the recorded 18.80 s shifted +2.61 s with the hit; his spray from 21.38 s is on Lokier through it; before G5 his real headshot at 21.38 s); no switch.

**9. `cart-goes-a`** (G1; cart takes A instead of B and never fires: from Back Alley through House and T spawn, down past Palace Alley to A main, where he waits looking at A):

| t (s) | event |
| ---: | --- |
| 19.73 | **sp4rtan LIVE: sees cart (the human)**, his flank coming down A main; 20.91 sp4rtan kills cart |
| 21.80, 21.81, 22.17 | lokier LIVE (outlived), barely LIVE (sees him), barely kills him: as in never-peeks |
| 21.92 | **sp4rtan REPLAY** (264 u, 1.2 s behind his tape; within 24 u 6.4 s later) |
| 23.19 | **barely REPLAY** |
| 27.52 – 66.80 | plant, Zwomp, donk, barely, defuse: all on the tape's ticks; CT bomb_defused, 12 – 15, 0.72 s left |

**10. `miss-lokier-shop`** (G1; cart plays his recording to the window, takes Lokier's scripted 73, sprays 6° wide and misses: Lokier lives. He backs off deep into the Apartments out of Lokier's sight, waits, then takes his recorded way over the Balcony drop and across B to Shop and hides there all round):

| t (s) | event |
| ---: | --- |
| 17.59, 18.50 | encounter: cart in sight at the spot (+0.1 s), on course: the scripted hit on the recorded tick (cart 27 HP; before G5 at 18.59 s). He is in the recorded duel, but his spray, 6° wide, has no shot that would hit Lokier: nothing is forced, Lokier lives |
| 21.80, 21.81, 22.17 | lokier LIVE (outlived), barely LIVE (sees him), barely kills him |
| 23.19 | **barely REPLAY** |
| 27.52 – 66.80 | plant, Zwomp, donk, barely, defuse: all on the tape's ticks; CT bomb_defused, 12 – 15; cart ends the round in Shop on 27 HP |

With cart hiding nearer the window (−1450, 760), see "Rejoin" → Known limits.

**11. `duel-perfect-aim`** (G5; cart plays his recording into the Apartments, stops at 18.0 s, aims at Lokier's head and fires until he is dead, every shot on target from the first): his first shot (18.05 s) would already hit, in the head, 0.47 s before the tape's first; it and the seven after it (all would-hit, all head) are blocked (no damage); Lokier's hit lands first, on its recorded tick (18.50 s), and the kill lands on the recorded 18.80 s (tick 1203), not on his first shot. Then he follows his recording again: "Played it like the tape: CT defuse, 0.72 s left", nobody LIVE.

**12. `early-peek-lokier`** (G5; cart plays his recording into the Apartments corridor and at 16.4 s, before Lokier has seen him at the window and a second before the recorded sighting, shoots Lokier through the window from the corridor, 370 u from the duel's spot): another place and time than the recorded duel, so his bullets are real. Lokier dies at 16.45 s (real AK headshot), the encounter is over before it starts, there is no duel with him and no hit on cart; Zwomp hears the unrecorded fire, goes LIVE and rejoins (18.38 s). Then cart follows his recording: CT defuse, 0.72 s left; 2 kills changed (cart → Lokier 2.3 s early; cart, on 100 HP, survives the post-round shot).

**13. `takeover-mid-duel`** (G5; nobody plays until 18.6 s, in the middle of the recorded duel, then the player keeps playing the recording): the puppet's spray has fired its first shot (18.50 s) and Lokier's hit has landed on the puppet; the takeover arms the duel (the puppet's shot starts his spray), he keeps spraying, and the kill lands on 18.80 s: "Played it like the tape". See "Recorded duels of the human" → Takeover.

### Known limits

- **2D sight**: the sight mask's window over B is the whole Apartments wall, and Truck sees down the whole corridor (Lokier sees cart at 7–11 s in several runs), so sighting-driven divergence is wider in 2D than it would be in CS2. Expected spans are per pair and time, not position.
- **Toy AI**: LIVE fights are the C4 bot's; a 2D LIVE Lokier at 1,750 u rarely lands a hit. Since F it leaves the bomb's blast after the round and gives up a defuse that can't finish (`docs/ai.md`).
- **No spread**: a scripted human's shots hit wherever they are aimed, the sight mask and cover permitting; the follow script aims the shots the tape shows missing where cart's recorded view was (`tools/follow-aim.ts`). The human-bot's `followRecording` does the same. G5: in his recorded duels the outcome is the tape's whatever the aim does (the kill of Lokier on its tick, no damage on sp4rtan), so this matters only outside them.
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
3. `block_damage` / `unblock_damage` for **every** self pair and ordered enemy pair: blocked when neither pawn is the human or has its blocks lifted (`blocksLifted`: it went LIVE and hasn't rejoined since; `everLive` before G1), plus a scheduled encounter's standing block. 50 + 10 actions.
4. `log {info, "rewind <id>: resync to tick <k>, <n> pawns placed, <m> LIVE, <b> blocked pairs"}`.

So rewinding across a LIVE switch returns the pawn to REPLAY in both paths (B4's note: the engine is told again). A pawn on a rejoin approach at the checkpoint gets its rejoin goal back (G1).

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
| follow run (`cart-follows-recording.json`, F; G5) | Played it like the tape: CT defuse, 0.72 s left | all 9 `same`, Δ 0 (before G5: cart → lokier `shifted` −0.30 s, his real first bullet; sp4rtan → cart `missed`, cart on 73 HP) | none | you; 1 kill, 100 dealt, 100 taken, died 69.41 s (G3's CS2 Mirage: RMS 275 u from his recording, the snapless human stuck behind boxes the recording walks through) |
| flank-sp4rtan (B4 #5) | You changed history: Ts win by elimination (recorded: CT defuse) | 6 `same` (G5: cart → lokier too; before, `shifted` −0.30 s); **new** cart → sp4rtan 44.63 s (HS); sp4rtan → donk, → barely `missed` ("sp4rtan was dead (44.63 s)"); G5: **new** bomb → cart 67.52 s (27 HP after Lokier's recorded hit) and sp4rtan → cart `missed` ("cart died to the bomb at 67.52 s"); the LIVE guards leave its blast (F) | sp4rtan sighting 44.61 s, donk outlived 53.34 s, barely outlived 61.84 s | you; 2 kills, 200 dealt, 100 taken, died 67.52 s, RMS 1,140 u (he waited in Back Alley) |

Summarizing the whole round's log takes ~250 ms in Node and ~80 ms in Chrome (it parses every line).

## Takeover: take control of cart at any time (G4)

Controlling cart is optional. A session can start **watching**: nobody controls cart, he is a REPLAY puppet like the
other nine, and the run is the no-human golden master byte for byte ("Played it like the tape: CT defuse, 0.72 s
left"). At any tick T the player can **take control** of cart; from T on cart is the human, exactly as if
`observe.human` had named him from the start, and before T nothing differs: the log's first T lines are the golden
master's. This is CS2's own bot takeover (a dead or spectating player presses E on a teammate bot): the CS2 adapter
maps it one to one (`docs/cs2-adapter.md`, `docs/port-notes.md` "Takeover").

### How the Core learns of it

- **From the observe.** `observe.human` changes from null to `cart` on tick T: the engine handed the pawn to the human
  before that observe (2D: `Session.takeControl`, i.e. `Sim2DHost.setHuman` between two steps; CS2: the player's E
  press, which the adapter sees as the human controller now controlling cart's pawn). Nothing is sent to the Core and
  nothing new is logged: the log shows the takeover as `human` changing in line T's observe, and a Replayer feeds it
  back like any observe. The contract's `take_control {id}` control is the app → engine request (`Session.control`
  routes it to `takeControl`; `ReplayCore.control` accepts it and does nothing).
- `ReplayCoreState.human` is the human of the last step. A step (not the setup step) whose observe names another one
  calls `humanChanged`. A takeover at tick 0 comes before the setup step, so the setup's blocks and encounter already
  follow it: it **is** a human from the start, byte for byte (`--takeover 0` = `--human cart`, tested).

### Tick T

In the Act of tick T, after a resync prefix and before the triggers:

1. `unblock_damage` for cart's self pair, then both directions with every enemy whose own blocks are not lifted, dead
   ones included (as a LIVE switch does). Nobody is LIVE while nobody plays, so it is always the self pair and the five
   CTs: 11 actions. The invariant of G1 holds on: a self or enemy pair is blocked exactly when neither pawn is the
   human nor has its blocks lifted.
2. `log {info, "takeover: cart is the human from tick T (27 hp, ak47); 11 damage blocks lifted"}`.
3. Scheduled encounters of cart (`Divergence.takeover`, below), each with a log line.

From T: status `HUMAN` since T; no Core input for him (Act T has none, so the engine moves him by the player's input,
or not at all); everything B3 does for "the human" applies, because it tests `observe.human` every tick ("Scripted
events" → The human): no scripted damage to or from him (`script: no scripted damage … : cart is the human` at the
entry's emission tick), no weapon, grenade, plant or defuse scripting; puppets still aim and shoot at him and the
engine decides those hits. A fire item of his that started before T was decided already, but without Core input
nothing fires. The divergence triggers that test the human (sighting with the on-course rule, blocked, gunfire,
damage) start at T: before it there is no off-script pawn. The puppets' snap rule uses his `sees` from T.

**His state at T** is the puppet's, untouched: position, velocity (with no input he coasts to a stop under friction),
view, weapon (a grenade the script drew for a throw stays drawn), ammo, HP, armor and items. Nothing is teleported.
`ExpectedEncounters` already describes the recording, so a human on course right after T is the recording: he is
within the puppet's drift of his track (15.1 u RMS; up to 93 u at the 13.0 s jump, ~100 u just before the puppet's
snaps at 14.38, 21.77, 29.38 and 64.28 s, where he starts off course). Idle, he leaves his course as his track moves on.

### Lokier's encounter by takeover time

The scheduled encounter is active while cart is the human, i.e. from T. While nobody plays the Core only notes the
first tick Lokier (REPLAY) sees the puppet cart within `humanSpotToleranceUnits` of the spot (`puppetSightTick`, 2D:
17.59 s, tick 1126; the recording's sighting is 17.45 s): state, nothing sent. At T (`Divergence.takeover`):

| T | encounter | what happens |
| --- | --- | --- |
| before Lokier saw the puppet at the window (T ≤ 17.59 s) | `waiting` | as at the setup: the recorded tap and aim are suppressed and Lokier holds the angle on the spot from the recorded aim's start (18.14 s). The hit comes when he sees cart at the spot: G5: on the recorded tick (18.50 s) if cart is on course then (as a human from the start gets it), else `encounterDelaySec` after it. Logged `active from the takeover at tick T, waiting …`; a takeover on tick 1126 itself (17.6 s) is seen on that same tick |
| after that sighting, before the recorded hit was sent (17.59 s < T ≤ tick 1183) | `seen` from the puppet's sighting | G5: the puppet was on course at its sighting (`puppetSightOnCourse`), so the hit is due on the recorded tick (1184, 18.50 s; before G5 1 s after the sighting, 1190), and at least one latency after T; the run-time aim from T (the recorded aim, if it began at 18.14 s, runs to its end at the same target). The gate applies on the hit's tick: Lokier still REPLAY and cart in his sight within 192 u of the spot, else Lokier goes LIVE (`encounter`). Logged `cart in sight at the spot since tick 1126 (+0.1 s …), before the takeover at tick T; scripted hit due at tick 1184 (on course: the recorded tick)` |
| after the recorded hit (B3 sent it to the puppet on tick 1183; it landed at 18.50 s), Lokier alive (T ≤ 18.80 s) | `fired` on the recorded ticks (no shift) | cart has 27 HP / 93 armor. Lokier's view of him at the spot is still the recorded duel and cart's fire at Lokier recorded fire. Cart's recorded kill of Lokier (18.80 s) is not scripted for the human (he never fires by himself): G5: he is in the recorded duel from T (unshifted), so if he keeps firing on Lokier the kill lands on 18.80 s (the puppet's shots before T start his spray: `takeover-mid-duel`), else Lokier outlives his recording at 21.80 s (LIVE, `hold` on B) and barely kills him at 22.17 s (as in never-peeks). Logged `the recorded hit (73 hp) landed on tick 1184, before the takeover at tick T` |
| after Lokier's death | none | `none after the takeover at tick T, lokier is dead` |

So a takeover any time before the hit gives an on-course cart the hit a human from the start gets, and a takeover
after it keeps what the puppet got: since G5 both are the recorded 18.50 s (before G5 a takeover before the hit gave
18.59 s, because the 2D sight sees him 0.14 s after the recorded sighting and the delay is a round 1 s against the
recorded 1.05 s).

**Recorded damage on cart after T**: Lokier's 73 is the encounter above, never B3's recorded tick. sp4rtan's
post-round kill (69.40 s) is real: B3's implied tap goes ahead (a puppet shooting at the human), the engine decides,
and the scripted lethal damage is skipped. Teammates can't hurt him (friendly fire off).

**Recorded damage by cart after T** (G5): only through his own shots in his recorded duels ("Recorded duels of the
human"): B3 never fires for him, and outside a duel his bullets are real.

### Rewind, seek, checkpoints

The takeover is part of the run, like the human's inputs (`Session`, `docs/app.md`):

- A checkpoint records who controlled cart and since when (the driver's `human`, `takeoverTick`; the Core's snapshot
  has `human`, the encounter state and the script's suppressions and holds). **Rewinding to a checkpoint before T
  returns to watching**: exact (host snapshot, whose `human` is null there): what follows is the no-human round byte
  for byte (tested: take over at 25 s, play to 30 s, rewind to 20 s, run to the end: the golden digest); resync (CS2):
  the driver gives the pawn back to the bot before the resync step (2D: `setHuman(null)`), and the resync prefix, made
  from the checkpoint's observe (`human` null), sets cart REPLAY and blocks all 60 pairs again. The player can then
  take over at another tick (tested: 40 s, both paths).
- The takeover stays on the **tape**: a forward seek through T replays it on its tick, before his inputs, and lands
  where the straight run did, byte for byte (exact path). Playing on live drops the tape and its takeover.
- The automatic checkpoint of a 5 s multiple is taken just before that tick's step, so a takeover on that very tick
  is in it: rewinding there keeps cart controlled.

### Release, death, after the round

- **Release** (`observe.human` from cart to null without a rewind; CS2: the player leaves or goes spectator and the
  bot plays on; the app never does this): cart goes LIVE (trigger `released`) with his regular goal, his blocks stay
  lifted, and G1 brings him back to his recording once calm.
- **A dead cart** can't be taken over (`Session.takeControlBlocked`: `cart is dead`; CS2 has no bot left to take).
- **After the round end** it is allowed while he lives (to 69.41 s): the post-round kill is then real. Idle from 68 s,
  he dies on the tape's tick (4442).

### Results: idle after the takeover (`tests/takeover.test.ts`)

The player takes control at T and does nothing (no input: cart stands still). Every run's first T lines are the golden
master's; T = 0 is the `--human cart` run byte for byte. Times in seconds; bold = the golden master's tick (the tape:
plant 27.52, barely → Zwomp 44.20, sp4rtan → donk 50.34 (kill feed 50.35), sp4rtan → barely 58.84 (58.85), defuse
66.80).

| T | outcome | plant | Zwomp | donk | barely | defuse | why |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 0 | CT defuse 12 – 15, 0.83 s left | 27.63 (+7) | **44.20** | **50.34** | **58.84** | **66.80** | cart stands on his start spot all round: Lokier outlives (21.80), barely goes LIVE, kills him (22.16) and rejoins (23.17) 0.6 s behind his tape, so his plant runs 7 ticks late (G1's late planter, as in never-peeks since G3); sp4rtan meets cart on his flank (40.09), kills him and rejoins; barely hears it, goes LIVE and rejoins |
| 5 | CT defuse, 0.83 s left | 27.63 (+7) | **44.20** | **50.34** | **58.84** | **66.80** | as T = 0 (he has hardly left his start: 64 u) |
| 17.6 | CT defuse, 0.83 s left | 27.63 (+7) | **44.20** | **flagged** 47.70 | **58.84** | **66.80** | hit at 18.50 (G5: on course at the sighting, the recorded tick; before 18.59); in the recorded duel to 18.98 s, but he never fires, so nothing is forced and Lokier lives; cart stays at the Apartments window on 27 HP; the plant as T = 0. sp4rtan's recorded flank passes the window at 46.7 s: he sees cart (off course), goes LIVE and kills him; the gunfire makes donk (904 u away, dwelling in the Apartments) and barely LIVE; LIVE sp4rtan kills LIVE donk at 47.70 (the toy AI's fight). Both rejoin; the rest is the tape |
| 18.0 | CT defuse, 0.83 s left | 27.63 (+7) | **44.20** | **flagged** 47.59 | **58.84** | **66.80** | as 17.6 (the same hit, from the puppet's sighting) |
| 18.6 | CT defuse, 0.83 s left | 27.63 (+7) | **44.20** | **flagged** 47.56 | **58.84** | **66.80** | the recorded hit already landed (27 HP); then as 17.6 |
| 30 | CT defuse 12 – 15, 0.72 s left | – | **44.20** | **50.34** | **58.84** | **66.80** | Lokier already dead; cart stands where his track had him on the B side, nobody's recorded way passes in sight; sp4rtan's post-round shot (69.41) misses: cart ends on 27 HP |
| 45 | CT defuse 12 – 15, 0.72 s left | – | – | **50.34** | **58.84** | **66.80** | as 30 |
| 60 | CT defuse 12 – 15, 0.72 s left | – | – | – | – | **66.80** | as 30 |
| 68 | CT defuse 12 – 15, 0.72 s left | – | – | – | – | – | after the round; the post-round kill lands on the tape's tick: "Played it like the tape" |

(– after T: before the takeover, so the golden master's by construction.) Every run ends in the recorded CT defuse.
What moves is not the takeover's doing: with cart idle before 18.8 s Lokier outlives his recording and the LIVE barely
who kills him rejoins too late for his plant tick (+7 ticks, as in never-peeks); and an idle cart left at the window
is in the path of sp4rtan's recorded flank half a minute later, where B4/G1 divergence and the 2D toy AI
(`docs/ai.md`) cost donk 2.6 s. A cart that follows his recording after the takeover (`takeover-duel` below), or just
leaves the window, meets neither.

**Scenario `takeover-duel`** (`fixtures/scenarios/takeover-duel.json`, `tests/takeover-rewind.test.ts`): watch to
18.0 s, take control at the window, aim at Lokier, take the hit (G5: on its recorded tick, 18.50 s, 27 HP; before G5
18.59 s), fire from 18.7 s (his first shot, 18.72 s, would hit) and, in the recorded duel, get the kill on the tape's
18.80 s (before G5 his real headshot killed Lokier at 18.72 s), then play the recording to the end. No pawn goes LIVE;
every event is on the golden master's tick, CT defuse 12 – 15 with 0.72 s left, and sp4rtan's post-round shot kills
cart at 69.41 s as recorded: "Played it like the tape" (before G5: "Same result, different round: … 1 kill changed").
**`takeover-mid-duel`** (G5, `tests/duels.test.ts`): taken over at 18.6 s, mid-spray, playing the recording on: the
same, the tape.

**Harness and tests**: `npm run harness -- --takeover <t>` (and `--script`, or a scenario's `"takeover": 18.6`)
watches to t and has cart taken over there (`docs/golden.md`); `--takeover 0` is `--human cart`. **Port fixture**
`round-cart-takeover`: takeover at 15 s, idle, to 24 s.

### Known limits

- Encounters exist for the default human only (cart); the Session offers only cart (`SessionConfig.playable`).
- Taken over just before one of cart's puppet snaps (14.38, 21.77, 29.38, 64.28 s), he is up to ~100 u behind his
  track: off course at once, so an enemy that sees him then goes LIVE.
- The release path exists for CS2 (a player leaving); the 2D app has no "give control back" (rewind instead).

## Recorded duels of the human (`duels.ts`, G5)

Once the player controls cart he **never fires by himself**: the Core sends the human nothing, so a recorded shot of
cart's happens only if the player fires it. His recorded engagements are **recorded duels**: if he shoots in one, his
shots land like the tape; if he doesn't, nothing is forced. That is John's call ("only my own shots"). Before G5 his
bullets were always real, and with no spread, recoil or aim punch in 2D the first AK bullet of a tape-like spray at
Lokier was a headshot at 18.50 s, before Lokier's own hit could land: Lokier died 0.30 s early, cart kept 100 HP and
survived sp4rtan's post-round shot ("2 kills changed").

### The duels (`buildDuels`)

One per B3 engagement (`plan.engagements`) in which the default human shoots an enemy. Its fire items give the weapon
and the shots; the recorded damage of the human on the target whose aim falls inside it is the **outcome**; a scheduled
encounter whose recorded hit on him falls inside it is the duel's **anchor**, whose time shift the duel takes. cart has
three:

| duel | target | window | recorded shots | outcome | shift | spot (192 u) |
| --- | --- | --- | --- | --- | --- | --- |
| `duel:0` | lokier | from Lokier's first sight of him at the spot (the encounter's `seenTick`, the shift's origin; recorded 17.45 s) to the last press (B3's `aim:4` ends at 18.98 s) | 6, 18.517–19.0 s | **the kill**: AK-47, head, at 18.80 s (tick 1203) | `enc:0`'s: the hit's tick − 1184 | the encounter's: (−1764, 800), cart at Lokier's hit |
| `duel:1` | sp4rtan, defusing | 65.55–66.89 s (`aim:10`, ticks 4195–4281) | 11, 65.9–66.9 s | no damage | 0 | (−2293, −148), cart halfway through his shots |
| `duel:2` | sp4rtan, after the round | 68.30–69.27 s (`aim:11`, 4371–4433) | 7, 68.667–69.267 s | no damage | 0 | (−2400, 230) |

The sp4rtan duels answer no encounter: the defuse they fall in and the post-round kill after them are on the tape's
ticks, so they are not shifted.

### Each tick (`HumanDuels.step`)

After the triggers and the rejoin (so it sees this tick's modes), before B3, for each duel while `observe.human` is its
shooter (watching, they do nothing: the no-human round is byte for byte the golden master):

1. **Armed** once its shift is known: an anchored duel when its encounter has seen him at the spot (`seen`, or `fired`
   after a takeover past the recorded hit); the window then opens at that sighting and closes at the last press plus
   the shift. Any other at once, on its recorded window. An anchored duel whose encounter ends first (Lokier LIVE or
   dead, cart dead) never arms.
2. **In the duel**: he is alive, the target alive and REPLAY, the tick inside the window, he within
   `humanSpotToleranceUnits` (192, 2D) of the duel's spot (or a hit is due). Then `block_damage {cart, target}` is in
   force: sent on the first tick he is in it, lifted on the first he isn't (he stepped away, the target went LIVE, the
   window closed). His bullets on the target do no engine damage; the engine reports each one that would have hit as
   `blocked_hit {attacker, victim, weapon, hitgroup}` (`docs/contracts.md`), and every `shot` of his is noted.
3. **The outcome.** With hits (Lokier): the next recorded hit, at its shifted tick K (1203 + shift), lands
   - **on K**, if his spray is on the target through it: at act K − `actionLatencyTicks` he has had a would-hit shot
     since the recorded spray's first shot (shifted) less one fire cycle (`cycleTicks`: the AK's 6.4 ticks, 7), and he
     is still firing (a shot within one cycle before K);
   - else **one action latency after his first would-hit shot** reported after that act (he opened fire late, or let
     go and fired again).

   Never before K: his shots before it miss, so Lokier's recorded hit on him lands first; a spray that stops more than
   a cycle short of K is a miss, like the tape's first shots. The hit is a scripted `damage` with B3's rules (attacker
   cart, AK-47, head, lethal: the `death` is cart's headshot kill; sent one action latency early; dropped, logged, if
   he or the target is dead or the target LIVE by then; a non-lethal one would stay non-lethal). Without hits
   (sp4rtan): his shots do nothing, as on the tape: the defuse completes, and sp4rtan's post-round shot at cart stays
   real (B3's implied tap, the engine decides).
4. **Over** when the target or he dies, or the window and its last report have passed with nothing due: the block is
   lifted, and if he was ever in it a log line says why, with the count of would-hit shots it blocked.

**Outside a duel his bullets are real**: another place (beyond 192 u of the spot), another time (before Lokier has seen
him at the window, after the window closed) or another target. So different input can still change history:
`early-peek-lokier` kills Lokier for real at 16.45 s from the corridor, and `flank-sp4rtan` kills sp4rtan at 44.63 s.
If he never fires on the target in a duel, nothing is forced: Lokier lives (never-peeks, miss-lokier-shop, an idle
takeover) and outlives his recording at 21.80 s as before.

**Why the kill lands on 18.80 s rather than one tick after "his first shot at or after 18.80 s".** A spray that starts
on the tape's first shot can't put its 4th bullet on the tape's 18.80 s: the engine's AK fires at 0, 7, 13, 20, … ticks
after the press, so B3's fit lands it on 1184, 1191, 1197, **1204**, 1210, 1216 against the tape's 1185, 1191, 1197,
**1203**, 1210, 1216. And the Core learns of a blocked shot one tick after the engine fires it, so a kill sent on that
report lands one more tick later (1205). A spray still on target at the kill moment is the tape's spray, so it kills on
the tape's tick, as the puppet's does, and its 4th bullet then hits a dead Lokier, as in the golden master. One
would-hit shot is enough for "on target" because the engine's sight decides which bullets reach him at all: with the
follow script only the first does (at 18.61 and 18.70 s the sight mask's window wall is between them; G6's CS2 mesh
will move that).

### Takeover (G4)

A takeover inside a duel's window arms it on that tick, after the takeover's `unblock_damage` for cart's B3 pairs (the
duel's `block_damage {cart, target}` comes later in the same Act). From then the duel's rules apply. Taken over in the
middle of the recorded spray (between the puppet's first shot, 18.50 s, and the kill), the puppet's shots of it that
landed before the takeover (B3 decided its spray while nobody played him, and aims it at Lokier) start his spray: a
player who keeps firing gets the kill on 18.80 s (`takeover-mid-duel`); one who doesn't fire leaves Lokier alive (the
idle takeover at 18.6 s: he outlives his recording, as before G5).

### Encounter: on course, the recorded tick

With tape-like play the duel must open with Lokier's hit on its recorded tick, so the encounter's rule changed too
("Divergence" → Scheduled encounters): when Lokier first sees him at the spot and he is **on course** (within
`offCourseUnits` of where his recording has him then: he is the recording), the hit is due on its recorded tick (18.50 s)
if that is at least one latency ahead; otherwise, as in B4, `encounterDelaySec` after the sighting. The follow run's
sighting is at 17.59 s (2D sight; the tape's 17.45 s sighting is 211 u from the spot, outside its tolerance), on
course: the hit at 18.50 s, shift 0, so the duel's kill moment is the tape's 18.80 s. A late or early peek is off course
and keeps B4's shift (lokier-late +2.64 s, smoke-window +2.61 s, cart-dies −9.5 s), and the duel shifts with it.

### State and logs

`DuelState` per duel, in the Core snapshot (absent in snapshots from before G5: every duel afresh): `shift`, `fromTick`,
`toTick` (armed), `startedTick`, `blocked`, `next` (the next recorded hit), `dueTick`, `aimedTick` (his last would-hit
shot in the spray), `lastShotTick`, `shots` (would-hit shots blocked), `done`. A resync rewind re-sends a standing duel
block with the encounters' (`standingBlocks`). Logs (integers, ids and tenths of seconds only):

- `duel cart -> lokier: in the recorded duel from tick 1126 (+0.0 s against the recording, to tick 1215); his shots on
  lokier land as recorded: kill (ak47, head) at tick 1203`
- `duel cart -> lokier: his spray is on lokier through the recorded kill (ak47, head) (on target at tick 1184, still
  firing at tick 1197): it lands at tick 1203 (recorded 1203)`, or `… his shot at tick 1206 would hit (head): the
  recorded kill (ak47, head) lands at tick 1207 (recorded 1203)`
- `duel cart -> lokier: dropped the recorded kill (ak47, head) due at tick k: lokier is LIVE`
- `duel cart -> lokier: over at tick 1203, lokier is dead; 1 would-hit shot blocked` (or `the recorded duel is over`,
  `cart is dead`)

The scenario timelines list them (kind `duel`).

### Results (`tests/duels.test.ts`, `tests/scenarios.test.ts`, `tests/takeover*.test.ts`; seed 1)

| run | Lokier → cart | cart → Lokier | sp4rtan → cart | headline (before G5) |
| --- | --- | --- | --- | --- |
| follow-recording (tape-identical input) | 18.50 s, 73 / 7 | **18.80 s** (1203), the duel's AK-47 HS | 69.41 s (4442) | **Played it like the tape: CT defuse, 0.72 s left** (Same result, …; 2 kills changed: Lokier 18.50 s real, no hit, cart survived) |
| duel-perfect-aim (on target from 18.05 s) | 18.50 s | **18.80 s**; 8 would-hit shots before it blocked | 69.41 s | **Played it like the tape** (new) |
| takeover-mid-duel (18.6 s) | 18.50 s (on the puppet) | **18.80 s** | 69.41 s | **Played it like the tape** (new) |
| takeover-duel (18.0 s, fires from 18.7 s) | 18.50 s | **18.80 s** | 69.41 s | **Played it like the tape** (Same result, …; 1 kill changed: hit 18.59 s, kill 18.72 s real) |
| early-peek-lokier (16.4 s from the corridor) | – | 16.45 s, **real** | – (100 HP) | Same result, different round: CT defuse, 0.72 s left; 2 kills changed (new) |
| lokier-late | 21.14 s | 21.44 s, the duel's (+2.64 s) | 69.41 s | Same result, …; 1 kill changed (kill 21.42 s real) |
| smoke-window (to 30 s) | 21.11 s | 21.41 s, the duel's (+2.61 s) | – | Round still on (kill 21.38 s real) |
| miss-lokier-shop (sprays 6° wide) | 18.50 s | – (no would-hit shot: Lokier outlives, barely kills him 22.16 s) | – | Same result, …, 0.83 s left; 3 kills changed (hit 18.59 s) |
| never-peeks, cart-goes-a, block-barely | – | – | – | unchanged, byte for byte (never in a duel) |

### Known limits

- **The engine decides "would hit"**: 2D's sight mask, cover and pitch bands now; G6's CS2 mesh changes which shots of
  a spray reach Lokier, CS2 its spread and recoil. A spray none of whose bullets reaches him before the kill moment gets
  the kill one action latency after its first one that does (up to a few ticks late), or none.
- **"On target" is one would-hit shot**: a player who hits once in the spray and then sprays the wall through 18.80 s
  still gets the kill on its tick (the tape's spray had misses too).
- **A fixed spot** per duel, 192 u: stepping out of it mid-spray makes his bullets real again (and the block toggles
  with him on the edge of it).
- Duels exist for the default human only (cart), like encounters, and only for his recorded engagements: shooting a
  CT he never shot on the tape is always real.
