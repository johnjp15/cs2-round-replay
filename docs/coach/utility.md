# Coach: utility, trades, deaths, economy (K4)

K4 fills the `utility`, `positioning` and `economy` areas of the analysis framework (docs/coach-plan.md, Contract 3):
six derived tables, 19 metrics computed for all ten players, and nine detectors. Tunables live in
`data/coach/tuning/utility.json`, `positioning.json` and `economy.json`, each with a typed loader in its
`src/coach/derive/<area>/tuning.ts`. Players are labelled by team and slot (A1…A5, B1…B5; team A starts T); no real
names appear here.

## Tables

| Table | File | One row per |
| --- | --- | --- |
| `utility.place_index` | `derive/utility/places.ts` | (index) place name of any world point: the nearest player sample within 400 units |
| `utility.throws` | `derive/utility/throws.ts` | grenade thrown in a played round |
| `positioning.trades` | `derive/positioning/trades.ts` | kill in a played round (`isTrade`, `traded`, `tradedBy`) |
| `positioning.deaths` | `derive/positioning/deaths.ts` | death, with its context |
| `positioning.opening` | `derive/positioning/opening.ts` | played round: its first kill between enemies |
| `economy.buys` | `derive/economy/buys.ts` | player and played round |

Damage everywhere comes from K2's `core.hurts` (health before minus after, never `dmg_health`).

### `utility.throws`

- **Join.** A projectile is joined to a detonation of its kind by the same thrower whose tick lies in
  [first sample, last sample + 32 ticks] and that lies within 200 units of a path sample. Among candidates, the one with
  the projectile's entity id wins, then the nearest, then the earliest; each detonation is used once. Entity ids are
  reused (in the test demo id 68 is a flash in round 4 and an HE in round 8, id 146 an HE in round 1 and a molotov
  in round 7), so the id alone never decides. Fires (`inferno_startburn`) carry the inferno's
  entity, never the projectile's, so they join on thrower, time and place. HE and smoke projectiles keep sampling after
  the detonation (HE 319 ticks, smoke until it expires), which the window allows. A detonation no projectile claims
  becomes a throw without a path. Expiries (`smoke_end`, `fire_end`) join their start by entity and time.
- **Flash.** Every `player_blind` of the flash's entity on the detonation tick (±2), labelled enemy / team / self,
  with the victim's alive state (dead players and spectators get blinds too: never counted). A blind *counts* at
  ≥ 1.1 s on a living player. A counted enemy "led to a kill" when the thrower's team killed him within
  min(duration, 3 s). A counted teammate (or the thrower) gets `fightTick`: the first tick he took enemy damage or died
  in that window.
- **HE / fire.** `hegrenade` hurts by the thrower within 4 ticks of the detonation; `inferno` hurts by the thrower
  from the startburn to the expiry + 16 ticks, the nearer fire when two burn. `fireEnemySec`: seconds with a living
  enemy within 160 units (horizontal) and 96 (vertical) of the startburn point; `fireNearSec`: within 500.
- **Smoke.** Landing position and place, lifetime from the expiry (22.0 s in the test demo).

### `positioning.trades`, `deaths`, `opening`

- A kill trades a teammate's death when its victim is that teammate's killer and it comes within 5 s. A killer dies
  once a round, so each death is traded at most once; one kill can trade two deaths.
