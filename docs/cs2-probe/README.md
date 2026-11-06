# CS2 probe

Task F2. Each card in this folder is one experiment on a real CS2 dedicated server. Together they settle the
`unknown — probe` rows in [`docs/cs2-adapter.md`](../cs2-adapter.md) and measure the numbers in
`data/tuning.json`. A future agent with SSH and RCON access to a Linux CS2 server should be able to run them in
order without reading anything else first.

| Card | Question | Feeds |
| --- | --- | --- |
| [P0](P0-coordinate-check.md) | Do the 2020 CS:GO Mirage coordinates still land on the same spots in CS2? | adapter world transform |
| [P0b](P0b-movement-calibration.md) | What accel, friction and speeds does a locked, input-driven bot get? | `movement.*`, `replay.walk/crouchSpeedThreshold`, `replay.hearingRangeUnits` |
| [P1](P1-locked-bot-track.md) | Does a locked bot hold a 10 Hz track within ~24 units for 10 s? | `replay.lookaheadSec`, `replay.drift*` |
| [P2](P2-view-angles.md) | Can we set a locked bot's view every tick, and does a shot land where it aims? | `replay.maxTurnRateDegPerTick`; picks the view route |
| [P3](P3-attack-cadence.md) | Does a one-tick `IN_ATTACK` fire exactly one round, and can we reproduce a 10-round spray? | `weapons.*` |
| [P4](P4-scripted-damage.md) | Do the damage block and scripted damage reproduce donk's 100→73→39→13→0 with the right kill feed? | picks the damage route |
| [P5](P5-replay-live-handoff.md) | Does a puppet unlocked mid-walk carry on with Bot-Nav and engage? | `ai.reactionSec`, `ai.aimErrorDeg` |
| [P6](P6-visibility-cost.md) | Are 10 × 5 visibility traces per tick cheap, and do they agree with native perception? | `ai.fovDeg`, `grenades.smokeSec`, `grenades.molotovSec` |
| [P7](P7-round-start.md) | After freeze time: clock 1:39, ten pawns placed and kitted, first kill at 0.50 s, bomb timings | `bomb.*`; picks the clock route |

## Order and dependencies

Run them risk-first. P2 and P4 decide whether we fork Bot-Controller and which damage route we use, and every later
card builds on those answers.

| Step | Card | Needs | Why this position |
| --- | --- | --- | --- |
| 1 | S0 setup (below) | — | Everything needs it |
| 2 | P0 | S0 | Every later card places pawns at recorded coordinates |
| 3 | P2 | S0 | Riskiest item. Decides fork or no fork |
| 4 | P4 | S0 (Route 2 also needs P2 and P3 step 1) | Second-riskiest. Decides the damage route |
| 5 | P1 | P0 | REPLAY movement; the view route from P2 is used in step 6 |
| 6 | P0b | P0, P1 step 1 | Uses the same injection path as P1 |
| 7 | P3 | P2 (aim at a wall) | Weapon cadence and stats |
| 8 | P6 | S0 (P2 for the FOV part) | Independent; can run any time after S0 |
| 9 | P5 | P1, P2 | Handoff needs a working puppet |
| 10 | P7 | P0, P1, P4 (P2, P3 for bomb part B) | Integration: everything at once |

A card that fails stops only the cards that depend on it. Record the failure, take the card's fallback, and carry on
with independent cards.

## Estimated effort

Agent wall-clock hours, assuming the server is already provisioned and reachable.

| Item | Effort | Notes |
| --- | --- | --- |
| S0 install + harness skeleton | 4–6 h | Includes writing the `cs2probe` harness plugin (below) |
| P0 | 1 h | |
| P0b | 3 h | Mostly curve fitting |
| P1 | 3–4 h | |
| P2 | 3 h (routes A, A2) + 1–2 days if the fork (route B) is needed | The fork needs a Linux C++ build of Bot-Controller |
| P3 | 2 h | |
| P4 | 4–6 h | Three routes |
| P5 | 3–4 h | |
| P6 | 2 h | |
| P7 | 4–6 h | Parts A and B |
| **Total** | **≈ 30–40 h**, plus 1–2 days if the fork is needed | |

