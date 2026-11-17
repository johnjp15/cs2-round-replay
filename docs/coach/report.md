# Coach: the report (K5)

What the user reads: the prioritizer that picks the fixes, the report page (fix cards, strengths, skill areas), the
two evidence viewers for aim (duel view, spray plot), the chart renderers K6 and K8 fill, "Hide names" and the
feedback buttons. Players are labelled A1…A5 / B1…B5 (team A started T, numbered by slot), the labels the finding
texts and `playerLabel` use. No real names.

| File | What |
| --- | --- |
| `src/coach/report/prioritize.ts` | the prioritizer (used by `analyze()`) |
| `src/coach/report/evidence-series.ts` | `Evidence.series` for duel and spray evidence, built at analysis time |
| `src/coach/report/format.ts` | `metricValue` (every renderer), `lobbyRankText` / `rankPhrase` (ties), `confidenceWord` |
| `data/coach/tuning/report.json` | the prioritizer's constants, fixability, root families, the lobby baseline list, the gate |
| `src/coach-app/report/` | `Cards.tsx` (fix, strength and area cards, Watch, feedback), `RankStrip.tsx`, `Areas.tsx` |
| `src/coach-app/viewers/` | `DuelView.tsx`, `SprayPlot.tsx`, `svg.ts` |
| `src/coach-app/charts/Charts.tsx` | renderers for `MatchReport.charts` |
| `src/coach-app/display.ts`, `feedback.ts` | "Hide names"; thumbs and notes, export |
| `tests/coach/prioritize.test.ts`, `evidence-series.test.ts`, `golden-report.test.ts` | tests; `npm run golden:coach` rewrites the snapshot |

## Prioritizer

```
priority = impact × confidence × fixability × recurrence
```

**Impact: one scale for every detector.** Fights decided against the player per 24 rounds, counting only what he
does beyond a typical player of this lobby. One fight is roughly 0.1–0.2 rounds of win probability (K9 replaces the
scale with win probability).

- The aim detectors (`aim.counter_strafe`, `aim.first_bullet`) already cost only the excess over the lobby median
  ("excess moving first bullets × cost"), and `pos.opening.losing` the excess over an even split.
- The count-based detectors (`baseline.lobby` in the tuning: `move.reload`, `move.caught_out`, `util.*`,
  `pos.untradeable`, `trade.missed`, `pos.opening.ct_push`, `eco.*`) count every instance. The prioritizer multiplies
  their impact by the **lobby excess** of the finding's first metric: lower-is-better `(you − median) / you`,
  higher-is-better `(median − you) / median`, clamped to 0–1, the median taken over the other players with a value
  (at least 3, else 1). A habit the whole lobby shares costs little and cannot lead: "more than half a magazine left"
  reloads run 60–80 % in this lobby, so `move.reload.exposed` keeps 7–17 % of its impact and never clears the bar.
  The flip side: a habit everyone in the lobby has stays hidden until reference values from better players exist.

Per-instance costs on that scale (judgement calls, in the area tuning files; K2's and K4's guesses recalibrated):

| Detector | Instance | Was | Now | Reason |
| --- | --- | ---: | ---: | --- |
| `aim.counter_strafe` | excess moving first bullet | 0.3 | 0.25 | standing first bullets hit about 15 points more in this lobby; the first hit swings a duel by about half |
| `aim.first_bullet` | excess missed first bullet | 0.25 | 0.25 | |
| `aim.spray` | drifting spray | 0.2 | 0.2 | |
| `aim.range_discipline` | long spray with no hit after bullet 4 | 0.25 | 0.15 | the fight at that range was poor odds anyway; the cost is time and a reload |
| `move.reload` | death while reloading / enemy near / > half a magazine | 1 / 0.25 / 0.05 | 0.6 / 0.2 / 0.02 | with the gun ready the duel is about a coin flip, not a sure win |
| `move.caught_out` | death with knife or grenade out | 0.7 | 0.5 | same |
| `util.flash` | flash that blinds nobody / teammate flashed into a fight | 0.15 / 0.5 | 0.15 / 0.4 | |
| `util.unused` | death with 2+ grenades in a lost round | 0.33 | 0.25 | |
| `util.buy` | rifle round with no utility | 0.25 | 0.2 | |
| `util.damage` | fire that touched nobody | 0.25 | 0.15 | a fire also buys time, which the detector cannot see |
| `pos.untradeable` | untraded death, nobody in range | 0.5 | 0.4 | a trade wins the kill back about 40 % of the time |
| `trade.missed` | missed trade | 1 | 0.5 | an average player converts about half of these chances |
| `pos.opening` | opening duel lost beyond even / CT push death | 1 / 1 | 1 / 0.7 | |
| `eco.sync` | buy against 3+ teammates | 0.5 | 0.25 | one off-sync round must not outrank a moving-first-bullet habit |
| `eco.kit_armor` | loadout hole | 0.33 | 0.25 | |

