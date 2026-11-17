# Demo coach contracts

The coach has three data contracts, all in `src/coach/model/`:

| File | Contract | Written by | Read by |
| --- | --- | --- | --- |
| `raw.ts` (+ `items.ts`, `raw-codec.ts`) | `RawDemo`: what a parser delivers | `tools/coach/parse-node.ts` (native), K1's browser parser | `src/coach/ingest` |
| `match.ts` | `Match`: the normalized match the analysis reads | `src/coach/ingest` | derive, metrics, detectors (K2 and later) |
| `report.ts` | `Finding`, `Annotation`, `MatchReport`: what the page renders | detectors and the prioritizer (K2, K5) | `src/coach-app` |

A change to `raw.ts` that a reader must know about bumps `RAW_FORMAT` (`coach-raw@1` now) and gets a line in the
changelog at the end of this file.

## `RawDemo` (`coach-raw@1`)

### Conventions

- **Units** are the demo's: Source units, degrees, units/second, seconds. Ticks are demo ticks (64/s).
- **Slots.** `players[p]` is player slot `p`. Every event field that names a player holds a slot, never a name or a
  Steam ID; `-1` is nobody, the world, or someone who is not in `players` (a spectator, GOTV, a coach).
- **Players** are those who played: team 2 or 3 with a pawn at some tick of the live range. Sorted by the team they had
  on their first present tick (T first), then by Steam ID, so slots are stable for a given demo.
  Bots get the Steam ID `BOT-<name>` and `bot: true`.
- **Item names** are canonical class names without `weapon_` (`ak47`, `m4a1` = M4A4, `m4a1_silencer`, `usp_silencer`,
  `hkp2000`, `knife` for every knife, `hegrenade`, `flashbang`, `smokegrenade`, `molotov`, `incgrenade`, `decoy`,
  `c4`, `vest`, `vesthelm`, `defuser`, `inferno` and `world` as damage sources). The demo spells items three ways
  (class names in events, display names such as `AK-47` in tick fields, definition indexes in `fire_bullets`);
  `items.ts` (`canonicalItem`, `itemFromDefIndex`) maps all three and both parsers must use it.
- **Order.** Event lists are sorted by tick, ties in the order the demo emitted them.
- **Name tables** (`names.weapons`, `names.places`) start with `''` and are otherwise sorted, so both parsers produce
  the same ids.

### The tick grid

`ticks` is dense: `T = ticks.count` sampled ticks × `P = players.length` slots, row `i = t * P + p`, one typed array per
column. Row `t` is demo tick `ticks.tick[t]`; the demo skips a tick now and then (10 gaps in the test demo), so never
assume `tick[0] + t`. Use `rowAtOrAfter(ticks, tick)` to find a row.

