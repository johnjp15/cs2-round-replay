# C# port notes

Things in `src/contracts` (and, at the end, `src/core`) that need care when ported to C# (CS2 server plugin). The session logs written by the TypeScript build are the fixtures: a correct port reproduces them byte for byte.

## Types

- **Discriminated unions** (`ObsEvent`, `Action`, `Control`) → an `abstract record` base per union with one `sealed record` per member; (de)serialize with a `"type"` discriminator whose value is the TS `type` string (`System.Text.Json` `[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]` + `[JsonDerivedType(typeof(X), "block_damage")]`). Switches over `type` → `switch` on the record type; keep them exhaustive.
- **String unions** (`PlayerId`, `Team`, `WeaponId`, `ItemId`, `Button`, `Hitgroup`, `Mode`, `SoundKind`, `BombPhase`, `RoundEndReason`, `LogLevel`, and for round data `Confidence`, `GrenadeId`, `ShotKind`) → either `string` constants or enums with a converter that writes the exact TS spelling (lowercase ids, `REPLAY`, `ATTACK2`, `bomb_defused`). Never use the enum's integer value in logs.
- **`readonly` fields** → `init`-only record properties. **`readonly T[]`** → `ImmutableArray<T>` (note: record equality on `ImmutableArray` is reference-based; compare logs by text, not by record `==`).
- **`null` vs absent**: TS has no optional fields; every property is always written, `null` included. Do not set `JsonIgnoreCondition.WhenWritingNull`. The one exception is input, not output: `data/round.json` omits `TrackSample.uncertainty` and `TrackSample.resampled` when they don't apply, so read them as `double?` / `bool?`.
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
- `Math.cos`/`Math.sin` etc. are not guaranteed bit-identical between V8 and .NET; Core logic that depends on them should round (or compare with tolerance) before branching. Plain `+ - * /` and `Math.Floor`/`Math.Sqrt` are IEEE-exact on both.
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