## Server access needed

| Access | Needed for | Required? |
| --- | --- | --- |
| SSH to the server host | Install and update the server, Metamod, CSS and plugins; upload builds to `game/csgo/addons/`; edit `game/csgo/gameinfo.gi`; download CSV logs and demos | yes |
| File upload to `game/csgo/addons/` | Metamod, CSS, Bot-Controller, Bot-Nav, the harness plugin | yes |
| RCON (or the server console through `tmux`/`screen`) | Every `probe_*` command and cvar. Start the server with `-usercon` and `+rcon_password <pw>`; any Source-RCON client works | yes |
| A CS2 client that can join the server | Visual checks: P2 (spectate the bot's view), P4 (kill feed), P7 (HUD clock 1:39) | recommended. Without one, record GOTV (`tv_enable 1`, `tv_record`) and check the `.dem` offline |
| Root, or a user with `sudo` | Installing SteamCMD and the .NET 10 SDK for building | once |

## S0: common setup (do once)

1. **Host:** Linux x86_64 (Ubuntu 22.04 or 24.04), 4+ cores, 8 GB RAM, 60 GB disk.
2. **CS2 server:** `steamcmd +force_install_dir /srv/cs2 +login anonymous +app_update 730 validate +quit`.
   Record the build (`version` in the console) in `results.md`. **Turn off automatic updates** while probing: each
   update can break signatures and resets `gameinfo.gi`.
3. **Metamod:Source 2.0**, official build ≥ 1483 (plugin API 18), which includes the shared KHook backend
   ([DemoTracer server README](https://github.com/unicbm/demotracer/blob/1a44ca9b8c9fda5482bb327763f658ccfa7cbdf7/server/README.md)),
   into `/srv/cs2/game/csgo/addons/`. Add
   `Game csgo/addons/metamod` to `game/csgo/gameinfo.gi` above the `Game csgo` line (CS2 updates overwrite this file;
   re-apply after every update).
4. **CounterStrikeSharp v1.0.379**, Linux "with runtime" package (it bundles the .NET 10 runtime), into `addons/`.
5. **CS2-Bot-Controller v0.9.0** (pin commit `71319b0`): the Linux Metamod package and the CSS API package from the
   release, both copied into `game/csgo/` ([TECH.md](https://github.com/XBribo/CS2-Bot-Locker/blob/71319b0477ec688f8bdc2fe0633ef992a7cd700a/TECH.md)).
6. **CS2-Bot-Nav v1.1.0** (`BotNav.dll`) into `addons/counterstrikesharp/plugins/BotNav/`.
7. **Harness plugin `cs2probe`** (spec below) into `addons/counterstrikesharp/plugins/cs2probe/`.
8. **Launch:**
   ```sh
   cd /srv/cs2 && ./game/bin/linuxsteamrt64/cs2 -dedicated -usercon -port 27015 \
     +game_type 0 +game_mode 1 +map de_mirage +sv_lan 1 +rcon_password "$RCON_PW" \
     -maxplayers 12 +sv_hibernate_when_empty 0
   ```
   If `-maxplayers` is rejected, try `-maxplayers_override 12` and record which one worked.
9. **Check it loaded** (RCON): `meta list` (BotController listed), `css_plugins list` (BotControllerImpl, BotNav,
   cs2probe), `bc_status`, `probe_status`. All four must answer before any card starts.
10. **Base cvars for every card** (put them in `cfg/cs2probe.cfg` and `exec cs2probe` at the start of each card):
    ```text
    sv_cheats 1; mp_warmup_end; mp_autoteambalance 0; mp_limitteams 0; mp_ignore_round_win_conditions 1
    mp_roundtime 60; mp_roundtime_defuse 60; mp_freezetime 0; mp_buytime 0; mp_respawn_on_death_t 0; mp_respawn_on_death_ct 0
    bot_quota 0; bot_quota_mode normal; bot_join_after_player 0; bot_difficulty 3; tv_enable 1
    ```
    A cvar the build doesn't know is not an error: note it in `results.md`.

### Harness plugin spec (`cs2probe`)

The cards drive the server through these console commands. The probe agent writes the plugin in this repo under
`cs2/probe-harness/`: a CSS plugin, .NET 10 SDK, NuGet `CounterStrikeSharp.API` 1.0.379, with `BotControllerApi.dll`
and `BotNav.dll` referenced `Private=false`. It is private test code and is never deployed publicly. Bots are
addressed by `PlayerId`, and the harness keeps the id → slot table.

| Command | Does |
| --- | --- |
| `probe_status` | Prints the CS2 build, Metamod build, CSS version, Bot-Controller `ApiVersion`, Bot-Nav `ModuleVersion`, `Server.TickInterval`, and the current `Server.TickCount` |
| `probe_spawn <id> <T\|CT> <x> <y> <z> <yaw> [weapon…]` | Ensures a bot named `<id>` exists on the team (adds one if needed), strips its weapons, gives the listed `weapon_*`/`item_*`, and teleports it with zero velocity |
| `probe_lock <id> <all\|aim\|none>` | Bot-Controller `Lock`/`Unlock` |
| `probe_log <on\|off> <name>` | Per-tick CSV for all pawns to `addons/counterstrikesharp/data/cs2probe/<name>.csv`: `tick,id,x,y,z,vx,vy,vz,eyeYaw,eyePitch,vAngleYaw,vAnglePitch,hp,armor,flags,duckAmount,buttons0,weapon,clip,reserve,isDefusing`, plus `<name>.events.csv` (`tick,event,fields…`) for every game event the cards mention |
| `probe_move <id> <forward> <side> <ticks>` | Starts or updates a movement token for `<ticks>`, then cancels it |
| `probe_press <id> <BUTTON> <count> <everyTicks> [holdTicks]` | Presses a button `count` times, every `everyTicks`, each held `holdTicks` ticks (0 = one command) by injecting with duration 0 on each held tick |
| `probe_aim <id> <yaw> <pitch> <A\|A2\|B\|C> [ticks]` | Applies the view with one route (see P2) every tick for `ticks` |
| `probe_track <id> <csv> [lookahead] [nudge] [snap] [nudgeOn]` | Runs the REPLAY follower over a `tick,t,x,y,z` track (P1) |
| `probe_block <attacker> <victim> <on\|off>` | Adds or removes a blocked pair in `OnPlayerTakeDamagePre` |
| `probe_dmg <attacker> <victim> <amount> <armor> <hitgroup> <weapon> <lethal> <route 1\|2\|3> [atTick]` | Applies scripted damage (P4) |
| `probe_live <id> <x,y,z;x,y,z;…>` | Unlocks the bot and chains Bot-Nav goals (P5) |
| `probe_sees <on\|off> <pairs> <rays>` | Runs the visibility traces each tick and logs `sees` and timings (P6) |
| `probe_round <setup\|release> [clockRoute]` | P7 helpers |
| `probe_vdata <weapon_…>` | Dumps `CCSWeaponBaseVData`: `MaxSpeed`, `CycleTime`, `Damage`, `HeadshotMultiplier`, `ArmorRatio`, `MaxClip1`, `PrimaryReserveAmmoMax`, `Penetration`, `Range`, `RangeModifier` |

All timing in the harness is in ticks (`Server.TickCount`), never wall clock, except where a card measures wall
clock explicitly.

## Recording results

- Copy [`results.md`](results.md) as the run log (one file; each card has a section) and fill it in as you go.
- Keep the raw CSVs and `.dem` files out of git if they are large (> 1 MB); summarise them in `results.md` and note
  where they are stored. Small CSVs (< 1 MB) can go in `docs/cs2-probe/runs/<card>/`.
- Propose `data/tuning.json` changes in the table at the end of `results.md`. Make the edit in a separate PR that
  cites the run.
- Every card ends with **PASS**, **FAIL** or **PARTIAL**, plus which fallback, if any, was taken.
