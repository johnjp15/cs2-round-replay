# C# port notes

Things in `src/contracts` (and, at the end, `src/core`) that need care when ported to C# (CS2 server plugin). The session logs written by the TypeScript build are the fixtures: a correct port reproduces them byte for byte. The fixtures, their walk oracle and the exact replay contract are in `docs/golden.md` (E1): `fixtures/golden/`, `manifest.json`.

## Types

- **Discriminated unions** (`ObsEvent`, `Action`, `Control`) → an `abstract record` base per union with one `sealed record` per member; (de)serialize with a `"type"` discriminator whose value is the TS `type` string (`System.Text.Json` `[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]` + `[JsonDerivedType(typeof(X), "block_damage")]`). Switches over `type` → `switch` on the record type; keep them exhaustive.
- **String unions** (`PlayerId`, `Team`, `WeaponId`, `ItemId`, `Button`, `Hitgroup`, `Mode`, `SoundKind`, `BombPhase`, `RoundEndReason`, `RoundPhase`, `BombState`, `LogLevel`, and for round data `Confidence`, `GrenadeId`, `ShotKind`) → either `string` constants or enums with a converter that writes the exact TS spelling (lowercase ids, `REPLAY`, `ATTACK2`, `bomb_defused`). Never use the enum's integer value in logs.
- **`readonly` fields** → `init`-only record properties. **`readonly T[]`** → `ImmutableArray<T>` (note: record equality on `ImmutableArray` is reference-based; compare logs by text, not by record `==`).
- **`null` vs absent**: TS has no optional fields; every property is always written, `null` included. Do not set `JsonIgnoreCondition.WhenWritingNull`. The one exception is input, not output: `data/round.json` omits `TrackSample.uncertainty` and `TrackSample.resampled` when they don't apply, so read them as `double?` / `bool?`.
- **`Hitgroup`** gained `neck` and `generic` (C2), appended after `leg`: `head chest stomach arm leg neck generic`. CS2's numeric hitgroups map 0 → `generic`, 8 → `neck`.
- **`Observe.round`** (C3) → `RoundObs` record with `Phase` (`live planted over`), `Score` (`record Score(double Ct, double T)`, JSON `ct`/`t`), `Winner` (`Team?`), `Reason` (`RoundEndReason?`), `EndTick` (`double?`), `TimeLeftSec` (double) and `Bomb` (`BombObs`: `State` `carried dropped planted defused exploded`, `Carrier` `PlayerId?`, `Pos` `Vec3?`, `PlantTick` `double?`, `Defuser` `PlayerId?`, `DefuseEndTick` `double?`). All nullable fields are written as `null`, never omitted. In CS2 the adapter fills it from `CCSGameRules` (bomb planted flag, round win status, round time) and the `planted_c4` entity (`C4Blow`, `DefuseCountDown`, `BombDefuser`); the score from the team entities.
- **`SoundEvent.source`** is `PlayerId?` (C3, finding F4): bomb beeps have no source.
- **`ItemId`** = every `WeaponId` plus `defuser` (`ITEM_IDS` keeps `WEAPON_IDS` order, then `defuser`). `WeaponId` gained `glock` (between `m4a4` and `knife`). `give.item` is an `ItemId`; `set_hp` has `helmet` (bool).
- **`number`** is a double everywhere, including ticks, hp and counts. Ticks are integral doubles; `Math.round(i * 6.4)` (trace sampling) is JS rounding (half up toward +∞) → `Math.Floor(i * 6.4 + 0.5)` in C#, not `Math.Round` (banker's).
- **Snapshots**: `data` is a `JsonValue` → `JsonNode`/`JsonElement`.

## Round data (round.ts)

- `RoundData` is the deserialized `data/round.json`. Objects keyed by player id (`tracks`, `timelines.*`) → `Dictionary<string, T>`; look up by id, never iterate them for output (iterate `PLAYER_IDS`).
- `parseRound` is the validator: port it as hand-written checks after deserializing (or a JSON schema), with the same `path: message` errors. It accepts the parsed object or the JSON text and does no file I/O. Every `tick` must equal `toTick(t)` = `Math.Floor(t * 64 + 0.5)`.
- `shot.raw` is `Dictionary<string, string>` (CSV header → cell).

## Ordering

