# Demo coach: the analysis framework and the mechanics detectors (K2)

K2 built the analysis framework (Contract 3 of [`coach-plan.md`](../coach-plan.md)), the combat tables, and the first
six detectors: `aim.counter_strafe`, `aim.spray`, `aim.range_discipline`, `aim.first_bullet`, `move.reload`,
`move.caught_out`. Players in this doc are labelled by team and slot order (`A1`…`A5`, `B1`…`B5`; team A starts T),
as `playerLabel` prints them. No real names.

```sh
npm run coach -- report <demo|file.craw[.gz]> --user <slot|A1…B5|part of a name> [--no-los]
npx tsx tools/coach/mechanics-check.ts <file.craw[.gz]>     # the physics check below, as Markdown tables
```

`report` prints the top fixes (numbers, lobby ranks, evidence moments with the round clock), the strengths, the other
findings and the lobby table of every metric, and writes the report JSON to `local/coach-reports/`. It loads
`data/coach/maps/<map>/los.bin.gz` when the map has a pack.

## Framework

| File | What |
| --- | --- |
| `src/coach/analyze/context.ts` | `AnalysisContext` (raw, match, tuning, weapon table, weapon-model constants, `los` or null, memoized `table(def)`, `weapon(item)`, `teamOf(slot)`), `TableDef`, `createContext` |
| `src/coach/metrics/types.ts` | `MetricDef` (`id`, `label`, `unit`, `better`, `area`, optional `minN`, `compute(ctx, slot)`) |
| `src/coach/detect/types.ts` | `Detector` (`id`, `area`, `scope`, `needs`, `run(ctx, slot, metric)`) |
| `src/coach/detect/common.ts` | confidence, the impact scale, strength / bottom-half rules, `makeFinding`, `pickClearest` (evidence) |
| `src/coach/detect/annotate.ts` | annotation and evidence builders |
| `src/coach/analyze/index.ts` | `analyze(raw, match, { user, los? }) → MatchReport`, `reportJson`, the first prioritizer |
| `src/coach/report/format.ts` | `pct`, `deg`, `ms`, `units`, `times`, `plural`, `span`, `rankOf`, `roundClock` ("round 7, 1:12", "round 7, bomb 0:28"), `playerLabel`, `weaponName` |
| `src/coach/analyze/area-tuning.ts` | checks for the per-area tuning files `data/coach/tuning/<area>.json` |
| `src/coach/{derive,metrics,detect}/<area>/index.ts` | one list per area; the top-level `index.ts` joins aim, movement, utility, positioning, economy in that order |
| `src/coach/derive/hurts.ts` | shared: every `player_hurt` with the health it removed (before − after) |

- **Metrics** are computed for every slot. A slot with no value (or fewer samples than `minN`) gets NaN in
  `MetricValue.lobby` (null in JSON) and rank 0. Ranks are competition ranks (1, 2, 2, 4), direction from `better`.
  `MatchReport.metrics` holds the user's `MetricValue` of every metric, with the whole lobby in `lobby`.
- **Detectors** run for the user; a detector whose `needs` are missing is skipped (`knowledge` is always missing until
  K8). Finding ids start with the detector id and are unique in a report.
- **First prioritizer** (K5 replaces it; `data/coach/tuning/report.json`): `priority = impact × confidence`; fixes
  sorted by priority, then id; the top three, never two of one family (the id up to the second dot), never one without
  evidence or below `minConfidence` 0.2; strengths: up to two `strength` findings by priority.
- **Confidence** = the detector's precision (a constant in its tuning until K11 measures it) × `1 − exp(−n / nScale)`.
- **Impact scale**: the estimated number of fights the habit decided against the player, scaled to a 24-round match
  (`perMatch`). About 3 means "three duels a match"; under 0.5 is noise. Each detector's cost per instance is a
  tunable (`costHit`, `costPerSpray`, `costPerMiss`, `costDeath`, `costNear`, `costFull`): K5 recalibrates them, K9
  replaces them with round-win probability.
- **Strength**: rank ≤ 2 among at least 6 players with a value, with enough samples, and an evidence moment.
- **Determinism**: no Date, no Math.random, fixed list orders, numbers rounded in the tables;
  `tests/coach/analyze.test.ts` checks the report JSON of the committed fixture is byte-identical across two runs.