**Confidence** = the detector's (its precision constant × the sample factor on opportunities) × an **instance
factor** `1 − exp(−instances / 3)`: a pattern seen twice (0.49) is less certain than one seen eight times (0.93),
however many chances it had. Shown in words: high ≥ 0.6, moderate ≥ 0.35, low below.

**Fixability** per detector (`fixability` in the tuning, default 0.7): counter-strafe and reloads 1, buys 0.8–0.9,
range discipline 0.9, weapon out 0.9, utility 0.7, trades 0.7, aim (first bullet, spray) 0.6, positioning 0.6.

**Recurrence** = min(2, 1 + 0.25 × earlier matches with the same root family); `analyze(…, { recurrence })` takes the
counts, 1 until match history exists (K10).

**Selection.** A fix may lead only above the **bar**: at least one evidence moment, effective confidence ≥ 0.2,
impact ≥ 0.75 fights per 24 rounds and priority ≥ 0.2. Up to three: first the best candidate of each scope
(mechanics, micro, macro), then the rest by priority; never two of one **root family**; shown by priority (ties by
id). Families (`families` in the tuning; any other detector is its own family): `first-shot` = counter-strafe +
first bullet, `spray` = spray + range discipline, `gun-ready` = reload + caught out, `loadout` = `util.buy` +
`eco.kit_armor`, `crosshair` = K6's placement + time to damage. **Strengths**: up to two, by
max(impact, 0.5) × confidence, one per family.

**Precision gate.** `gate.measured` holds K11's measured precision per detector; a detector below 0.9 can only
produce observations (its fixes and strengths are demoted, `scoring.gated`). Nothing is measured yet: the precision
constants in the area files are assumptions and do not gate.

Every finding carries `scoring` (`rawImpact`, `polarity` before the gate, `family`, `excess`, effective `confidence`,
`fixability`, `recurrence`, `gated`, `bar`), so the page and the CLI can say why something leads or not. `impact`
after the prioritizer is the unified one; the prioritizer is idempotent.

## The top fixes on the test demo (with the Mirage sight mesh)