`T` spans `liveRange(events.rounds, …)`: from the start of the first live round (the last `begin_new_match`; failing
that the first `round_start` outside warmup; failing that the demo's first tick) to the last `round_end`. Freeze time
is included, warmup is not. Columns, with the demo field they come from:

| Column | Type | From | Notes |
| --- | --- | --- | --- |
| `tick` [T] | Int32 | tick | strictly increasing |
| `game` [T] | Uint8 | `GAME_FLAG`: warmup, freeze, bombPlanted, matchStarted | from `is_warmup_period`, `is_freeze_period`, `is_bomb_planted`, `is_match_started` |
| `roundsPlayed` [T] | Uint8 | `total_rounds_played` | |
| `scoreT`, `scoreCT` [T] | Uint8 | `team_rounds_total` of a T / CT row | 255 when no player of that side is present |
| `present` | Uint8 | team 2/3 and a pawn | 0 = everything else in the row is zero / NaN |
| `x y z` | Float32 | `X Y Z` | feet |
| `pitch yaw` | Float32 | `pitch yaw` | |
| `vx vy vz` | Float32 | `velocity_X/Y/Z` | NaN where null (a few ticks) |
| `health armor` | Uint8 | `health`, `armor_value` | |
| `duck` | Uint8 | `duck_amount` × 255 | `ducking`/`ducked` are empty in GOTV demos |
| `weapon` | Uint8 | `active_weapon_name` | index into `names.weapons`, 0 = none |
| `clip` | Uint8 | `active_weapon_ammo` | 255 = none |
| `team` | Uint8 | `team_num` | 2 T, 3 CT, 0 none |
| `place` | Uint8 | `last_place_name` | index into `names.places`, 0 = unknown |
| `flags` | Uint16 | `FLAG` bits | alive, scoped, walking, airborne, defusing, reloading, helmet, kit, inBombZone, inBuyZone, spotted, connected, controllingBot |
| `buttons` | Uint32 | `buttons` (decimal string of a 64-bit mask) | low 32 bits; `BUTTON`: fire 0, jump 1, duck 2, forward 3, back 4, use 5, left 9, right 10, attack2 11, reload 13, walk 16 |
| `spottedBy` | Uint16 | `approximate_spotted_by` (Steam IDs) | bit q = slot q |
| `flash` | Float32 | `flash_duration` | seconds |
| `penalty` | Float32 | `accuracy_penalty` | |
| `punchPitch punchYaw` | Float32 | `aim_punch_angle[0], [1]` | degrees |
| `recoilIndex` | Float32 | `fl_recoil_idx` | |
| `shotsFired` | Uint16 | `shots_fired` | |
| `money` | Uint16 | `balance` | |
| `equip` | Uint16 | `current_equip_value` | |

A player who leaves keeps his slot; his rows after he left have `present = 0` (the demo reports his team as null and
`is_connected` = 8). Mouse input (`usercmd_*`) is empty in GOTV demos and is not carried.

### Events

`events` holds **every** event of the demo, warmup and post-match included (the `rank_update`s come after the last
round end), each with `tick` and slots. Ingest decides what belongs to which round. Lists and record types:

| List | Type | Source event(s) | Fields |
| --- | --- | --- | --- |
| `rounds` | `RawRoundEvent` | begin_new_match, round_announce_match_start, cs_pre_restart, round_start, round_freeze_end, round_end, round_officially_ended, cs_win_panel_match, buytime_ended | kind, roundsPlayed, warmup, winner, reason, message |
| `shots` | `RawShot` | weapon_fire | p, weapon, silenced |
| `bullets` | `RawBullet` | fire_bullets | p, defIndex, weapon, origin x/y/z, pitch, yaw, inaccuracy, spread, recoilIndex, seed, mode, clip |
| `hurts` | `RawHurt` | player_hurt | victim, attacker, weapon, hitgroup, dmgHealth, dmgArmor, health, armor |
| `kills` | `RawKill` | player_death | victim, attacker, assister, weapon, headshot, penetrated, thruSmoke, attackerBlind, noScope, assistedFlash, distance, hitgroup |
| `blinds` | `RawBlind` | player_blind | victim, attacker, duration, entity |
| `detonations` | `RawDetonation` | hegrenade_detonate, flashbang_detonate, smokegrenade_detonate/expired, inferno_startburn/expire, decoy_started/detonate | kind, p, entity, x, y, z |
| `bomb` | `RawBombEvent` | bomb_beginplant, bomb_abortplant, bomb_planted, bomb_begindefuse, bomb_abortdefuse, bomb_defused, bomb_exploded, bomb_dropped, bomb_pickup | kind, p, site, hasKit |
| `footsteps`, `jumps`, `reloads`, `zooms` | `RawPlayerTick` | player_footstep, player_jump, weapon_reload, weapon_zoom | p |
| `pickups` | `RawPickup` | item_pickup | p, item, defIndex, silent |
| `equips` | `RawEquip` | item_equip | p, item, defIndex |
| `purchases` | `RawPurchase` | item_purchase | p, item, cost, sold |
| `ranks` | `RawRank` | rank_update | p, rankOld, rankNew, rankChange, numWins, rankType (11 = Premier) |
| `presence` | `RawPresenceEvent` | player_spawn, player_disconnect | p, kind, reason |

`projectiles` (from the grenade entities): type, thrower slot, entity id, first and last tick, and the path as Int16
x, y, z every 4 ticks (`PATH_STEP`), `PATH_NONE` (-32768) for a missing sample. `inventories`: each present player's
items at every freeze end and round end, and the victim's at the tick before each death (canonical names, sorted).
`scoreboard`: the demo's own totals per slot (kills, deaths, assists, damage, headshot kills, enemies flashed,
utility damage, MVPs, score) read at the last round's end, for reconciliation.

