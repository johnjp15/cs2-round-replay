# P4: scripted damage and kill-feed attribution

## Goal

With engine bullet damage blocked between two REPLAY bots, applying the recorded damage reproduces donk's HP
100 → 73 → 39 → 13 → 0 on the recorded ticks. The kill feed and the `player_death` event must show attacker sp4rtan,
weapon AK-47, no headshot. Movement-doc item 4. This card also picks the damage route for the adapter.

Depends on: S0. Route 2 also needs a passing P2 route and P3 step 1.

## The schedule (from `data/round.json`)

| Round tick | t (s) | Event | donk HP after |
| --- | --- | --- | --- |
| 3194 | 49.9 | sp4rtan hits donk for 27 (ak47) | 73 |
| 3200 | 50.0 | hit for 34 | 39 |
| 3206 | 50.1 | hit for 26 | 13 |
| 3213 | 50.2 | shot, miss | 13 |
| 3219 | 50.3 | kill shot for 13 (lethal) | 0 |

The kill feed in the source says 50.35 (tick 3222). Lethal damage and death land on the same tick in the engine, so
the target is tick 3219 (contract finding F9). The probe runs on a local clock: probe tick 0 = round tick 3130, so
the hits land at probe ticks 64, 70, 76 and 89. Armor: donk has 100 armor with a helmet; the source gives no armor
loss for these hits, so schedule `armor = 0` unless a route can't avoid engine armor maths (then record the armor
actually lost).

## Setup

- `exec cs2probe`, `mp_restartgame 1`.
- `probe_spawn sp4rtan CT -1068 748 -80 <yaw toward donk> weapon_ak47` and
  `probe_spawn donk T -1592 793 -48 <yaw toward sp4rtan> weapon_awp`. These are their recorded positions at 49.9 s,
  about 526 units apart. Set donk to 100 HP, 100 armor, helmet.
- `probe_lock sp4rtan all`, `probe_lock donk all`.
- `probe_block sp4rtan donk on`, `probe_block donk sp4rtan on`.
- `probe_log on p4-<route>`. Log `player_hurt`, `player_death` (all fields), `Health`/`ArmorValue` per tick, and the
  scoreboard stats (`ActionTrackingServices.MatchStats` kills/deaths/damage), plus `InGameMoneyServices.Account`
  for both.
- A connected client watching the kill feed (screenshot), or GOTV `tv_record p4-<route>`.

## Routes

| Route | How the harness applies one scheduled hit |
| --- | --- |
| **1. Constructed `TakeDamage`** | Build a native `CTakeDamageInfo`: `Attacker` and `Inflictor` = sp4rtan's pawn handle, `Ability` = his AK, `Damage` = amount, `BitsDamageType` = bullet, `HitGroupId` = chest. Call `VirtualFunctions.CBaseEntity_TakeDamageOldFunc.Invoke(donkPawn, info, result)` while the block hook lets this one call through (an "applying" flag). CSS has no constructor, so: capture the byte size and layout of a real `CTakeDamageInfo` in `OnPlayerTakeDamagePre` during a test shot, allocate that size, zero it, and fill fields by schema offset. Record whether the hitgroup pointer chain (`CTakeDamageInfo_HitGroup`) needs filling for the headshot flag |
| **2. Bullet rewrite** | sp4rtan really aims at donk (P2 route) and taps `ATTACK` on the scheduled tick. `OnPlayerTakeDamagePre` lets the hit through only if a scheduled hit for (sp4rtan, donk) is due within ±2 ticks, and sets `info.Damage` so that the HP removed equals the amount. If armor gets in the way, zero `ArmorValue` just before and restore it after. Every other hit is blocked |
| **3. Set + event rewrite** | Non-lethal: set `Health` (and `ArmorValue`) with `SetStateChanged`, then fire a synthetic `player_hurt` (`new EventPlayerHurt(true)`: userid donk, attacker sp4rtan, weapon `ak47`, `dmg_health`, `dmg_armor`, `hitgroup` 2, `health`). Lethal: arm an `EventPlayerDeath` **Pre** hook for donk that sets `Attacker` = sp4rtan, `Weapon` = `ak47`, `Headshot` = false and returns `Changed`; then kill donk (`CommitSuicide(false, true)`). Afterwards fix the scoreboard: sp4rtan +1 kill and the kill reward; undo donk's suicide penalty |

## Steps

1. **Leak test:** unlock both bots for 10 s (or make sp4rtan spray at donk with P3's hold) while the block is on.
   Count engine damage events between the pair. Expect 0.
2. For each route that can be built (try 1, then 3, then 2): reset HP and positions, then run the schedule on
   probe ticks 64, 70, 76, 89. Repeat 3 times.
3. **Headshot variant:** lokier (CT, ssg08) at the Truck (−2387, 815, −127) → eradicate (T) at (−1129, 775, −80),
   lethal headshot. This is the recorded kill at 12.75 s. Expect `Headshot` = true and the headshot icon in the kill
   feed.
4. **Client view:** screenshot the kill feed and the scoreboard (Tab) after each lethal hit.

## Measurements

| Quantity | Unit |
| --- | --- |
| tick of each HP change (relative to the schedule) | ticks |
| HP after each hit | HP |
| armor lost per hit | armor points |
| `player_hurt` fields per hit (attacker, weapon, dmg_health, dmg_armor, hitgroup) | — |
| `player_death` tick and fields (attacker, weapon, headshot) | ticks, — |
| kill feed as the client shows it (who [icon] who, headshot icon) | — |
| scoreboard K/D, damage, money of sp4rtan and donk afterwards | — |
| leaked engine damage events while blocked (step 1) | count |

## Pass / fail

A route **PASSES** when, in 3 of 3 runs:

- HP is exactly 73, 39, 13, 0 on the scheduled ticks, ±0 ticks;
- `player_death` fires on the lethal tick with attacker sp4rtan, weapon `ak47`, headshot false;
- the client kill feed shows "sp4rtan [AK-47] donk";
- the headshot variant shows `Headshot` = true and the icon;
- the scoreboard shows sp4rtan +1 kill and donk +1 death;
- and the leak test shows 0 leaked events.

**PARTIAL**: HP and the event are right but the scoreboard or money needs a manual fix (normal for Route 3). Record
the fix needed.

**FAIL**: no route gets both the HP sequence and the kill-feed attacker right.

## Fallback

- **Route 1 crashes or ignores the struct:** drop it; it relies on undocumented layout.
- **Route 3's event rewrite doesn't change the client kill feed:** mark the real `player_death` `DontBroadcast` in
  the Pre hook (`EventInfo.DontBroadcast`) and fire a fully synthetic `player_death` instead.
- **The scoreboard can't be fixed:** accept it. Record it as a known difference in the adapter doc.
- **Route 2 misses** (aim or spread): it can't be the main route. Use it only where the human can see the shooter, and
  Route 3 elsewhere.

## Record

Fill in the P4 section of `results.md`, and name the chosen route for the adapter.
