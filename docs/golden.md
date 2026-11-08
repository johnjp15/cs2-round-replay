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
npm run harness -- [--human none|cart] [--takeover <t>] [--script <path>] [--until <t|end>] [--seed <n>] [--out <dir>]
npm run harness -- --scenario fixtures/scenarios/lokier-late.json   # B4: a human-bot scenario, prints its timeline
npm run harness -- --until end                     # the golden master: 4,517 ticks, digest 138b0c70 on mirage-2020 (X1d; 46a352d7 on mirage-cs2 at P3)
npm run harness -- --until end --map mirage-cs2    # X1: the same round on CS2's Mirage package
npm run harness -- --human cart --script fixtures/scripts/cart-idle.json --until 20 --out logs/idle
npm run harness -- --takeover 18.6                 # G4: watch to 18.6 s, then cart is the human (no input: he stands still)
```

It builds a `Session` (src/app/session.ts) with the app's `defaultCore` and steps it, so it runs exactly what the
page runs: same Core, same `Sim2DHost`, same per-tick contract, same `SessionLog`. The page and the harness produce
the same log (see "Browser parity").

| Option | Meaning |
| --- | --- |
| `--human none` (default) | Nobody plays; the Core drives all ten pawns. |
| `--human cart` | cart is the human pawn: the Core sends him no input and no scripted damage (B3). Without `--script` he gets no input and stands where the setup put him. Other player ids work too; the app only offers cart. |
| `--takeover <t>` | G4: nobody plays until observe tick round(t × 64); there the human (`--human`, default cart) takes control (`Session.takeControl`, before that tick's observe) and from then on it is as `--human`: the first lines are the no-human run's, byte for byte. Without `--script` he gets no input after it (stands still). `--takeover 0` is `--human cart`, byte for byte. Overrides a scenario's `takeover`. Not with `--human none`. |
| `--script <path>` | The human's input script (below). Needs `--human` (or `--takeover`). With `--takeover`, entries apply from the takeover tick (the one in force then, and those after). |
| `--until <t\|end>` | Run through observe tick round(t × 64), inclusive (`--until 20` logs ticks 0–1280, 1,281 lines). `end` (default) is the golden length, 4,517 ticks: one past the latest track end plus the 0.25 s hold. |
| `--seed <n>` | Core seed, default 1 (the page's default). Nothing draws from the Core's PRNG yet, so the log doesn't depend on it today. |
| `--out <dir>` | Writes `log.jsonl` (the SessionLog), `trace.json` (`toReplayTrace`, opens in the existing replay page) and `summary.json`. |
| `--scenario <path>` | B4: a human-bot scenario (`fixtures/scenarios/*.json`, `tools/human-bot.ts`): its human, seed, length (unless `--until`), (G4) `takeover` (seconds; the steps start on that tick, the view where the puppet left it) and steps. Prints the bot's steps and the divergence timeline (switches to LIVE with their triggers, encounters, deaths, the round end). Excludes `--script`. |

`summary.json` is deterministic (canonical numbers, sorted keys), so two summaries can be diffed: digest and tick
range; (G4) `takeoverTick`; every `death` (tick, attacker, weapon, headshot); `bomb` and `round_end` events; the final `observe.round`;
per pawn its Core mode changes and whether it ever went LIVE; snaps (teleports after the setup, with their log
line); body blocks (`host.blockedBy`); `plant` / `defuse_start` fallbacks; Core `log` actions; host notes (actions
not applied); per-player drift against the recording (observed, other and inferred samples: count and RMS; the
smallest uncertainty radius; % of ticks more than 24 u behind; snaps); script warnings. Timing goes to stdout only.

**Library.** `runHarness(data, options)` returns the Session, the parsed log lines (`entries`), each tick's
positions after its actions, snaps, body blocks and, with `recordWalk`, every walk-query call. `measureDrift`,
`deaths`, `hpChanges`, `shots`, `buttonSpans`, `roundEvents`, `actionsOfType`, `coreLogs` and `modeChanges` read a
run. `npm run ghost` and `npm run scripted` are now thin wrappers over it (same outputs and digest as before).
`HarnessOptions.controls` sends controls on given ticks (the browser check uses it to replay a page's `speed`).
G4: `HarnessOptions.takeover` (a tick) has `human` take control there; the driver is asked every tick (a human-bot's
shadow puppet needs them all) but its commands apply only once someone plays.
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
entries). One exception (F, `tools/follow-aim.ts`): B3 aims every recorded shot at its target, which is right for a
puppet (its damage is scripted) but not for the human, whose bullets are real and, with no spread in 2D, land where
aimed. In an aim engagement the recording shows him **missing** (no damage or kill by him on that target), the script
looks where his recorded view does (his POV yaw, where the camera follows him) and keeps moving the same way (the stick
re-expressed in that yaw); the pitch stays B3's. For cart that is the defuse spray at sp4rtan (65.55–66.89 s; his
recorded yaw tracks a fixed point near (−2210, 275) within 0.8°, 17–22° off sp4rtan's spot, `docs/vision.md`) and the
post-round spray (68.30–69.27 s); his Lokier engagement (a recorded kill) keeps B3's aim. (G5: these engagements are
the human's recorded duels, so his shots there resolve like the tape whatever the aim; the recorded view is kept as
the truer input.) The human-bot's `followRecording` does the same. The inputs are written as entries, a new one only
where the held one would give a different input (`"track"` where the input's yaw is the recorded yaw: 2,325 of 3,962
entries), and the generator checks that playing the file reproduces the generation run byte for byte (digest
`0c4f0fa7`; before G5 `5a558c44`, 3,980 entries). Results:

- cart, observed samples: RMS 277.6 u, max 525 u at 33.7 s, unchanged by G5: without the puppet's snaps he has to
  catch up physically after the recording's jumps, and on G3's CS2 Mirage he can't get past where the puppet snaps
  (29.4 s, 64.3 s). The puppets' snaps of cart are gone; the others happen as in the golden master.
- **G5: the tape.** Lokier sees him on course at the window (17.59 s), so his hit lands on the recorded tick (18.50 s,
  73 / 7); cart is in the recorded duel, his bullets on Lokier are blocked, and his spray, on target (the first bullet
  would hit) and still firing at the kill moment, lands the recorded kill on 18.80 s (tick 1203). His sprays at
  sp4rtan (the defuse, after the round) are duels with no damage; sp4rtan defuses at 66.80 s (CT `bomb_defused`,
  12 – 15, 0.72 s on the bomb) and his post-round shot kills cart on 27 HP at 69.41 s (tick 4442). **No pawn goes
  LIVE**; every kill is on the golden master's tick; B5's summary (printed by `npm run harness` as `round summary:`):
  "Played it like the tape: CT defuse, 0.72 s left". Before G5 cart's real AK headshot killed Lokier at 18.50 s
  through the Apartments window (2D has no spread) before the time-shifted hit was due (18.59 s), so cart kept
  100 HP and survived the post-round shot (on 73 HP): "Same result, different round: CT defuse, 0.72 s left; 2 kills
  changed". `docs/core.md` "Recorded duels of the human", "Divergence" scenario 1.
- **D1 (John 2026-11-07 13:10): real damage in the duel.** Lokier's hit still lands on 18.50 s (cart 27 HP); his
  first would-hit bullet is now real and kills Lokier at 18.61 s (tick 1191, 0.19 s early); nobody goes LIVE, every
  other kill, the plant and the defuse are on the tape's ticks, and the post-round shot still kills cart: "Same result,
  different round: CT defuse, 0.72 s left; 1 kill changed".
- The shadow is a `ReplayCore` with `{divergence: false}` (B2/B3 only).

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
| Teleports | Exactly the documented snaps (X1d, on mirage-2020: snarlbot 333, cart 920, donk 921, sp4rtan 1169 / 1229 / 1245, donk 1344, cart 1395; B2's were cart 922, donk 923, sp4rtan 1165 and 1248, cart 1350, barely 2879), each inside a teleport window and logged once; no other teleport after the setup. |
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
| `round-nohuman.jsonl.gz` | The golden master: no human, ticks 0–4516 (4,517 lines); X1d: on mirage-2020, the default package | 991,874 | (see manifest) | `138b0c70` |
| `round-nohuman.walk.jsonl.gz` | Its walk oracle: 29,630 calls | 436,161 | | `fc2e2709` |
| `round-cart-idle.jsonl.gz` | Human cart, `cart-idle.json`, ticks 0–2880 (45 s; G1: Lokier outlives, barely and sp4rtan go LIVE and rejoin) | 598,570 | (see manifest) | `d803f5ab` |
| `round-cart-idle.walk.jsonl.gz` | Its walk oracle: 20,126 calls, and barely's rejoin path queries | 272,095 | | `ecb20b33` |
| `round-cart-takeover.jsonl.gz` | G4: watching until 15 s, then cart is the human and stands still (`--takeover 15 --until 24`), ticks 0–1536 (1,537 lines): lines 0–959 are the golden master's; line 960 has `human: cart`, the 11 `unblock_damage` and the takeover log; Lokier outlives (21.80 s), barely kills him and rejoins (23.14 s) | 378,378 | (see manifest) | `a92fb84c` |
| `round-cart-takeover.walk.jsonl.gz` | Its walk oracle: 15,594 calls, and barely's rejoin path queries | 168,526 | | `faed9b39` |
| `manifest.json` | One entry per fixture | 2,111 | | |

The golden files total 2.85 MB gzipped (G4's fixture added 0.55 MB); `tests/fixtures.test.ts` keeps them under 3 MB. **Nothing is strided**: every line is a complete SessionLog line (`{act, controls, observe}`) for
every tick. A trimmed "observe + act only" variant would save nothing (`controls` is `[]` on every line but the
first), so there is none.

- **Log** (`<name>.jsonl.gz`): the SessionLog text exactly as `SessionLog.toText()` writes it (canonical JSON lines,
  `\n` after each), so the manifest digest is `SessionLog.digest()` of the uncompressed bytes. Ticks are
  consecutive from 0, with no repeats.
- **Walk oracle** (`<name>.walk.jsonl.gz`): every `WalkQuery.isWalkableLine(a, b)` call the Core made, one line per
  tick that made any: `{"calls":[{"a":{x,y,z},"b":{x,y,z},"walkable":true},…],"tick":12}`, calls in the Core's call
  order, numbers as the log writes them (6 decimals). It lets a Core port be tested without porting the 2D nav mesh
  (the CS2 plugin's walk query is a different implementation, so the answers have to come from somewhere). G1: a
  tick on which the rejoin planner asked `WalkQuery.pathLength(a, b)` also has
  `"paths":[{"a":{x,y,z},"b":{x,y,z},"length":207.014072},…]` (length null = no path), in call order; the key is
  absent on every other tick, so oracles without rejoin plans are unchanged. A port answers `pathLength` calls from
  `paths` the same way, in order.
- **gzip**: level 9, header with mtime 0, no file name and OS byte 255 (unknown), so the header doesn't depend on
  the machine. The deflate stream itself may differ between zlib builds (Node bundles Chromium's zlib, which picks
  code paths by CPU features); therefore `fixtures:update` keeps a committed file whose *uncompressed* content is
  unchanged, and the tests compare content, not compressed bytes.
- **`manifest.json`**: per fixture `name`, `description`, `file`, `walkFile`, `human`, `script` (+ `scriptHash`),
  `seed`, `until`, (G4) `takeover` (seconds, or null: the human plays from the start), `ticks`, `firstTick`, `lastTick`, `digest`, `rawBytes`, `bytes`, `walkCalls`, `walkDigest`,
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
   (`npm run harness -- … --out` before and after, and diff `summary.json`). `tools/fixture-diff.ts` (F) compares two
   logs line by line and separates the Core's acts from the observes (pawn fields, `sees` on its own, events by type,
   the round); it exits 1 if any act differs:

   ```sh
   git show main:fixtures/golden/round-nohuman.jsonl.gz > /tmp/old.jsonl.gz
   npx tsx tools/fixture-diff.ts /tmp/old.jsonl.gz fixtures/golden/round-nohuman.jsonl.gz
   ```

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
for him, 40 + 9 `block_damage` instead of 50 + 10, the `debug` logs). `round-cart-takeover` (G4) covers a takeover:
the port's Core must notice `observe.human` changing on line 960 by itself (no control announces it) and answer with
the 11 `unblock_damage`, the takeover log and the encounter's log, then treat cart as the human.

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
through tick 1280 both are `8a6f3b52` (F's cover; `2b8dc5fb` on B4's main, where the docs still said C4's `045fe7ec`),
and the whole page log matches too (`e5b41166` for 1,293 lines, to tick 1292; that digest depends on the tick the page
paused on).
D1's spectate check (phone viewport, 1×) still compares a whole page log with a bare Node `Session`. Safari is not
tested (no WebKit here).

## History

- X1d (`mirage-2020` is the default map package, docs/maps.md "The default"): every fixture moves (no-human
  `46a352d7` → `138b0c70`, cart-idle `bd0f9623` → `d803f5ab`, cart-takeover `e4fa9352` → `a92fb84c`; walk oracles
  `fca9c138` → `fc2e2709`, `3833a5f8` → `ecb20b33`, `312d45f2` → `faed9b39`; never-peeks without rejoin `ae7af1f6` →
  `a60ad2e1`; the follow script regenerated, 4,236 entries, run `390f1ec0`). `tools/fixture-diff.ts` against main: the
  acts and every pawn field differ from tick 0/1 (another collision mesh, another snapped track for every pawn); the
  no-human round's deaths, plant, defuse and round end are on the same ticks (32, 794, 816, 1142, 1203, 2829, 3222,
  3766, 4442; plant 1761; defuse 3955 → 4275; CT defuse, 0.72 s left), the bomb lies on the 2020 floor (z −159.97,
  CS2 −149.99); the snaps are 8 (snarlbot 333, cart 920, donk 921, sp4rtan 1169 / 1229 / 1245, donk 1344, cart 1395).
  cart-takeover: the same deaths / plant ticks. cart-idle: plant 1795 (1792), sp4rtan kills cart at 2674 (2601) and
  barely, LIVE again, kills Zwomp for real at 2682 (2829): sp4rtan sees the idle cart 1.1 s later on the 2020 mesh.
- V2 (`docs/viewfit.md`: every watched player's yaw and pitch fitted to the video, puppets follow them; scoped rifles
  slower than a walk hold their angle; the window duel's positions as on main, see "Engagement positions"): no-human
  `cf57c99a` → `f4129248`, cart-idle → `8beda596`, cart-takeover → `6bd4b304` (manifest); never-peeks without rejoin
  `64ad6d38` → `fc6f7bda`. `tools/fixture-diff.ts` on all three: the acts
  differ in input.yaw / pitch and input.forward / side (the stick is relative to the yaw), a few buttons and the
  targets of the same snap teleports (same ticks); the observes in yaw, pitch, `sees`, pos (up to 19 u, barely, from
  the stick's rounding and the walk) and footstep `sound`; **no shot, damage, death, bomb or round event differs** and
  observe.round is identical (2D = 3D, "Played it like the tape: CT defuse, 0.72 s left").

- K1 (`tools/snap-tracks.ts` pass 4 `lead` and pass 5's barely ↔ sp4rtan duel, docs/round-data.md "sp4rtan's kill on
  barely"): no-human `9f07df0b` → `9a994b97` (walk oracle `29adfc6e` → `a29f7a43`), cart-idle `384e6c75` → `b3a92236`
  (walk unchanged), cart-takeover unchanged (`f49d323c`); never-peeks without rejoin `b861137b` → `7ce7345e`.
  `tools/fixture-diff.ts`, no-human: Core acts from tick 3146 (sp4rtan's and, from 58.4 s, barely's puppet inputs),
  pawn pos/vel/yaw/pitch/sees/onGround and footstep `sound` events; no shot, damage, death, bomb or round event
  differs. cart-idle: one act (sp4rtan's LIVE route waypoints at tick 2564, a few units), no observe line.

- W2 (every pawn gets a pistol in the setup: the recorded one, else Glock-18 T / USP-S CT, docs/core.md "Start state"):
  no-human `7168c0a5` → `9f07df0b`, cart-idle `12bf92f7` → `384e6c75`, cart-takeover `53e00fa6` → `f49d323c`; never-peeks without rejoin
  `93e0dc15` → `b861137b`. `tools/fixture-diff.ts` on all three: one act differs (tick 0: eight more `give`s, glock
  20/120 for barely, cart, eradicate, snarlbot; usps 12/24 for incredibad, lokier, snakelore, zwomp), every observe
  line identical (no pawn field, event or round state moves), walk oracles unchanged.
- T1 (`tools/snap-tracks.ts` pass 0, barely back on Catwalk 35.1–44.7 s): on G6's base no-human `150f77b4` → `7168c0a5`
  (walk oracle `8d41dc25` → `29adfc6e`), cart-idle `8f471b88` → `5770cd34` (`f9a434ca` → `7fae11b5`), cart-takeover
  unchanged (`cae23207`, it ends at tick 1536). `tools/fixture-diff.ts`, no-human: only barely's pawn fields differ (pos from tick
  2072; ≤ 28 u before 35 s, ≤ 220 u 35–45 s, ≤ 12 u 46–49.9 s while his puppet catches up, identical from 50.3 s; yaw,
  pitch, sees and crouching follow) and footstep `sound` events; every shot, damage, death, plant and defuse event is
  on the same tick (Zwomp 2829). cart-idle: barely, LIVE there from 40.30 s, now sees Zwomp up Catwalk and kills him at
  2650 instead of the scripted 2829 (the fixture ends at 2880); docs/core.md "Results: never-peeks".
- M1 (movement vs CS2, `docs/movement.md` "M1 fixes"): every fixture moves (no-human `72b58704` → `63bd3d86`, cart-idle
  `9a995ab4` → `fb19a2fa`, cart-takeover `a3163f9d` → `e1131654`, walk oracles `e5b887cf` → `72d1547f`, `b1b09042` →
  `6cd197f2`; the rejoin-off never-peeks run `7ca637e5` → `4dc88459`). `tools/fixture-diff.ts`: positions and velocities
  differ from tick 283 (the first tick a ground speed ends under 1 u/s, now zeroed), the acts follow them; every damage,
  death, plant and defuse event is at the same tick in all three fixtures (bomb positions move by < 0.00001 units), and
  the no-human round still ends CT defuse at tick 4274, 0.72 s left ("Played it like the tape").
- G5 (recorded duels of the human): every golden fixture is byte-identical (no-human `72b58704`, cart-idle
  `9a995ab4`, cart-takeover `a3163f9d`; walk oracles too; `npm run fixtures:update` reports "nothing changed"): nobody
  is ever in a recorded duel in them (no human; cart standing in Back Alley; cart standing in the Apartments from 15 s,
  where Lokier never sees him at the window), and the engine reports blocked bullets (`blocked_hit`) only for the
  human's, whose pairs only a duel blocks. The follow script is regenerated (3,980 → 3,962 entries; every entry before
  18.52 s, tick 1185, is the same): from 18.50 s Lokier's hit lands on cart and Lokier lives until 18.80 s, so the shadow's inputs differ
  (its aim follows the live Lokier, and the observed state it re-expresses the stick in differs); its run is now the
  tape (`0c4f0fa7`, was `5a558c44`). No new fixture: a duel fixture (the follow run to 20 s, about 0.3 MB gzipped)
  would break the 3 MB cap of `tests/fixtures.test.ts`.
- G4 (takeover): every existing digest is unchanged (G3's `72b58704` and `9a995ab4`; walk oracles too; before G3,
  `e9a228d9` and `2923a71d` were unchanged by G4 as well): nobody takes over in them, and a human from the start is set
  up exactly as before. The manifest gains `takeover` on every entry (null for both), so their entries were refreshed
  (`commit`, and `sourceDirty` false: G3's were made from a dirty tree); the new fixture `round-cart-takeover`
  (`a3163f9d` in 3D; `2ad2eb5c` on the 2D movement before G3) is the takeover at 15 s above. The follow script is
  unchanged.

- G1 (rejoin, LIVE → REPLAY): no-human `e9a228d9` unchanged (nobody leaves the tape, so no rejoin, no path query; the
  manifest entry changed only for the new `tuningHash`). cart-idle was unchanged too at 20 s (`4f8bc45c`: the first
  LIVE switch is Lokier's at 21.80 s), so its spec now runs **45 s** to cover G1 for the port: `4f8bc45c` (1,281 lines)
  → `2923a71d` (2,881 lines), walk oracle `84734d9c` → `25917ddf`. Its first 1,281 lines, and its walk oracle's first
  lines up to tick 1280, are byte-identical to the 20 s fixture; the rest has Lokier outliving his recording, barely
  killing him and rejoining (23.19 s, the one path query: his walk to the plant spot), the plant on its recorded tick,
  sp4rtan killing cart on his flank (40.58 s) and rejoining, and barely going LIVE on sp4rtan's gunfire and rejoining
  again. The follow script is unchanged (no switch, so no rejoin).

- C4 (#16) made `sees` real (radar sight mask) and clamps grenade throws at the mask's walls: the no-human digest went `0fb55e23` → `e6c2be70` and cart-idle `6505c774` → `76ee296f`. Core acts, positions, kills, HP, shots, plant and defuse are unchanged. The harness must pass `vision` to `Session` (as the app does): `parseSessionData` defaults the mask to null, which silently falls back to nav line of sight.
- F (fidelity and polish) adds **cover** to the sight mask (`docs/vision.md`): no-human `e6c2be70` → `e9a228d9`, cart-idle `868f56db` → `4f8bc45c`; both walk oracles unchanged. `tools/fixture-diff.ts` against B4's fixtures: **0 Core acts differ**, no controls, positions, HP, events (kills, damage, shots, the plant, the defuse) or round state differ; only `sees`, on 123 of 4,517 lines (from tick 940) and 17 of 1,281. Every change is a pair that no longer sees the other across a box: donk → barely (teammates in the Apartments) 14.69–14.94 s, 17 ticks, in both fixtures; barely → cart (teammates) on 48 ticks between 23.1 and 50.9 s; cart ↔ sp4rtan on 58 ticks between 63.3 and 65.1 s (the B-site stack between cart at the Shop door and the defusing sp4rtan, low for cover). The follow script changes from 65.55 s (tick 4195, the first missed engagement, `tools/follow-aim.ts`) and runs to the end (4,321 → 4,460 entries): cart no longer dies in the explosion. Merged after B5 (whose checkpoints change no digest) the digests are the same; the manifest changed only for the merged `tuningHash` (B5's `replay.checkpoint*` and F's `ai` keys), and `tools/fixture-diff.ts` against B5's main gives the same result (0 acts, `sees` only).
- G6 (sight and bullets on the CS2 mesh, `docs/vision.md`): no-human `72b58704` → `7339dbf2`, cart-idle `9a995ab4` → `f0ba1a27`, cart-takeover `a3163f9d` → `fb303936`. In two steps: the sight change alone changes **only `sees`** in the no-human round (`tools/fixture-diff.ts`: 0 acts, 1,525 lines differ only in `sees`). Then the snapped tracks' pass 5 (recorded duels in sight) moves cart 17.0–19.3 s (up to 106 u), eradicate 12.5–12.7 s and donk 49.9–50.1 s: 927 acts (the puppets' inputs on the new tracks and aim at the moved targets), positions of those three (cart until his 29.4 s snap; the two bodies), footstep sounds on 99 lines; no kill, damage, plant, defuse or round state changes and the round still plays like the tape. cart-idle also moves sp4rtan's LIVE kill of cart 2 ticks (40.58 s). Third, puppets aim only at what they see (pre-aim on the recorded spot otherwise, `docs/core.md` "Aim"): no-human `7339dbf2` → `00fa463b`, cart-idle `f0ba1a27` → `5805058c`, cart-takeover `fb303936` → `aa5aee88`; `tools/fixture-diff.ts` against the step before: 414 / 215 / 136 acts (the look: yaw, pitch and the stick re-expressed in it), observed yaw and pitch, positions by at most 4e-5 units (the rotated stick's rounding; sound positions with them), and **no** `sees`, damage, death, shot, bomb or round difference. The 3D host (same MeshSight) now matches the no-human fixture in every line.
- B4 (divergence) adds the `HUMAN` status mode and plays Lokier's hit on cart as a scheduled encounter: cart-idle `76ee296f` → `868f56db` (walk oracle `cfcdde41` → `84734d9c`). Every line's status shows cart `HUMAN` instead of `REPLAY`; from tick 1161 Lokier holds the angle on the Apartments window instead of the recorded aim at cart, so his input (yaw, and the stick re-expressed in it) and from 1162 his observed yaw and position differ, and his recorded tap at 1183 is gone (no `shot` at 1184; the encounter never starts, cart stays in Back Alley). The no-human golden master is byte-identical (`e6c2be70`); its manifest entry changed only for the new `tuningHash`. The follow script is the same through 66.0 s (sp4rtan goes LIVE at 65.91 s, so cart's aim at him differs from 66.03 s on).
- B5 (checkpoints, rewind, summary): the app's Session (so the harness) takes an automatic checkpoint every `replay.checkpointSec` before the step; checkpoints are not logged and change no state, so both digests are unchanged (`e6c2be70`, `868f56db`; `tests/rewind.test.ts` re-checks the golden digest with checkpoints on and after an exact rewind). The manifest changed only for the new `tuningHash` (`replay.checkpointSec`, `replay.checkpointMax`). A rewind cuts the log back, so every log stays one straight run (each line's tick is its index) and replays; a resync rewind adds one line with `controls: [{type: rewind, id}]` and an Act starting with `set_round` (`docs/core.md` "Checkpoints, rewind, summary").
