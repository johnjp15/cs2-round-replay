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

## Changelog

- `coach-raw@1` (K0, 2026-11-16): first version.
