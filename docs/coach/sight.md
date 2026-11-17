# Demo coach: sight-based analysis (K6)

The demo says where everyone stood and looked, but not who could see whom (`spotted` is the radar's lagging flag). K6
computes sight on the map pack's mesh (KM, [`maps.md`](maps.md)) and builds on it the aim analysis that needs it:
where the crosshair was when an enemy appeared, how long until he was hurt, what killed you unseen. Players in this doc
are labelled by team and slot order (`A1`…`A5`, `B1`…`B5`; team A starts T), never by name.

```sh
npm run coach -- report <demo|file.craw> --user B5          # the findings below, with the Mirage pack
npx tsx tools/coach/sight-check.ts [file.craw] [--user 3] [--evidence 3,9]   # every number in this doc
```

| File | What |
| --- | --- |
| `src/coach/derive/sight/sightings.ts` | `SIGHTINGS` (`sight.sightings`): the per-row sight state of every ordered enemy pair, the sightings, the blind rows |
| `src/coach/derive/sight/duels.ts` | `DUELS` (`sight.duels`): one row per meeting of two enemies |
| `src/coach/derive/sight/firsts.ts` | `FIRSTS` (`sight.firsts`): each player's first sight in each duel, with the crosshair offset and the times |
| `src/coach/derive/sight/habits.ts` | `HABITS` (`sight.habits`): airborne and blind shots, scoped movement, sniper re-peeks |
| `src/coach/derive/sight/death-context.ts` | `DEATH_CONTEXT` (`sight.death_context`): every death labelled from sight |
| `src/coach/derive/sight/radar.ts` | `compareRadar`: the demo's radar flags against computed sight |
| `src/coach/metrics/aim/sight.ts`, `metrics/positioning/death-context.ts` | the 19 metrics, every slot |
| `src/coach/detect/aim/{placement,time-to-damage,habits,sight-evidence}.ts`, `detect/positioning/death-context.ts` | the detectors and their evidence |
| `data/coach/tuning/sight.json` | every threshold (with KM's `los` section, moved here from `data/coach/los-tuning.json`) |
| `tools/coach/sight-check.ts` | timings, ground truth, radar comparison, Inferno stress, lobby table, spot and evidence checks |
| `tests/coach/sight-{tables,detectors,fixture}.test.ts`, `sight-synth.ts` | synthetic box-map tests of every table and detector; the committed fixture with the Mirage pack |

Without a sight mesh (`ctx.los` null) every table is empty (`available: false`), every metric is undefined and the
detectors are skipped (`needs: ['los']`).

## Sightings

For each round's live play (freeze end through round end; freeze time is never evaluated) and each ordered pair of
enemies on the round's roster, one state byte per row (`SEE` bits):

| bit | meaning |
| --- | --- |
| `los` | some body point of the target (`LosWorld.visible`'s seven points) is visible from the observer's eye and not behind opaque smoke (`SmokeField` from the smoke detonations and their expiries) |
| `head` | the head point is visible |
| `inView` | a visible point is inside the observer's frustum (`inFov`'s: 90° at 4:3 widened to 16:9, the row's view angles) |
| `seen` | `inView` and the observer is not blind: **the sighting** |
| `smoked` | a point clears the mesh, but every such point is behind smoke |
| `blind` | the observer is blind: the flash he is under has more than `blindRemainingSec` (1.0 s) left. The demo's `flash` column is the flash's full duration and stays constant until the next flash, so the remaining time is counted from the row it changed (or the `player_blind` event) |
| `eval` / `far` | the pair was live (both alive, within `maxDistance` 4,500 units) / both alive but farther apart |

`Sighting` = a run of `seen` rows (observer, target, round, rows, ticks, head visible at the start). The "weaker
facts" the detectors need are the other bits: line of sight outside the view (`los` without `inView`), a body part
without the head (`los` without `head`), through smoke only (`smoked`).

**Method.** Each pair is evaluated every 8 rows (`stepTicks`) and at anchor rows: every gun shot by either player and
every hurt and kill between them, and the row before each. Where two consecutive evaluations differ in any visible bit,
the change is found to the row by bisection (three evaluations for an 8-row gap); rows between equal evaluations take
their value. One evaluation tests the head first, then the chest, then the other points inside the frustum, then those
outside it, and stops as soon as the answer is known: a point seen in view, or line of sight with no untested point in
view. A blocked pair costs 7 segment tests, a visible one 1–3. Both directions of a pair share the sample rows, the
alive and distance checks and the smokes; the geometry is not shared (eye-to-body segments differ each way).

**What is skipped, and why that is safe** (test demo, all pairs, 2,019,150 live-play pair-rows):

| skipped | share | why it is safe |
| --- | ---: | --- |
| freeze time | 22.8 % of round rows | nobody can leave spawn; Mirage's spawns do not see each other |
| teammates | 4 of every 9 ordered pairs | sight between teammates is not an enemy sighting |
| one of the pair dead | 44.8 % of pair-rows | a dead player sees nothing and cannot be seen |
| farther than 4,500 units | 0.0 % | the longest line of sight between live enemies was 2,203 units; the margin is for the longer maps |
| rows between equal samples | 276,569 evaluations for 2,019,150 pair-rows (14 %; the dead rows' are a flag test) | measured against every row below: 1.1 % of seen rows differ, almost all in glimpses shorter than the step |

## Timings

`tools/coach/sight-check.ts`, Node 22 on this workspace (2 shared cores, other agents running), best of 3. The test
demo has 9 played rounds; "full match" scales by 24/9.

| | test demo (9 rounds) | full match (24 rounds) | budget | evaluations | segment tests |
| --- | ---: | ---: | ---: | ---: | ---: |
| Mirage, all pairs | **1.4 s** (1.4–2.2 s over runs) | 3.8 s | 30 s | 276,569 | 1,066,912 |
| Mirage, the user's pairs (`slots: [A4]`) | **0.37 s** | 1.0 s | 10 s | 55,538 | 215,134 |
| Inferno stress, all pairs | **1.6 s** | 4.3 s | 30 s | 277,680 | 1,037,997 |
| Inferno stress, the user's pairs | **0.36 s** | 1.0 s | 10 s | 56,303 | 201,234 |
| Mirage, every row (ground truth, `step: 1`) | 8.0–11.9 s | | | | |

The Inferno stress test maps every Mirage position (and smoke) affinely from Mirage's nav-hull box onto Inferno's, so
the same pair geometry runs through Inferno's mesh (404,075 triangles against Mirage's 57,767): 5.2 % of live
pair-rows have line of sight there against 1.3 % on Mirage, so many more segments are clear and walk their whole
length. It still costs about the same, because most segments are blocked within a few grid cells on either map and the
early exit stops visible pairs after one to three tests; the fourfold slowdown measured in review is for clear
segments, which stay a small share. The whole `analyze()` of the test demo with the pack takes about 2.1 s (0.26 s
before K6): the sightings are built once and memoized like every other table. Memory: the state array is
rows × P × P bytes, 5.7 MB for the test demo, about 14 MB for a full match.

**Step 8 against every row** (the same table at `step: 1`):

- seen pair-rows: 11,788 at step 8, 11,857 at step 1; 125 differ (1.1 % of the true seen rows); line-of-sight rows
  differing: 142;
- sightings: 326 against 383; of the 57 true sightings that do not start on the same row, 49 are shorter than 8 rows
  (glimpses of a knee or shoulder for 1–7 ticks), the other 8 are a glimpse merged into the sighting that follows;
- duels: 139 against 143, 138 matched; the first-sight tick is identical on 235 of 244 sides (median difference 0,
  largest 29 ticks).

Glimpses that matter get an anchor (any shot or hit between the two is evaluated exactly), and the one label that
must not miss a glimpse (`unseen`, below) re-checks every row of its window exactly (`SightTable.probe`).

## Radar flags against computed sight

For the game-sense card, which will read the radar flags. `spottedBy` (the demo's `approximate_spotted_by`, bit q on
the target's row = observer q) and the target's own `spotted` flag, over the 1,113,864 live enemy pair-rows (285,747
target rows):

| radar flag | against | both | sight only | radar only | sight rows the radar flags | radar rows with sight |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `spottedBy`, per observer | `seen` | 4,385 | 7,403 | 1,178 | 37 % | 79 % |
| `spottedBy`, per observer | `los` | 4,429 | 9,498 | 1,134 | 32 % | 80 % |
| `spotted`, per target | some enemy sees him | 4,217 | 6,801 | 1,575 | 38 % | 73 % |
| `spotted`, per target | some enemy has line of sight | 4,264 | 8,652 | 1,528 | 33 % | 74 % |

- **Lag at the start:** the bit comes on a median **328 ms** after the sighting starts (p10 78 ms, p90 938 ms; 184
  sightings); **142 of 326 sightings are never flagged** within ±2 s. Of the sightings of 1 s or more, 39 of 50 are
  flagged.
- **Lag at the end:** for flagged sightings, the bit clears a median **281 ms** after sight is lost (p10 63, p90 922
  ms; 146 sightings, 8 not cleared within 2 s).
- The radar bit with line of sight but outside the view: 25 pair-rows. The radar follows what the observer sees, not
  bare line of sight.

So the radar flag is a delayed, sampled subset of true sight: about four fifths of flagged rows are real sight; it
misses most short exposures and lags a third of a second at both ends. This matches what Leetify reports of the same
flag ("The radar does not update instantaneously, instead it updates on a set rate", 0–500 ms; leetify.com/blog/
enemy-actually-spotted). A game-sense reader built on it should treat a flag as "seen about 0.3 s ago", keep the
enemy's last radar position for about 0.3 s after the flag clears, and expect no flag for a peek under a second.

## Duels

A duel (meeting) joins the sightings of one enemy pair in one round, both directions, whose gaps are at most
`mergeGapSec` (1 s). Per side: the first row it saw the other, its first bullet at him (K2's `TARGETS`: the bullet hurt
him or was aimed at him with sight), its first damaging gun hit (grenades and fire do not count), its gun damage, its
speed at its first sight and whether it was holding (≤ 80 units/s, one-tick velocity lag applied), its weapon. Shots and
damage count from 0.5 s before the meeting to 1 s after its last sighting or the kill. Outcome: `kill` (one killed the
other in that window), `other` (one of them died to someone else), `disengaged`. Test demo: 139 duels, 57 kills, 11
other, 71 disengaged. 57 of the 61 gun kills by an enemy in live play end a duel the killer won; the other four had
no sighting: three went through smoke, and one is the smoke model's known false positive at tick 30042 (maps.md).

## Metrics

All slots; null without a sight mesh. Tunables in `data/coach/tuning/sight.json`.

| id | definition | better |
| --- | --- | --- |
| `aim.placement.angle_deg` | median angle between the view direction and the enemy's head point at the player's first sight in each duel (within 4,000 units), n ≥ 8 | lower |
| `aim.placement.vertical_deg` / `horizontal_deg` | \|median\| of the signed offset (the finding gives the sign: up + = head above the crosshair = "crosshair low"; right + = head right of it) | lower |
| `aim.placement.holding_deg` / `peeking_deg` | the angle at first sights where the player was holding (≤ 80 units/s) / moving | lower |
| `aim.placement.leetify_deg` | Leetify's definition: median angle the view moved from the first sight to the shot that did the first damage | lower |
| `aim.time_to_damage.median_ms` | median first sight → first gun damage on that enemy (damage before the sight, a prefire or wallbang, is left out) | lower |
| `aim.time_to_damage.leetify_ms` | the same without times of 1 s or more (Leetify's definition) | lower |
| `aim.time_to_damage.shot_ms` | median first sight → first bullet at that enemy | lower |
| `aim.time_to_damage.saw_first_lost_share` | duels the player saw first by ≥ 300 ms (or the enemy never saw him) and lost (died to him) | lower |
| `aim.habits.airborne_bursts` | bursts fired in the air at a target | lower |
| `aim.habits.flashed_bursts` | bursts fired while blind | lower |
| `aim.habits.scoped_moving` | runs of ≥ 150 ms with a scoped sniper rifle above 34 % of its scoped speed while an enemy is in sight either way | lower |
| `aim.habits.sniper_repeeks` | a sniper bullet at a target that hurt nobody; both lose line of sight; within 4 s the target sees the player again within 160 units of where he shot | lower |
| `pos.death_context.<label>_share` | share of the player's deaths by an enemy gun or knife that carry the label (below) | lower |

**Death labels** (a death can carry several): `unseen` (the victim did not see the killer on any row of the 3 s
before; with where the killer was against the victim's view: in front, from the side beyond the view's half-width, or
behind beyond 120°, and whether the kill went through smoke or a wall), `crossfire` (two or more enemies saw the
victim on the row before the death), `repeek` (in the 4 s before he was hit by or killed an enemy within 250 units of
where he died, then no enemy saw him for ≥ 0.3 s, then he came back into sight and died within 4 s), `objective`
(planting or defusing), `open` (the killer had line of sight for all of the 1.5 s before the death while the victim
moved ≥ 100 units).

## Detectors

| finding | polarity | rule | evidence |
| --- | --- | --- | --- |
| `aim.placement.off` | fix | n ≥ 8, in the lobby's bottom half and ≥ 1.5° worse than the lobby median. Names the signed error when \|median\| ≥ 1.5° and the two worst places (≥ 3 first sights) | three first sights beyond the lobby median, lost duels first |
| `aim.placement.sharp` | strength | rank ≤ 2 of ≥ 6 | two first sights on the crosshair, won duels first |
| `aim.time_to_damage.slow` | fix | n ≥ 6, bottom half, ≥ 100 ms slower than the lobby median | the slowest three, lost duels first |
| `aim.time_to_damage.fast` | strength | rank ≤ 2 | the fastest two |
| `aim.time_to_damage.saw_first_lost` | fix | ≥ 2 such duels and ≥ 30 % of the saw-first duels | three of them |
| `aim.habits.<airborne\|flashed\|scoped_moving\|repeek>` | fix at ≥ 4, else observation | counted per burst / run / re-peek | up to three |
| `pos.death_context.<label>` | fix | ≥ 4 deaths and one avoidable label (unseen, crossfire, repeek, open) on ≥ 40 % | three deaths with that label |
| `pos.death_context.labels` | observation | otherwise, when any death has a label | three labelled deaths |

Every evidence moment draws the observer's view cone at the moment (`cone`: 53.1° half-angle at 16:9), the sight line
to the enemy (`line`) and a label with the angle and the time ("4.6° off (3.5° left, 3.0° above); 469 ms to
damage"); death moments draw the victim's cone, the killer's line and dashed lines from every other enemy who saw him.
`aim.placement` also fills `MatchReport.charts['aim.placement']` (K5's `scatter`): one point per first sight at
(degrees right, degrees above) of the crosshair, category `won` / `lost` / `no_shot` / `other`, rings at 1°, 3°, 5°,
and a `link` to the finding's evidence for the points it shows.

**Confidence** = the detector's precision constant (0.75–0.85 in the tuning, until K11 measures it) ×
`1 − exp(−n / nScale)`, as every detector. **Impact**, on K2's scale (fights the habit decided against the player per
24 rounds, `perMatch`): placement 0.3 fights per lost duel that began beyond the lobby median; slow damage 0.3 per lost
slow duel; saw first and lost 1 per such duel; a recurring habit 0.25 per instance; a dominant death label 0.5 per
death. Strengths and observations have impact 0. I assumed K5 keeps K2's scale (it is still the scale on `main` and on
K5's branch at the time of writing); each cost is one tunable in `sight.json` if K5 rescales.

## Lobby table (test demo, Mirage pack)

Value (n). Signed medians: vertical + = crosshair below the head, horizontal + = head to the right of the crosshair.

| metric | A1 | A2 | A3 | A4 | A5 | B1 | B2 | B3 | B4 | B5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `aim.placement.angle_deg` | 3.5° (24) | 2.7° (25) | 13.6° (14) | 17.2° (27) | 3.3° (30) | 2.8° (23) | 4.4° (24) | 3.8° (27) | 5.4° (30) | 7.5° (21) |
| signed vertical | +0.3° | +0.2° | +1.0° | +0.4° | +0.5° | +0.9° | +1.0° | +0.7° | −0.2° | +0.3° |
| signed horizontal | +0.4° | −1.6° | +1.7° | −1.9° | −1.3° | +0.4° | −1.3° | +1.0° | −1.8° | 0.0° |
| `aim.placement.holding_deg` | 0.9° (6) | 1.7° (11) | 2.2° (4) | 2.0° (9) | 3.2° (12) | 6.3° (4) | 2.4° (7) | 5.6° (5) | 4.3° (10) | 5.2° (6) |
| `aim.placement.peeking_deg` | 4.2° (18) | 3.5° (14) | 15.0° (10) | 20.4° (18) | 3.6° (18) | 2.8° (19) | 4.8° (17) | 3.6° (22) | 7.8° (20) | 7.5° (15) |
| `aim.placement.leetify_deg` | 1.9° (14) | 3.3° (6) | 4.5° (4) | 7.1° (11) | 4.6° (15) | 2.0° (7) | 5.4° (15) | 3.3° (10) | 3.3° (5) | 9.5° (7) |
| `aim.time_to_damage.median_ms` | 508 (14) | 742 (6) | 790 (4) | 563 (11) | 500 (15) | 609 (7) | 500 (15) | 539 (10) | 469 (5) | 672 (7) |
| `aim.time_to_damage.leetify_ms` | 438 (13) | 688 (4) | – (3) | 563 (11) | 469 (11) | 547 (5) | 438 (11) | 500 (9) | 438 (4) | 547 (6) |
| `aim.time_to_damage.shot_ms` | 438 (17) | 1016 (13) | 938 (7) | 391 (15) | 438 (19) | 532 (10) | 438 (18) | 524 (16) | 399 (12) | 446 (10) |
| `aim.time_to_damage.saw_first_lost_share` | 0 % (3) | 0 % (4) | 0 % (3) | 0 % (4) | 0 % (6) | 0 % (4) | 14 % (7) | 0 % (7) | – (2) | 0 % (5) |
| `aim.habits.airborne_bursts` | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 1 | 0 | 0 |
| `aim.habits.flashed_bursts` | 0 | 0 | 1 | 2 | 0 | 1 | 0 | 1 | 0 | 0 |
| `aim.habits.scoped_moving` | 0 | 0 | 1 | 0 | 0 | 1 | 0 | 4 | 0 | 0 |
| `aim.habits.sniper_repeeks` | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 |
| `pos.death_context.unseen_share` | 20 % (5) | 14 % (7) | 50 % (2) | 0 % (4) | 50 % (4) | 0 % (7) | 0 % (7) | 25 % (8) | 11 % (9) | 0 % (8) |
| `pos.death_context.crossfire_share` | 0 % | 14 % | 50 % | 0 % | 0 % | 14 % | 0 % | 13 % | 11 % | 13 % |
| `pos.death_context.repeek_share` | 0 % | 14 % | 0 % | 25 % | 0 % | 14 % | 0 % | 0 % | 11 % | 13 % |
| `pos.death_context.objective_share` | 0 % | 0 % | 0 % | 0 % | 0 % | 0 % | 0 % | 0 % | 0 % | 0 % |
| `pos.death_context.open_share` | 20 % | 0 % | 0 % | 0 % | 0 % | 0 % | 0 % | 0 % | 0 % | 0 % |

## Sanity against Leetify's ranges

Leetify defines crosshair placement as the angle the crosshair moved from the enemy's first appearance to the first
hit (median) and time to damage as first seen to first damage, dropping times of a second or more (median)
(leetify.com/blog/leetify-stats-glossary). It publishes no rank averages; players quote their own numbers at 8–10° and
500–600 ms (FACEIT level 10 players call 10° bad), and Leetify calls 400–500 ms "really fast".

- **Time to damage lands in that range.** Leetify-style, the lobby runs from 438 to 688 ms (median of the nine with a
  value about 500 ms); with the long ones kept, 469–790 ms. Several hundred ms, as expected.
- **Crosshair placement at first sight** (our main figure) is several degrees: lobby median 4.1°, from 2.7° to 17.2°.
  The two high values (A3 13.6°, A4 17.2°) are real: their peeks put enemies at the edge of the screen (20° when
  peeking against 2° when holding for A4; the evidence below shows 36–54° appearances).
- **Leetify's own figure comes out lower than the 8–10° players quote**: the lobby's `leetify_deg` is 1.9–9.5°,
  median 3.9°. Reasons, in the order I expect them to matter: (1) our first sight is later than Leetify's first
  appearance. Leetify counts "any part of the enemy's body or gun"; we test seven body points, so a gun barrel or a
  sliver of shoulder around a corner is not yet a sighting, and by the time the chest or head clears the crosshair has
  already moved toward it. (2) Only duels with damage after the first sight count (n 4–15 per player): a 9-round
  sample of the hits that landed, which are the well-aimed ones. (3) Measuring from the first line of sight instead
  (no field of view, as Leetify seems to) changes nothing here: the same 1.9–9.5° (`sight-check.ts` prints it),
  because enemies who are later hit nearly always appear inside the view. So the gap is in what counts as visible, not
  in the frustum. John's Leetify page for one of his own matches will show how large it is; until then compare our
  `leetify_deg` across matches and against the lobby, not against Leetify's absolute number.

## Spot checks

From `sight-check.ts`: each row's state recomputed independently with `LosWorld.visible` (all seven points, with the
smoke field) and `inFov`, and the events at those ticks from `raw.events`.

**Ten sightings**, one per round (the median-length one of at least 16 rows) and the shortest overall. "before" is the
row before tick0; every sighting starts where the recompute first finds a visible point in view (row 3: line of sight
existed before but outside the view, then the observer turned; the shortest is a one-row glimpse that fell on a sample
row):

| round, clock | observer → target | ticks | places | distance | before: los / view | tick0: los / head / view | tick1: view | angle at tick0 | radar 0.5 s later | ok |
| --- | --- | --- | --- | ---: | --- | --- | --- | ---: | --- | --- |
| 1, 1:45 | B3 → A2 | 2338–2366 | SnipersNest → TopofMid | 1641 | n / n | y / n / y | y | 2.1° | on | yes |
| 2, 1:22 | A1 → B4 | 12794–12836 | BombsiteA → BombsiteA | 554 | n / n | y / y / y | y | 24.3° | on | yes |
| 3, 1:02 | B5 → A5 | 20336–20385 | Underpass → Apartments | 1408 | y / n | y / y / y | y | 47.8° | off | yes |
| 4, 1:36 | B5 → A4 | 24348–24379 | BombsiteB → BombsiteB | 271 | n / n | y / n / y | y | 1.5° | off | yes |
| 5, 1:02 | A5 → B2 | 31153–31196 | BombsiteA → BombsiteA | 690 | n / n | y / n / y | y | 0.3° | off | yes |
| 6, 1:20 | B4 → A1 | 35151–35195 | Jungle → BombsiteA | 215 | n / n | y / n / y | y | 15.3° | on | yes |
| 7, 1:37 | A4 → B4 | 41660–41695 | BackAlley → Underpass | 886 | n / n | y / n / y | y | 0.1° | on | yes |
| 8, 1:38 | B5 → A5 | 47904–47941 | PalaceInterior → PalaceInterior | 438 | n / n | y / n / y | y | 1.4° | on | yes |
| 9, 1:39 | B2 → A4 | 54450–54484 | BombsiteB → Apartments | 637 | n / n | y / y / y | y | 4.1° | off | yes |
| 1, 1:03 | A5 → B4 | 5081–5081 | BombsiteA → BombsiteA | 997 | n / n | y / n / y | y | 5.2° | off | yes |

**Ten duels**, the first kill duel of each round and one disengaged; against the kill event and the bullets and
hurts between the two in the duel window (bullets: at the other / all fired):

| round, clock | a vs b | sight a / b | first shot a / b | first damage a / b | damage a→b / b→a | outcome | kill event | bullets a / b | ok |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1, 1:35 | A1 vs B1 | 3023 / 3059 | 3086 / – | 3086 / – | 100 / 0 | kill (A1) | 3086: A1 → B1 P250, head | 1/1 · 0/0 | yes |
| 2, 1:33 | A2 vs B4 | 12047 / 12046 | – / 12067 | – / 12076 | 0 / 100 | kill (B4) | 12085: B4 → A2 MP9, head | 0/1 · 5/5 | yes |
| 3, 1:17 | A4 vs B2 | 19352 / 19353 | 19385 / 19375 | 19390 / 19381 | 100 / 99 | kill (A4) | 19429: A4 → B2 MAC-10, head | 10/10 · 9/9 | yes |
| 4, 1:37 | A1 vs B5 | 24318 / – | 24346 / – | 24361 / – | 100 / 0 | kill (A1) | 24380: A1 → B5 MAC-10 | 8/8 · 0/2 | yes |
| 5, 1:30 | A4 vs B1 | 29383 / 29386 | 29410 / 29415 | 29422 / 29415 | 14 / 52 | kill (A4) | 29422: A4 → B1 AK-47 | 3/4 · 2/3 | yes |
| 6, 1:30 | A1 vs B2 | 34507 / 34515 | 34525 / – | 34525 / – | 92 / 0 | kill (A1) | 34525: A1 → B2 AWP | 1/1 · 0/0 | yes |
| 7, 1:37 | A4 vs B4 | 41660 / 41663 | 41696 / 41685 | 41696 / 41685 | 100 / 37 | kill (A4) | 41696: A4 → B4 AK-47, head | 1/1 · 1/1 | yes |
| 8, 1:38 | A5 vs B5 | 47902 / 47904 | 47929 / 47924 | 47936 / 47924 | 100 / 42 | kill (A5) | 47942: A5 → B5 AK-47, head | 3/3 · 3/3 | yes |
| 9, 1:39 | A4 vs B2 | 54520 / 54450 | 54554 / 54481 | 54560 / – | 100 / 0 | kill (A4) | 54599: A4 → B2 AK-47, head | 8/9 · 3/3 | yes |
| 1, 1:46 | A2 vs B3 | 2335 / 2338 | 2363 / 2360 | – / – | 0 / 0 | disengaged | none | 1/3 · 1/1 | yes |

Notes: round 6's A1 vs B2 at first had a first damage 32 ticks before the first sight: a grenade. Duels now count gun
damage only (92 from the AWP; the grenade's 8 is not a duel hit). Round 9 is a duel B2 saw 70 ticks first and shot
first, missed, and lost: the `saw_first_lost` case.

**Evidence moments.** `sight-check.ts --evidence 0,…,9` checks every evidence moment of every K6 finding in all ten
players' reports the same way (the observer sees the enemy at the focus tick and not on the row before, or was blind
then; the angle and times in the label equal the table's; a hurt event at the damage tick; for deaths the kill event and
an exact every-row recompute of "saw the killer in the 3 s before"; for habits the bullet, the airborne flag, the flash
column or the scoped flag and speed at the tick). 57 of 57 agree. Three that were wrong on the first pass and are fixed:

- round 6, A1 vs B2: a grenade's damage counted as the duel's first damage (fixed: gun damage only);
- round 4, B5's death to A1 was labelled `unseen` although B5 glimpsed A1's knees and shoulder for 8 ticks (24229–24236)
  between two samples, 2.3 s before; fixed by the exact every-row lookback for that label;
- grenade deaths were labelled (B5's round-6 death to an HE "from an unseen killer"): death context now covers gun
  and knife deaths only.

Death moments that are right but read oddly: B4 (round 3) and A3 (round 5) died to a killer 1° off their view yet
`unseen`. A3's is the known smoke-model case at tick 30042 (maps.md: the model's smoke is still dense in its last second
where CS2's has thinned). B4 was blind (a 5.0 s flash) and half crouched: no line of sight from his eye to A3, while
A3 saw his right shoulder. The caption says "in front of you but out of sight" for these, adds "you were blind", and
"through smoke" / "through a wall" from the kill event's flags.

## Findings for two players (test demo)

**B5** (`npm run coach -- report <craw> --user B5`): the top fix is
**aim.placement.off** "Pre-aim where the enemy will appear": 7.5° on median over 21 first sights (lobby 4.1°, 8th of
10): holding 5.2° (6), peeking 7.5° (15); Leetify-style 9.5° (10th of 10); worst at Catwalk (11.0° over 5) and
BombsiteB (8.0° over 6); 14 enemies appeared beyond the lobby median and B5 lost 4 of those duels (impact 3.2 ×
confidence 0.52). Fix 3 is **aim.time_to_damage.slow**: 672 ms (547 ms Leetify-style; lobby 551 ms, 8th of 10), first
shot after 446 ms. Evidence: round 1 1:13 (A3 at Ladder, 5.6°, lost), round 3 1:02 (A5 from Underpass, 47.8°, lost),
round 7 1:08 (A1 at CTSpawn, 7.5°, lost); round 2 1:33 (1,266 ms to damage), round 5 1:19 (813 ms).

**A5**: fix 3 is **pos.death_context.unseen** "Stop dying to enemies you have not seen": 2 of 4 deaths (9th of 10),
round 7 1:31 (B3 through the Mid smoke, 6° off the view) and round 8 bomb 0:28 (B1 from the side at PalaceInterior, 69°
off). Strength **aim.time_to_damage.fast**: 500 ms over 15 duels (2nd of 10), evidence 328 ms and 344 ms.

Also: A3 and B5 get `aim.placement.off`, B3 `aim.habits.scoped_moving` (4 runs, fix 3), A2 and B1
`aim.placement.sharp`, B2 `aim.time_to_damage.fast`; the observations (airborne, flashed, re-peeks, death labels)
appear for most players one click down.

## Known limits

- Everything in [`maps.md`](maps.md) "Known limits" applies: static geometry (no doors, no breakables), the decimated
  mesh, no player models as blockers, rest-pose hitboxes, the smoke model's shape and fade.
- Seven body points, no weapon model: the first sight comes when a body point clears, later than the first pixel.
- The view is the demo's view angles at 64 Hz; the frustum assumes 16:9 (a stretched 4:3 player sees less).
  `inFov` does not model the scope's zoom.
- Blindness is a threshold on the remaining flash time, not CS2's fade curve.
- Step 8 misses glimpses under 8 ticks with no shot or hit (1.1 % of seen rows); only `unseen` re-checks every row.
- `saw_first_lost` is rare in this lobby (one such duel in nine rounds); its threshold will need John's demos.