- `replay` stays empty (K3's `src/coach/report/replay.ts`).

## Physics check (test demo, patch 13984)

All from `tools/coach/mechanics-check.ts` on the public test demo (1,242 bullets).

**The tick row at a bullet's tick shows the state after the shot**: the accuracy penalty already includes the shot's
fire penalty, the recoil index is already one higher, the view angles are those of the next tick. **The velocity
column lags the positions by one tick**: the speed behind an action at row t is the velocity at row t + 1
(`derive/movement/speed.ts`). Read that way, everything below fits.

### 1. `fire_bullets.inaccuracy` equals the engine's model

Model: `inaccuracy(w, mode, penalty(row t) − fire[mode], velocity(row t + 1), airborne(row t))`
(`src/engine/weapons/accuracy.ts`, 34 % threshold, the 0.25 movement curve, the air term). "Naive" reads penalty and
velocity from the row before the shot.

| weapon | bullets | median rel. error | within 1 % | within 5 % | moving: within 10 % | naive: moving within 10 % | airborne |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ak47 | 640 | 0.00 % | 96 % | 97 % | 91 % of 66 | 52 % | 5 |
| m4a1s (mode 1) | 128 | 0.00 % | 97 % | 98 % | 96 % of 23 | 48 % | 0 |
| mac10 | 79 | 0.00 % | 91 % | 96 % | 96 % of 28 | 89 % | 3 |
| deagle | 68 | 0.00 % | 90 % | 93 % | 83 % of 18 | 83 % | 1 |
| usps (mode 1) | 52 | 0.00 % | 92 % | 100 % | 100 % of 29 | 86 % | 6 |
| glock | 48 | 0.00 % | 94 % | 100 % | 100 % of 18 | 67 % | 1 |
| m4a4 | 45 | 0.00 % | 100 % | 100 % | 100 % of 3 | 33 % | 0 |
| p2000 | 44 | 0.00 % | 95 % | 100 % | 100 % of 24 | 75 % | 0 |
| famas | 31 | 0.00 % | 90 % | 90 % | 33 % of 3 | 67 % | 0 |
| mp9 | 26 | 0.00 % | 100 % | 100 % | 100 % of 14 | 71 % | 0 |
| ssg08 (mode 1) | 24 | 0.00 % | 100 % | 100 % | 100 % of 1 | 0 % | 0 |
| others (7 weapons) | 55 | ≤ 0.35 % | 80–100 % | 80–100 % | 100 % of 17 | – | 3 |
| **all** | 1,240 | 0.00 % | 95 % | 97 % | 95 % of 244 | 68 % | 19 |

The game's per-bullet inaccuracy is the engine model exactly for 95 % of bullets. Where it deviates: a few moving
shots with the velocity changing fast within the tick (sub-tick timing: the Deagle 83 %, the FAMAS 1 of 3), some
airborne shots, and the scoped AWP's first frames. The detectors use the game's own number (`fire_bullets.inaccuracy`)
for costs and the model only to define "standing": `stillInaccuracy = penalty(row t) − fire penalty`.

### 2. The bullet's angles include the aim punch, with a scale of 2

Least squares of (bullet angle − view angle) against the aim punch, 671 bullets with punch ≥ 0.3°:

| view row | punch row | pitch scale | yaw scale | residual median | p90 |
| --- | --- | ---: | ---: | ---: | ---: |
| before the shot | the shot's | 2.014 | 1.954 | 0.071° | 0.368° |
| the shot's | the shot's | 2.044 | 1.748 | 0.277° | 0.997° |
| before | before | 1.427 | 1.669 | 1.295° | 2.494° |

Bullets with zero punch (298): bullet = view of the row before to 0.001° for 62 %, median 0.0002°. So
**bullet = view(row before) + 2 × punch(shot's row)**: the bullet angles are the recoil-compensated aim, and that is
what the spray metrics compare with the target. The demo says CS:GO's `weapon_recoil_scale` 2, not the repo's 1.884;
see 4 for why the repo's patterns still fit.

### 3. `recoilIndex` and the bullet number

- In full-auto sprays at the cycle time (812 bullets): `recoilIndex` = bullet number − 1 for 71 %, and = the first
  bullet's index + bullet number − 1 for 94 %: the index counts on from where the last burst left it.
- First bullets of bursts (394): index 0 for 65 %; otherwise fractional (decaying since the last shot), median 0.60,
  p90 1.76. A burst that starts at index 1.7 kicks like bullet 2.7. The spray profile counts bullets by their position
  in the burst (what the player did); the index is kept per shot for K12's sim drills.

### 4. The patterns in `data/weapons.json` against the measured kick

Measured offset per bullet = 2 × punch at that bullet (sprays from index 0, bullets 2–10), fitted against
`sprays[weapon]` (the engine pattern at `recoilScale` 1.884):

| weapon | bullets | measured / pattern | RMS residual | RMS kick difference between consecutive bullets |
| --- | ---: | ---: | ---: | ---: |
| ak47 | 263 | 1.017 | 0.224° | 0.231° |
| m4a4 | 7 | 1.023 | 0.124° | 0.116° |
| famas | 9 | 0.944 | 0.149° | 0.166° |
| mac10 | 29 | 1.115 | 0.373° | 0.366° |
| mp9 | 17 | 0.896 | 0.353° | 0.409° |
| m4a1s | 76 | 0.699 | 0.365° | 0.385° |

The AK-47 and M4A4 patterns match the real kick within 2 % in size and about 0.2° per bullet. Since the demo's scale
is 2, the engine's punch must be about 6 % larger than CS2's while their product (the bullet's offset) is right: the
1.884 fit compensates. The M4A1-S is 30 % off because its bullets are fired in mode 1 (silencer on) while `sprays`
holds the primary-mode pattern. Not fixed here (engine files are not K2's): a note for the sim's weapon owner.

### 5. The intended target

| sight mesh | hurt an enemy | aimed at one, clear | ambiguous | none | assigned | in sprays | in taps / short bursts |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| no | 201 | 427 | 8 | 606 | 51 % | 52 % | 48 % |
| yes (Mirage pack) | 201 | 287 | 3 | 751 | **39 %** | 42 % | 32 % |

With line of sight required, 39 % of bullets get a target; ambiguity is rare (3). Most of the rest are bullets at
nobody in sight: prefires, spam through smokes and walls, spray bullets far off. Of the unassigned bullets without the
mesh, 232 were 3–10° from an enemy (spray drift or tracking), the rest farther. A spray is measured against its
majority target for every bullet, so drift away from the target still counts.

## Combat tables (`src/coach/derive/aim/`, `src/coach/derive/movement/`)

| Table | Rows | Notes |
| --- | --- | --- |
| `SHOTS` (`aim.shots`) | one per bullet | `weapon_fire` and `fire_bullets` share tick and player for every gun shot (348 `weapon_fire` without a bullet: knives, grenades). Speed (row t + 1), airborne, duck, scoped, walking, penalty, punch, recoil index, clip, buttons over 300 ms, stop technique, ms until stopped, hits (every gun `player_hurt` shares its bullet's tick: 205 of 205), damage (health before − after), burst id, bullet number, burst length |
| `bursts` (in `SHOTS`) | one per burst | same player, weapon and round, gaps ≤ 1.6 × cycle time; `spray` = 3+ bullets. Test demo: 394 bursts, 136 sprays |
| `TARGETS` (`aim.targets`) | one per bullet | hurt enemy; else the living enemy nearest the zero-spread direction (head, chest or pelvis) inside min(8°, 1.5° + atan(24 / distance)), ≤ 4,000 units, visible with a pack, runner-up ≥ 1.6× farther; up / right offsets from the chest and "on target" (the aim ray crosses a 28 × 63-unit silhouette, crouch-scaled) |
| `SPRAYS` (`aim.sprays`) | one per spray with a target | majority target (hits count double); every bullet measured against it |
| `RELOADS` (`movement.reloads`) | one per `weapon_reload` in a round, alive | clip and weapon on the event's row (still the old clip), nearest enemy, enemy within 1,200 (and visible with a pack), more than half the magazine, died before it finished |
| `DEATHS_IN_HAND` (`movement.deaths_in_hand`) | one per death in a round | weapon, clip and reloading on the row before; "reloading" only while the clip is not refilled (it refills about a second before the flag clears: an AK-47 at 1.4 s of 2.47 s); grenade thrown at the killer within 1.5 s |

Stop technique, from the 300 ms before a shot: `standing` (never above the threshold), `holding` (a movement key
still pushes along the velocity at the shot), `opposite` (after the peak speed a key pushed against it), `crouch`,
`coast` (keys released).

## Metrics (all slots; tunables in `data/coach/tuning/aim.json` and `movement.json`)

"First bullets": the first bullet of each burst, on the ground, in a round, with a target, from a gun other than a
shotgun or the Zeus. "Moving": speed above 34 % of the weapon's max speed in the mode fired.

| id | definition | better |
| --- | --- | --- |
| `aim.counter_strafe.early_share` | moving share of first rifle bullets, not crouched (Leetify-comparable), n ≥ 8 | lower |
| `aim.counter_strafe.early_share_all` | moving share of all first bullets | lower |
| `aim.counter_strafe.late_ms` | median ms from a moving first bullet until the speed fell under the threshold (capped at 500) | lower |
| `aim.counter_strafe.cost_x` | mean `inaccuracy / stillInaccuracy` of moving first bullets | lower |
| `aim.counter_strafe.opposite_share` | share of stops before a first bullet made with the opposite key | higher |
| `aim.spray.on_target_share` | spray bullets from bullet 2 whose aim ray crossed the target | higher |
| `aim.spray.vertical_drift_deg` / `horizontal_drift_deg` | \|median\| up / right offset over bullets 4+ | lower |
| `aim.spray.hit_share` | spray bullets from bullet 2 that hit the target | higher |
| `aim.range_discipline.wasted_share` | sprays of 6+ beyond 1,200 units with no hit after bullet 4 | lower |
| `aim.first_bullet.hit_share` (`_standing`, `_moving`) | first bullets that hit | higher |
| `move.reload.exposed_share` | reloads with an enemy near or > half a magazine | lower |
| `move.reload.deaths` | deaths while reloading | lower |
| `move.caught_out.share` | deaths with the knife or a grenade in hand, not throwing at the killer | lower |

Detectors: `aim.counter_strafe.early` (fix: share ≥ 20 % and bottom half) / `.clean` (strength);
`aim.spray.drift` (fix: on-target share bottom half, ≥ 20 bullets in the weapon-and-band group, a drift segment from
bullet 2 reaching bullet 4 and two bullet numbers long) / `.controlled`; `aim.range_discipline.long_sprays` (≥ 2,
bottom half or ≥ 50 %) / `.disciplined`; `aim.first_bullet.low` (bottom half and 8 points under the median) /
`.sharp`; `move.reload.exposed` (a death while reloading, or ≥ 2 exposed and bottom half); `move.caught_out.deaths`
(≥ 2). Evidence: the clearest instances by a per-detector score, one per round first, up to three.

## Lobby table, test demo (with the Mirage sight mesh)

| metric | A1 | A2 | A3 | A4 | A5 | B1 | B2 | B3 | B4 | B5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| counter_strafe.early_share | – | 22 % | – | 50 % | 6 % | – | – | – | – | – |
| counter_strafe.early_share_all | 18 % | 11 % | – | 54 % | 4 % | 11 % | 35 % | 21 % | 42 % | 42 % |
| counter_strafe.late_ms | 47 | – | – | 125 | – | – | 109 | 141 | 211 | 63 |
| counter_strafe.cost_x | 2.3× | – | – | 16.9× | – | – | 3.8× | 7.8× | 3.5× | 2.8× |
| counter_strafe.opposite_share | 91 % | 90 % | – | 40 % | 88 % | 0 % | 47 % | 90 % | 40 % | 70 % |
| spray.on_target_share | 78 % | 33 % | 17 % | 51 % | 54 % | 45 % | 62 % | 57 % | 56 % | 69 % |
| spray.vertical_drift_deg | 0.08 | 0.25 | 0.52 | 0.06 | 0.40 | 1.07 | 0.65 | 0.15 | 0.86 | – |
| spray.horizontal_drift_deg | 0.77 | 1.77 | 1.99 | 0.75 | 0.21 | 0.87 | 0.18 | 0.25 | 0.02 | – |
| spray.hit_share | 33 % | 12 % | 10 % | 18 % | 20 % | 23 % | 26 % | 26 % | 22 % | 39 % |
| range_discipline.wasted_share | 50 % | 0 % | 0 % | – | 50 % | – | 100 % | 0 % | – | – |
| first_bullet.hit_share | 65 % | 22 % | – | 23 % | 50 % | – | 35 % | 43 % | 26 % | 50 % |
| first_bullet.hit_share_standing | 71 % | 25 % | 50 % | 33 % | 52 % | 38 % | 40 % | 45 % | 18 % | 43 % |
| first_bullet.hit_share_moving | – | – | – | 14 % | – | – | 25 % | – | 38 % | 60 % |
| reload.exposed_share | 75 % | 71 % | 25 % | – | 60 % | 80 % | – | 67 % | 71 % | 67 % |
| reload.deaths | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| caught_out.share | 0 % | 0 % | – | 0 % | 0 % | 0 % | 0 % | 25 % | 0 % | 0 % |

Ten rounds is a small match: the rifle-only counter-strafe figure reaches its 8-bullet minimum for three players.
Analysis time on this demo: ingest and map pack 58 ms, `analyze()` 112 ms, peak RSS 185 MB.

## Spot checks (each printed evidence moment against the raw events)

Checked with a script that reads only `raw.events` and `raw.ticks` at each evidence's focus tick.

**B4** (fixes: counter-strafe, reload, first bullet)

| tick | finding says | raw events say |
| --- | --- | --- |
| 5160 | first P2000 bullet at 178 u/s, still holding the key, missed | bullet hkp2000 inaccuracy 0.0230; velocity row+1 178; buttons right + fire, speed rising 63 → 171 → 200; no hurt; slot 4 alive at 974 u |
| 12811 | first MP9 bullet at 180 u/s, missed | inaccuracy 0.0353, speed 180, no hurt, target alive at 556 u |
| 28421 | first P250 bullet at 103 u/s, still moving 500 ms later, missed | inaccuracy 0.0120, speed 103, no hurt |
| 5806 | reload of the P2000 with an enemy 908 u away in sight | weapon_reload at 5806, hkp2000 clip 5, enemy slot 4 at 908 u |
| 19794 | reload of the FAMAS with 16 of 25 | weapon_reload, famas clip 16 |
| 47830 | reload of the Desert Eagle with 6 of 7 | weapon_reload, deagle clip 6 |
| 5140 | first P2000 bullet missed at 973 u, 2.8° off, standing | bullet at 5140, speed 65 (under 82), no hurt, target at 973 u |
| 12142 | first MP9 bullet missed at 899 u, standing | speed 45, no hurt, target at 899 u |
| 25616 | first Deagle bullet missed at 993 u, standing | speed 10, no hurt, target at 993 u |

**B2** (fixes: counter-strafe, range discipline)

| tick | finding says | raw events say |
| --- | --- | --- |
| 4469 | first Five-SeveN bullet at 240 u/s, missed | inaccuracy 0.0515, speed 240, no hurt, target alive at 722 u |
| 24703 | first MP9 bullet at 240 u/s, missed | inaccuracy 0.0380, speed 240, no hurt |
| 54532 | first Deagle bullet at 223 u/s, missed | inaccuracy 0.0598, speed 223, no hurt |
| 29752 | 8 bullets at 1,240 u, 0 of 4 hit after bullet 4, 2 hit | M4A1-S bullets from 29752, hurts at 29752 and 29758 only (slot 1), target at 1,240 u |
| 29816 | 7 bullets at 1,265 u, no hit | bullets 29816–, no hurt |
| 45035 | 9 bullets at 1,240 u, 1 hit (bullet 4 or earlier) | 9 AK-47 bullets 45035–45086, one hurt at 45054 (bullet 4), target at 1,240 u |

**A2** (fixes: first bullet, reload): three standing misses at 878–1,282 u (speeds 0–20, no hurts) and three reloads
with 13/20, 5/7 and 6/7 in the clip: all as the events say.

What the spot checks changed: a "death while reloading" at A4's 30359 had a full clip (the AK-47 refilled 1.4 s into
the reload, the flag stays on to 2.47 s), so a death now counts only before the clip refills; a one-bullet "drift"
segment (bullet 1, or bullet 5 alone) no longer makes a spray finding; the spray caption now gives that spray's own
offsets rather than the group's.

## Known limits

- The spray finding did not fire on the test demo (no player's drift met the bar); it is covered by synthetic tests.
- `move.reload`'s "more than half a magazine" is common in every lobby (60–80 %); its cost per instance is low
  (`costFull` 0.05) so it rarely leads, but K5 should look at it.
- Intended targets need line of sight to the target's body points from the bullet origin, without smokes (spraying
  into a smoke at a seen enemy keeps the target).
