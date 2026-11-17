# Coach: map knowledge and strategy (K8)

K8 adds the `strategy` area: what the two teams did with the map round after round, the patterns in it, and the
user's part in them (John's example: "positioning better on CT side to prevent an A Long push"). It has four parts:
map knowledge files, six derived tables, five per-player metrics, and five detectors (`strat.lane`, `strat.setup`,
`strat.rotate`, `strat.t_side`, `strat.opponent`) with round boards in `MatchReport.charts`. Tunables are in
`data/coach/tuning/strategy.json` (loader `src/coach/derive/strategy/tuning.ts`). Players are labelled A1…A5,
B1…B5 (team A starts T); no real names appear here.

Strategy findings rest on a handful of rounds (plan principle 4). They are worded as patterns with counts ("3 of
the 8 hits"), never as verdicts; the confidence carries the sample size (below), not the wording.

## Knowledge files (`data/coach/knowledge/<map>.json`, `coach-knowledge@1`)

| Field | What |
| --- | --- |
| `map`, `verified`, `checkedAgainst[]` | `verified: true` needs at least one checked demo: its SHA-256, the number of place names it used, how many were unknown, and `siteIds` (the plant event's bomb-site entity id → `A` / `B`, from where the plants happened) |
| `zones[]` | `id`, `name`, `kind` (`site`, `lane`, `connector`, `mid`, `spawn`), `group` (`A`, `B`, `mid`, `T`, `CT`: the side of the map, used for setup labels), optional `site` (the zone is part of that bomb site's area), optional `defends` (sites a CT standing here also covers: Mirage's CT spawn sits behind A), `places` (the demo's `last_place_name` values) |
| `sites[]` | `id` (`A` / `B`), `name`, `zones` (the site's area: where a T "is on the site") |
| `lanes[]` | `id`, `name`, `places` (a T in one of them is in the lane), `site` it leads to (or null), `earlyFight` (`T`, `CT`, `both`: who normally fights for it early), `counters` (one or two sentences each, quoted as the advice) |

Every place name belongs to exactly one zone, and to at most one lane; the loader (`loadKnowledge` in
`src/coach/derive/strategy/knowledge.ts`) rejects a file that breaks a rule, names an unknown zone or site, or is
`verified` without a checked demo. A place name a demo uses that the file does not list is **unclassified**: the
tables give it the zone code `Z_UNKNOWN`, count it (`strategy.grid.unknown`), and never guess where it is.
`analyze()` runs detectors that need `knowledge` only when the map has a file.

**Mirage** (verified): 14 zones over the 23 names of the test demo, 2 sites, 6 lanes (A Ramp, Palace, Mid/Window/
Connector, Short, Underpass, Apartments). Site ids: **184 = A, 185 = B** (every plant in the test demo: rounds 2, 6
and 7 at 184 with the planter on `BombsiteA`; rounds 1, 4 and 8 at 185 on `BombsiteB`). At run time the plant's site
comes from the planter's place; the id table is the fallback when that place is unknown.

**Dust II** (draft, `verified: false`): written from knowledge of the map with CS:GO-era nav names (`LongDoors`,
`LongA`, `Pit`, `Catwalk`, `ShortStairs`, `TopofMid`, `MidDoors`, `OutsideTunnel`, `UpperTunnel`, `BDoors`, …). Its
names must be confirmed by the first Dust II demo (below).

### Checking a new demo

```sh
npx tsx tools/coach/knowledge-check.ts <demo.dem | file.craw> [--strict]
```

prints every place name the demo used in live play with its player-samples and zone, the `unknown` names (used,
not in the file) and the `unused` ones (in the file, not used), and each plant's site id with the site its planter
stood on. `--strict` exits 1 on an unknown name or a site id that disagrees. On the test demo: 23 names, 23
classified, 0 unknown, 0 unused, 184 → A and 185 → B.

**For John's first Dust II demo:** run the check; move each `unknown` name into its zone (and lane) and drop the
`unused` ones that never appear; confirm `ARamp`, `CTMid`, `Hole` and `Short` exist at all; write the site ids into
`checkedAgainst` (they are entity indexes and may differ from Mirage's); then set `verified: true` and look at one
round of each kind in the replay (a Long take, a B tunnels rush, a mid-to-B split).

## Tables (`src/coach/derive/strategy/`)

All per played round, read from a grid of samples every `grid.sampleTicks` (16 ticks, 0.25 s) from freeze end to
the round end.

| Table | One row per | What |
| --- | --- | --- |
| `strategy.grid` | round | each player's zone and lane per sample, spotted by an enemy (`spotted_by`), position, the bomb carrier; the plant's site |
| `strategy.hits` | round | the site the Ts committed to (the plant's site; else the first site with `hitMinTs` = 2 Ts in its area at once), the entry tick and timing (fast ≤ 30 s, late ≥ 60 s), the committed Ts, the lanes they came through (each one's last lane before the area), T utility that landed on the site or its lanes in the 10 s before the entry (`behindUtil`: ≥ 2 grenades, one a smoke or flash), each T's role (entry, second within 3 s, support, lurk ≥ 1,500 units away outside the site's lanes, dead), and `firstSite` (the first site 2 Ts stood on, which differs after a split or a re-hit) |
| `strategy.lanes` | round × lane | first T, Ts entered by 15 / 25 / 40 s, the most at once, **taken** (a T got through to the lane's site, or stayed ≥ 3 s: a peek into a doorway next to spawn, like Mirage's House or the T end of Palace, is not a take), **contested in time** (from freeze end until the Ts were through plus 5 s: a CT in the lane, a CT who saw a T in it, CT damage to or from it, or a CT grenade landing in it), when the CTs gave it up (died, left, held), the round's result |
| `strategy.setups` | round | each CT's zone 15 s after freeze end and at the first damage between enemies, as a label ("2 A, 1 mid, 1 B, 1 CT"), CTs defending each site at setup time, and the defenders of the hit site at setup time and at the entry |
| `strategy.rotations` | round × CT on a site at setup | rotated (reached the other site's side within 25 s, not through T territory), when he left, the first information per site (a plant, 2 Ts spotted in its area or lanes, the bomb spotted there, or a fight there), early (left before any information on the site he went to), punished (early, and the Ts entered his site within 30 s), stayed (the other site had information and was hit, and 8 s later he was still home with no T on his side) |
| `strategy.repeats` | half × team | counts and longest streaks of each choice: as T `site:*`, `via:*` (lanes of the hit), `lane:*` (taken), `timing:*`, `dry`; as CT `setup:*`, `light:*` (≤ 1 CT on a site at setup), `contest:*`, `open:*`, `quiet:*`; a repeat is ≥ 3 rounds and ≥ half the half |
| `strategy.place_boxes` | place name | an x/y box per place (from `data/coach/maps/<map>/places.json`, else the demo's own samples) for zones on the replay and the boards |

**Sight.** The demo's `spotted_by` is the radar flag and is sparse in GOTV demos (7 % of player-ticks in the test
demo; two players in the same Palace room for 20 s never had it set). With a sight mesh loaded (the CLI and the page
both load it), a CT also "sees" a T in a lane when the T is within 3,000 units, inside the CT's field of view, with a
clear line to a body point (checked every 0.5 s; smokes ignored). For the rotation information, fights carry most of
the signal for the same reason.

## Metrics (all ten players)

| id | unit | better | Definition | Test demo (B1…B5 or A1…A5) |
| --- | --- | --- | --- | --- |
| `strat.lane.contest_share` | % | higher | CT rounds in which he contested a lane the Ts took | B: 89, 100, 89, 89, 78 |
| `strat.setup.on_hit_share` | % | higher | Ts' hits he was defending the hit site for at the entry | B: 0, 0, 25, 50, 13 |
| `strat.rotate.mistake_share` | % | lower | rounds as a site player with a punished early rotation or a stay | B: 20, 14, 33, 0, 14 |
| `strat.t_side.entry_share` | % | higher | team hits he entered first or second | A: 75, 0, 25, 63, 13 |
| `strat.t_side.util_share` | % | higher | team hits he threw a grenade onto the site or its lanes before | A: 38, 25, 25, 25, 13 |

## Detectors (`scope: macro`)

| id | Fires | Finding |
| --- | --- | --- |
| `strat.lane` | As CT, a lane with a site: taken in ≥ 3 rounds, ≥ 3 of them uncontested, uncontested in ≥ half of the takes, and ≥ 2 open rounds lost or planted on that site through it | `strat.lane.open` (fix): "They took Palace in 7 of your 9 CT rounds, 5 times with nobody contesting it; those 5 rounds ended in 4 A plants and 4 lost. You were the A player in 5 of them and stood in A site each time." + the lane's counters |
| `strat.setup` | As CT, ≥ 3 hits; a fix when ≥ 3 went to a site the setup had ≤ 1 CT on at 15 s and ≥ 2 of those were lost | `strat.setup.light` (fix) or `strat.setup.pattern` (observation), with where the user set up in those rounds |
| `strat.rotate` | As CT site player, ≥ 2 punished early rotations plus stays | `strat.rotate.timing` (fix) |
| `strat.t_side` | As T, ≥ 4 hits; fix when ≥ 3 dry hits won ≤ 40 %; strength when ≥ 3 hits behind utility won ≥ 60 %; else observation | `strat.t_side.dry` / `.executes` / `.hits`, with the user's role counts |
| `strat.opponent` | The other team's most repeated `site:` / `via:` (user CT) or `light:` (user T) in a half of ≥ 4 rounds | `strat.opponent.unanswered` (fix: the repeats after the second went mostly unanswered and ≥ 2 were lost) or `.habit` (observation) |

Each finding has replay evidence for the two or three clearest rounds (`pickClearest`): the lane or site drawn as
`zone` annotations from the place boxes, the user and the relevant Ts circled, a caption with the outcome. Each of
`strat.lane`, `strat.setup`, `strat.rotate` and `strat.t_side` also fills a `boards` chart under its id: one small
map per round of the user's side, the dots at the key tick (the Ts through the lane, the entry, the rotation
moment), the lane or site coloured (amber taken untouched / blue contested; red light / blue defended; green behind
utility / red dry), a caption with the outcome, and a link to the evidence of that round when there is one.

Charts go through K5's optional `Detector.charts(ctx, slot, metric, findings)`; `analyze()` collects them into
`MatchReport.charts` with sorted keys.

**Confidence and impact.** Confidence = precision 0.7 (until K11 measures it) × (1 − e^(−rounds / 6)): 9 rounds give
0.54, 4 rounds 0.34, 24 rounds 0.69. Impact = rounds lost to the pattern per 24 rounds × 0.3 (a round is worth
several fights on K2's scale, but a team pattern is shared by five players). Observations and strengths have
impact 0.

## The nine rounds of the test demo

Team A (A1…A5) is T in all nine played rounds (round 10 is a surrender in freeze time), team B CT; the score is 8–2
for A. Checked with `tools/coach/strategy-check.ts`, which seeks the replay to the setup time, the first T in the
lane of the hit, the entry and the plant of every round and saves the radar (in `logs/coach/strategy/`, not
committed: the demo has real names). With the sight mesh.

| R | What the Ts did (replay) | Tables | Agree |
| --- | --- | --- | --- |
| 1 | Pistol round. Four Ts through Mid and Underpass, fights in Mid; two take A by 52 s and hold it; at 90 s the two left walk through CT spawn and Market into B and plant at 102 s; T win | hit B (plant) at 96 s with A3, A5, late, dry; `firstSite` A at 52 s; lanes taken Mid (contested: Window and three sightings), Underpass (open), Apartments (contested by a grenade); setup 1 A, 1 mid, 2 B, 1 CT | Yes. `lanes` of the hit says Mid: the last lane they crossed; they reached B from A through CT spawn, which is no lane |
| 2 | Split: two Ts rush B through Apartments at 20 s and die at Truck and on the site; A1 takes Ramp and Palace alone, A5 comes through Connector; A1 plants A at 42 s; B3 defuses | hit A at 39 s with A1, A5, behind 2 smokes; `firstSite` B at 22 s; Ramp, Palace (B1 saw A1), Mid and Apartments contested; CT win | Yes |
| 3 | Slow default: Ramp → Palace (A1), Mid, Underpass, Apartments, Short late; fights everywhere; no site taken; the Ts win by kills at 70 s | no hit; every taken lane contested; setup 1 A, 1 mid, 1 B, 2 CT | Yes |
| 4 | B rush through Apartments at 17 s, no utility (A1, A4; A2 at the Apps exit); A3 lurks Palace (fights B1 there), A5 Short; plant B at 36 s | hit B at 17 s with A1, A4, fast, dry; Apartments taken, open; Palace and Short contested; the CT setup had 1 on B (B5); A3 and A5 lurk | Yes |
| 5 | A execute: Palace (A3 from 5 s), Ramp (A1), Mid to Connector (three); 1 smoke, 2 flashes, 1 HE; entry at 27 s; CTs stacked A (3) win it | hit A at 27 s with 4, behind utility; Ramp, Palace, Mid contested; setup 3 A, 1 mid, 1 B; CT win | Yes |
| 6 | Mid and Underpass take, Window killed at 24 s; three Ts to A through Connector at 35 s with one flash; plant A at 51 s | hit A at 35 s with A4, A1, A2 via Mid, dry (1 flash < 2); Mid, Short, Underpass, Apartments contested | Yes |
| 7 | Mid fights (two Ts die), slow push through Connector and Jungle; A at 51 s; plant A at 64 s | hit A at 51 s with A1, A4, A3 via Mid, dry; Mid, Underpass, Apartments contested; setup 1 A, 2 mid, 1 B, 1 CT; 0 CTs on A at the entry | Yes |
| 8 | Fake/lurk Palace (A5 alone holds it vs three CTs), three Ts through Apartments to B at 26 s behind 2 smokes, a flash and an HE; plant B at 36 s | hit B at 26 s with A1, A4, A3 via Apartments, behind utility; Apartments, Mid, Short open; Palace contested by three; setup **4 A, 1 CT**, 0 on B | Yes |
| 9 | B hit through Apartments at 26 s behind 2 smokes and 2 HEs; A1 and A2 lurk Palace and Mid; no plant, the Ts win by kills at 39 s | hit B at 26 s with A4, A3, behind utility; A1, A2 lurk; Palace and Underpass open; setup 1 A, 1 mid, 1 B, 2 CT | Yes |

Nine of nine agree on the site, the timing, who went in, the lanes and the setups; the one nuance (round 1's "via
Mid") is the definition, explained in the row.

### What the detectors say on this demo

- **CT side (all of team B, e.g. B1):** `strat.setup.light`, fix, confidence 0.54, impact 2.4: "They hit A 4 times
  and B 4 times in your 9 CT rounds; 3 of the 8 hits went to a site your setup had at most 1 CT on at 15 s, and you
  lost 3 of those 3. In those 3 rounds you set up in Palace twice, in A site once." Evidence rounds 4, 8, 9 (the
  B hits against 1, 0 and 1 CT); the advice puts two on B. It reaches B1's top three in the CLI report. Plus
  `strat.opponent.habit` (observation): the Ts came through Mid in 5 of 9 rounds and the CTs contested it in each
  repeat after the second.
- **T side (all of team A, e.g. A4):** `strat.t_side.hits` (observation): "Your team hit a site in 8 of 9 T rounds
  (A 4 times, B 4 times; 4 fast (by 30 s), 3 mid-round, 1 late (after 60 s)): 4 hits without a smoke or flash
  before the entry, 4 won; 4 hits behind utility, 2 won. You entered first twice, went in second 3 times, came in
  behind once, were dead before the hit twice. The 5 where you were first or second in: 4 won." No fix: the dry hits
  all won, and 2 of 4 executes is under the strength bar. `strat.opponent.habit` (observation): the CTs left B light
  in 6 of 9 rounds; team A hit B in 3 of those (3 won) and went A in the other 3 (2 won).
- **No `strat.lane` on this demo, by the numbers:** team B contested lanes well. Ramp was taken in 4 rounds and
  contested in all 4; Palace taken in 6, open once (round 9); Mid taken in 8, open once (round 8); Short taken in 5,
  open once (round 8); Underpass taken in 5, open twice (rounds 1 and 9); Apartments taken in 8, open twice (rounds 4
  and 8, both lost to B plants). Every lane is under the bar of 3 open rounds and half the takes. **No `strat.rotate`**: the most any CT has is one early rotation (B2 in
  round 1, not punished: B fell 60 s later) and one stay (B1, B2, B3, B5 once each).

## Tests

`tests/coach/strategy.test.ts` (synthetic Mirage matches, `tests/coach/strategy-synth.ts`): the knowledge loader
and validator; an uncontested Palace taken in six rounds (tables and `strat.lane` with its wording, evidence and
boards); the same with a CT in Palace and with a CT smoke landing there (contested, no finding); an early punished
rotation and a stay after a plant; two halves with the sides swapped (halves, repeats per team and side, a dry-hit
`strat.t_side.dry` fix, `strat.opponent` for the other side); an unknown place name; the plant site from the place
and from the id table; no knowledge file. `tests/coach/strategy-fixture.test.ts`: on the committed fixture every
place name is classified, round 4 reads as the B rush through Apartments, and `analyze()` is deterministic for all
ten players.

## Known limits

- Place names are the game's; a lane is only as fine as its places (Mirage's `Middle` covers Top and Bottom Mid).
- Lanes are read from where the Ts walked, so a hit that reaches a site through no lane (round 1's walk from A through
  CT spawn to B) reports the last lane it crossed.
- Sight ignores smokes; the radar flag alone misses most sightings in GOTV demos.
- One demo, one half per team: thresholds are set so this demo's patterns read as the replay shows them; John's demos
  will move them (K11).
