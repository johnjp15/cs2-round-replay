# Golden master, headless harness and port fixtures (C5, E1)

The round must reproduce itself headless, and the TypeScript Core's behaviour on it is frozen into fixtures that
the C# port (F3) must reproduce byte for byte. Three pieces:

- **Headless harness** (`tools/harness.ts`, `npm run harness`): the round in Node through the app's own `Session`,
  optionally with a scripted human.
- **Golden master** (`tests/golden-round.test.ts`): the CI gate for the no-human round.
- **Fixtures** (`fixtures/golden/`, `npm run fixtures:update`, `tests/fixtures.test.ts`): logged rounds plus the walk
  oracle, which the TS Core must keep replaying and which the C# Core must reproduce.

## Headless harness (C5)

```sh
npm run harness -- [--human none|cart] [--script <path>] [--until <t|end>] [--seed <n>] [--out <dir>]
npm run harness -- --scenario fixtures/scenarios/lokier-late.json   # B4: a human-bot scenario, prints its timeline
npm run harness -- --until end                     # the golden master: 4,517 ticks, digest e6c2be70
npm run harness -- --human cart --script fixtures/scripts/cart-idle.json --until 20 --out logs/idle
```

It builds a `Session` (src/app/session.ts) with the app's `defaultCore` and steps it, so it runs exactly what the
page runs: same Core, same `Sim2DHost`, same per-tick contract, same `SessionLog`. The page and the harness produce
the same log (see "Browser parity").

