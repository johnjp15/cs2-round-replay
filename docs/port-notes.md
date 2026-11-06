# C# port notes

Things in `src/contracts` that need care when ported to C# (CS2 server plugin). The session logs written by the TypeScript build are the fixtures: a correct port reproduces them byte for byte.

## Types

- **Discriminated unions** (`ObsEvent`, `Action`, `Control`) → an `abstract record` base per union with one `sealed record` per member; (de)serialize with a `"type"` discriminator whose value is the TS `type` string (`System.Text.Json` `[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]` + `[JsonDerivedType(typeof(X), "block_damage")]`). Switches over `type` → `switch` on the record type; keep them exhaustive.
- **String unions** (`PlayerId`, `Team`, `WeaponId`, `Button`, `Hitgroup`, `Mode`, `SoundKind`, `BombPhase`, `RoundEndReason`, `LogLevel`) → either `string` constants or enums with a converter that writes the exact TS spelling (lowercase ids, `REPLAY`, `ATTACK2`, `bomb_defused`). Never use the enum's integer value in logs.
- **`readonly` fields** → `init`-only record properties. **`readonly T[]`** → `ImmutableArray<T>` (note: record equality on `ImmutableArray` is reference-based; compare logs by text, not by record `==`).
- **`null` vs absent**: TS has no optional fields; every property is always written, `null` included. Do not set `JsonIgnoreCondition.WhenWritingNull`.
- **`number`** is a double everywhere, including ticks, hp and counts. Ticks are integral doubles; `Math.round(i * 6.4)` (trace sampling) is JS rounding (half up toward +∞) → `Math.Floor(i * 6.4 + 0.5)` in C#, not `Math.Round` (banker's).
- **Snapshots**: `data` is a `JsonValue` → `JsonNode`/`JsonElement`.

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