- Every per-player array (`pawns`, `inputs`, `status`, `sees`) is sorted by id with **ordinal** comparison (UTF-16 code units, `string.CompareOrdinal` / `StringComparer.Ordinal`), never culture-aware. `sortById` is stable.
- `buttons` are in `BUTTONS` declaration order: `ATTACK ATTACK2 USE DUCK WALK JUMP RELOAD`.
- `events` and `actions` keep emission order; never sort them.
- Never iterate a `Dictionary`/object to produce output; iterate a sorted key list (`PLAYER_IDS`).

## stableStringify (json.ts)

The log format is defined by this function; `System.Text.Json` defaults do not match it. Write a custom writer:

- Object keys sorted ordinally (UTF-16 code units). No whitespace. Arrays in order.
- **Numbers**: `formatNumber(x)`:
  1. NaN/±Infinity → error.
  2. `|x| >= 1e21` → exact integer digits of the double (`new BigInteger(x).ToString()`), no exponent.
  3. Otherwise the exact decimal value of the double rounded to 6 decimals, ties away from zero (JS `toFixed(6)`; .NET Core 3.0+ `x.ToString("F6", CultureInfo.InvariantCulture)` is exact and rounds ties away from zero — verify with the test vectors below).
  4. Strip trailing `0`s after the point, then a trailing `.`; `"-0"` → `"0"`.
  Vectors: `-0→0`, `1e21→1000000000000000000000`, `0.1+0.2→0.3`, `1/3→0.333333`, `-1e-7→0`, `-6e-7→-0.000001`, `1/128→0.007813`, `-1/128→-0.007813`, `123456789.1234567→123456789.123457`, `2^53+2→9007199254740994`.