| Option | Meaning |
| --- | --- |
| `--human none` (default) | Nobody plays; the Core drives all ten pawns. |
| `--human cart` | cart is the human pawn: the Core sends him no input and no scripted damage (B3). Without `--script` he gets no input and stands where the setup put him. Other player ids work too; the app only offers cart. |
| `--script <path>` | The human's input script (below). Needs `--human`. |
| `--until <t\|end>` | Run through observe tick round(t × 64), inclusive (`--until 20` logs ticks 0–1280, 1,281 lines). `end` (default) is the golden length, 4,517 ticks: one past the latest track end plus the 0.25 s hold. |
| `--seed <n>` | Core seed, default 1 (the page's default). Nothing draws from the Core's PRNG yet, so the log doesn't depend on it today. |
| `--out <dir>` | Writes `log.jsonl` (the SessionLog), `trace.json` (`toReplayTrace`, opens in the existing replay page) and `summary.json`. |
| `--scenario <path>` | B4: a human-bot scenario (`fixtures/scenarios/*.json`, `tools/human-bot.ts`): its human, seed, length (unless `--until`) and steps. Prints the bot's steps and the divergence timeline (switches to LIVE with their triggers, encounters, deaths, the round end). Excludes `--script`. |

`summary.json` is deterministic (canonical numbers, sorted keys), so two summaries can be diffed: digest and tick
range; every `death` (tick, attacker, weapon, headshot); `bomb` and `round_end` events; the final `observe.round`;
per pawn its Core mode changes and whether it ever went LIVE; snaps (teleports after the setup, with their log
line); body blocks (`host.blockedBy`); `plant` / `defuse_start` fallbacks; Core `log` actions; host notes (actions
not applied); per-player drift against the recording (observed, other and inferred samples: count and RMS; the
smallest uncertainty radius; % of ticks more than 24 u behind; snaps); script warnings. Timing goes to stdout only.

**Library.** `runHarness(data, options)` returns the Session, the parsed log lines (`entries`), each tick's
positions after its actions, snaps, body blocks and, with `recordWalk`, every walk-query call. `measureDrift`,
`deaths`, `hpChanges`, `shots`, `buttonSpans`, `roundEvents`, `actionsOfType`, `coreLogs` and `modeChanges` read a
run. `npm run ghost` and `npm run scripted` are now thin wrappers over it (same outputs and digest as before).
`HarnessOptions.controls` sends controls on given ticks (the browser check uses it to replay a page's `speed`).
`logDigest(log)` is `SessionLog.digest()` computed on a Buffer (about 6× faster on 17 MB; tested equal).

**Timing** (Node 22, the 2-vCPU 2.1 GHz cloud VM of `docs/app.md`, measured while another agent's test runs kept
the load average at 1.2–1.6, so ranges over five runs; `npm run harness` prints its own breakdown):

| | full round (4,517 ticks) |
| --- | ---: |
| Session construction | 0.06–0.08 s |
| 4,517 `session.step()` plus body blocks, then reading back the log (parse, positions, snaps) | 1.65–1.70 s |
| summary (digest, drift, events) | 0.14–0.16 s |
| **round, in process (cold)** | **1.87–1.92 s** |
| later rounds in the same process (JIT warm; tests, batch runs) | 1.6–1.7 s |
| process wall time, `npm run harness -- --until end` (adds npm + tsx start-up and loading the data) | 2.26–2.42 s |
| `--out` (writing the 17 MB log, the trace and the summary) | +0.25–0.33 s |

About two thirds of a step is JSON work the contract requires (`docs/app.md` "Worker decision": canonicalizing
the observe, writing the log line, canonicalizing the act), not the simulation.

### Input scripts ("chaos cart")

A script is a JSON array of entries, each held from its tick until the next entry's:

```json
[
{"t":0,"forward":0,"side":0,"yaw":175.601,"pitch":0,"buttons":[]},
{"t":3.53125,"forward":1,"side":0,"yaw":"track","pitch":0,"buttons":["WALK"],"weapon":"smoke"}
]
```

- `t`: video seconds ≥ 0; the entry starts on tick round(t × 64). Ticks must strictly increase. Before the first
  entry the human pawn gets no input.
- `forward`, `side`: −1..1 relative to the yaw (+side = strafe right), as `PawnInput`.
- `yaw`, `pitch`: degrees (Source convention: yaw CCW from +x, pitch positive down), or `"track"`. Yaw `"track"` is
  the pawn's recorded yaw at that tick (`PuppetTrack.recordedYawAt`, the Core's own interpolation of the POV yaw);
  where the recording has none it holds the previous tick's yaw (the setup yaw at first). Pitch `"track"` is 0: the
  recording has no pitch.
- `buttons`: from `ATTACK ATTACK2 USE DUCK WALK JUMP RELOAD`.
- `weapon` (optional): on the entry's first tick, switch to it through the app's weapon-slot keys
  (`Session.requestWeaponSlot`, pressed as often as slot cycling needs). It is not in the logged Act (as in the
  app); a weapon the pawn can't select becomes a warning in the summary.

Unknown keys, out-of-range values and unknown buttons or weapons are errors (`parseHumanScript`). Scripts are
written one entry per line (`formatHumanScript`).

**`fixtures/scripts/cart-idle.json`**: one entry: cart stands still on his start spot in Back Alley facing his
setup yaw (175.601°). He never moves, the Core sends him nothing, and his two scripted hits are skipped with a
`debug` log (Lokier's 73 HP at 18.5 s, his own kill of Lokier at 18.8 s), so Lokier lives on.

**`fixtures/scripts/cart-follows-recording.json`**: cart plays his own recording, the closest thing to "a human who
plays it perfectly". Generated, not written by hand (`tools/follow-script.ts`, run by `npm run fixtures:update`):
the harness runs the round with cart as the human, and each tick a shadow `ReplayCore` (fed the live observe with
`human: null`, and with `driftSnapUnits` = 10⁹, because a human can't teleport) decides cart's input as if he were a
puppet: B2's track following and B3's aim, shots, grenades and weapon switches (its `set_weapon`s become `weapon`
entries). The inputs are written as entries, a new one only where the held one would give a different input
(`"track"` where the input's yaw is the recorded yaw: 2,305 of 4,460 entries), and the generator checks that
playing the file reproduces the generation run byte for byte (digest `5c3016f4`). Results:

- cart, observed samples: RMS 20.5 u (13.5 as a puppet), max 152 u at 14.5 s: without the puppet's snaps he has to
  catch up physically after the recording's jumps (217 u in 0.3 s at 14.2 s, the Balcony drop at 21.0 s). The
  puppets' snaps of cart are gone; the other four happen as in the golden master.
- With C4's sight mask cart's real AK headshot kills Lokier at 18.50 s through the Apartments window (0.3 s before the
  recorded kill: 2D has no spread), before B4's time-shifted scripted hit is due (18.63 s), so cart keeps 100 HP. With
  B4 the only pawn that goes LIVE is sp4rtan, hit by cart's recorded spray during the defuse at 65.91 s (the B-site
  boxes that stopped it in the recording are open in the mask); cart kills him at 66.22 s (T elimination, 11 – 16) and
  the bomb explodes at 67.52 s. `docs/core.md` "Divergence", scenario 1.
- The shadow is a `ReplayCore` with `{divergence: false}` (B2/B3 only). 4,321 entries.

## The golden master (CI gate)

`tests/golden-round.test.ts` runs the no-human round once through the harness (it merges B2's
`ghost-round.test.ts` and B3's `scripted-round.test.ts`; no assertion was dropped) and gates:

| Gate | What |
| --- | --- |
| Kills | All nine recorded kills as `death` events within ±1 tick, with attacker, weapon and headshot; nobody else dies; sp4rtan survives on 100 HP. |
| HP | Every pawn's HP / armor goes through exactly the recorded changes (the schedule's damage entries), each within a tick; donk 100 → 73 → 39 → 13 → 0, cart 100/100 → 27/93 → 0, snarlbot 44 → 0. |
| Shots | Every recorded exact-time shot has a `shot` event within a tick; rounds fired match the HUD (cart 24, barely 18, donk 2, Lokier 2). |
| Latency | Input, damage action and `set_weapon` show one tick later, as `tuning.replay` says. |
| Plant / defuse | `planted` once by barely at 1761 ± 1 with USE held from the planned tick until then; `defuse_start` 3955 ± 1, `defused` 4275 ± 1 by sp4rtan; no `defuse_stop`, no explosion. |
| Round end | Once, CT `bomb_defused` at 4275 ± 1; the final round state is `over`, CT 12 – T 15; no `end_round` action; the post-round kill on cart at 4442 still happens. |
| Drift | Every T's observed samples RMS < 24 u; every CT's inferred samples RMS < that CT's smallest uncertainty radius. |
| Teleports | Exactly B2's six documented snaps (cart 922, donk 923, sp4rtan 1165 and 1248, cart 1350, barely 2879), each inside a teleport window and logged once; no other teleport after the setup. |
| Modes | No pawn ever goes LIVE: each is REPLAY until DEAD (sp4rtan REPLAY throughout); no `set_mode`. |
| Fallbacks | No `plant` / `defuse_start` action, no `script:` log, no action the host leaves unhandled, no harness warning. |
| Collision | No body block at any tick. |
| Replay | The log replays identically through a fresh `defaultCore`. |
| Fixture | The log equals `fixtures/golden/round-nohuman.jsonl.gz` byte for byte (digest and tick count from the manifest). |
| Trace | `toReplayTrace` has all ten tracks, to each death; one `info` event per snap. |

`tests/golden-harness.test.ts` covers the harness itself (script parsing and playback, slot switching, CLI options,
`--until` semantics, the summary, `logDigest`, harness = bare `Session`) and the two example scripts (idle cart
stands exactly still and his scripted damage is skipped; the committed follow script is the generator's output for
its first 20 s, plays back byte for byte and keeps cart within 30 u RMS with no snap).

## Fixtures (`fixtures/golden/`)

| File | Content | Size (gzip) | Raw | Digest |
| --- | --- | ---: | ---: | --- |
| `round-nohuman.jsonl.gz` | The golden master: no human, ticks 0–4516 (4,517 lines) | 966,178 | (see manifest) | `e6c2be70` |
| `round-nohuman.walk.jsonl.gz` | Its walk oracle: 27,859 calls | 413,961 | | `9517e48f` |
| `round-cart-idle.jsonl.gz` | Human cart, `cart-idle.json`, ticks 0–1280 (20 s) | 279,873 | (see manifest) | `868f56db` |
| `round-cart-idle.walk.jsonl.gz` | Its walk oracle: 12,770 calls | 129,333 | | `84734d9c` |
| `manifest.json` | One entry per fixture | 1,846 | | |

With the two scripts (402 KB) everything under `fixtures/` is 2.19 MB; `tests/fixtures.test.ts` keeps the golden
files under 3 MB. **Nothing is strided**: every line is a complete SessionLog line (`{act, controls, observe}`) for
every tick. A trimmed "observe + act only" variant would save nothing (`controls` is `[]` on every line but the
first), so there is none.

- **Log** (`<name>.jsonl.gz`): the SessionLog text exactly as `SessionLog.toText()` writes it (canonical JSON lines,
  `\n` after each), so the manifest digest is `SessionLog.digest()` of the uncompressed bytes. Ticks are
  consecutive from 0, with no repeats.
- **Walk oracle** (`<name>.walk.jsonl.gz`): every `WalkQuery.isWalkableLine(a, b)` call the Core made, one line per
  tick that made any: `{"calls":[{"a":{x,y,z},"b":{x,y,z},"walkable":true},…],"tick":12}`, calls in the Core's call
  order, numbers as the log writes them (6 decimals). It lets a Core port be tested without porting the 2D nav mesh
  (the CS2 plugin's walk query is a different implementation, so the answers have to come from somewhere).
- **gzip**: level 9, header with mtime 0, no file name and OS byte 255 (unknown), so the header doesn't depend on
  the machine. The deflate stream itself may differ between zlib builds (Node bundles Chromium's zlib, which picks
  code paths by CPU features); therefore `fixtures:update` keeps a committed file whose *uncompressed* content is
  unchanged, and the tests compare content, not compressed bytes.
- **`manifest.json`**: per fixture `name`, `description`, `file`, `walkFile`, `human`, `script` (+ `scriptHash`),
  `seed`, `until`, `ticks`, `firstTick`, `lastTick`, `digest`, `rawBytes`, `bytes`, `walkCalls`, `walkDigest`,
  `walkBytes`, `tuningHash` / `roundHash` / `navHash` (FNV-1a 32-bit of the canonical JSON of `data/tuning.json`,
  `data/round.json`, `data/mirage-nav.json`: `fnv1a32Hex(stableStringify(JSON.parse(text)))`), `commit`
  (`git rev-parse HEAD` when the content last changed) and `sourceDirty` (src/, data/ or tools/ had uncommitted
  changes then).

### `tests/fixtures.test.ts`

For each fixture: the manifest's input hashes, script hash, seed and length match the current files and specs;
the gzip header is as above; the content matches the manifest (digest, sizes, tick count, consecutive ticks; every
line already canonical); every line replays through a fresh Core with an identical act, while a checking walk query
confirms the Core asks exactly the oracle's questions in order and the 2D nav agrees with the oracle's answers; the
human fixture is also re-run through the harness (engine included) and must come out byte for byte (the no-human
one is re-run by the golden master).

### Updating fixtures: when and why

```sh
npm run fixtures:update             # regenerates fixtures/golden/* and fixtures/scripts/cart-follows-recording.json
npm run fixtures:update -- --check  # changes nothing; exit 1 if anything would change
```

A failing `fixtures.test.ts` or golden "equals the committed fixture" test means the Core's or the engine's output
changed. That is allowed, but it has to be explicit:

1. Make sure the change is intended (a new feature or tuning, an engine fix), not a regression: the other golden
   gates still have to pass.
2. Commit the code first, then run `npm run fixtures:update` on the clean tree (so the manifest's `commit` names
   it and `sourceDirty` is false) and commit `fixtures/` in the same PR.
3. In the PR, say which fixtures changed, the old and new digests, the first tick that differs and why
   (`npm run harness -- … --out` before and after, and diff `summary.json`).

Re-running is idempotent: unchanged content keeps its bytes and its manifest entry, so a diff under `fixtures/`
always means behaviour changed. The follow script is regenerated too (it is the generator's output for the current
Core and engine); `cart-idle.json` is hand-written. A change to `data/tuning.json`, `data/round.json` or
`data/mirage-nav.json` makes the fixtures stale even if no output changed (the hashes are checked).

**Known upcoming change: C4** (radar visibility mask, real `sees`) changes the Observe stream (`sees` arrays),
`tuning.json` and with it every digest. Whoever merges second runs `npm run fixtures:update` and reports the new
digests. With no human, C4 shouldn't change what the puppets do (snaps only check the human's `sees`); with human
cart it can (a puppet the human sees is never snapped).

## Replay contract for the C# port (F3)

What a port must reproduce, for every fixture in `manifest.json`:

1. **Build** the Core from `data/round.json`, `data/tuning.json` (check `roundHash` / `tuningHash` first) and the
   fixture's `seed`: `RoundModel`, `EventSchedule`, the parsed tuning, `new ReplayCore(model, schedule, tuning,
   seed, walk)`. `walk` is the fixture's walk oracle (preferred), or a port of the 2D `NavMesh.segmentWalkable` over
   `data/mirage-nav.json`.
2. **Feed every line, in order, to one fresh Core.** For line i: send its `controls` to `Control()` in order (line 0
   has `start`), then `act = Step(observe)` with the line's `observe` exactly as parsed (its numbers are already
   canonical doubles). No line may be skipped and there is no starting mid-stream: the act depends on the Core's
   state from all earlier lines (puppet yaw and drift, used teleport points, spray and fire decisions, bomb events
   seen, the setup flag), and the log holds no Core snapshot.
3. **Compare** `StableStringify(act)` with the line's act re-serialized the same way: they must be equal as text
   (`docs/port-notes.md` "stableStringify": sorted keys, 6-decimal numbers, `-0` → `0`, JSON.stringify string
   escaping). That covers inputs (one per REPLAY pawn, sorted, buttons in `BUTTONS` order), actions in Core order
   (including `log` texts, which use only integers and ids) and the status of all ten pawns.
4. **Walk queries**: on line i the Core's `isWalkableLine` calls must be the oracle's calls for that tick, in
   order, with coordinates equal as `formatNumber` text; answer with the oracle's `walkable`. An extra, missing or
   different call is a divergence (report it with the tick); the oracle-backed run is then still useful to find the
   first act that differs.
5. **Whole-log check**: serialize every line as `StableStringify({act, controls, observe})` with your act; the
   FNV-1a 32-bit of the UTF-8 text (each line plus `\n`) must equal the manifest `digest`. This also tests the port's
   serializer on the observe side.

The human's own input and app-side weapon switches are engine-side and not in the log; the Core doesn't need them
(it sends the human nothing). `round-cart-idle` covers the human path (no input, no block pairs or scripted damage
for him, 40 + 9 `block_damage` instead of 50 + 10, the `debug` logs).

## Cross-engine determinism

- **Exact everywhere:** `+ − × ÷`, `Math.sqrt`, `floor` / `ceil`, the integer bit math of FNV and the PRNG, and the
  number format (`toFixed(6)` is an exact decimal conversion). With canonical inputs these give identical bits in
  V8, JavaScriptCore and .NET.
- **Not specified:** `Math.cos`, `Math.sin` and `Math.atan2` (and `Math.hypot`, which the engine uses). ECMAScript
  doesn't fix their last bit. V8 computes them with code it ships (fdlibm-derived, or a bundled port of glibc's
  sin/cos, depending on a build flag), so V8 results don't depend on the OS, but Node's and Chrome's V8 builds aren't
  guaranteed to agree, JavaScriptCore (Safari) may differ, and .NET's `Math.Sin` / `Cos` / `Atan2` call the
  platform's C library.
- **How the Core copes** (C1, B2, B3; `docs/port-notes.md` "Puppets", "Trig"): those three are the Core's only inexact math,
  and every result is rounded before it is logged, stored or branched on (yaws and pitches to 0.001°, sticks to
  10⁻⁶), so an ulp only matters when it flips a rounding tie.
- **Measured on the fixtures:** nudging *every* `cos`, `sin` and `atan2` result in the Core by 1, 16, 256, 4,096 or
  65,536 ulps (up or down) and replaying `round-nohuman` and `round-cart-idle` changes **no act**. Only at 2²⁰ ulps
  (about 2 × 10⁻¹⁰ relative) does one line of 4,517 change (one stick value in its last digit); at 2²⁴, 35 lines; at
  2²⁸, about 460, each a last-digit change that doesn't spread (the observes are fixed in a replay). A correct libm
  (within an ulp or two) therefore reproduces the fixtures; F3 should not need to port fdlibm. If a C# run shows
  isolated last-digit differences in a yaw, pitch or stick, this is the cause.
- **The engine** (Sim2DHost) uses trig too (movement, hitscan, grenades), so a different JS engine could produce a
  different *observe* stream for the same inputs. The fixtures carry the observes, so the Core test doesn't depend
  on the engine; only `npm run harness`, the golden master and browser parity do.

### Browser parity

`npm run build && npx tsx tools/browser-check.ts --only parity` (also step 8 of the full `npm run check:browser`):
the built page plays the no-human round with its own loop (`?human=none`, 4×) past 20 s and pauses; the page
hashes its log through tick 1280, and the Node harness runs the same round with the controls the page logged (its
4× button logs `speed` on tick 1). Result (headless Chromium 153.0.8010.12, V8 15.3, against Node 22.23, V8 12.4):
through tick 1280 both are `045fe7ec`, and the whole page log (1,293 lines, to tick 1292) matches too (`ba029b1a`).
D1's spectate check (phone viewport, 1×) still compares a whole page log with a bare Node `Session`. Safari is not
tested (no WebKit here).

## History

- C4 (#16) made `sees` real (radar sight mask) and clamps grenade throws at the mask's walls: the no-human digest went `0fb55e23` → `e6c2be70` and cart-idle `6505c774` → `76ee296f`. Core acts, positions, kills, HP, shots, plant and defuse are unchanged. The harness must pass `vision` to `Session` (as the app does): `parseSessionData` defaults the mask to null, which silently falls back to nav line of sight.
- B4 (divergence) adds the `HUMAN` status mode and plays Lokier's hit on cart as a scheduled encounter: cart-idle `76ee296f` → `868f56db` (walk oracle `cfcdde41` → `84734d9c`). Every line's status shows cart `HUMAN` instead of `REPLAY`; from tick 1161 Lokier holds the angle on the Apartments window instead of the recorded aim at cart, so his input (yaw, and the stick re-expressed in it) and from 1162 his observed yaw and position differ, and his recorded tap at 1183 is gone (no `shot` at 1184; the encounter never starts, cart stays in Back Alley). The no-human golden master is byte-identical (`e6c2be70`); its manifest entry changed only for the new `tuningHash`. The follow script is the same through 66.0 s (sp4rtan goes LIVE at 65.91 s, so cart's aim at him differs from 66.03 s on).