- Death context, victim's state on the last row before the death tick: active weapon, reloading, scoped, airborne,
  defusing (flag or `begin_defuse`), planting (`begin_plant` not yet ended), flash left (the tick column) and the
  thrower of the blind still running; grenades and their value from the `death` inventory; killer distance (3D units
  and the game's metres); every living teammate's horizontal distance, the nearest one, his damage to the killer and
  whether he killed him inside the window, whether he held a gun; with a sight mesh, whether he saw the killer at a
  row sampled every 8 ticks through the window (smokes ignored); alive counts, round clock, bomb state, first death,
  round won.
- Opening duel: the round's first enemy kill, with places, weapons, sides, clock, outcome, and each player's
  progress toward the enemy spawn (0 own spawn, 1 enemy spawn; spawns = the sides' mean positions at freeze end).

### `economy.buys`: purchases are not what `item_purchase` says

`item_purchase` in the test demo behaves like a replicated purchase list, not a purchase log: whenever a player's
list changes, the event re-sends entries (509 records; 354 inside buy windows, 123 after buy time in rounds, 24 in
warmup), and `was_sold` marks items replaced later (a vest upgraded to a helmet shows `sold` on the vest with the money
going *down*). So a record is a purchase only when the balance change on its tick pays for it: per tick, a subset of
that tick's records whose costs equal the fall is bought; a rise refunds a subset of what was bought so far (sold
back); no change means a re-send. 298 of the 354 in-window records survive. Checked on one player's round 3 record by
record: vest, helmet upgrade, M4A1-S, flash, smoke, re-send, helmet sold (+350), M4A1-S sold (+2,900), FAMAS, flash,
incendiary; the result matches his armor (no helmet) and inventory. moneyStart − spent = moneyLeft holds in 79 of 90
rows (the rest are drops for teammates and sales the subset rule cannot pin down). The raw record carries
`inventory_slot` and `user_balance`, which would make this exact; the contract (`RawPurchase`) does not keep them
(see "For the orchestrator").

Loadout after the buy = the freeze-end inventory plus items bought after the freeze end (inventories exist only at
freeze end, deaths and round ends); armor, helmet, kit and money from the tick grid at `buytime_ended` (or just before
an earlier death). Own buy class from the larger of the equipment value at freeze end and after the buy (late buys
count), with ingest's thresholds; pistol rounds are `pistol`.

## Reconciliation (test demo, all ten players)

| | A1 | A2 | A3 | A4 | A5 | B1 | B2 | B3 | B4 | B5 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| utility damage, ours (sum of `enemyDamage` over throws) | 122 | 61 | 0 | 121 | 85 | 64 | 7 | 60 | 0 | 52 |
| utility damage, demo scoreboard | 122 | 61 | 0 | 121 | 85 | 64 | 7 | 60 | 0 | 52 |
| enemies flashed ≥ 1.1 s, ours | 1 | 3 | 5 | 1 | 3 | 2 | 0 | 0 | 5 | 0 |
| enemies flashed, demo scoreboard | 2 | 4 | 5 | 2 | 3 | 2 | 0 | 0 | 5 | 0 |
| grenade damage to teammates | 0 | 0 | 32 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| flashes / HE / fires / smokes | 5/4/2/8 | 4/6/5/4 | 9/6/5/5 | 7/6/6/6 | 15/2/5/7 | 1/3/1/2 | 0/3/0/2 | 2/3/1/1 | 5/0/2/4 | 0/1/1/1 |

Utility damage matches **exactly** for every player, and every `hegrenade` / `inferno` hurt is assigned to a throw
(none left over). Enemies flashed differs for 3 players, by one each (ours lower), the same as ingest's
approximation (docs/coach/contracts.md: the game's rule is not exposed). All 150 live projectiles joined; 3 molotovs
never burst (no `inferno_startburn`). Both checks are pinned by `tests/coach/k4-fixture.test.ts` on the committed
fixture.

## Metrics: the lobby on the test demo (sight mesh loaded)

| metric | unit | better | A1 | A2 | A3 | A4 | A5 | B1 | B2 | B3 | B4 | B5 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `util.flash.enemies_per_flash` | count | higher | 0.2 | 0.75 | 0.56 | 0.14 | 0.2 | 2 | – | 0 | 1 | – |
| `util.flash.blind_median` (n ≥ 3) | ms | higher | – | 1842 | 3006 | – | 4901 | – | – | – | 2609 | – |
| `util.flash.team_per_flash` | count | lower | 0.4 | 0.25 | 0.11 | 0.29 | 0.2 | 0 | – | 0 | 0.6 | – |
| `util.flash.self_share` | % | lower | 20 | 25 | 0 | 0 | 7 | 0 | – | 0 | 60 | – |
| `util.flash.kill_share` | % | higher | 0 | 0 | 0 | 0 | 0 | 100 | – | 0 | 0 | – |
| `util.unused.grenades_per_round` | per round | lower | 0.56 | 0 | 0.67 | 0.22 | 0.33 | 0.56 | 0.78 | 0.78 | 0.33 | 0.11 |
| `util.unused.value_per_round` | $ / round | lower | 122 | 0 | 200 | 67 | 89 | 178 | 189 | 211 | 67 | 22 |
| `util.buy.no_util_share` | % | lower | 0 | 17 | 0 | 0 | 0 | 0 | 25 | 20 | 0 | 0 |
| `util.damage.per_grenade` | count | higher | 24.4 | 6.1 | 0 | 11 | 12.1 | 16 | 2.3 | 15 | 0 | 26 |
| `util.damage.wasted_fire_share` | % | lower | 0 | 25 | 60 | 20 | 20 | 0 | – | 0 | 50 | 0 |
| `pos.untradeable.share` | % | lower | 40 | 14 | 0 | 75 | 50 | 80 | 67 | 57 | 88 | 44 |
| `pos.untradeable.nearest_median` | units | lower | 588 | 340 | 461 | 942 | 832 | 965 | 1266 | 1624 | 1539 | 649 |
| `trade.missed.miss_share` | % | lower | 50 | 33 | 100 | 0 | 80 | – | 33 | 0 | – | 0 |
| `trade.missed.success_share` | % | higher | 0 | 67 | 0 | 100 | 20 | – | 67 | 50 | – | 100 |
| `pos.opening.duels` | count | higher | 2 | 1 | 0 | 5 | 1 | 2 | 2 | 0 | 2 | 3 |
| `pos.opening.win_rate` | % | higher | 100 | 0 | – | 100 | 100 | 0 | 0 | – | 50 | 0 |
| `pos.opening.ct_push_deaths` | count | lower | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `eco.sync.off_share` | % | lower | 0 | 25 | 0 | 0 | 0 | 0 | 25 | 13 | 25 | 13 |
| `eco.kit_armor.miss_share` | % | lower | 0 | 17 | 0 | 0 | 0 | 20 | 60 | 20 | 0 | 0 |

`–` = undefined for that player (no flash thrown, no trade chance, no opening duel). Units follow K2's list, so the
blind time is in ms and the per-round grenade value is dollars per round.

### Trade distance: why 900 units

Nearest living teammate at the 55 deaths where one was alive (the victim not the last of his team):

| distance (units) | 0–300 | 300–600 | 600–900 | 900–1,200 | 1,200–1,500 | 1,500–2,000 | 2,000+ |
|---|---:|---:|---:|---:|---:|---:|---:|
| deaths | 9 | 8 | 8 | 11 | 5 | 8 | 6 |

Percentiles: p10 190, p25 485, median 921, p75 1,575, p90 2,095, max 2,956. The 9 actual trades came from 101, 136,
441, 517, 551, 649, 822, 881 and 1,017 units, 1.8–4.3 s after the death. `trades.tradeDistance` = 900 covers 8 of
those 9 and sits at the lobby median, so "no teammate within 900" marks the less-supported half of deaths. With the
sight mesh, 25 of 62 deaths had a teammate who saw the killer inside the window.

## Detectors and thresholds

| Detector | Findings | Fires when (tuning) |
| --- | --- | --- |
| `util.flash` | `.no_enemy` fix · `.team` fix · `.strength` | ≥ 4 flashes and ≥ 60 % blind no enemy ≥ 1.1 s · ≥ 2 teammates/self blinded ≥ 1.1 s who took enemy damage or died inside min(duration, 3 s) · ≥ 4 flashes, ≥ 1.2 enemies per flash and a lobby strength |
| `util.unused` | `.death` fix | ≥ 2 deaths with ≥ 2 grenades left in rounds the team lost |
| `util.buy` | `.no_util` fix | ≥ 2 rifle/sniper rounds with no grenade bought or carried and ≥ $200 left |
| `util.damage` | `.wasted_fire` fix · `.strength` | ≥ 2 fires and ≥ 50 % of them with no enemy damage, inside or within 500 units · ≥ 4 HE/fire, ≥ 20 damage each and a lobby strength |
| `pos.untradeable` | `.isolated` fix | ≥ 3 untraded deaths with no teammate within 900 and ≥ 50 % of deaths (last-alive rounds excluded) |
| `trade.missed` | `.no_damage` fix · `.strength` | ≥ 2 misses and ≥ 50 % of chances; a chance = teammate died to an enemy within 900 units of the player, who was alive with a gun in hand on some row of the window (with the mesh: and saw the killer); attempt = damage to the killer; success = killed him; traded by someone else = not a miss · ≥ 2 trades and a lobby strength |
| `pos.opening` | `.losing` fix · `.ct_push` fix · `.strength` | ≥ 4 duels, win rate ≤ 35 % · ≥ 2 first deaths as CT in the first 30 s past halfway to the T spawn · ≥ 4 duels, ≥ 65 % and a lobby strength |
| `eco.sync` | `.off` fix | ≥ 2 non-pistol rounds where he bought (force/full) with ≥ 3 teammates on eco, or saved with ≥ 3 buying |
| `eco.kit_armor` | `.holes` fix | ≥ 2 non-pistol gun rounds with: CT and no kit with ≥ $400 left; a rifle and 0 armor; a full buy with > $1,000 left and ≤ 2 grenades |

The minimum counts keep a finding from resting on one moment; the shares are set so a finding names something the
player does more often than not, which on this demo separates players clearly (for example 80 % vs. 14–57 % for
flashes, 75–88 % vs. 0–57 % for isolated deaths).

**Confidence** = precision × K2's sample factor `1 − exp(−n / nScale)` with n = the finding's opportunities; precision
is a constant until K11 measures it (utility 0.85, positioning 0.8, economy 0.85; nScale 6, 5, 4). **Impact** follows
K2's scale (fights decided against the player, per 24 rounds, `perMatch`), with an assumed fights-per-instance weight:
flash that blinds nobody 0.15, teammate flashed into a fight 0.5, death with grenades left in a lost round 0.33, rifle
round without utility 0.25, wasted fire 0.25, isolated untraded death 0.5, missed trade 1, opening duel lost beyond an
even split 1, CT push death 1, buy out of sync 0.5, loadout hole 0.33. These are judgement calls; K5 recalibrated
them (docs/coach/report.md, "Prioritizer"). Strengths carry impact 0.

Evidence is always `replay`, two or three moments picked with K2's `pickClearest` (one per round where possible):
flashes draw the throw line, the burst and a label per blinded player ("A4 3.3 s"); deaths draw the 900-unit trade
ring around the victim, the killer's line and a dashed line to the nearest teammate; missed trades draw the ring
around the dead teammate, the kill line, a label at the player ("you: 783 units, no damage in 5 s") and "in your
sight" at the first tick he saw the killer; fires draw the 160- and 500-unit rings; buys label the player (and his
teammates' classes for `eco.sync`) at the freeze end.

## Findings on the test demo (with the sight mesh)

`npm run coach -- report <cache> --user <label>`. K4 findings for every player:

| Player | K4 findings |
| --- | --- |
| A1 | `util.flash.no_enemy` (4 of 5), `util.damage.strength` (24 per grenade, 2nd) |
| A2 | `eco.sync.off` (saved twice while 3+ bought) |
| A3 | `util.damage.wasted_fire` (3 of 5), `trade.missed.no_damage` (2 of 2) |
| A4 | `util.flash.no_enemy` (6 of 7), `pos.untradeable.isolated` (3 of 4), `pos.opening.strength` (5 of 5) |
| A5 | `util.flash.no_enemy` (12 of 15), `trade.missed.no_damage` (4 of 5) |
| B1 | `pos.untradeable.isolated` (4 of 5) |
| B2 | `util.unused.death`, `pos.untradeable.isolated`, `eco.sync.off`, `eco.kit_armor.holes` |
| B3 | `util.unused.death`, `pos.untradeable.isolated` |
| B4 | `pos.untradeable.isolated` (7 of 8), `eco.sync.off` |
| B5 | `pos.untradeable.isolated` (4 of 9) |

**A5** (the report's top fixes):
1. *Throw flashes that blind someone* — 12 of your 15 flashes (80 %) blinded no enemy for 1.1 s or more (3 of them
   blinded a teammate instead); you blind 0.20 enemies per flash (5th of 8). Moments: rounds 5, 6, 7.
2. *Trade your teammates* — 4 times a teammate died within 900 units of you, his killer came into your sight, and you
   did no damage to his killer within 5 s: 5 chances, 1 attempt, 1 trade (7th of 8). Moments: rounds 1, 5, 6.

**B2**:
1. *Play where a teammate can trade you* — 4 of your 6 deaths (67 %) came with no teammate within 900 units and went
   untraded; your team lost 4 of those 4 rounds; nearest teammate 1,266 units on median (8th of 10).
2. *Buy with your team* — in 2 of 8 rounds your buy went against 3 or more teammates: 2 times you bought while they
   saved (8th of 10).
3. *Complete your loadout* — 3 of 5 gun rounds: 2 as CT without a kit you could afford, 2 full buys with over $1,000
   left and 2 or fewer grenades (10th of 10).
4. *Use your grenades before you die* — died 2 times with 2+ grenades in lost rounds ($1,000 unused).

### Spot checks (every instance behind the A5 and B2 findings, against the raw events)

| Finding | Moment | Raw events |
| --- | --- | --- |
| A5 `util.flash.no_enemy` | r5 tick 28644 | `flashbang_detonate` by A5, entity 491; blinds on that entity and tick: A4 3.33 s, A2 1.07 s, A5 0.61 s — no enemy ✔ |
| | r6 tick 33749 | entity 393: A1 3.88 s, A2 0.81 s, A5 0.63 s — no enemy ✔ |
| | r7 tick 41120 | entity 111: A1 0.79 s, A2 3.24 s, A5 4.18 s — no enemy ✔ |
| A5 `trade.missed` | r1 tick 4876 | B4 kills A4 (P2000); A5 alive 783 units away; A5 fired 2 shots in the next 320 ticks, no `player_hurt` by A5 on B4; B4 survived the round ✔ |
| | r5 tick 29827 | B3 kills A2; A5 69 units away, 2 shots, no hurt on B3; B3 died at 30362 (8.3 s later, outside the window) ✔ |
| | r6 tick 36522 | B3 kills A2; A5 836 units away, no shots, no hurt; B3 died at 36871 (5.5 s) ✔ |
| B2 `util.unused.death` | r8 tick 49410, r9 tick 54599 | `death` inventory at the death tick: deagle, flashbang, knife, smokegrenade both times ($500); both rounds won by team A ✔ |
| B2 `pos.untradeable` | r1 tick 4518 | killed by A2; living teammates B3 1,672 and B4 2,047 units away; A2 not killed within 5 s ✔ |
| | r6 tick 34525 | killed by A1; B1 2,273, B3 1,641, B4 1,394; not traded ✔ |
| | r8 tick 49410 | killed by A2; only B1 alive, 1,590 away; not traded ✔ |
| B2 `eco.sync` | r4, r8 | r4 purchases MP9 1,250 + vest 650 (equipment after buy 2,100); teammates' equipment after buy 200, 700, 1,350, 200 (all eco) ✔ · r8 helmet, Deagle, smoke, flash (2,200); teammates 500, 1,000, 700, 500 ✔ |
| B2 `eco.kit_armor` | r4, r5, r6 | r4 CT, kit flag 0 after buy time with $3,900 left ✔ · r5 no kit, no grenades, $1,900 left ✔ · r6 full buy, 2 grenades, $1,850 left ✔ |

The other findings' instances are covered by the synthetic tests (`tests/coach/k4-detectors.test.ts` builds each
pattern and its near-miss) and by the fixture test, which runs every K4 detector for three players and checks each
evidence moment lies in its round.

## Tests

- `tests/coach/k4-tables.test.ts`: joins with a reused entity id and a fire with its own entity, blind labelling
  (enemy, team, self, too short, dead), the kill and teammate fight inside the window, HE damage from health deltas
  (not `dmg_health`), fire damage and exposure, smoke lifetime, the match radius; trades (one kill trading two deaths,
  a kill outside the window); the death context (state, flash and thrower, grenade value, distances, alive counts,
  clock, bomb, planting); the opening duel; buys (re-sent records, a sale, a mid-round record, late grenades, pistol
  rounds, prices).
- `tests/coach/k4-detectors.test.ts`: each detector fires on a demo built for it and stays quiet on its near-miss.
- `tests/coach/k4-fixture.test.ts`: the committed fixture: utility damage exact, enemies flashed within one,
  round-4 trades, `analyze()` for three players, evidence inside rounds, byte-identical reports.

## For the orchestrator

- `RawPurchase` drops `inventory_slot` and `user_balance`; with them the purchase list could be rebuilt exactly instead
  of through the money column. A contract change for K0/K1 if wanted.
- `util.flash.kill_share` is 0 for nine of ten players on this demo (only B1's single flash led to a kill within
  min(duration, 3 s)); worth re-checking on John's demos before it feeds a finding.
- Fires: "touched" uses a disc around the startburn point (160 units); the real fire spreads unevenly, so
  `fireEnemySec` undercounts on slopes and stairs. The wasted-fire rule therefore also requires no enemy within 500.
