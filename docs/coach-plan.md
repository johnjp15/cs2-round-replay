# CS2 Demo Coach: plan and task board

Written by the orchestrator (Fable 5.2) on 2026-11-16 from John's request (backlog #97):

> Plan out a web-app that can process cs2 demos and then analyze what you could do to improve. These things could be anything from nitty mechanics feedback (e.g. better spray control) to macro game-strategy decisions (e.g. positioning better on CT side to prevent A Long push). The goal is for a user to take a look at the feedback, visualize the feedback, and learn a couple applicable things that can improve their gameplay immediately and over time.

And his follow-up twenty minutes later (backlog #98):

> Keep in mind sites like Leetify already do analysis of demos. A future goal will be to make software that can watch the player's screen in realtime and suggest improvements or give feedback, e.g. it can serve as additional game sense, like "we just spotted 3 enemy CT players on the A side of the map (2 long, 1 short) and there's only 1 player left, so they might be B, so let's shift and play for B".

Opus 5.5 agents implement it, one task card each (cards at the end). The 2D and 3D sims stay as they are.

## The product in one paragraph

You drop a demo on the page (`.dem`, Valve's `.dem.bz2`, FACEIT's `.dem.zst`) and pick which player you are. Everything runs in your browser, so the demo never leaves the machine. About a minute later you get **three things to fix**. Each one comes with the number that proves it, where that number ranks among the ten players of the match, two to four moments you can watch (a 2D replay, an aim trace, a spray plot), what to do instead, and a drill. Under that sit the full breakdown by skill area and a round-by-round replay. Analyzed matches stay in a local library, so the app can show whether last week's fix stuck.

## Principles

1. **Few findings, each with evidence.** A report leads with at most three fixes and one or two strengths. The rest is one click down. A finding with no watchable moment is not shown.
2. **Deterministic first.** Findings come from rules over the demo data that can be read and tested. The same demo always gives the same report. A language model may later explain findings and answer questions about them, but it never produces a number.
3. **Compare like with like.** Every metric is computed for all ten players, so "8th of 10 in this lobby" needs no outside data and uses exactly our definition. The user's own history is the second yardstick. Reference values computed by this same code on pro demos are the third.
4. **Say how sure we are.** Each finding carries a sample size and a confidence. Mechanics findings rest on dozens of shots. Strategy findings rest on a handful of rounds, so they are worded as patterns with counts ("6 of 9 CT rounds"), never as verdicts.
5. **Private by design.** No server, no upload, no account. This repo is public, so no demo of John's and nothing that identifies his lobbies is ever committed (`local/` is gitignored).

## Next to Leetify

Leetify and its peers (Scope.gg, Refrag, CSSkill, PureSkill) already cover the breadth: match history pulled automatically, ratings, rank benchmarks, a per-round rating breakdown, a 2D replay, and aggregate stats for aim, utility, trades, opening duels and clutches. The coach does not rebuild any of that: no rating, no profiles, no match sync, no stats site. It spends its effort where a stats site stops.

| A stats site tells you | The coach adds |
| --- | --- |
| "Counter-strafing 72 %, rank average 81 %" | Which shots, how many ms too early, which way you stop (opposite key, coast, still holding), and what each cost in the game's own inaccuracy, with the fights to watch |
| "Spray accuracy 33 %" | Which bullets leave the target and in which direction, against the pattern, per weapon and range |
| A number per round | The moment inside the round, opened in the replay with the reason drawn on it |
| Twenty stats to interpret | Three fixes, chosen and ordered, each with what to do instead |
| Individual stats | Team patterns with your part in them (the "A Long" case), and **game sense**: what your team knew at each moment and whether you acted on it |
| Review after the match | The same reasoning built so it can later run live (see "Later: the live coach") |

The handful of metrics Leetify also publishes (counter-strafing, crosshair placement, time to damage, spray accuracy, the flash numbers) are computed to Leetify's published definitions so John can check ours against his Leetify page. Leetify also has a public API (player profile, match history, per-match metrics; an API key and a "Data Provided by Leetify" credit are required). It is a possible later source of rank averages, not a dependency.

## Decisions (fixed unless John says otherwise)

1. **Same repo, third app.** The coach lives here as `src/coach` (the analysis: no DOM, runs in Node and in a worker), `src/coach-app` (the page) and `coach/index.html`, published at **`https://johnjp15.github.io/cs2/coach/`** behind the same lock. It reuses what the sims already built: the CS2 weapon table and accuracy model (`src/engine/weapons`, `data/weapons.json`), the recoil patterns, hitboxes, the smoke model, `MapGeometry` sight traces, the awpy-data map builder and the deploy chain. It can be split into its own repo later with its history.
2. **Browser only.** A static page; parsing runs in a Web Worker as WebAssembly. A Node CLI runs the same analysis for tests and for the agents.
3. **Parser: demoparser2's Rust core first** (MIT; its last commit is from the day this plan was written). Its native Node build works in the workspace today and is the reference. The browser build is K1's job, with demoinfocs-golang compiled by Go as the fallback. The analysis reads only our own `RawDemo` contract, so the parser can change without touching it.
4. **Stack:** TypeScript, Vite and Vitest like the rest of the repo; **Preact** for the page (the report is cards, tables and tabs); charts drawn by hand in SVG and canvas, no chart library.
5. **Determinism.** `src/coach` uses no `Date` and no `Math.random`. The same `RawDemo` gives a byte-identical report in Node and in the browser.
6. **Tunables in `data/coach/tuning.json`** (thresholds, windows, weights). Code never hard-codes one.
7. **Map data from awpy-data** through the existing builder: radar, radar transform and collision mesh per map. Mirage and Dust II first (both already built here), then the rest of Active Duty, which since 8 July 2026 is Ancient, Anubis, Cache, Dust II, Inferno, Mirage and Nuke.
8. **The locked page stays small.** Map packs (radar, sight mesh) are fetched on demand from this public repo's raw files at the build's commit and cached in the browser. `raw.githubusercontent.com` sends `access-control-allow-origin: *` (checked). If the repo goes private again, the packs get embedded or shipped as side assets instead.
9. **At most three or four agents at a time** (John's usage rule of 11-07).
10. **Built so it can go live later.** The game-sense part (`src/coach/sense`) reads only what the player's team could know at that moment (the radar, the kill feed, the clock, the bomb), never the demo's ground truth, and only the past: it is a reducer over a stream of observations with no look-ahead and a bounded cost per update. On a demo the stream is replayed from the file; later the same code is fed by a screen reader.

## What a demo gives us

Checked on 2026-11-16 with `@laihoe/demoparser2` 0.42.3 on a Valve matchmaking GOTV demo (Mirage, 60.6 MB, 57,970 ticks at 64/s, 10 round ends).

| | Present | Missing or caveat |
| --- | --- | --- |
| **Per tick, per player** | position, view pitch/yaw, velocity, health, armor, helmet, kit, money, equipment value, inventory, active weapon and clip, scoped, walking, duck amount, airborne, flash duration, `spotted`, place name (callout), `shots_fired`, **aim punch**, **`accuracy_penalty`**, recoil index, reloading, movement buttons (forward/back/left/right/fire/…), Premier rank fields, crosshair code | `usercmd_*` (mouse deltas, sub-tick moves) are empty in GOTV demos; `ducking`/`ducked` are empty (use `duck_amount`); velocity is null on a few ticks |
| **Events** | `weapon_fire`, **`fire_bullets`** (per bullet: inaccuracy, spread, recoil index, seed, firing angles, origin), `player_hurt` (hit group, damage), `player_death` (headshot, wallbang, through smoke, attacker blind, no-scope, assister, flash assist), `player_blind` (thrower, duration), grenade detonations and expiries, bomb events, round events, `player_footstep`, `player_jump`, `weapon_reload`, `weapon_zoom`, `item_pickup`, `item_equip`, `rank_update` | no purchase event (buys come from inventory at freeze end and `cash_spent_this_round`) |
| **Grenades** | a position per tick for every projectile | some ticks have null coordinates |

Two things follow. The server's own inaccuracy for every bullet is in the demo, so "you shot while moving" can be stated in the game's own numbers and needs no simulation. And line of sight is not in the demo in a usable form (`spotted` is a radar flag that lags), so sight has to be computed against the map mesh.

Cost seen in the check: all ticks for 20 fields as generic JS arrays took 4.1 s natively and **1.3 GB** of memory for this ten-round demo. A full match is about 2.5 times that, so the browser parser must return typed arrays (about 70 bytes per player-tick, roughly 100 MB for a full match) and never row objects.

## Architecture

```
 .dem / .dem.bz2 / .dem.zst / .dem.gz
            │  (file drop; a Web Worker; nothing is uploaded)
            ▼
 parser (WebAssembly in the browser · native demoparser2 in Node)
            │  RawDemo: typed-array columns per player-tick + event records
            ▼
 src/coach/ingest    rounds, sides, scores, economy, alive timeline; warmup/knife/restart/overtime handling;
            │        scoreboard reconciliation against the demo's own totals
            ▼
 src/coach/derive    shots+bullets joined to hits · bursts and sprays · movement at each shot · line of sight
            │        (map mesh + smokes + FOV) → sightings → duels · utility effects · trades · death context ·
            │        map control and lanes · win probability
            │
            ├──► src/coach/sense   observations a team could have (radar sightings, kill feed, clock, bomb)
            │        → information state (who is alive, who was last seen where and when, who is unaccounted for)
            │        → calls ("3 seen A, one unaccounted: B is light"). Causal, no ground truth, live-ready.
            ▼
 src/coach/metrics   every metric for all ten players → lobby rank, history delta, reference bands
 src/coach/detect    one module per detector → Finding[] with evidence moments
            ▼
 src/coach/report    prioritizer → MatchReport (versioned JSON: top fixes, strengths, skill areas, rounds, replay tracks)
            ▼
 src/coach-app       library (IndexedDB) · report · evidence viewers (2D replay, duel view, spray plot,
                     placement scatter, heatmaps, round boards) · progress across matches
```

Import rules (ESLint, like the existing zones): `src/coach` may import `src/contracts`, `src/engine` and `src/sim2d` (for `MapGeometry`); `src/coach-app` may import anything. Tools live in `tools/coach/`, tests in `tests/coach/`, data in `data/coach/`, docs in `docs/coach/`.

### Contract 1: `RawDemo` (what any parser must deliver)

```ts
interface RawDemo {
  format: 'coach-raw@1';
  header: { map: string; server: string; source: 'valve' | 'faceit' | 'other'; gotv: boolean; patch: number | null;
            tickRate: number; demoSha256: string; bytes: number };
  players: { steamId: string; name: string; bot: boolean }[];   // the index is the slot p used everywhere below
  names: { weapons: string[]; places: string[] };               // lookup tables for the id columns
  ticks: {
    count: number;            // T: every tick from the first live round's start to the last round's end
    tick: Int32Array;         // [T] the demo tick of row t
    // [T × P] columns, row i = t * P + p
    present: Uint8Array;      // 0 = no pawn on this tick
    x: Float32Array; y: Float32Array; z: Float32Array; pitch: Float32Array; yaw: Float32Array;
    vx: Float32Array; vy: Float32Array; vz: Float32Array;        // NaN where the demo has none
    health: Uint8Array; armor: Uint8Array; duck: Uint8Array;     // duck = duck amount × 255
    weapon: Uint8Array; clip: Uint8Array; team: Uint8Array; place: Uint8Array;   // team: 2 = T, 3 = CT
    flags: Uint16Array;       // alive, scoped, walking, airborne, defusing, reloading, helmet, kit, inBombZone, inBuyZone, spotted
    buttons: Uint32Array;     // forward, back, left, right, fire, attack2, jump, duck, use, reload, walk
    flash: Float32Array; penalty: Float32Array; punchPitch: Float32Array; punchYaw: Float32Array;
    recoilIndex: Float32Array; shotsFired: Uint16Array; money: Uint16Array; equip: Uint16Array;
  };
  events: { /* plain records, each with `tick` and player slots: */
    rounds; shots; bullets; hurts; kills; blinds; detonations; bomb; footsteps; jumps; reloads; zooms; pickups; equips; ranks };
  projectiles: { type: string; thrower: number; t0: number; t1: number; path: Int16Array }[];   // x, y, z every 4 ticks
  inventories: { tick: number; p: number; items: string[] }[];  // at freeze end, at every death (the victim), at round end
}
```

K0 finalizes names and writes `docs/coach/contracts.md`. Changes after that go through that doc and bump `format`.

### Contract 2: `Finding` and `MatchReport` (what the page renders)

```ts
interface Finding {
  id: string;                 // the detector, e.g. 'aim.counter_strafe.early_shot'
  area: 'aim' | 'movement' | 'utility' | 'positioning' | 'trading' | 'decisions' | 'economy' | 'strategy';
  scope: 'mechanics' | 'micro' | 'macro';
  polarity: 'fix' | 'strength' | 'observation';
  title: string;              // imperative and short: "Stop before you shoot"
  summary: string;            // one sentence with the numbers in it
  why: string;                // what it costs, in rounds or fights
  advice: { text: string; drill?: string }[];
  metrics: { id: string; value: number; unit: string; n: number; lobbyRank: number; lobby: number[]; history?: number[] }[];
  evidence: { kind: 'replay' | 'duel' | 'spray' | 'map' | 'board'; round: number; tick0: number; tick1: number; focus: number;
              players: number[]; annotations: Annotation[]; caption: string }[];
  stats: { instances: number; opportunities: number; rounds: number[]; roundsLost: number; winProbLost: number | null };
  confidence: number;         // 0–1: the detector's measured precision × a sample-size factor
  impact: number;             // estimated cost, comparable across detectors
  priority: number;           // set by the prioritizer
}
```

`Annotation` is a small drawing vocabulary in world coordinates with a time range (line, circle, cone, path, zone, label), so any detector can point at things in the 2D replay without the viewer knowing the detector. `MatchReport` holds the match facts, the user's slot, all metrics for all ten players, all findings, the chosen top fixes and strengths, per-round summaries and compact replay tracks (positions at 16 Hz as int16, about 3 MB a match). It is the only thing stored in IndexedDB and the only thing the page reads.

## What it analyzes

Tier 1 ships in the first usable report. Tier 2 needs line of sight or map knowledge. Tier 3 comes later. Every row is computed for all ten players.

### Aim and movement (mechanics)

| id | What it says | From | Tier | Shown as |
| --- | --- | --- | --- | --- |
| `aim.counter_strafe` | Share of first bullets fired above 34 % of the weapon's top speed (below it CS2 adds no movement inaccuracy; `src/engine/weapons/accuracy.ts`); how many ms too early; how you stopped (opposite key, release and coast, still holding, crouch); what it cost in the bullet's real inaccuracy | `fire_bullets.inaccuracy`, velocity, buttons | 1 | duel view: speed trace against the threshold with the shots on it |
| `aim.spray` | Per bullet number, how far the recoil-compensated aim was from the target, split into vertical and horizontal: "bullets 1–3 on target, 4–10 drift 1.8° high, 11+ wander right" | view angles + aim punch per bullet, target position, pattern from `data/weapons.json` | 1 | spray plot: your compensation path against the ideal one, per spray and averaged |
| `aim.range_discipline` | Long sprays at long range that hit nothing past bullet 4: burst or tap there | sprays, distance | 1 | list of sprays with distance and hits |
| `aim.first_bullet` | First-bullet hit rate, standing against moving, by distance band | bullets, hits | 1 | bars by band |
| `aim.placement` | Angle between your crosshair and the enemy's head at the moment he becomes visible, split vertical/horizontal and holding/peeking; also the Leetify-style figure (angle moved from first sight to first damage) | line of sight, view angles | 2 | scatter of where enemies appeared relative to your crosshair |
| `aim.time_to_damage` | First sight → first shot → first damage; fights where you saw first and still lost | line of sight, shots, hits | 2 | duel view timeline |
| `aim.habits` | Jumping shots, shooting while flashed, crouch-spraying into a miss, scoped-in walking, re-peeking after a missed AWP shot | flags, events | 2 | counted moments |
| `move.reload` | Reloads with an enemy close or half a magazine left; deaths while reloading | reload events, clip, deaths | 1 | replay moments |
| `move.caught_out` | Deaths with the knife or a grenade in hand | active weapon at death | 1 | replay moments |
| `move.noise` | Running within earshot when silence mattered (lurk, clutch, retake) | footsteps, distances | 3 | replay moments |
| `move.peek` | Wide swings into an AWP, re-peeking the angle you were just tagged from | sightings, damage | 2–3 | replay moments |

### Utility

| id | What it says | Tier |
| --- | --- | --- |
| `util.flash` | Enemies blinded per flash and for how long, teammates (and yourself) blinded, flashes that led to a kill; the same 1.1 s floor Leetify uses so numbers are comparable | 1 |
| `util.unused` | Grenades and their value still on you at death and at round end | 1 |
| `util.buy` | Rounds where you could afford utility and bought none | 1 |
| `util.damage` | HE and fire damage per grenade; fire thrown where nobody was or came | 1 |
| `util.smoke` | Smokes that landed off the standard spot or after the fight had started; later: CT smokes that stopped a push | 2 |
| `util.dry_peek` | You or a teammate entered a chokepoint without a flash while one was in a pocket nearby | 2 |

### Positioning, trades and decisions (micro)

| id | What it says | Tier |
| --- | --- | --- |
| `pos.untradeable` | Deaths with no teammate close enough to trade (distance first; path distance and sight to the killer in tier 2) | 1 |
| `trade.missed` | A teammate died next to you and you dealt no damage to his killer inside the trade window (5 s, tunable) | 1 |
| `pos.opening` | Opening duels: how often you take them, win rate, where, with what; first deaths while pushing as CT | 1 |
| `pos.death_context` | Each death labelled: from outside your view, seen by two or more enemies, in the open while rotating, after a re-peek, while planting or defusing | 2 |
| `pos.repeat` | The same CT spot three rounds running, and the enemy pre-aimed it | 2–3 |
| `dec.advantage` | With a man advantage you took a solo duel you didn't need and lost it | 2 |
| `dec.postplant` | After the plant: died peeking when the clock was on your side; retook alone; no kit when it mattered | 2 |
| `dec.clock` | Rounds lost to the timer as T; defuses started that could not finish | 2 |
| `eco.sync` | You forced when three or more teammates saved, or the reverse | 1 |
| `eco.kit_armor` | CT gun rounds without a kit; rifle without armor; money left over with utility slots empty | 1 |
| `eco.save` | Died with an expensive loadout in a round that was already lost | 2 |

### Strategy (macro: team patterns, with the user's part in them)

| id | What it says | Tier |
| --- | --- | --- |
| `strat.lane` | Per chokepoint (Dust II Long, Mirage Mid and Palace, Inferno Banana, …): how often the Ts took it, how fast, whether any CT contested it with a body or a grenade, and how those rounds ended. This is the "A Long" case: "They took Long in 8 of 12 CT rounds, 6 times untouched; those 6 ended in 5 A plants. You were on A in 9 of them, behind site each time." | 2 |
| `strat.setup` | CT setups per round against where the Ts actually hit, shown as one small map per round | 2 |
| `strat.rotate` | Rotations that left a site before any information and were punished; rotations that started late or took the long way | 2 |
| `strat.t_side` | Your team's site choices, timing and utility before entry, with results: "five rushes without utility: 1 won; four executes with it: 3 won" | 2 |
| `strat.opponent` | What the other team kept doing, and whether you adapted: "B rush four rounds in a row" | 2 |
| `strat.role` | Across matches: how often you enter, lurk, anchor or support, and how each goes | 3 |

### Game sense (what was known, and what you did with it)

The sense engine keeps an **information state** for the user's team, tick by tick, from things that team could see: enemies shown on the radar (the demo's `spotted` flag is the radar's own state, lag included; K14 first checks how complete it is in GOTV demos and falls back to computed line of sight from any teammate), the kill feed, the clock, the bomb. From it come **calls**, each with its reason and a confidence. John's example is the first rule: three CTs seen on A (two Long, one Short), four alive, so B has one defender at most: play B.

| id | What it says | Tier |
| --- | --- | --- |
| `sense.numbers` | A numbers read was available for some seconds (enemies counted on one side, so the other side is light), your team played against it, and the round was lost | 2 |
| `sense.radar` | You died to an enemy who had been on your radar, near that spot, in the two seconds before | 2 |
| `sense.rotate` | As CT: the information pointed to the other site (bomb seen, four shown) and you stayed; or nothing pointed anywhere and you left | 2 |
| `sense.last_seen` | You walked into the last known position of an enemy without clearing it; or held an angle nobody could come from any more | 2 |
| `sense.clock_eco` | Reads from the clock and the money: they must come to you with 20 s left; they are on an eco, expect a rush or a stack | 2–3 |

Every call the engine would have made is also placed on the replay timeline ("1:12 · B is light: 3 seen A"), and the replay has a **fog-of-war mode** that shows only what your team knew: enemies as last-seen markers that age and fade. Because the demo holds the truth, every call is scored against what the enemy really did, so the engine's hit rate is measured over hundreds of rounds before it ever speaks live.

Map knowledge for the strategy and game-sense rows lives in `data/coach/knowledge/<map>.json`: the demo's place names grouped into sites, lanes and connectors; each chokepoint with what it leads to; standard grenade landings; and the textbook counters the advice text quotes. Unknown place names are reported by a tool and treated as unclassified, never guessed.

## Choosing and showing the feedback

**Prioritizer.** `priority = impact × confidence × fixability × recurrence`. Impact is the cost in round-win probability where a table exists (K9) and a calibrated per-detector weight before that. Fixability is a constant per detector (a counter-strafe habit is quick to fix, map sense is slow). Recurrence rises when the same finding showed up in earlier matches. The top three are picked for spread: one mechanics, one micro and one macro when each has a candidate above the bar, and never two findings with the same root cause. Detectors below a measured precision of 90 % on the review set can only appear as observations.

**The report page.**
1. Header: map, score, your side splits, the lobby's rank range.
2. **Your three fixes.** One card each: the title, one sentence with the numbers, a rank strip (you among the ten), "Watch" buttons for the evidence, what to do instead, the drill.
3. One or two things that went well.
4. Skill areas (aim, movement, utility, positioning and trades, decisions, economy, strategy): every metric with rank and trend, every finding.
5. Rounds: a strip of all rounds with tags; click one for the replay.

**Evidence viewers.**
- **2D replay.** The radar with players, view cones, health, weapons, grenade paths, smokes, fires, flashes, kill lines and the bomb; a timeline with event and finding markers; speed control. "Watch" opens five seconds before the moment with the detector's annotations drawn (the sight line that killed you, the trade-distance ring, the lane the Ts walked through). In fog-of-war mode it shows only what your team knew, with the coach's calls on the timeline.
- **Duel view.** One fight on a time axis: angle to the enemy's head, your speed against the accuracy threshold, crouch, the game's inaccuracy for each bullet, shots marked hit or miss.
- **Spray plot.** Bullet by bullet, where your aim was relative to the target after recoil, against the ideal compensation path.
- **Placement scatter.** Where each enemy appeared relative to your crosshair, with 1°, 3° and 5° rings.
- **Maps and boards.** Heatmaps of deaths, kills and opening duels; one small map per round for setups; lane-control bands per round.

**Drills.** Each fix names one concrete drill with a length (for example ten minutes of counter-strafe taps on a named workshop map, or a console recipe). In phase 4 the drill button opens the 3D sim on the same weapon, or replays your own moment with you in control.

**Look.** Dark and calm, numbers first, CT blue and T amber as in the sims, one accent colour, system fonts. Charts follow one small set of marks (bar, rank strip, scatter, sparkline, small-multiple maps).

## Over time

The library keeps every report. A **progress** page shows each metric as a sparkline against the lobby band, and for each finding whether it recurred in the next matches. The user pins up to three **focus goals**; a new report says first how those went. Demos can be tagged as reference (a pro match, a better friend) so their numbers become a comparison line. A "Copy coach brief" button exports the findings as compact Markdown or JSON to paste into Claude for a deeper conversation; an in-app chat with the user's own API key is a later option.

## Later: the live coach

The future goal is software that watches the screen during play and speaks up with game sense. The plan gets there in steps, each useful by itself, and the offline coach builds most of it.

1. **Calls on demos (phase 2).** The sense engine above, scored against the truth in the demo. This is the reasoning of the live coach, finished and measured, with nothing live about it yet.
2. **A screen reader checked against the demo (phase 5).** For a player, CS2's Game State Integration reports only his own state, the round phase and the bomb; other players' data is sent to spectators and GOTV only. So enemy sightings have to be read off the screen: radar dots mapped to world positions with the radar transform, the kill feed, the alive counters, the clock. John records one match on video and keeps its demo; the reader's output is then scored frame by frame against the demo's `spotted` data. The repo already has the video-frame tooling from the round replay (`tools/viewfit`, `tools/video-parity.ts`).
3. **Live, in practice.** A page captures the game window (`getDisplayMedia`), reads a few frames a second, feeds the same sense engine and answers by voice or on a second screen. It never touches the game process or its memory, so CS2's trusted mode stays on. Calls are short enough to say (twelve words or fewer) and rate-limited so they don't talk over the game.
4. **Ranked play only where the rules allow it.** Advice from software during a competitive match is a fair-play question that is separate from whether an anti-cheat can see it. FACEIT and tournament rules restrict outside help, and the rules differ by platform and change. Scrims, practice and replays are clear; check the platform's current rules before using it anywhere ranked.

What this asks of the work now: the sense engine stays causal and observation-only (decision 10), calls are data with a reason and a confidence, and the 2D replay can draw an information state.

## Validation: how we know the feedback is right

1. **Scoreboard reconciliation.** Kills, deaths, assists, damage, headshot kills, enemies flashed and utility damage computed from events must equal the demo's own totals (`kills_total`, `damage_total`, …) for every player, or the difference is explained.
2. **Parser conformance.** The browser parser and the native Node parser must produce the same `RawDemo` for the same file.
3. **Sight check against real kills.** Nearly every kill that is neither a wallbang nor through smoke must have line of sight in our mesh at the kill tick (target ≥ 97 %).
4. **Detector tests.** Each detector has synthetic unit tests, a set of labelled real moments, and a measured precision that gates whether it may lead a report.
5. **Golden report.** The report for the public test demo is snapshotted; a change must be intended.
6. **John's review.** Thumbs up or down on each finding in the page, stored locally and exportable, plus a cross-check of our aim numbers against Leetify's for the same match where he has it.

## Budgets

| | Budget |
| --- | --- |
| Parse and analyze a 150 MB demo (Apple silicon, Chrome or Safari) | ≤ 60 s, with a progress bar |
| Peak memory | ≤ 2 GB |
| Report JSON | ≤ 5 MB |
| Locked page | ≤ 4 MB before encryption |
| Map pack, per map | ≤ 1.5 MB, fetched once |
| Opening an analyzed match | ≤ 0.5 s |

## Phases

| Phase | What John can do at the end | Cards |
| --- | --- | --- |
| **0 Foundations** | Nothing visible yet: contracts, Node parsing, rounds and scoreboard that reconcile, a browser parser, map packs with line of sight | K0, K1, KM |
| **1 First report** | Drop one of his demos at `cs2/coach/`, get three fixes from the tier-1 set with watchable 2D evidence, the duel view and the spray plot | K2, K3, K4, K5, K7 |
| **2 Seeing, strategy and game sense** | Crosshair placement, time to damage and death context from real line of sight; lanes, setups, rotations and opponent habits on all seven pool maps; the information state, the coach's calls on the timeline and the fog-of-war replay; impact from win probability | K6, K8, K9, K14 |
| **3 Over time** | Library, trends, focus goals, recurring findings, reference demos, the coach brief for Claude | K10, K11 |
| **4 Close the loop** | Replay any moment of his demo in the 3D sim with himself in control; spray and counter-strafe drills on the sim's exact CS2 model; optional in-app chat | K12, K13 |
| **5 Live coach** (future goal) | A screen reader scored against the demo of the same match, then the sense engine live by voice in practice | K15, K16 |

The order inside phases 1 and 2 follows the Leetify note: the bullet-level mechanics, the watchable moments and the game-sense layer come first; the aggregate numbers a stats site already shows are by-products that feed lobby ranks.

## Task cards

Every card: one branch, one PR, `npm test`, `npm run lint`, `npm run build` green, new behaviour tested, docs updated, no edits outside the card's files except through public interfaces (`docs/conventions.md`). Push early and often. Never commit a demo, a Steam ID or a player name from John's matches; fixtures made from the public test demo get their names and IDs replaced.

Test demo for everyone: `https://raw.githubusercontent.com/LaihoE/demoparser/8035c3d9c61e00fb6634f76541e535f64f0f4d3f/src/parser/test_demo.dem` (60,601,900 bytes, SHA-256 `84a1a4191302bdd2a3bbb5a727842093744b1fb1a228aeec630369e44b622cb2`), fetched to `local/demos/`, never committed.

### Wave 1 (running)

**K0 · Contracts, scaffold, Node ingest** (`k0-coach-contracts`)
- `src/coach/model/`: `RawDemo`, `Match`, `Finding`, `Annotation`, `MatchReport` as above; `docs/coach/contracts.md`.
- ESLint zones for `src/coach` and `src/coach-app`, the no-`Date`/`Math.random` rule on `src/coach`; `tsconfig` and JSX set up for Preact.
- `tools/coach/parse-node.ts`: `.dem` (and `.bz2`, `.zst`, `.gz`) → `RawDemo` with `@laihoe/demoparser2` as a devDependency, typed arrays only, bounded memory; a binary cache format in `local/coach-cache/`.
- `src/coach/ingest/`: rounds, sides per round, scores, alive timeline, economy basics; warmup, knife round, restart, overtime, disconnects and bots handled; `validate.ts` reconciles the scoreboard.
- `tools/coach/fetch-test-demo.ts` (pinned URL and hash) and `tools/coach/coach.ts` (`parse`, `inspect`).
- A small committed fixture (two rounds, names and IDs replaced, ≤ 3 MB) and tests on it; full-demo tests that skip when the file is absent.
- The page skeleton: `coach/index.html`, `src/coach-app/main.tsx` (drop zone, nothing more), `vite.coach.config.ts`, `dev:coach` and `build:coach`, the build added to CI.
- Done when: `coach.ts inspect` prints the test demo's rounds and a scoreboard that reconciles for all ten players, and CI is green.

**K1 · Browser parser** (`k1-coach-parser`)
- Goal: `parseDemo(bytes, onProgress) → RawDemo` in a Web Worker (Chrome, Safari, Firefox) and in Node, reading `.dem`, `.dem.bz2`, `.dem.zst` and `.dem.gz`.
- Known constraint: this workspace cannot install the `wasm32-unknown-unknown` target (`static.rust-lang.org` is blocked), while crates.io, GitHub and the Go proxy work. The npm package `demoparser2` (the upstream WASM build) is from April 2026, before the July demo-format change, so it is a baseline at most.
- Paths, in order: (A) our own crate `crates/coach-parser` on demoparser2's `parser` crate pinned to a commit, built by a GitHub Actions workflow on this public repo (and locally if a build-std route works); (B) demoinfocs-golang with `GOOS=js GOARCH=wasm`, which builds here today. Decide with numbers: correctness against the native parser, parse time and peak memory in headless Chrome, binary size, field coverage (`fire_bullets`, aim punch, accuracy penalty, buttons).
- Conformance test against K0's Node adapter; a worker harness and `tools/coach/bench-parser.ts`; the built binary committed with a provenance file; `docs/coach/parser.md` with the decision record and how to bump upstream.
- Done when: the test demo parses in headless Chrome inside the budget and equals the native result.

**KM · Map packs and line of sight** (`km-coach-maps`)
- `tools/coach/build-map-pack.ts` on top of `tools/build-map.ts`: for each Active Duty map (and Overpass, Train, Vertigo when the release has them) write `data/coach/maps/<map>/` with the radar (and lower level), the transform and a sight mesh, from the newest awpy-data release that has the map (tags run to 2000943; this repo pins 2000942). A size table in `docs/coach/maps.md`.
- `src/coach/derive/los.ts`: eye position from feet and duck amount; body sample points from `src/engine/hitboxes.ts`; `MapGeometry.sightBlocked` per point; smokes from detonation events (the engine's smoke model if practical, a documented sphere otherwise); a field-of-view test. Benchmark: at least 300,000 segment tests a second in Node here.
- Validation tool: for every kill in the test demo that is neither a wallbang nor through smoke, is there line of sight at the kill tick? Target ≥ 97 %; list the failures with positions.
- `tools/coach/places-report.ts`: the place names a demo uses, with counts and centroids (the awpy-data navs carry none, so demos are the source of the callout vocabulary).
- Done when: packs exist for every pool map in the release, the sight check passes on Mirage, and the benchmark meets the target.

### Wave 2 (after K0 merges)

- **K2 · Combat derive and mechanics.** Shots joined to bullets and hits; bursts and sprays; state at each shot; `aim.counter_strafe`, `aim.spray`, `aim.range_discipline`, `aim.first_bullet`, `move.reload`, `move.caught_out`; metrics for all ten players with lobby ranks.
- **K3 · Page shell and 2D replay.** Worker pipeline, IndexedDB library, player picker, the radar replay with timeline, annotations and deep links from findings.
- **K4 · Utility, trades, deaths, economy.** `util.*` tier 1, `pos.untradeable`, `trade.missed`, `pos.opening`, `eco.*` tier 1.

### Wave 3

- **K5 · Report.** Prioritizer, the three-fixes cards, skill-area pages, duel view, spray plot, rank strips, golden report test.
- **K6 · Sight-based analysis.** Sightings and duels from `los.ts`; `aim.placement`, `aim.time_to_damage`, `aim.habits`, `pos.death_context`, placement scatter.
- **K7 · Publish.** Single-file build, lazy map packs from the repo's raw files, staging into web-apps as `cs2/coach/`, the locked-page check.

### Wave 4 and later

- **K8 · Strategy.** Map control, lanes, setups, rotations, T-side and opponent patterns; knowledge files for all seven maps; round boards.
- **K14 · Game sense.** `src/coach/sense`: the observation stream from a demo (radar sightings from `spotted`, kill feed, clock, bomb), the information-state reducer, the call rules starting with the numbers read, call scoring against the truth, the `sense.*` detectors, fog-of-war mode and calls in the replay. Causal and observation-only (decision 10).
- **K9 · Win probability.** A small table model (players alive, bomb, time, equipment) fitted with our own pipeline; impact scoring.
- **K10 · Over time.** Trends, focus goals, recurring findings, reference demos, the coach brief.
- **K11 · Validation audit.** A fresh agent reviews every detector on John's demos with rendered evidence and measures precision.
- **K12 · Sim tie-in.** Export a moment as a 3D-sim scenario; drill deep links.
- **K13 · In-app coach chat** with the user's own key, on top of the findings only.
- **K15 · Screen reader (future).** Radar, kill feed, alive counters and clock read from a match video, scored against the demo of the same match.
- **K16 · Live coach (future).** Window capture feeding the sense engine, voice output, rate limits; practice and scrims first.

## Risks

| Risk | What we do about it |
| --- | --- |
| The browser parser is slow or memory-hungry on a 250 MB demo | Typed-array output, one pass, progress bar; measured in K1 before anything is built on it; reports are cached so a demo is parsed once |
| The Rust WebAssembly build can't be made in the workspace | Build it in GitHub Actions; Go fallback that builds here |
| CS2 updates change the demo format (it happened in July 2026) | The parser is pinned and bumped on purpose; the conformance and golden tests show breakage at once; the upstream project is active |
| GOTV demos have no mouse input and only 64 samples a second | Aim analysis uses view angles and the game's own per-bullet inaccuracy; timing claims are worded to the tick (15.6 ms) |
| A wrong finding costs trust | Precision gate, confidence shown, evidence always watchable, John's thumbs feed the thresholds |
| Strategy claims over-read a few rounds | Counts and sample sizes in the sentence; patterns firm up across matches |
| No population data for "good" and "bad" | Lobby rank, own history, reference demos run through the same code |
| Callout names differ per map and aren't in awpy-data | Read from demos; unknown names reported, never guessed; maps are enabled for strategy one by one |
| Public repo | Nothing from John's matches is committed; fixtures are anonymized |
| Rebuilding what Leetify already does | No rating, profiles or match sync; shared metrics follow Leetify's definitions and exist only as yardsticks; effort goes to moments, causes, strategy and game sense |
| The live coach breaks a platform's rules | It reads only the player's own screen and never the game process; it is proven on demos and used in practice first; ranked use waits on each platform's current rules |

## Needs John

1. **Three to five of your recent demos**, ideally at least one Dust II and one Mirage (Valve `.dem.bz2` or FACEIT `.dem.zst`). Put them in a folder on the Mac and add that folder to the chat, or attach them. They are the acceptance test and the only way to check current-format demos and the callouts of maps other than Mirage.
2. Your in-game name in those demos (the page will ask too).
3. If you use Leetify: your aim numbers for the same matches, to cross-check ours.
4. Say so if you'd rather have a separate repo, an unlocked page, or map packs embedded instead of fetched from the public repo.
5. Later, for the live coach: a screen recording of one match whose demo you also keep, and your radar settings (`cl_radar_scale`, `cl_radar_rotate`, `cl_radar_always_centered`, `cl_hud_radar_scale`).

## Sources

- demoparser2 (Rust parser, Python/Node/WASM bindings, MIT): https://github.com/LaihoE/demoparser
- awpy 3 (Rust parser with Python API, map control, win probability, MIT): https://github.com/pnxenopoulos/awpy · awpy-data: https://github.com/pnxenopoulos/awpy-data
- cs-demo-analyzer (Go, MIT; reference for clutches, economy types, sources): https://github.com/akiver/cs-demo-analyzer
- demoinfocs-golang (Go parser, MIT): https://github.com/markus-wa/demoinfocs-golang
- In-browser parsing precedent (demoparser2 fork as WASM in a worker): https://cs2-replays.pages.dev/about/
- Leetify's metric definitions: https://leetify.com/blog/leetify-stats-glossary · https://leetify.com/blog/enemy-actually-spotted/ · its public API rules: https://leetify.com/blog/leetify-api-developer-guidelines
- Game State Integration (what a playing client is sent, and what only spectators get): https://developer.valvesoftware.com/wiki/Counter-Strike:_Global_Offensive_Game_State_Integration
- Active Duty pool since 8 July 2026: https://alviran.net/blog/cs2-map-pool-2026-active-duty-history/