- **Strings**: JSON.stringify escaping: `\"`, `\\`, `\b \f \n \r \t`, other code units < 0x20 as `\u00xx` (lowercase hex), lone surrogates as `\udxxx` (lowercase); everything else (including non-ASCII and `/`) written raw. `JavaScriptEncoder.UnsafeRelaxedJsonEscaping` still escapes some characters differently — use a hand-written escaper.
- `undefined` → error (no C# equivalent; just never omit fields).
- Logs are UTF-8, `\n` line endings, a trailing `\n` after the last line.

## Hashes

- `SessionLog.digest()` = FNV-1a 32-bit (offset `0x811c9dc5`, prime `0x01000193`) over the **UTF-8 bytes** of the JSONL text (lone surrogates → U+FFFD), printed as 8 lowercase hex digits (`h.ToString("x8")`). Use `uint` and `unchecked` multiply.
- Note `rng.ts`'s internal `fnv1a32` (for `fork` labels) hashes **UTF-16 code units**, not UTF-8 bytes. They agree for ASCII labels only.

## Determinism

- Feed Core canonical observes (`parse(stableStringify(observe))`, i.e. numbers already rounded to 6 decimals) so that live runs and replays see identical input.
- `Math.cos`/`Math.sin` etc. are not guaranteed bit-identical between V8 and .NET; Core logic that depends on them should round (or compare with tolerance) before branching. Plain `+ - * /` and `Math.Floor`/`Math.Sqrt` are IEEE-exact on both. Measured (E1, `docs/golden.md` "Cross-engine determinism"): perturbing every `cos`/`sin`/`atan2` result in the Core by up to 65,536 ulps changes no act in the fixtures, so .NET's `Math.Sin`/`Cos`/`Atan2` should reproduce them.
- Integer bit math (`>>> 0`, `Math.imul`) → `uint` with `unchecked`.

## Core (src/core)

- **Rounding.** `tickOf` and the HUD bomb timer use JS `Math.round` (half up) → `Math.Floor(x + 0.5)`. `hudClock` uses `Math.Ceiling`. All clock arithmetic is on `tick / 64` (exact), so no rounding noise reaches these.
- **Start yaw** uses `Math.Atan2`, which is not guaranteed bit-identical across runtimes; the result is rounded to 0.001° (`Math.Floor(deg * 1000 + 0.5) / 1000`, then −180 → 180) before it is logged.
- **Sorting.** `EventSchedule` sorts with an explicit build-order index as the last key, because `List<T>.Sort` is not stable (or use LINQ `OrderBy().ThenBy()`, which is). Ids compare ordinally.
- **Maps** (`RoundModel.index`, the HP walk in `schedule.ts`, `ReplayCore.step`'s pawn lookup) are lookups only and are never iterated, so `Dictionary` is fine.
- **Union of schedule entries** (`ScheduledEvent`) → `abstract record` + one `sealed record` per entry type, like the contract unions; every entry has `Tick`. `ofType(type)` → `OfType<T>()`.
- **ReplayCore hooks** `pawnInput(pawn, observe, actions)` (B2: returns the input, may append a snap) and `scheduledActions` are `protected virtual` methods. The optional `walk` constructor parameter → `IWalkQuery? walk = null`.
- **Randomness.** `ReplayCore.rng` is only seeded; later tasks should draw through `rng.fork(label)` keyed by tick and id, so the Core snapshot needs only the seed.

## Puppets (src/core/puppet.ts)

- **WalkQuery in CS2.** `isWalkableLine(a, b)` is the only map query the Core makes. Options, best first: (1) a nav-mesh raycast between the two points, rejecting crossings that need a jump, a drop or a level change (CS2's nav mesh is what the 2D sim's patched mesh approximates); (2) a player-hull trace (`Trace.TraceHullShape` from a point a step height above `a` to the same above `b`, standing hull), plus a ground check along the way so a line over a ledge or a hole doesn't count. It must be deterministic for a given pair: cache per tick if traces are costly. The Core makes 10 calls a tick in the normal case (one per puppet) and up to ~140 for one puppet when the line to its lookahead point is blocked (the fallback walks back over the last 2.15 s, one tick at a time).
- **Trig.** `atan2` (headings) and `cos` / `sin` (stick) are not bit-identical across runtimes. Every computed yaw is normalised to (−180, 180] and then rounded to 0.001° (`Math.Floor(normYaw(d) * 1000 + 0.5) / 1000`, then −180 → 180), and forward / side are rounded to 6 decimals, before anything is logged or stored. Branches use distances (`sqrt`, IEEE-exact), sample times, the WalkQuery, and yaws only after that rounding. An ulp difference can still flip a rounding tie (0.001° in a yaw, 1e-6 in a stick value), so expect at most rare last-digit diffs, not divergence.
- **normYaw** uses the remainder operator on doubles (`((d % 360) + 540) % 360 − 180`): JS `%` and C# `%` both truncate, so they agree.
- **Ticks**: lookahead and fallback are times, not ticks (`t + 0.15`); window lengths are converted with `Math.round(sec * 64)` → `Math.Floor(sec * 64 + 0.5)`. The spike time limit compares integer sample ticks (0.5 s = 32 ticks exactly).
- **Log text** of a snap uses only integers: `puppet <id>: snap to track at tick <k>, <Math.round(behind)> u behind (<kind> at ticks <a>-<b>)`. `Math.round` is half up → `Math.Floor(x + 0.5)`.
- **State** (`PuppetState`) is plain data and already canonical (yaw 0.001°, `behind` 6 decimals), so a snapshot round trip is exact. `usedPoints` is an ordered list (append order), not a set.
- `describeEvent` (debug text, not logged) uses `toFixed`; port it with `ToString("F2", CultureInfo.InvariantCulture)` if a C# debug dump has to match.

## Bomb and round rules (src/sim2d, C3)

The 2D engine is not ported (the CS2 host uses the game's own rules), but logs written with it are fixtures, so a
C# re-implementation for tests would need:

- **Tick rounding.** `dueTick(t) = Math.ceil(roundNumber(t) − 1e-9)` → `Math.Ceiling(Round6(t) − 1e-9)`. Plant
  3.2 s from tick s ends on s + 205; 40 s, 5 s and 10 s are exact (2560, 320, 640). The time-out tick for 98.25 s
  is 6288.
- **Order.** Bomb rules run after scripted damage, then the round rules; pawns are scanned in ordinal id order for
  the plant starter, the defuse starter, the drop and the pickup. Explosion damage is applied in id order. A
  same-tick wipe of both sides is a T win.
- **Distances.** Defuse range and pickup range compare squared 2D distances (`dx*dx + dy*dy <= r*r`, exact). The
  explosion uses `Math.hypot` in 3D (not bit-specified across runtimes; the damage is rounded to 6 decimals before
  the armor `trunc`, like grenades).
- **Collision.** `collideMove` uses `sqrt` and `hypot`; positions are rounded to 6 decimals after each move like all
  movement (`docs/movement.md`), so expect the same rare last-digit caveat as wall slides.

## Scripted events (src/core/scripted.ts, aim.ts)

- **Ticks from seconds**: `secTicks` = `Math.Floor(sec * 64 + 0.5)` (preAim, plantSec, throwHold); `ceilTicks` = `Math.Ceiling(sec * 64 - 1e-9)` (deploy times: a deploy must be complete). Burst taps use `⌊(k + ½) × span / count + ½⌋` explicitly, not `Math.Round` (banker's in C#).
- **Fire cadence model** (`cadenceOffsets`, `simulateHolds`): due times accumulate the fractional cycle (`64 × 60 / rpm`) rounded to 6 decimals after every add (`roundNumber`, as the 2D engine stores them), and a shot fires on `Math.Ceiling(due - 1e-9)`. Plain `+ - * /` and ceiling: identical in C#. `cadenceOffsets` guards `-0` (`Math.ceil(-1e-9)` is `-0` in JS; C#'s `Math.Ceiling` returns `-0.0` too, and `-0` must not reach a log).
- **Spray fit** tie-breaks are part of the output: candidates in `SPRAY_FIT_SHIFTS` order (0, −1, +1, −2, +2), one hold before two holds, splits in shot order, first-hold shift outer and second-hold shift inner; a candidate replaces the best only if strictly better (largest error, then sum of squared errors).
- **Aim** uses `atan2` (bearing and pitch); both are rounded to 0.001° before they are logged or compared (`roundYaw`, `roundPitch`), and pitch is clamped to ±89. `withLook` uses `cos` / `sin` and rounds the stick to 6 decimals, like B2.
- **Decisions** (`ScriptState.decisions`) are a list in the order they were made, looked up by string key (`fire:<i>`, `aim:<i>`); plan item indices come from a sort by (first act tick, shooter id ordinal, build order).
- **Log texts** of drops and fallbacks use only integers and ids (`script: dropped … (5 shots from tick 3192): donk is dead`, `script: no planted event by tick 1764, …`).

## Vision and LIVE AI (src/sim2d/vision.ts, ai.ts; C4)

The 2D engine is not ported (CS2 traces sight and runs its own bots), but its logs are fixtures, so a C# re-implementation
for tests would need:

- **Sight mask DDA.** Cells from `Math.floor`; the walk starts at the lexicographically smaller end (x, then y) so it is
  exactly symmetric; `tMax += tDelta` accumulation and the run lengths `(t − tStart) × length` in doubles, compared
  with `>` against the tolerances. A step exactly through a cell corner moves both axes at once (the side cells are not
  visited). `Math.Floor`, `+ - * /` and `Math.Sqrt` are IEEE-exact, so C# matches bit for bit.
- **Level check.** Samples at `i / n` with `n = ceil(length / step)`; floors from `floorsAt` sorted ascending; runs over a
  surface are matched to the previous sample's floors in that order (first match within `stepHeight`).
- **sees** visits unordered pairs (i < j) in id order and traces each once; the lists are then sorted ordinally. The FOV
  test uses `atan2` (not bit-specified): a target exactly on the FOV edge can differ in the last ulp.
- **AI randomness:** `new Rng(seed).fork("ai:" + id).fork("d" + n).NextDouble()` for the n-th draw. The normal draws use
  Box–Muller (`Math.Log`, `Math.Cos`), rounded to 6 decimals; the inputs are canonicalized (6 decimals) like all host
  state. Expect the same rare last-digit caveat as the movement trig.
- **Order:** the AI runs at the start of a tick, before the movement locks, LIVE pawns in id order; a weapon switch it
  asks for is applied at once (deploy time from that tick).

## Divergence (src/core/divergence.ts, B4)

- **Pure triggers**: `damageTrigger`, `sightingTrigger`, `gunfireTrigger`, `outlivedTrigger`, `blockedTrigger` take the Observe, the modes at the start of the tick and plain data; port them as static methods. Pawns are visited in `PLAYER_IDS` order and the first trigger in table order wins; switches are applied after all pawns are checked (a cascade takes a tick).
- **Distances and branches**: 2D `Math.Sqrt` distances and dot products only (IEEE-exact); `offCourseUnits`, `contactSlackUnits`, hearing range and the spot tolerance compare with `<=` / `>` as written. The contact's starting drift is rounded to 6 decimals (`roundNumber`) before it is stored. No trig.
- **Ticks**: windows and delays are `secTicks` (`Math.Floor(sec * 64 + 0.5)`); the encounter's shot tick is `seenTick + max(secTicks(encounterDelaySec), max(inputLatencyTicks, actionLatencyTicks))`.
- **Log texts** use only integers, ids and tenths of seconds from integer tick arithmetic (`intText` = `Math.Floor(x + 0.5)`; `tenthsText(ticks)` = `Math.Floor(|ticks| * 10 / 64 + 0.5)` split into `a.b`, sign explicit). No `ToString("F1")`.
- **Sightings**: `RoundModel.sightings[].by` is resolved from the free text by splitting the lowercase string at anything but `a-z0-9` and keeping the words that are player ids, in `PLAYER_IDS` order (`Regex.Split(by.ToLowerInvariant(), "[^a-z0-9]+")`).
- **RDP route thinning** uses an explicit stack of index pairs (push a, best, best, b; pop b then a); the furthest point wins, on a tie the first (strict `>` against the tolerance).
- **State** (`DivergenceState`: encounter phases and ticks, contacts) is plain data in the Core snapshot. B3's `ScriptState` gained `extraFire`, `extraEngagements` (run-time items, decided like the plan's) and `holds`; `suppress(key)` pre-decides a plan item as dropped without a log.
- **Goal coordinates** come from track samples (they may be fractional: Lokier's last sample is (−2145.78125, 432.21875, −160.03125), exact in binary).

## Rejoin (src/core/rejoin.ts, G1)

- **WalkQuery.pathLength in CS2.** The rejoin planner asks `pathLength(a, b)` for the walk from a LIVE bot to points of its recorded track (at most 32 a plan, plans only while calm and only every `rejoinRetrySec` at most, none in a run nobody leaves the tape in). Implement it over CS2's nav mesh: an A* over the `.nav` areas (the engine's `CNavMesh` path, or a port of `NavMesh.path` over the CS2 areas), **one-way drop and jump links included** (the 2D mesh has none, so 2D over-estimates any way back down the Balcony), 2D length of the resulting polyline, `null` when unreachable, rounded to 6 decimals. Pure and deterministic for a given pair (cache per tick if needed); the golden fixtures' walk oracle (`paths`) has the 2D answers for replay tests.
- **set_mode REPLAY on a bot** is the reverse of the LIVE switch (`docs/cs2-adapter.md`, risk 5): take the bot back from the native AI (stop its own think / pathing, resume usercmd injection for it) on the tick it arrives, without touching position or velocity. The Core sends no teleport; the puppet's per-tick inputs catch it up (run speed, wall-aware).
- **The `rejoin` role** is a plain "run to `goal.hold` and wait" for the native bot (e.g. a forced move-to on the nav, run, not walk; it still fights). The Core switches it back on the way, usually within a second or two. If the bot switches away from the c4 the Core drew for a planter (`set_weapon c4` during the approach), the Core draws it again at the switch and the scripted USE waits the c4 deploy (`damage.defaultDeploySec`), so the plant is that much late.
- **Blocks back.** The switch re-sends B3's `block_damage` for the pawn's self pair and both directions with every enemy whose blocks aren't lifted: the same `OnTakeDamage` filter as B3's round-start blocks. `PawnState.blocksLifted` (LIVE and not rejoined since; also once dead) replaces B5's `everLive` in the resync's block rule.
- **Reconciliation actions** are ordinary `give` / `set_weapon`. A pickup the tape made while the bot was LIVE is given at the rejoin (`GiveNamedItem`); in CS2 the weapon it would have picked up may still lie on the ground (the 2D sim has no dropped guns): the adapter may remove it.
- **Arithmetic.** Lags are checked every 4 ticks back to `secTicks(steerFallbackSec)`; distances are 2D `Math.Sqrt`; `trackLength` sums the reference samples strictly between the two ticks plus the interpolated ends, in sample order; budgets are `runSpeed × rejoinSpeedFactor × ((k − tick) / 64 − rejoinLeadSec)` in doubles; plan targets and path lengths are rounded to 6 decimals before they are stored or logged. Log texts use `intText` and `tenthsText` only (`script: plant … runs x.x s late` uses the same integer tenths).
- **State** in the Core snapshot: the `RejoinState` list (one per LIVE pawn, PLAYER_IDS order: `liveSince`, `trigger`, `calmSince`, `target {tick, pos, plannedTick, pathUnits, chase}`, `nextPlanTick`, `drawTick`), `ScriptState.liveSpans` (`{id, from, to}` in the order they began) and `plantShift`, and each pawn's `blocksLifted`. All optional on restore (absent = none, 0, `everLive`).

## Checkpoints, rewind, summary (B5)

- **Capabilities.** `IHost.capabilities()` → `HostCapabilities {Snapshot, Seek, Speed}` (a record of bools). The CS2 adapter returns all **false** (`CS2_CAPABILITIES`): no engine snapshot, no ticks faster than real time, no `host_timescale`. What follows: every rewind is a **resync** (below); a seek back is a rewind to `CheckpointStore.AtOrBefore(tick, safe: true)` and then real-time play; a seek ahead and `speed` are refused (the app hides or disables them).
- **Checkpoints** are the driver's (`src/core/checkpoints.ts`, port it with the Core: plain data, a list in insertion order, `max` from `replay.checkpointMax`, oldest out first; `AtOrBefore` returns the last added among equal ticks). Take one before the step of every `replay.checkpointSec` multiple (`checkpointInterval`: `Math.Floor(sec * 64 + 0.5)`, at least 1), id `auto:<tick>`. Store `ICore.Snapshot()`, `null` for the host, the canonical observe the step will get, the log length, `ReplayCore.CheckpointHazards(observe)` and the driver's pending controls. Checkpointing must not change the log.
- **Resync rewind** (the CS2 path): `core.Restore(cp.Core)`; cut the log to `cp.LogLength`; `core.Control(new RewindControl(cp.Id))` (logged with the next line); feed `cp.Observe` to the next `Step` instead of the engine's. The Act starts with `resyncActions` (`src/core/resync.ts`): `set_round`, then per living pawn in id order `set_hp`, `teleport`, `strip`, `give`s, `set_weapon`, `set_mode` (not for the human), then `block_damage`/`unblock_damage` for all 60 self and enemy pairs in `PLAYER_IDS` × `PLAYER_IDS` order, then one `log`. Pure function of the observe and the Core state, so the golden replay contract holds (`tests/rewind.test.ts` replays a resync log).
- **CS2 adapter mapping** for the two new actions: `set_round` → `releaseTick = Server.TickCount − tick` (so the next observe is tick + 1), shift `CCSGameRules.RoundStartTime` by the same, team scores, and the bomb: carried → nothing (the gives place the `weapon_c4`), dropped → spawn `weapon_c4` at `pos`, planted → create or move `planted_c4` (the cs2-retakes recipe) with `C4Blow = now + (plantTick + 40 s − tick) / 64`, defused / exploded → remove it; remove grenade projectiles, smokes and infernos. A finished round can't be resumed: rewinding past `round_end` in CS2 is out of scope (the 2D host does it). `strip` → `RemoveWeapons()` + `weapon_knife`; `set_hp` with `hp > 0` on a dead pawn → `Respawn()` first; `set_hp 0` on a living one → `CommitSuicide` (a kill-feed line; avoid by not rewinding across a death in CS2 if that matters).
- **Not restorable in CS2** (and not in 2D's resync either): velocity, grenades in flight and active smokes / fires, a plant or defuse in progress, weapon timers, flashes, the bots' memory. `CheckpointHazards` marks checkpoints taken mid-plant / mid-defuse so the driver skips them.
- **Loadout ledger** (`loadout.ts`, in the Core snapshot): items sorted ordinally (stable for duplicate grenades), a gun `give` replaces its entry, a grenade / c4 / defuser `give` adds one. `releaseWindowTicks` = `Math.Ceiling((max(fuseSec, molotovFuseSec, throwRange / throwSpeed) + 1) * 64 − 1e-9)`; releases are a list (oldest first) filtered by `tick − release.tick <= window` at each pop.
- **Summary** (`summary.ts`): a pure function of `RoundModel` and the log lines. Times are formatted by `fixed2` (`c = Math.Floor(Math.Abs(x) * 100 + 0.5)`, sign only if `c > 0`, then `c / 100` and two digits of `c % 100`), never `ToString("F2")`. Kill matching: for each recorded kill in file order, the first unused run death of that victim; rows sorted by (recorded tick, else run tick), then recorded order, then death order. `aliveSec` and the RMS skip tick 0 (its observe predates the setup). The RMS uses `RoundModel.TrackAtTick` and `Math.Sqrt` (exact).

## Takeover (G4: take control of cart at any time)

- **Detect it from the observe, never from a control.** The Core keeps the last step's `observe.human`
  (`ReplayCoreState.human`, in the snapshot) and treats a different one on a later step (not the setup step) as a
  takeover (`humanChanged`). The CS2 plugin sends the Core nothing when the player takes over: the `take_control`
  control exists for the 2D app (its Session hands the pawn over itself) and `ICore.Control` accepts and ignores it.
  A log replays because the change is in the observe stream.
- **CS2: the native bot takeover.** Run the human as a sixth T who is dead or spectating at round start (no pawn of
  his own), with `bot_controllable 1`. While watching, the adapter reports `human: null` and drives cart's bot like
  any puppet. The player presses E (`+use`) while spectating cart's bot: CS2 hands him the bot's pawn (game event
  `bot_takeover` with `Userid` and `Botid`; the human's `CCSPlayerController.ControllingBot` turns true and the pawn's
  `OriginalControllerOfCurrentPawn` is cart's bot controller). From the next `OnTick` the adapter's observe names
  `cart` as `human`, and it **stops injecting usercmds for cart's bot** (the Core's Act has no input for him anyway;
  drop any movement token, button and view route of that slot, and release Bot-Controller's lock on it so the
  player's own usercmds drive the pawn). Position, velocity, view, weapon and HP stay the engine's: nothing to do.
  Only cart may be taken over: the plugin refuses the others (clear `CanControlObservedBot` while the player observes
  another bot, or cancel in a `bot_takeover` Pre hook if CSS allows it; probe P8).
- **Release.** A resync rewind to a checkpoint before the takeover (`checkpoint.observe.human == null`) must first
  give cart's pawn back to his bot and the player back to spectating (CS:GO's `CCSPlayer::ReleaseControlOfBot`; in CS2
  the route is unknown: P8 tries the player switching to spectator and back, which returns the pawn to its bot in
  CS:GO), then apply the resync prefix (which makes cart REPLAY and re-blocks his pairs). If the player leaves on his
  own mid-round, the Core sees `human` go null and makes the pawn LIVE (trigger `released`, regular goal): the
  adapter unlocks the bot for the native AI as for any LIVE switch. Engine rules: the player must be dead or spectating and
  the bot a living teammate (a dead cart can't be taken: the 2D Session refuses it too); CS2 probably allows one
  takeover per player per round (the controller schema has `HasControlledBotThisRound` and `BotsControlledThisRound`),
  so a second takeover after a rewind may need that flag cleared (P8).
- **The takeover tick's Act** has, before the triggers: `unblock_damage` cart → cart, then cart → each CT and back,
  in `PLAYER_IDS` order (only enemies without `blocksLifted`), then the log line, then one log per encounter of his.
  Integers and ids only in the texts (`tenthsText` for the encounter's shift).
- **Encounters** (`Divergence.Takeover`): `EncounterState` gained `puppetSightTick` (nullable int; absent in old
  snapshots = null), set while `observe.human` is null on the first tick the shooter (REPLAY) has the victim in `sees`
  within `humanSpotToleranceUnits` of the spot. At the takeover tick k: shooter dead / not REPLAY → `done`; `k >
  hitTick − actionLatencyTicks` → `fired` with `seenTick = recordedSightTick`, `shotTick = hitTick`; else suppress the
  recorded fire and aim keys (`Suppress` only pre-decides undecided ones), add the hold, and if `puppetSightTick` is set:
  `seen`, `seenTick = puppetSightTick`, `shotTick = max(seenTick + max(secTicks(encounterDelaySec), lead), k + lead)`
  with `lead = max(inputLatencyTicks, actionLatencyTicks)`, and the run-time engagement from k to `shotTick −
  inputLatencyTicks`; otherwise `waiting`.
- **Driver (the plugin's Session)**: record the takeover tick with the run (a checkpoint stores the human and the
  takeover tick next to the Core snapshot). A rewind to a checkpoint whose human is null undoes it (release, above);
  the takeover stays on the tape for a forward seek (2D only: CS2 can't seek ahead). The automatic checkpoint on the
  takeover tick is taken after it (before the step), so it keeps the human.