### Binary container (`raw-codec.ts`)

`encodeRawDemo(raw) → Uint8Array` and `decodeRawDemo(bytes) → RawDemo`. Layout: the magic `CRAW`, a Uint32 version (1),
a Uint32 header length, the JSON header (everything except the typed arrays, with each array replaced by
`{ "$buf": index }`), zero padding to 8 bytes, then the buffers back to back, each padded to 8 bytes. The JSON
records each buffer's type, offset and length. Used for `local/coach-cache/`, fixtures (gzipped) and worker transfer.

### Sizes on the test demo

56,625 rows × 10 players: 40.4 MB of typed arrays in memory (~71 bytes per player-tick), 41.3 MB as a `.craw` file,
6.1 MB gzipped. Native parse: 10.6 s, peak RSS 533 MB for the `.dem` (about 20–28 s and 650 MB for `.gz`, `.zst`,
`.bz2`, which are decompressed in memory first).

## `Match` (`coach-match@1`, `match.ts`)

Built by `ingestMatch(raw)` (`src/coach/ingest/ingest.ts`). It holds facts, not per-tick data:

- `meta`: map, source, server, patch, tick rate, demo hash, `score` by team (from round ends), `gameScore` (the
  game's `team_rounds_total` on the last row, to cross-check), `winner`, `surrendered`, `startedMidMatch`,
  `regulationRounds`, and `notes` (anything unusual ingest saw: dropped restarts, knife rounds, players who left).
- `players`: slot, name, bot, `team` (`A` | `B`) and the round numbers the player was present in. **Team `A` is the
  team on the T side in the first round of the demo**; teams stay with their players across the half-time swap and
  overtime swaps. A late arrival (a bot that takes over, a reconnect under a new slot) joins the team of the side it
  appears on.
- `rounds[]`: `number` (the game's: `total_rounds_played` at the start + 1), `played`, `kind` (`regulation`,
  `overtime` above `regulationRounds`, `knife`), `startTick`, `freezeEndTick`, `endTick`, `officialEndTick`, the row
  range `[rowStart, rowEnd)` into `RawDemo.ticks`, `refRow` (freeze end, or the end when there is none: sides,
  rosters and economy are read there), `sides` (`{ T: team, CT: team }`), `winnerSide`, `winner`, `reason` and
  `reasonName`, `scoreAfter`, `bomb` (plant tick, site entity, planter, defuse tick, defuser, explode tick), `economy`
  per team (equipment value at freeze end, money at the start, players, buy type), `roster` per team.

Round rules (`src/coach/ingest/rounds.ts`, each pinned by `tests/coach/rounds.test.ts`):

| Case | Rule |
| --- | --- |
| Warmup | Everything before the live start (`liveRange`) is ignored, and so are events flagged warmup. |
| Knife round / restart before the match | `begin_new_match` fires again when the real match starts; the last one is the live start. A knife round after it (every player holding only a knife at freeze end) is kept as `kind: 'knife'`, not played, not scored. |
| Restart mid-round | A `round_start` while the round has a freeze end but no end drops that round (noted). |
| Surrender | A round that ends with no freeze end is kept with `played: false`; its result counts (the test demo's round 10, CT surrender during freeze time, so the score is 8–2 over 9 played rounds). |
| Cut-off demo | A last round with no end is kept, not played, no winner. |
| Overtime | Numbers continue past `regulationRounds` (24) and are `kind: 'overtime'`; sides come from the players' team per round, so swaps need no rule. |
| Mid-match demo | No `begin_new_match`: numbering from `total_rounds_played`, score carried in from `team_rounds_total` on the first row. |
| Disconnect / bot | The leaver keeps his slot and drops out of later rosters (noted); a bot gets its own slot (`BOT-<name>`) and the team of its side. |

Buy types (tuning `economy`): pistol for rounds 1 and 13 (regulation only); otherwise equipment value per present
player at freeze end below 1,500 is `eco`, from 3,900 `full`, in between `force`.

Accessors (`src/coach/ingest/access.ts`): `roundRows(raw, round, live?)`, `roundAtTick(match, tick)`,
`isAlive(raw, row, slot)`, `aliveTimeline(raw, match, round)` (per-row alive counts per team), `playedRounds(match)`.

## Report types (`coach-report@1`, `report.ts`)

Types only; detectors (K2+) and the prioritizer (K5) fill them. `Finding` is the plan's Contract 2 field for field.
`Annotation` is a union on `kind`: `line` (from, to), `circle` (center, radius), `cone` (apex, yaw, half-angle,
length), `path` (points, optional per-point ticks), `zone` (x/y polygon), `label` (at, text); each has
`tick0`/`tick1` and a colour `role` (`user`, `teammate`, `enemy`, `ct`, `t`, `accent`, `good`, `bad`, `neutral`)
the viewer maps to the theme. `Evidence`, `MetricValue` (value, unit, n, lobby rank, the lobby's values by slot,
optional history), `RoundSummary`, `ReplayTrack` (positions at `hz` as Int16) and `MatchReport` (match facts, user
slot, metrics, findings, top fixes, strengths, rounds, replay tracks, coach version).

## Reconciliation (`src/coach/ingest/validate.ts`)

`reconcile(raw, match)` recomputes each player's scoreboard from the events between the live start and the
scoreboard tick (the last round's end) and compares it with the demo's totals. On the test demo **kills, deaths,
assists, damage, headshot kills and utility damage match exactly for all ten players.** The rules that make it match:

- Read the demo totals at the last round's end, not at the demo's last tick: after the match every player's
  `deaths_total` goes up by one and `score` drops (the server kills everyone when the match ends).
- Damage is the victim's health before the hit minus after it (`player_hurt.health`), team damage excluded.
  `dmg_health` is not usable: uncapped it overcounts (a 100+ headshot on a 30-HP player), capped at the remaining
  health it still undercounts by 2–24 per player, because it is sometimes a point below the health actually removed.
- Kills: +1 per enemy, −1 per teammate; assists only on enemies (flash assists included).
- Utility damage: the same health rule for `hegrenade` and `inferno` (molotov and incendiary).

**Enemies flashed is approximate** and not part of `ok`: we count `player_blind` on a living enemy longer than
1.1 s (tuning `validate.blindMinSec`, Leetify's floor). The game's counter follows a rule the events do not expose:
no duration threshold reproduces it (per player the fitting threshold ranges from below 0.3 s to above 3.6 s; one
flash that blinded four enemies for 0.8–3.8 s counts 2). On the test demo 3 of 10 players differ, each by one.

## What the test demo showed that differs from the plan

| Plan ("What a demo gives us") | Seen in the test demo |
| --- | --- |
| "no purchase event" | `item_purchase` is there (509 records: item, cost, sold-back); kept as `events.purchases` |
| footsteps are an event | `player_footstep` has exactly 512 records for the whole match, and `item_pickup` also exactly 512: they look capped, so neither is a complete record (matters for `move.noise`) |
| 57,970 ticks | the ticks are not contiguous (10 gaps); rows carry their tick |
| `player_hurt` damage | `dmg_health` is not the health removed (see Reconciliation) |
| grenade positions per tick | `parseGrenades` by default also returns every held grenade and weapon (517k rows, 1.5 GB RSS); `grenades=false` gives the 87k projectile rows. Entity ids are reused, so a gap of more than 16 ticks starts a new projectile |
| `fire_bullets` | `player_inair` and `player_scoped` are always null; use the tick grid's `airborne` / `scoped` flags |
| round flow | the first `round_start` (tick 65) is still warmup; `begin_new_match` (67) starts round 1. The last round ends by surrender in freeze time with no `round_freeze_end` and no `round_officially_ended` |
| velocity and shot state per tick | the velocity column lags positions by one tick (use row t + 1 for the speed behind an action at row t); a bullet's tick row already holds the post-shot penalty, recoil index and punch, and `fire_bullets` angles = view(row before) + 2 × punch (docs/coach/mechanics.md) |
| a player who leaves | his rows keep coming with team null and `is_connected` = 8 |

## Changelog

- `coach-raw@1` (K0, 2026-11-16): first version. Name tables are sorted (`''` first) so they do not depend on the order
  the parser met the names.