Before (K2's first prioritizer, impact × confidence, K2/K4 costs):

| Player | Fixes |
| --- | --- |
| A1 | flash blinds nobody; **reload exposed** |
| A2 | **buy with your team** (2 rounds); first bullet; **reload exposed** |
| A3 | missed trades (2 of 2); wasted fire |
| A4 | untradeable; flash; counter-strafe |
| A5 | missed trades; flash |
| B1 | untradeable; **reload exposed** |
| B2 | untradeable; buy with your team; loadout |
| B3 | untradeable; caught out; grenades unused |
| B4 | untradeable; buy with your team; counter-strafe |
| B5 | counter-strafe |

The reload rule was in three lists; "play where a teammate can trade you" led every B (CT) list, though CTs holding
sites alone die untraded by the role (B-team shares 44–88 %, median 57 %); two off-sync rounds led A2's.

After:

| Player | Fixes (key number, rank, instances, unified impact, confidence, priority) | Strengths |
| --- | --- | --- |
| A1 | 1. **Throw flashes that blind someone** (`util.flash.no_enemy`): 0.20 enemies per flash, tied 5th of 8; 4 of 5; impact 1.02, moderate, 0.25 | Sharp first bullets; Controlled sprays |
| A2 | 1. **Make the first bullet count** (`aim.first_bullet.low`): 22 %, 8th of 8; 14 of 18; impact 1.99, moderate, 0.43<br>2. **Buy with your team** (`eco.sync.off`): 25 %, tied 8th of 10; 2 of 8; impact 1.33, moderate, 0.38 | – |
| A3 | 1. **Throw fire where enemies are or will be** (`util.damage.wasted_fire`): 60 %, 9th of 9; 3 of 5; impact 1.00, low, 0.21 | – |
| A4 | 1. **Throw flashes that blind someone** (`util.flash.no_enemy`): 0.14, 7th of 8; 6 of 7; impact 1.78, moderate, 0.63<br>2. **Stop before you shoot** (`aim.counter_strafe.early`): 50 %, 3rd of 3; 5 of 10; impact 1.85, low, 0.53 | You win the opening duels |
| A5 | 1. **Throw flashes that blind someone** (`util.flash.no_enemy`): 0.20, tied 5th of 8; 12 of 15; impact 3.07, high, 1.65<br>2. **Trade your teammates** (`trade.missed.no_damage`): 80 %, 7th of 8; 4 of 5; impact 3.11, moderate, 0.81 | Sharp first bullets |
| B1 | 1. **Play where a teammate can trade you** (`pos.untradeable.isolated`): 80 %, 9th of 10; 4 of 5; impact 1.60, moderate, 0.36 | – |
| B2 | 1. **Stop before you shoot** (`aim.counter_strafe.early`): 35 %, 6th of 9; 8 of 23; impact 2.05, moderate, 1.17<br>2. **Complete your loadout** (`eco.kit_armor.holes`): 60 %, 10th of 10; 3 of 5; impact 2.00, moderate, 0.69<br>3. **Play where a teammate can trade you** (`pos.untradeable.isolated`): 67 %, 7th of 10; 4 of 6; impact 1.07, moderate, 0.26 | – |
| B3 | 1. **Have your gun out where enemies can be** (`move.caught_out.deaths`): 25 %, 9th of 9; 2 of 8; impact 2.67, low, 0.48<br>2. **Use your grenades before you die** (`util.unused.death`): $211 / round, 10th of 10; 2 of 8; impact 0.77, low, 0.21 | – |
| B4 | 1. **Stop before you shoot** (`aim.counter_strafe.early`): 42 %, 8th of 9; 8 of 19; impact 2.62, moderate, 1.35<br>2. **Play where a teammate can trade you** (`pos.untradeable.isolated`): 88 %, 10th of 10; 7 of 8; impact 3.20, moderate, 1.11<br>3. **Buy with your team** (`eco.sync.off`): 25 %, tied 8th of 10; 2 of 8; impact 1.33, moderate, 0.38 | – |
| B5 | 1. **Stop before you shoot** (`aim.counter_strafe.early`): 42 %, 7th of 9; 5 of 12; impact 1.62, low, 0.53 | Sharp first bullets |

Read as a player: the reload rule leads nobody (it stays in Movement as a fix "below the bar"); untradeable deaths
lead only for the CT who is clearly worse than the other CTs (B4: 7 of 8 deaths, nearest teammate 1,539 units) and
sit third for B2; counter-strafing leads every list where it fires on more than a handful of bullets; two off-sync
rounds come after a 22 % first-bullet hit rate (A2) and after a 42 % moving-first-bullet habit (B4). A3's missed
trades (2 of 2) stay below the bar on two instances. A4 is close (flashes 0.63 against counter-strafe 0.53: 6 of 7
flashes against 5 of 10 rifle bullets). Ten rounds is a short match: most confidences are moderate or low, and the
page says so.

Report JSON for the test demo (without the replay): 22–73 KB per player; the evidence series are most of it for
players with duel or spray evidence (A4 73 KB with 6 series evidences, A3 22 KB with none). With the replay, the
stored gzipped report is 0.42 MB (browser check, B2), inside the 5 MB budget.

## The report page

From the top: header (map, score, sides, "Change player", **Hide names**), the round strip, **Your three fixes**,
**What went well**, the evidence viewer (when a duel or spray moment is open) above the 2D replay, **Skill areas**.

**Fix card anatomy**: number, title, scope tag · the one-sentence summary · the key number (the finding's first
metric through `metricValue`, its label and n) over a rank strip · instances, rounds, rounds lost, confidence in words ·
Watch buttons (kind, round, the round clock the player saw; the link opens the replay five seconds before the moment,
K3's deep link `#/m/<id>/r/<round>?t=<tick>&ev=<f>.<e>`) · "Do instead" and the drill · why it costs · feedback.
Strength cards are the compact version (rank in words, no strip).

**Metric values.** A `%` metric stores a 0–1 share; every other unit stores its own value; `metricValue` formats all
of them (`78 %`, `1.8°`, `125 ms`, `16.9×`, `942 units`, `0.14`, `0.56 / round`, `$122 / round`). The page, the CLI
and the docs use it, so nothing prints a raw share (the browser check fails on `0.x %`). `util.unused.value_per_round`
now has the unit `$/round`.

**Rank strip**: the players with a value as dots on the metric's axis, better always to the right, the user in the
accent colour with a ring, the others tinted by their side, the lobby median as a tick. Tied values stack on one spot
(up to three dots; a bigger tie is one dot labelled "7 tied"); the caption says "tied 2nd of 8" or "all 10 tied" and
how many players lacked enough samples (they are left out). Ranks are competition ranks (1, 2, 2, 4).

**Skill areas**: per area every metric with a value (label, value, n, rank strip), every finding (fixes, strengths
and observations; "in your fixes" on the ones already on top; "below the bar for a top fix" and "below the precision
gate" where they apply), and the area's charts. An area with measured metrics, findings or charts but no finding says
**nothing to flag**; **not analyzed** only when nothing in it was measured (decisions and strategy until K6/K8/K14).

**Hide names** (`localStorage['cs2-coach.hideNames']`) replaces every player name in the header, replay, kill feed,
picker and library by the labels; finding texts already use labels. The browser check turns it on before the first
screenshot and fails if any real name is in the page text.

**Feedback**: ▲ / ▼ on every finding (fix, strength, area row) with an optional note, saved per match in
`localStorage['cs2-coach.feedback.<match id>']`; "Export feedback (JSON)" in the library downloads all matches'
feedback (`coach-feedback@1`: match id, map, coach version, the user's label, and per finding id, title, vote, note,
time).

## Viewers

Fed by `Evidence.series` (contract: `docs/coach/contracts.md` "Evidence series"), built in `analyze()` after the
prioritizer, so a match reopened from the library shows them without the demo.

- **Duel view** (`kind: 'duel'`; the window K2's counter-strafe and first-bullet evidence uses, 2 s before to 1 s
  after the first bullet, every tick): speed (the velocity column read one row late: the server's speed behind the
  shot) with the weapon's accurate-speed line (34 % of its max speed in the mode fired), crouch as a shaded band, the
  angle from the crosshair to the target's head while he lives, and per bullet the game's own inaccuracy (mrad)
  against the same shot standing; shots marked hit (filled) or miss (hollow); ms from the moment on the axis.
- **Spray plot** (`kind: 'spray'`): left, each bullet's recoil-compensated aim (the bullet's own direction = view of
  the row before + 2 × punch) relative to the target's chest, numbered, over the body outline at that distance and
  1° / 3° rings; right, where the crosshair was against where it had to be: the weapon's pattern from
  `data/weapons.json` (bullet n = pattern row n − 1), or the bullet's own measured kick when the weapon has no pattern
  or fires in its second mode (the silenced M4A1-S, whose pattern the table does not hold). Crosshair − ideal = the
  aim error, by construction (tested).

Sizes: a duel is 4–6 channels of about 190 values; a spray 7 channels of its bullets.

## Charts (`MatchReport.charts`)

Contract in `docs/coach/contracts.md` "Charts". Detectors fill them through the optional `Detector.charts(ctx, slot,
metric, findings)`; `analyze()` checks each key starts with the detector id and sorts the keys. The page shows each
chart in its `area`, one renderer per kind (`src/coach-app/charts/Charts.tsx`): **scatter** (dots by category, rings
around the origin, legend; a linked dot opens its evidence), **bars** (horizontal, value and n at the tip, the user's
bar in the accent, an optional reference line), **series** (lines, legend), **boards** (one small radar per round from
the map pack, zones, dots / crosses / rings, a highlighted board outlined; a linked board opens its evidence). Colours
come from the roles (`ct`, `t`, `user`, `good`, `bad`, `teammate`, `enemy`, `neutral`); detectors never pick colours.
The browser check renders one synthetic payload of each kind.

## Browser check

`tools/coach/browser-check.ts` (default user slot 6, B2, who has duel and spray evidence) adds to K3's run: names
hidden from the start; the fix cards equal `topFixes` in order, each key number equals `metricValue`, each has a rank
strip and one Watch per moment; strength cards; no analyzed area says "not analyzed"; a rank strip per measured
metric; no raw share printed; a duel and a spray Watch open their round with the evidence and render the viewer
(screenshots `2b-duel.png`, `2c-spray.png`); a synthetic scatter, bars, boards and series payload render in their
areas (`6b-charts.png`); a thumbs-down with a note is stored and comes back in the exported JSON.

Last run (full test demo, B2): drop → interactive 1.1 s; fix cards counter-strafe 35 %, loadout 60 %, untradeable
67 %; 38 rank strips (9 with the user tied); duel (round 1) and spray (round 5) viewers rendered; four charts;
feedback stored and exported; every K3 check as before.
