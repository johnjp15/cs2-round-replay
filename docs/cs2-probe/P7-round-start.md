# P7: round start and bomb timings

## Goal

**Part A** (movement-doc item 7): after freeze time the HUD clock reads 1:39 (98.25 s left at t = 0), all ten
players stand on their clip-start spots with the right kit, HP and armor, the score reads 11–15, and the first
scripted kill (snarlbot → incredibad, AK-47, no headshot) lands at t = 0.50 s (tick 32).

**Part B:** the bomb ticks for 40 s, and plant and defuse (with and without a kit) take the right time with the right
events. This feeds `bomb.*`.

Depends on: P0 (spots), P1 (puppets hold position and move), P4 (the damage route). Part B also needs P2 (looking at
the bomb) and P3 (attack input).

## Round facts (from `data/round.json`)

| id | team | start (x, y, z) | HP / armor / helmet | kit at t = 0 (clip/reserve for the drawn weapon) |
| --- | --- | --- | --- | --- |
| barely | T | −473, 647, −82 | 100 / 100 / yes | ak47 30/90, he, smoke, **c4** |
| cart (human) | T | −391, 909, −84 | 100 / 100 / yes | ak47 30/90, smoke ×2 |
| donk | T | −177, 544, −73 | 100 / 100 / yes | awp 10/30, glock, flash, molotov |
| eradicate | T | −731, 567, −82, yaw 167.2 | 100 / 100 / yes | ak47 30/90 |
| incredibad | CT | 905, −1290, −109 | 100 / 100 / yes (assumed) | m4a4 30/90 (assumed) |
| lokier | CT | −2387, 815, −127 | 100 / 100 / yes | ssg08 10/90 |
| snakelore | CT | 133, −1710, −169 | 100 / 100 / yes (assumed) | m4a4 30/90 (assumed) |
| snarlbot | T | 800, −1120, −264 | **44** / 100 / yes | ak47 30/90, smoke, flash |
| sp4rtan | CT | −505, −1460, −81 | 100 / 100 / yes | deagle 7/35, **defuse kit** |
| zwomp | CT | −1180, −500, −168 | 100 / 100 / yes (assumed) | m4a4 30/90 (assumed) |

Only eradicate has a recorded start yaw. Give the others the heading of their first movement (from samples 0 → 1),
or 0 if they don't move.

## Setup

- `exec cs2probe`, then `mp_ignore_round_win_conditions 0`, `mp_freezetime 5`, `mp_roundtime_defuse 1.92`
  (115 s, the default), `mp_c4timer 40`, `mp_buytime 0`. Run Bot-Controller `SetBuySkip(slot)` for every bot.
- Nine bots with the ids above (`probe_spawn`). cart is a connected human, or a tenth bot if no client is available
  (then the HUD check uses the server number only).
- **Score:** set `CCSTeam.Score` for CT = 11 and T = 15 (`cs_team_manager` entities) with `SetStateChanged`.
- **During freeze time** (on `round_start`): strip and give each kit (`GiveNamedItem`: `weapon_ak47`, `weapon_awp`,
  `weapon_glock`, `weapon_ssg08`, `weapon_deagle`, `weapon_m4a1`, `weapon_hegrenade`, `weapon_smokegrenade`,
  `weapon_flashbang`, `weapon_molotov`, `weapon_c4`, `item_assaultsuit`; the kit via `HasDefuser` or
  `item_defuser`); set clip/reserve, HP and armor; select the drawn weapon (`SwitchBotWeapon`, recording
  `BotActiveWeaponDef`); teleport to the start spot; lock all bots.

## Clock routes

| Route | How |
| --- | --- |
| **A. Shift the start time** | On the first tick after freeze ends (`round_freeze_end`, or `FreezePeriod` turning false): `gameRules.RoundStartTime -= gameRules.RoundTime − 98.25` (16.75 with a 115 s round), then `Utilities.SetStateChanged(gameRulesProxy, "CCSGameRulesProxy", "m_pGameRules")` (this call is a guess; try `"CCSGameRules", "m_fRoundStartTime"` too). t = 0 is that tick |
| **B. No memory write** | Set `mp_roundtime_defuse` so that `gameRules.RoundTime` reads **99** (try 1.65, then 1.6501, then 1.651, since `RoundTime` is whole seconds), and release t = 0 exactly 48 ticks (0.75 s) after freeze end. Keep everyone still for those 48 ticks: bots stay locked, the human gets `MoveType` none (+ `SetStateChanged`) or is simply told not to move |
| **C. Write `RoundTime`** | As B, but write `RoundTime = 99` directly if the cvar can't produce 99 |

## Steps (Part A)

1. Clock route A: `mp_restartgame 1`; setup runs in freeze time; at freeze end apply the route and capture
   `releaseTick`.
2. From t = 0 the puppets run their REPLAY tracks (P1 follower). snarlbot's lethal scripted damage on incredibad
   (100 HP, chest, ak47, no headshot) goes through P4's chosen route at tick 32.
