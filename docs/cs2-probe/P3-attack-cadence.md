# P3: one-tick `IN_ATTACK` and spray cadence

## Goal

A one-tick `IN_ATTACK` on a locked bot fires exactly one AK-47 round on that tick, and a 0.1 s cadence reproduces a
10-round spray. Movement-doc item 3. Also measures the weapon numbers in `tuning.json`.

Depends on: S0. P2 helps (aim at a surface), but without it the bot fires at its frozen spawn view, which is fine for
counting.

## Background

The AK fires every 0.1 s, which is 6.4 ticks at 64 tick. One-tick taps on `round(i·6.4)` are 6 or 7 ticks apart.
A tap 6 ticks after a shot comes 0.4 tick early, and is probably dropped rather than queued. If so, Core must hold
`ATTACK` for the whole spray (contract finding F7). Bot-Controller's `InjectUsercmd` duration is wall-clock ms, and
"a zero duration presses for one command"
([TECH.md](https://github.com/XBribo/CS2-Bot-Locker/blob/71319b0477ec688f8bdc2fe0633ef992a7cd700a/TECH.md)). The
harness therefore holds a button by pressing with duration 0 on every held tick.

## Setup

- `exec cs2probe`, `mp_restartgame 1`; `sv_infinite_ammo 0` (we count the clip).
- `probe_spawn gun CT -1675 300 -168 0 weapon_ak47`, `probe_lock gun all`. If P2 passed, `probe_aim gun 0 10 <route>`
  for the whole card.
- `probe_log on p3-<case>`, logging `weapon_fire`, `bullet_impact`, `weapon_reload`, and `Clip1` per tick.

## Steps

1. **Single taps:** `probe_press gun ATTACK 10 64 0` (10 one-command taps, 64 ticks apart).
2. **Rounded 0.1 s taps:** taps at relative ticks 0, 6, 13, 19, 26, 32, 38, 45, 51, 58 (`round(i·6.4)`), each one
   command. Refill the clip to 30 first.
3. **7-tick taps:** `probe_press gun ATTACK 10 7 0`.
4. **Held spray:** hold `ATTACK` for 58, 60 and 64 consecutive ticks (`probe_press gun ATTACK 1 1 <n>`), refilling
   between runs.
5. **Duration API:** a single `InjectUsercmd(slot, IN_ATTACK, 900)` (wall-clock 900 ms). Count the shots and the
   ticks covered.
6. **Weapon stats**, for `weapon_ak47`, `weapon_awp`, `weapon_ssg08`, `weapon_deagle`, `weapon_m4a1`:
   - `probe_vdata <weapon>`;
   - give the weapon, empty the clip (taps), then `probe_press gun RELOAD 1 1 0`, and log the ticks until `Clip1`
     equals `MaxClip1`;
   - for AWP and SSG 08, `probe_press gun ATTACK2 1 1 0` and log `IsScoped`.

## Measurements

| Quantity | Unit | `tuning.json` key |
| --- | --- | --- |
| shots per tap (from `weapon_fire` and `Clip1` drops), steps 1–3 | count | — |
| tap → `weapon_fire` latency | ticks | contract finding F8 |
| shots and their ticks in each held window, step 4 | count, ticks | — |
| mean ticks between shots under hold | ticks | `weapons.<w>.rpm` = 3840 / ticks (cross-check `60 / CycleTime`) |
| shots from the 900 ms duration press | count | — |
| VData `Damage`, `HeadshotMultiplier`, `ArmorRatio` | — | `weapons.<w>.damage`, `headshotMult`, `armorPen` (= `ArmorRatio / 2`, hypothesis) |
| VData `MaxClip1`, `PrimaryReserveAmmoMax`; reserve right after `give` | rounds | `weapons.<w>.clip`, `reserve` |
| RELOAD press → full clip | ticks → s | `weapons.<w>.reloadSec` |

## Pass / fail

- **PASS** needs all three:
  - step 1: 10 of 10 taps fire exactly one round each, with constant latency (0 or 1 tick);
  - step 4: a held window of 58–64 ticks fires exactly 10 rounds (allow ±1 round per 64 ticks only if the
    inter-shot mean is 6.4 ± 0.2 ticks);
  - each `weapon_fire` shows up as one `shot` event for the right bot.
- **Report, not pass/fail:** step 2's count. Fewer than 10 confirms finding F7, so Core must hold `ATTACK` through
  sprays.
- **FAIL**: a tap fires 0 or 2+ rounds, or `weapon_fire` doesn't fire for injected attacks.

## Fallback

- **Taps fire 0 rounds under the All lock:** check the injection token (−1 means no hook) and whether the bot's
  weapon is deployed. Draw time after `give` is `DeployDuration` in VData, so wait it out.
- **Taps fire 2 rounds:** the tap is held for two commands. Check the harness, and use `SuppressUsercmd` for one tick
  after the press.
- **Held cadence wrong:** let Core schedule each shot as a tap on ⌈6.4·i⌉ ticks, and accept the 0.109 s spacing in
  REPLAY.

## Record

Fill in the P3 section of `results.md` and the tuning-change table (per-weapon rows).