3. Log ticks 0–128 for all pawns (`probe_log on p7a-<route>-<run>`).
4. A client takes a screenshot at t = 0 (HUD clock, kill feed at 0.5 s, scoreboard). Also `tv_record`.
5. Repeat 5 times. If route A fails, run route B (then C) 5 times each.

## Steps (Part B, bomb)

1. **Engine plant:** `probe_spawn barely T -1982 311 -160 0 weapon_c4`, lock, select the C4 (`SwitchBotWeapon` with
   C4's defIndex), set the view pitch to +60 (P2), then hold `ATTACK` for up to 256 ticks until `bomb_planted`.
   Repeat holding `USE` instead. Record whether each plants.
2. **Timer:** at `bomb_planted`, read `C4Blow − Server.CurrentTime` and `TimerLength`. Let it run to
   `bomb_exploded` once.
3. **Spawned bomb:** the cs2-retakes recipe
   ([BombService.cs](https://github.com/B3none/cs2-retakes/blob/2fde4a9cc21e791d6909b98bacc833aa5c54bdad/RetakesPlugin/Services/BombService.cs))
   at (−1982, 311, −160). Right after `DispatchSpawn`, read `C4Blow − CurrentTime`. If it isn't about 40, set
   `C4Blow = CurrentTime + 40` (+ `SetStateChanged`) and check the explosion time.
4. **Defuse:** `probe_spawn sp4rtan CT <40 units from the bomb> <facing it>`, with the kit, the view on the bomb
   (P2), holding `USE`. Then the same without a kit. Then a kit defuse with `USE` released after 2 s (expect
   `bomb_abortdefuse`).
5. Log the events and `IsDefusing`, `BeingDefused`, `DefuseCountDown`, `DefuseLength`, plus `round_end`
   (winner, reason).

## Measurements

| Quantity | Unit | `tuning.json` key |
| --- | --- | --- |
| remaining at t = 0 = `RoundTime − (CurrentTime − RoundStartTime)` (server) and the HUD reading (client) | s, mm:ss | — |
| `RoundTime` after each `mp_roundtime_defuse` value (route B) | s | — |
| per-player distance from the start spot at t = 0 | units | — |
| per-player kit check: weapons (designer names), drawn weapon and defIndex, clip/reserve, HP, armor, helmet, kit | — | — |
| incredibad's `player_death` tick relative to t = 0, and its fields | ticks | — |
| score shown (CT–T) | — | — |
| `bomb_beginplant` → `bomb_planted` | s | `bomb.plantSec` |
| plant input that works (`ATTACK`, `USE`, both) | — | adapter button map |
| `C4Blow − CurrentTime` at plant (engine and spawned) and the actual explosion time | s | `bomb.timerSec` |
| `bomb_begindefuse` → `bomb_defused` with and without a kit; `DefuseLength` | s | `bomb.defuseKitSec`, `bomb.defuseSec` |
| `round_end` reason and winner after defuse and explosion | — | (mapping check) |

## Pass / fail

- **Part A PASS** (5 of 5 runs, for one clock route):
  - remaining = 98.25 s ± 0.016 (one tick) at t = 0, and the HUD reads 1:39;
  - all ten players within 8 units of their start spot;
  - all kits match the table;
  - incredibad's death on tick 32 ± 0, with attacker snarlbot, weapon ak47, headshot false;
  - the score reads 11–15.

  Record which clock route passed.
- **Part B PASS**:
  - an engine plant happens with at least one input;
  - timer 40.0 ± 0.05 s for the engine plant, and for the spawned bomb (after the manual `C4Blow` if needed);
  - kit defuse 5.0 ± 0.05 s and no-kit defuse 10.0 ± 0.05 s;
  - the abort fires `bomb_abortdefuse`;
  - `round_end` reasons map as in `cs2-adapter.md`.
- **FAIL**: no clock route reaches 98.25 ± 0.016, or the first kill lands off-tick, or no plant route works.

## Fallback

- **Clock:** route B or C. If no route works, start t = 0 at freeze end and accept that the HUD shows the default
  round time (1:55). The Core timeline is unaffected; record it as a known difference.
- **Kits overwritten by bots** (buy or auto-switch): repeat the give on t = 0, and use a Bot-Controller weapon lock
  (`Lock(slot, LockTarget.SlotN)`).
- **Positions off at t = 0:** teleport again on the release tick (all are locked, and the human is not watching a
  puppet yet).
- **Plant input fails:** use the spawned `planted_c4` with `C4Blow` set by hand, and remove barely's C4.
- **Defuse needs aim that P2 can't give:** at the defuse start, set `BeingDefused`, `BombDefuser`, `DefuseCountDown`
  and `IsDefusing` by hand. At the end, fire `bomb_defused` and `TerminateRound(5, BombDefused)`, and remove the
  bomb.

## Not checked

The HUD round label (`meta.hudRound` is "Round 12/30", while an 11–15 score means 26 rounds played) is not part of
this card.

## Record

Fill in the P7 section of `results.md` (Part A table per route, Part B table) and the tuning-change table.
