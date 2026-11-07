# CS2 adapter: mapping the Core contracts onto a CS2 server

Task F1. Research only: nothing here has been run on a CS2 server yet. Every row says how sure we are, and the
probe cards in [`docs/cs2-probe/`](cs2-probe/README.md) turn the open rows into measurements. Sources were read on
2026-11-05, pinned to the tags and commits below, so the links keep pointing at what was read.

Status values used throughout:

- **verified in docs**: the API, hook or event exists, and its source or documentation says it does what the row
  needs. It has not been run.
- **likely**: the API exists, but whether it does what we need depends on engine behaviour nobody has documented.
- **unknown — probe**: no primary source settles it. A probe card measures it.

## Stack as read (pin these)

| Component | Version read | Platform | Licence | Notes |
| --- | --- | --- | --- | --- |
| CS2 dedicated server | game 1.41.9.x | Linux and Windows | Valve | CSS v1.0.378 is "fix: Game Update 1.41.9.2"; v1.0.379 updates the schema to 1.41.9.3 ([css-changelog]) |
| Metamod:Source | 2.0, build ≥ 1483 (plugin API 18) | both | not checked | DemoTracer requires this build: "These upstream builds include the shared KHook backend" ([dt-server]). CSS switched its hooks to KHook in v1.0.375 ([css-changelog]); Bot-Controller's hooks return `KHook::Return` ([bc-injector]) |
| CounterStrikeSharp (CSS) | v1.0.379 (2026-10-31), `net10.0` | both | GPLv3, with an exception that lets plugins use MIT ([css-license]) | **.NET 10, not .NET 8**: "chore: upgrade to .NET 10 (LTS)" in v1.0.369 ([css-changelog]) |
| CS2-Bot-Controller (XBribo) | v0.9.0, commit `71319b0` (2026-11-06 01:10 UTC) | Windows and Linux ([bc-readme], [bc-gamedata]) | AGPL-3.0-only since 0.4.8 ([bc-license]) | CSS capability `botcontroller:api`, `ApiVersion` 1; the C# provider targets `net10.0` with CSS 1.0.378. The repo now calls itself CS2-Bot-Controller; the CS2-Bot-Locker URL serves the same repo |
| CS2-Bot-Nav (ed0ard) | v1.1.0, commit `0d1d04f` (2026-10-17) | both (signatures hard-coded in C#) | AGPL-3.0 (no version qualifier) | targets `net10.0` with CSS 1.0.376 ([nav-csproj]) |
| DemoTracer (unicbm) | 1.6.7, commit `1a44ca9` (2026-11-03) | **Windows x64 only** ([dt-server], [dt-controller]) | playback AGPL-3.0-only; desktop GUI proprietary ([dt-readme]) | its runtime `dtr-controller` is a maintained fork of Bot-Controller ([dt-controller-upstream]) |
| Prior art | cs2-retakes `2fde4a9` (GPL-3.0); OpenPrefirePrac `44fb66e` (MIT, Feb 2025) | | | ticking `planted_c4` ([retakes-bomb]); bot aim set from CSS ([opp-aim]) |

## What changes the plan

1. **Bot-Controller can't set view angles on a live (locked) bot.** Its live input path, `ApplyUsercmdControls`,
   writes only the button planes and `forwardmove`/`leftmove` ([bc-injector], lines 311–416). The *replay* path does
   write view angles: it sets the usercmd's `viewangles`, calls the original `CCSPlayerPawn::SetEyeAngles`, and writes
   `v_angle`/eye-angle fields ([bc-injector] `ApplyReplayUserCommand`, [bc-recorder] `OnReplayCommandPre/Post`,
   [bc-controller] `ApplyReplayEyeAnglesInternal`). So a fork is a small, well-defined patch: reuse those calls in the
   live path. Two cheaper routes are untested: writing `EyeAngles` and calling `Teleport` with angles each tick from
   CSS, which OpenPrefirePrac does for its aim lock ([opp-aim]), or calling `SetEyeAngles` from CSS with
   Bot-Controller's own Linux signature.
2. **Bot-Controller's replay is kinematic.** Before and after every command it writes the recorded origin, velocity
   and eye angles into the pawn ([bc-recorder] lines 1247–1350). Replay buffers are per-tick `ReplayTick`
   (pre/post `MovementSnapshot` with origin, velocity, angles and duck state) plus `ReplayCommandFrame` (forward/left
   move, pitch/yaw, buttons) ([bc-types]). We could synthesize them from a track and `LoadReplay` them: positions and
   angles would be exact, but the puppet would ignore collisions, inputs would not come from Core tick by tick, and
   "Replay clears injected controls and rejects new ones" ([bc-tech]). That makes it a fallback, not the plan.
3. **The All lock stops native perception.** `bc_lock all` supersedes `CCSBot::Update` entirely, and
   `Upkeep`/`UpdateLookAngles` too ([bc-controller] `HookedUpdate`, `HookedViewUpdate`). A REPLAY bot's
   `CCSBot.IsEnemyVisible`/`Enemy` therefore go stale, so `sees` must come from our own traces, and a bot that has just
   gone LIVE starts from stale perception. DemoTracer's fork changed exactly this: "Native AI continues perception during
   replay so it is ready for handoff", and its handoff triggers on "fresh native bot perception" ([dt-controller],
   [dt-commands], [dt-combat]).
4. **DemoTracer's runtime doesn't run on Linux.** "Linux runtime packages are unsupported" ([dt-controller]), and all
   19 signatures in its gamedata have empty `linux` values ([dt-gamedata]). On the planned Linux server it is design
   reference only. Its movement-intent API also "does not select targets, aim, switch weapons or teleport"
   ([dt-controller]).
5. **CS2-Bot-Nav has one goal per bot.** It re-calls native `CCSBot::MoveTo` every 0.1 s, auto-releases once the bot is
   within 40 units of the goal, and has no multi-waypoint route ([nav-src] lines 56, 86, 125–200). Its
   `MoveTo` signatures are byte strings in C#, not a gamedata file, so a CS2 update leaves it logging "MoveTo
   disabled" until a new release ([nav-src] lines 25–30, 78). Route chaining is ours to write.
6. **Injected button durations use wall-clock milliseconds.** The injector uses `std::chrono::steady_clock`, not
   ticks ([bc-injector] `MonotonicMilliseconds`). "A zero duration presses for one command" ([bc-tech]). For
   tick-exact input, press with duration 0 on every tick the button should be down.
7. **CSS can block damage, but has no supported way to apply it.** `OnPlayerTakeDamagePre` returning `Handled` "will
   prevent the entire damage application process" ([css-listeners], [css-docs-takedamage]). The only way to *apply*
   damage is `VirtualFunctions.CBaseEntity_TakeDamageOldFunc` (marked obsolete), which needs a native
   `CTakeDamageInfo`, and CSS has no constructor for one ([css-vfuncs], [css-gamedata]). The hitgroup is read
   through an opaque pointer chain ([css-dmginfo-hitgroup]). Game-event fields, however, are writable in a Pre hook
   (`EventPlayerDeath.Attacker`/`Weapon`/`Headshot` setters, [css-ev-death]). That gives a reliable fallback for the
   kill feed.
8. **CSS has had a Ray/Hull Trace API since v1.0.372** (`Trace.TraceEndShape`, `TraceHullShape`) ([css-trace],
   [css-changelog]). It is a physics query; whether smoke blocks it is unknown (probably not).
9. **The round clock is two fields.** `CCSGameRules.RoundStartTime` is a float and `RoundTime` is an **Int32
   (seconds)** ([css-schema-gamerules]). `mp_roundtime` alone can't give 98.25 s. Shifting `RoundStartTime` is a
   networked memory write with no prior art found. A write-free fallback exists (P7).
10. **The ticking-bomb recipe exists, and it skips the timer.** cs2-retakes creates `planted_c4`, sets `BombSite`,
    `BombTicking`, `CannotBeDefused = false`, calls `DispatchSpawn`, sets `gameRules.BombPlanted` and fires
    `bomb_planted` ([retakes-bomb]). It never sets `C4Blow`, so whether the timer starts from `mp_c4timer` at spawn
    must be measured.

## Tick loop (where each row lives)

```text
CSS Listeners.OnTick (64/s, [css-listeners]):
  1. observe = BuildObserve()          // schema reads + game events buffered since the previous OnTick
  2. act     = core.Step(canonicalize(observe))
  3. log.Append(observe, act, controls)
  4. Apply(act): actions in array order, then per-REPLAY-pawn inputs
     (UpdateUsercmdMovement, view-angle route from P2, one-command button presses)
tick = Server.TickCount − releaseTick;  t = tick / 64   (Server.TickInterval is 0.015625 in [css-server])
```

Whether inputs written in `OnTick` reach the bot's usercmd on the same tick or the next one is unknown. P1 measures
the latency, and Core must tolerate one tick of it (see contract findings).

## Mapping table

### Observe (engine → Core)

| Contract item | CS2 implementation | Source | Status | Risk notes |
| --- | --- | --- | --- | --- |
| `tick` | `Server.TickCount − releaseTick`, where `releaseTick` is captured at t = 0 (P7) | [css-server] | verified in docs | `host_timescale` or a pause would break the 1:1 tick mapping |
| `t` | `tick / 64`. CSS hard-codes `TickInterval => 0.015625f` | [css-server] | verified in docs | CS2 servers run at 64 tick only |
| `pawns[].id` | Adapter table: player slot → `PlayerId`. Bots get the recorded display names; the human is matched by SteamID | [css-controller] | likely | How to name a bot at add time is not documented in CSS; writing `PlayerName` with `SetStateChanged` is the fallback. Sort by id ordinally (port-notes) |
| `team` | `controller.Team` / `pawn.TeamNum` (2 = T, 3 = CT) | [css-schema-entity] | verified in docs | |
| `pos` | `pawn.AbsOrigin` (scene-node origin, at the feet) | [css-baseentity] | verified in docs | P0 checks that the 2020 CS:GO coordinates match CS2 Mirage |
| `vel` | `pawn.AbsVelocity` (units/s) | [css-schema-entity] | verified in docs | |
| `yaw` | `pawn.EyeAngles.Y`, normalised. Source yaw 0 = +x and 90 = +y, the same as `setang` and our convention | [css-schema-pawn] | likely | On a locked bot it only changes if we set it (P2). The contract does not define the range (finding F1) |
| `pitch` | `pawn.EyeAngles.X` (Source: positive = looking down) | [css-schema-pawn] | likely | Sign and range are undefined in the contract (finding F1) |
| `hp` | `pawn.Health` | [css-schema-entity] | verified in docs | |
| `armor` | `pawn.ArmorValue` | [css-schema-pawn] | verified in docs | The helmet (`ItemServices.HasHelmet`) is not in Observe |
| `alive` | `controller.PawnIsAlive` (or `pawn.LifeState == 0`) | [css-controller-schema] | verified in docs | After death, keep the last known pawn data (the contract wants a dead pawn's last weapon) |
| `weapon` | `pawn.WeaponServices.ActiveWeapon.Value.DesignerName` mapped to `WeaponId` | [css-schema-basepawn] | likely (mapping) | M4A4's entity name is `weapon_m4a1` (M4A1-S is `weapon_m4a1_silencer`); grenades are `weapon_smokegrenade`/`flashbang`/`hegrenade`/`molotov`/`incgrenade`. `glock`, the CT pistols and `incgrenade` have no `WeaponId` (finding F2). P7 prints the real names |
| `ammo.clip` / `ammo.reserve` | `ActiveWeapon.Clip1` / `ActiveWeapon.ReserveAmmo[0]` | [css-schema-weapon] | verified in docs | |
| `crouching` | `MovementServices` cast to `CCSPlayer_MovementServices`: `Ducked`, or `DuckAmount ≥ 0.5` | [css-schema-csmove] | likely | Which signal matches the 2D sim's meaning; P0b logs `DuckAmount` through a crouch |
| `sees` | Adapter-computed for each pair: `Trace.TraceEndShape(eye(a), eye(b), ignore a)` with eye = `AbsOrigin + ViewOffset`; visible if nothing hits before b; then a FOV test against a's eye angles (`ai.fovDeg`); then our own smoke test (active smokes from `smokegrenade_detonate`/`_expired`) | [css-trace], [css-schema-model], [css-ev-smoke] | likely (API) / unknown — probe (smoke, cost: P6) | Native `CCSBot.IsEnemyVisible` is stale under the All lock (finding 3). A physics trace probably ignores smoke, and the round has four smokes (`data/round.json` `utility`). Cost: 90 ordered pairs per tick (P6) |
| `human` | The one non-bot controller (`!IsBot`) on T or CT that has a living pawn, mapped to the `PlayerId` of that pawn; `null` while he watches. G4: he takes control of cart with the native bot takeover (below), so it is the id of the bot pawn he controls: `ControllingBot` true and the pawn's `OriginalControllerOfCurrentPawn` is cart's bot | [css-controller], [css-ev-takeover] | verified in docs (fields) / unknown — probe (P8) | Reported from the first `OnTick` after `bot_takeover`; never inferred from input |
| `round` (C3) | `phase`/`winner`/`reason`/`endTick` from `EventRoundEnd` and `CCSGameRules` (bomb planted flag); `score` from the two team entities; `timeLeftSec` from the round clock (finding 9) or `CPlantedC4.C4Blow − CurrentTime`; `bomb` from the C4 carrier's inventory, the dropped `weapon_c4` and `planted_c4` (`AbsOrigin`, `BombDefuser`, `DefuseCountDown`) | [css-schema-gamerules], [css-schema-c4] | likely | Not probed yet; tick values (`plantTick`, `defuseEndTick`) are adapter ticks, so convert game times with the tick mapping above |

### ObsEvent (events since the previous tick)

| Contract item | CS2 implementation | Source | Status | Risk notes |
| --- | --- | --- | --- | --- |
| `damage` | `EventPlayerHurt` (Post): `Userid`, `Attacker`, `DmgHealth`, `DmgArmor`, `Hitgroup`, `Weapon`. `scripted` is the adapter's own flag for damage it applied on that tick | [css-ev-hurt] | verified in docs | Clamp `amount` to the HP actually removed (the contract defines it as HP removed). Engine hitgroups include generic (0) and neck (8), which the contract lacks (finding F3). World damage → `attacker: null` |
| `shot` | `EventWeaponFire` (`Userid`, `Weapon`) | [css-ev-fire] | verified in docs | Whether it fires for injected `IN_ATTACK` on a locked bot is P3 |
| `death` | `EventPlayerDeath` (`Userid`, `Attacker`, `Weapon`, `Headshot`) | [css-ev-death] | verified in docs | Map the weapon strings (`ak47`, `m4a1`→`m4a4`, `hegrenade`→`he`, `inferno`→`molotov`, `planted_c4`/`world`→`null`) |
| `sound` (footstep) | `EventPlayerFootstep` + the pawn's `AbsOrigin`; `EventPlayerSound` carries `Radius` and `Step` | [css-ev-footstep], [css-ev-sound] | verified in docs | Which events fire for bots, and the radius, are measured in P0b |
| `sound` (land) | No `player_land` event exists. Derive it from `Flags` gaining `FL_ONGROUND` after a fall | [css-schema-entity] | likely | |
| `sound` (shot, reload) | `EventWeaponFire`, `EventWeaponReload` | [css-ev-fire], [css-ev-reload] | verified in docs | |
| `sound` (grenade) | `EventGrenadeThrown` and the `*_detonate` events | [css-ev-grenade] | verified in docs | |
| `sound` (bomb) | `EventBombBeep` (`Entindex` only, no player) → `source: null` | [css-ev-beep] | verified in docs | F4 resolved in C3: `source` is nullable |
| `bomb` planted | `EventBombPlanted` (`Userid`, `Site`); `pos` from the `planted_c4` entity's `AbsOrigin` | [css-ev-planted], [css-schema-c4] | verified in docs | |
| `bomb` defuse_start / defuse_stop | `EventBombBegindefuse` (`Userid`, `Haskit`) / `EventBombAbortdefuse` | [css-ev-begindefuse] | verified in docs | |
| `bomb` defused / exploded | `EventBombDefused` / `EventBombExploded` | [css-ev-defused], [css-ev-exploded] | verified in docs | |
| `round_end` | `EventRoundEnd` (`Winner` 2/3, `Reason`). `TargetBombed`→`bomb_exploded`, `BombDefused`→`bomb_defused`, `CTsWin`/`TerroristsWin`→`elimination`, `TargetSaved`→`time`; anything else is logged | [css-ev-roundend], [css-roundend] | likely | That `Reason` uses the `RoundEndReason` numbering is assumed |

### Act inputs (one entry per REPLAY pawn)

| Contract item | CS2 implementation | Source | Status | Risk notes |
| --- | --- | --- | --- | --- |
| `forward`, `side` | Bot-Controller `StartUsercmdMovement(slot, forward, leftMove)` once on entering REPLAY, then `UpdateUsercmdMovement(slot, token, forward, −side)` every tick; `CancelUsercmdMovement` on LIVE. It clamps to [−1, 1] and sets `IN_FORWARD/BACK/MOVELEFT/MOVERIGHT` from the signs | [bc-api], [bc-injector], [bc-tech] | verified in docs (API) / unknown — probe (fidelity: P1) | `leftMove` positive = left (A). Core's `side` positive = right, so negate. The direction is relative to the **usercmd** view yaw, which may not be `EyeAngles` unless the P2 route writes the usercmd. Whether fractional magnitudes scale speed is P0b. Latency is P1 |
| `yaw`, `pitch` | No live API. Routes, in test order: **A** each tick, `pawn.Teleport(null, QAngle(p, y, 0), null)` plus writing `EyeAngles` (prior art [opp-aim]); **A2** call `CCSPlayerPawn::SetEyeAngles` from CSS (`MemoryFunctionVoid`) with the signature in [bc-gamedata]. Bot-Controller only supersedes it during its own replays ([bc-controller]); **B** fork: a `SetUsercmdView` token that writes usercmd `viewangles` in `ApplyUsercmdControls` and calls the original `SetEyeAngles`, as the replay path already does; **C** synthesized replay buffers | [bc-injector], [bc-controller], [opp-aim], [css-schema-pawn] | **unknown — probe (P2)** | Top risk. Angles also drive the shot direction (CS2 subtick input history), defusing (`+use` toward the bomb), the movement frame and the FOV in `sees` |
| `buttons`: `ATTACK` | `InjectUsercmd(slot, 1<<0, 0)` on every tick it is held | [bc-tech], [css-buttons] | verified in docs (API) / unknown — probe (cadence: P3) | An AK cycle is 6.4 ticks; taps 6 ticks apart probably drop shots (finding F7) |
| `ATTACK2` | `1<<11` | [css-buttons] | verified in docs | Scoping (AWP/SSG 08) is checked in P3 |
| `USE` | `1<<5` | [css-buttons] | verified in docs | Defusing needs the view on the bomb (P2, P7) |
| `DUCK` | `1<<2` | [css-buttons] | verified in docs | Crouch speed is P0b |
| `WALK` | CSS lists `Speed = 1<<16` ("holding the speed key") and `Walk = 1<<17`. Which one CS2's walk key sets is not documented | [css-buttons] | unknown — probe (P0b) | |
| `JUMP` | `1<<1` | [css-buttons] | verified in docs | |
| `RELOAD` | `1<<13` | [css-buttons] | verified in docs | Reload time is P3 |

### Actions

| Contract item | CS2 implementation | Source | Status | Risk notes |
| --- | --- | --- | --- | --- |
| `damage` | **Route 1** (plan): build a `CTakeDamageInfo` (attacker/inflictor = attacker pawn, ability = its weapon, `Damage`, `BitsDamageType` = bullet, `HitGroupId`) and call `VirtualFunctions.CBaseEntity_TakeDamageOldFunc.Invoke(victim, info, result)`. **Route 2**: the puppet really fires (P2/P3); `OnPlayerTakeDamagePre` rewrites `info.Damage` when a scripted hit is due for that pair, and blocks otherwise. **Route 3**: non-lethal hits write `Health`/`ArmorValue` plus `SetStateChanged` and fire a synthetic `player_hurt`; lethal hits kill the pawn while an `EventPlayerDeath` Pre hook rewrites `Attacker`, `Weapon` and `Headshot` | [css-vfuncs], [css-schema-dmginfo], [css-dmginfo-hitgroup], [css-listeners], [css-ev-death], [css-gameevent] | **unknown — probe (P4)** | Route 1: no constructor, unknown struct size, hitgroup behind a pointer. Route 2 depends on aim. Route 3 always works for HP, but the scoreboard (K/D, kill reward) needs manual fixes |
| `block_damage` | `OnPlayerTakeDamagePre`: map `info.Attacker` (a pawn handle) to the controller and its id, and return `HookResult.Handled` if the pair is blocked | [css-docs-takedamage], [css-schema-dmginfo] | verified in docs | Grenade damage has attacker = thrower and inflictor = projectile, so blocking by attacker covers it. Whether `Handled` also removes tagging and aim punch is checked in P4 |
| `unblock_damage` | Remove the pair from the blocked set | (adapter) | verified in docs | |
| `set_mode` REPLAY | `BotNav.Release(slot)`; Bot-Controller `Lock(slot, LockKind.All)`; start the movement token | [bc-api], [bc-controller], [nav-readme] | verified in docs | Native perception stops (finding 3). `InjectUsercmd` binds the current pawn itself ([bc-injector] `BindCurrentPawn`) |
| `set_mode` LIVE, `goal.route` | Cancel the tokens; `Unlock(slot, All)`; `BotNav.SetGoal(slot, route[0], Fastest)`. When `IsControlled(slot)` turns false (auto-release ≤ 40 units), set `route[i+1]`. Release after the last waypoint or on first contact | [nav-readme], [nav-src] | likely | One goal at a time. Re-calling `MoveTo` every 0.1 s may fight combat behaviour, so release on contact (P5). Signatures are hard-coded |
| `set_mode` LIVE, `goal.hold` | `BotNav.SetGoal(hold)`, then `BotNav.Hold(slot)` on arrival. Hold re-points the goal at the bot's own origin and its comment says it keeps "attack and aim alive" | [nav-src] (lines 159–165) | likely | Hold only holds the *current* origin |
| `set_mode` LIVE, `goal.role` | Not engine-applied; could map to `BotNav.SetRoute` (Safest/Retreat) | [nav-readme] | likely | |
| `set_weapon` | Bot-Controller `SwitchBotWeapon(slot, defIndex)`; optionally `Lock(slot, LockTarget.SlotN)` to pin it | [bc-api] | likely | Needs a defIndex table. CS:GO's `items_game` values (ak47 7, awp 9, deagle 1, glock 4, m4a4 16, ssg08 40, flash 43, he 44, smoke 45, molotov 46, incgrenade 48, c4 49) are unverified for CS2; check with `BotActiveWeaponDef` (P7) |
| `give` | `controller.GiveNamedItem("weapon_…")`, then `Clip1`/`ReserveAmmo[0]` with `SetStateChanged`; kit: `ItemServices.HasDefuser`; armor: `item_assaultsuit` or `ArmorValue` + `HasHelmet` | [css-controller], [css-schema-weapon], [css-schema-items] | likely | Bots may buy over it; `SetBuySkip(slot)` prevents that ([bc-api]) |
| `set_hp` | `pawn.Health` / `pawn.ArmorValue` + `Utilities.SetStateChanged(pawn, "CBaseEntity", "m_iHealth")` / `("CCSPlayerPawn", "m_ArmorValue")` | [css-utilities], [css-schema-entity] | likely | |
| `teleport` | `pawn.Teleport(pos, QAngle(0, yaw, 0), Vector(0, 0, 0))`, then the P2 view route for the eye angles. The "unseen" test reuses the human's `sees` | [css-baseentity] | verified in docs (API) / unknown (eye yaw) | |
| `plant` | **Route 1**: the puppet holds the plant input with `weapon_c4` active in the bomb zone for `plantSec`, giving the engine's own `bomb_planted`. **Route 2**: spawn `planted_c4` at `pos` the cs2-retakes way and strip the carrier's C4 | [retakes-bomb], [css-schema-c4] | likely (Route 2) / unknown — probe (P7) | Plant input: primary attack with C4 drawn (likely); one guide says "E" plants faster ([scope-bomb]), so test both. Spawned C4 never sets `C4Blow`; P7 measures the timer |
| `defuse_start` | The puppet faces the C4 (P2 route) and holds `USE`. Progress shows in `pawn.IsDefusing`, `CPlantedC4.BeingDefused` and `DefuseCountDown` | [css-schema-c4], [css-schema-pawn] | unknown — probe (P7) | Needs the view on the bomb within use range. CS2 now lowers the viewmodel during a defuse and adds a 150 ms fire delay after one (beta notes, Oct 2025, [cs2-defuse-delay]) |
| `defuse_stop` | Stop pressing `USE` | (adapter) | likely | |
| `end_round` | `gameRules.TerminateRound(delay, RoundEndReason.X)`. CSS picks the Linux or Windows argument order itself | [css-gamerules], [css-vfuncs] | verified in docs | |
| `log` | `Server.PrintToConsole`, plus an optional centre-HTML line to the human or spectators | [css-server] | verified in docs | |
| `status` | Not engine-applied; the adapter mirrors it to `log`/HUD | — | verified in docs | |

### Control (app → Core/engine)

| Contract item | CS2 implementation | Source | Status | Risk notes |
| --- | --- | --- | --- | --- |
| `start` | Arm the plan, `mp_restartgame 1`; set up kits during freeze time; release at `EventRoundFreezeEnd` (clock route in P7) | [css-ev-freezeend] | likely | |
| `restart` | Same as `start` | — | likely | |
| `seek {t}` | Back: a resync rewind to the latest safe checkpoint at or before t, then real time. Ahead: refused (`capabilities().seek` false) | — | B5: Core and driver side done; adapter untested | Contract finding F6 |
| `checkpoint` / `rewind` | No engine snapshot (`capabilities().snapshot` false): the driver keeps Core snapshots; a rewind is a **resync** (B5): `set_round` (tick base, round start time, `planted_c4`), `set_hp` / `teleport` / `strip` / `give` / `set_weapon` per pawn, `set_mode`, all damage blocks. Humans see the teleport. Velocity, grenades, plant / defuse progress are lost | — | B5: Core side done and tested in 2D with snapshots off; adapter untested | `docs/port-notes.md` "Checkpoints, rewind, summary" |
| `pause {paused}` | `mp_pause_match` (takes effect at the next freeze time), or `sv_pausable 1` + `pause` (behaviour on a dedicated server unknown) | — | unknown (deferred) | |
| `speed {x}` | `host_timescale` (cheat-protected, server-wide) | — | unknown (deferred) | |
| `take_control {id}` (G4) | Nothing to send: CS2's **native bot takeover** is it. The human is a sixth T, dead or spectating from the round start (`bot_controllable 1`); he spectates cart's bot and presses E (`+use`). The engine hands him the pawn (`bot_takeover` event: `Userid`, `Botid`); from the next `OnTick` the observe's `human` is `cart` and the plugin **stops injecting usercmds for cart's bot** (movement token, buttons, view route; release the Bot-Controller lock of that slot so his own usercmds drive it). The Core reacts to `observe.human` alone (`docs/core.md` "Takeover"). Only cart may be taken over: refuse the other bots (clear `CanControlObservedBot` while he observes another bot, or cancel the takeover). A resync rewind to before the takeover first releases the pawn back to its bot (route unknown: P8) | [css-ev-takeover], [css-controller], [cs2-takeover] | verified in docs (event, fields) / unknown — probe (P8: restriction to cart, release, a second takeover in the round) | The player must be dead to take over (CS2's rule), so he is never a seventh pawn on the map. Kills he makes count for the bot's scoreboard line ([cs2-takeover]); one takeover per round is likely (`HasControlledBotThisRound`) |

None of the Control rows besides `start` are covered by P0–P7 (`take_control`: P8). They are deferred until Core needs them in CS2.

## Tuning fields the probe must measure

| `data/tuning.json` key | Current | How it is measured | Probe |
| --- | --- | --- | --- |
| `movement.svAccelerate` | 5.5 | Read the `sv_accelerate` cvar; fit the speed ramp from standstill (Source model `v += a·wishspeed·dt`) | P0b |
| `movement.svFriction` | 5.2 | Read `sv_friction`; fit the coast-down curve | P0b |
| `movement.svStopSpeed` | 80 | Read `sv_stopspeed`; check the low-speed tail of the coast-down | P0b |
| `movement.walkFactor` | 0.52 | Steady walk speed / steady run speed, same weapon | P0b |
| `movement.crouchFactor` | 0.34 | Steady crouch speed / run speed | P0b |
| `movement.runSpeedByWeapon.<w>` | knife 250, ak47 215, awp 200, ssg08 230, deagle 230, m4a4 225, … | Steady speed per weapon (units/s), cross-checked with weapon VData `MaxSpeed` ([css-schema-weaponvdata]) | P0b |
| `replay.lookaheadSec` | 0.15 | Sweep 0.10–0.25 s; keep the lowest p95 track error | P1 |
| `replay.driftNudgeUnits` | 24 | p95 error with nudges off, plus the gain that holds ≤ 24 | P1 |
| `replay.driftSnapUnits` | 96 | Max error seen; keep 96 unless errors approach it | P1 |
| `replay.walkSpeedThreshold` | 120 | Midpoint between measured walk and run speeds | P0b |
| `replay.crouchSpeedThreshold` | 60 | Midpoint between crouch-walk and walk speeds | P0b |
| `replay.maxTurnRateDegPerTick` | 12 | Largest per-tick yaw step the P2 route follows with ≤ 1 tick lag | P2 |
| `replay.hearingRangeUnits` | 1500 | `EventPlayerSound.Radius` for footsteps (if bots emit it) | P0b |
| `replay.outliveGraceSec` | 3 | Core policy, not an engine constant | — |
| `weapons.<w>.damage` / `headshotMult` | AK 36 / 4 … | VData `Damage` / `HeadshotMultiplier` | P3 |
| `weapons.<w>.armorPen` | AK 0.775 … | VData `ArmorRatio / 2`. The current values equal CS:GO's ratio/2 (e.g. AK 1.55 → 0.775); this is a hypothesis to confirm | P3 |
| `weapons.<w>.rpm` | AK 600 … | `60 / CycleTime` from VData; check the interval between `weapon_fire` events under a held trigger | P3 |
| `weapons.<w>.clip` / `reserve` | 30 / 90 … | VData `MaxClip1` / `PrimaryReserveAmmoMax`, and the values right after `give` | P3 |
| `weapons.<w>.reloadSec` | AK 2.4 … | Ticks from the `RELOAD` press to `Clip1` refilling | P3 |
| `bomb.plantSec` | 3.2 | `bomb_beginplant` → `bomb_planted` | P7 |
| `bomb.timerSec` | 40 | `C4Blow − CurrentTime` at plant (engine plant and spawned C4) | P7 |
| `bomb.defuseSec` / `defuseKitSec` | 10 / 5 | `DefuseLength`, and `bomb_begindefuse` → `bomb_defused` with and without a kit | P7 |
| `grenades.smokeSec` / `molotovSec` | 18 / 7 | `smokegrenade_detonate` → `_expired`; `inferno_startburn` → `inferno_expire` | P6 |
| `grenades.flashSec` | 3 | Not measured (blind time depends on angle and distance) | — |
| `ai.fovDeg` | 106 | The FOV whose trace-based `sees` best agrees with native `IsEnemyVisible` on unlocked bots | P6 |
| `ai.reactionSec` | 0.25 | LIVE bot: first visible tick → first shot | P5 |
| `ai.aimErrorDeg` | 2.5 | LIVE bot: angle between its first shot and the target's chest (optional) | P5 |
| `nav.*` | — | 2D sim only; CS2 uses the engine nav mesh | — |

## Ranked open risks (most dangerous first)

1. **View angles on a locked bot (P2).** No live API exists (finding 1). Angles affect aim, whether shots land (CS2
   reads the view from the command's input history when it fires), defusing, the movement frame and the FOV in
   `sees`. *Mitigation:* try the cheap CSS routes A and A2 first. If they fail, write a fork patch of roughly 50 lines
   of C++ that reuses the replay path's view calls. Last resort: synthesized replay buffers.
2. **Scripted damage with correct attribution (P4).** CSS can't construct a `CTakeDamageInfo`, and the headshot flag
   depends on a hitgroup read through an opaque pointer (finding 7). *Mitigation:* Route 3 (set HP, then rewrite the
   `player_death` event in a Pre hook) always applies the damage and gets the kill feed right, at the cost of manual
   scoreboard fixes. Route 2 gives the real kill feed but needs aim (P2) and taps that fire (P3).
3. **Update fragility and a moving toolchain.** Each CS2 update can break signatures: CSS shipped fixes for 1.41.8.2,
   1.41.9.2 and others ([css-changelog]); Bot-Nav's signatures are compiled in; Bot-Controller depends on a signature
   tracker ([bc-sigs]). The stack moved to .NET 10 and KHook in the last months, and DemoTracer, the best prior art,
   is Windows-only. *Mitigation:* pin exact versions, keep the server off automatic updates, re-run P0/P1/P3 after
   each update, and keep our own code in CSS (C#) behind one small native fork.
4. **Round clock shift (P7).** `RoundStartTime` is a networked float whose write and `SetStateChanged` path are
   undocumented, and `RoundTime` is whole seconds (finding 9). *Mitigation:* the write-free Route B — a 99 s round,
   with t = 0 released 48 ticks (0.75 s) after freeze end.
5. **REPLAY → LIVE handoff (P5).** Under the All lock the bot's perception is stale (finding 3). Bot-Nav re-calls
   `MoveTo` every 0.1 s and may pull the bot out of a fight (finding 5). *Mitigation:* release Bot-Nav on first
   contact. If reacquiring takes too long, add a perception-keeping lock to the fork (DemoTracer's design).
6. **Shot cadence (P3).** The AK fires every 6.4 ticks, so single-tick taps on rounded ticks can arrive before the
   next shot is allowed. Wall-clock durations make multi-tick holds inexact (finding 6). *Mitigation:* hold `ATTACK`
   for a whole spray, pressing with duration 0 every tick (finding F7).
7. **Sighting correctness and cost (P6).** A physics trace probably ignores smoke, eye height matters, and there are
   90 pairs per tick. *Mitigation:* our own smoke-sphere test, round-robin tracing, distance and FOV culling first.
8. **Movement fidelity under the lock (P0b/P1).** Input latency, analog scaling, the WALK bit, and the yaw the movement
   code uses (usercmd versus eye angles); a kinematic-free puppet can be body-blocked by the human. *Mitigation:*
   lookahead plus velocity nudges; the snap is the last resort.
9. **Bomb details (P7).** The plant input (`ATTACK` with C4 drawn, or `USE`), whether a spawned C4 starts its timer,
   and defusing needing aim. *Mitigation:* engine plant first; spawned C4 with `C4Blow` set by hand as the fallback;
   `TerminateRound(BombDefused)` as the defuse of last resort.
10. **Map drift from CS:GO 2020 to CS2 (P0).** Probably small, but props and boxes changed in the port.
    *Mitigation:* a global offset if all spots move together, nav snapping if they don't.

## Recommendation: bot-control layer

**Fork CS2-Bot-Controller. Keep the fork minimal and try to upstream it.** Don't adopt DemoTracer's runtime, and don't
write our own usercmd hook from scratch.

| Option | For | Against |
| --- | --- | --- |
| Bot-Controller as released | Linux supported; CSS API in place (locks, tokens for movement, buttons and suppression, weapon switch, buy plans) ([bc-tech]); signatures maintained against each CS2 build ([bc-sigs]) | No live view angles (finding 1); the All lock stops perception (finding 3) |
| **Bot-Controller + small fork** (recommended) | Same base. The two missing features are small: (1) a view token in `ApplyUsercmdControls` that writes usercmd `viewangles` and calls the original `SetEyeAngles`, code that already exists for replays; (2) optionally, a lock that blocks `Update`'s movement and aim but keeps perception | We own a C++ build (Linux, HL2SDK/Metamod pins) and rebase on each upstream release; signature updates stay upstream |
| DemoTracer runtime (`dtr-controller`) | Most mature handoff: native-perception contact, bullet-damage handoff, physics-driven replay through `SetupMove` ([dt-controller], [dt-combat]) | Windows x64 only; Linux unsupported, with empty Linux signatures ([dt-gamedata]); built around `.dtr` demo files; its intent API does no aiming ([dt-controller]) |
| Our own usercmd hook | Full control | We would re-derive and maintain every signature (PlayerRunCommand, ProcessMovement, `CCSBot::Update`/`Upkeep`, `SetEyeAngles`…) on every CS2 update: the most expensive option |

Order of work: run P2 with the no-fork routes A and A2 first. If one passes, use Bot-Controller and Bot-Nav exactly as
released. Fork only for what fails. Borrow *designs* from DemoTracer (perception-keeping lock, contact and
bullet-damage handoff); copying its code is allowed under AGPL but ties us to its licence (below).

**Licence implications** (not legal advice; John should decide):

- Bot-Controller is AGPL-3.0-only ([bc-license]); Bot-Nav and DemoTracer's playback code are AGPL-3.0
  ([nav-license], [dt-readme]). CSS is GPLv3, with an exception allowing plugins under MIT ([css-license]).
- Our plugin would load `BotControllerApi.dll` and `BotNav.dll` and call them in-process. Treat it as a work based on
  AGPL code: licence the CS2 plugin, including the C# port of Core, as AGPL-3.0.
- AGPL §13: once anyone other than the operator connects to a server running *modified* AGPL code (cart, eradicate),
  they must be offered its corresponding source. The simplest way is a public repo for the fork and the plugin,
  linked from the server's MOTD or chat. Running the released, unmodified Bot-Controller adds no source obligation
  for that component.
- The TypeScript web app and 2D sim are a separate program that never links AGPL code, so they can stay private and
  `UNLICENSED`. To keep Core's C# port private too, run it out of process (IPC) instead of inside the plugin. That
  boundary is weaker in law and costs latency, so it is not recommended unless privacy matters.
- A private probe server that only the probe agent connects to triggers no distribution or §13 obligation.

## Findings that should change the Core contracts

These are proposals for the contracts owner (task A4). This task changes no interface.

- **F1. Angles.** Define the `pitch` sign and range (Source: positive = down, about ±89) and the `yaw` range
  (normalise to [−180, 180) or [0, 360)) in `docs/contracts.md` and the `PawnInput` doc comments. The C# port and the
  CS2 adapter need one answer.
- **F2. `WeaponId` is too small for CS2.** Missing: `glock` (already in `data/round.json` for donk), the CT default
  pistols (`usp_silencer`, `hkp2000`), `incgrenade` (the CT molotov), `m4a1_silencer`. `tuning.json` already lists
  `m4a1`, `famas` and `galil`. A LIVE bot can hold any of these, and Observe's `weapon` can't say so. Add them, or add
  an `other` value.
- **F3. `Hitgroup` lacks `generic` and `neck`.** World, bomb, fall and fire damage has no body part, and CS2 reports a
  neck hitgroup (8). Either add both or make `DamageEvent.hitgroup` nullable.
- **F4. `SoundEvent.source` is non-null,** but `bomb_beep` has no player. Make it nullable, or define bomb sounds as
  coming from the planter. `land` has no engine event, so the adapter derives it; the contract should say landing
  sounds are adapter-derived.
- **F5. `sees` in CS2 is adapter-computed.** The contract should say whether smoke and flashes block it, whether
  teammates are included, and the eye height used (e.g. `AbsOrigin + ViewOffset`). *Resolved in C4:* both teams, eye
  to eye, FOV `ai.fovDeg`, smoke blocks, a flashed viewer sees nothing, dead pawns neither see nor are seen
  (`docs/contracts.md`, "sees"; the 2D version in `docs/vision.md`).
- **F6. Control and snapshots.** `seek` (except t = 0), `checkpoint`/`rewind`, `speed` and
  `IHost.snapshot()/restore()` can't be done faithfully on a live CS2 server. Make them optional host capabilities
  (e.g. an `IHost.capabilities()` list) so Core and the app degrade gracefully. **Done in B5:** `HostCapabilities
  {snapshot, seek, speed}`; the CS2 adapter returns all false and rewinds resync (`docs/core.md` "Checkpoints, rewind,
  summary", `docs/port-notes.md`).
- **F7. Shots.** Single-tick `ATTACK` taps can't reproduce a 600 rpm spray at 64 tick: the 6.4-tick cycle means taps 6
  ticks apart probably arrive early and are dropped (P3 confirms). Core should express a spray as `ATTACK` held for
  the whole window and let the engine set the cadence; keep single taps for single shots.
- **F8. Latency.** Act is "same tick" in the contract, but CS2 may apply inputs on the next simulated tick (P1). Either
  document a one-tick input latency for the CS2 host or make Core's REPLAY follower tolerant of it.
- **F9. Data note for B-tasks.** donk's lethal hit is at t = 50.3 (tick 3219) while the kill feed says 50.35 (tick
  3222). The engine applies death on the lethal damage tick, so Core should schedule the death there.

## Sources

Read 2026-11-05. Code links are pinned to the commit or tag read.

[css-changelog]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/CHANGELOG.md
[css-license]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/LICENSE
[css-listeners]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Core/Listeners.g.cs
[css-docs-takedamage]: https://docs.cssharp.dev/api/CounterStrikeSharp.API.Core.Listeners.OnEntityTakeDamagePre.html
[css-server]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Server.cs
[css-utilities]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Utilities.cs
[css-baseentity]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Core/Model/CBaseEntity.cs
[css-controller]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Core/Model/CCSPlayerController.cs
[css-ev-takeover]: https://docs.cssharp.dev/api/CounterStrikeSharp.API.Core.EventBotTakeover.html
[cs2-takeover]: https://cs2pulse.com/how-to-control-bots-in-cs2
[css-controller-schema]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Generated/Schema/Classes/CCSPlayerController.g.cs
[css-gamerules]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Core/Model/CCSGameRules.cs
[css-vfuncs]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Modules/Memory/VirtualFunctions.cs
[css-dmginfo-hitgroup]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Core/Model/CTakeDamageInfo.cs
[css-trace]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Modules/Utils/Trace.cs
[css-buttons]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/PlayerButtons.cs
[css-roundend]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Modules/Entities/Constants/RoundEndReason.cs
[css-gameevent]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Modules/Events/GameEvent.cs
[css-gamedata]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/configs/addons/counterstrikesharp/gamedata/gamedata.json
[css-schema-entity]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Generated/Schema/Classes/CBaseEntity.g.cs
[css-schema-model]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Generated/Schema/Classes/CBaseModelEntity.g.cs
[css-schema-basepawn]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Generated/Schema/Classes/CBasePlayerPawn.g.cs
[css-schema-pawn]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Generated/Schema/Classes/CCSPlayerPawn.g.cs
[css-schema-csmove]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Generated/Schema/Classes/CCSPlayer_MovementServices.g.cs
[css-schema-weapon]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Generated/Schema/Classes/CBasePlayerWeapon.g.cs
[css-schema-weaponvdata]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Generated/Schema/Classes/CCSWeaponBaseVData.g.cs
[css-schema-items]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Generated/Schema/Classes/CCSPlayer_ItemServices.g.cs
[css-schema-gamerules]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Generated/Schema/Classes/CCSGameRules.g.cs
[css-schema-c4]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Generated/Schema/Classes/CPlantedC4.g.cs
[css-schema-dmginfo]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Generated/Schema/Classes/CTakeDamageInfo.g.cs
[css-schema-bot]: https://docs.cssharp.dev/api/CounterStrikeSharp.API.Core.CCSBot.html
[css-ev-hurt]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Generated/GameEvents/EventPlayerHurt.g.cs
[css-ev-death]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Generated/GameEvents/EventPlayerDeath.g.cs
[css-ev-fire]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Generated/GameEvents/EventWeaponFire.g.cs
[css-ev-reload]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Generated/GameEvents/EventWeaponReload.g.cs
[css-ev-footstep]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Generated/GameEvents/EventPlayerFootstep.g.cs
[css-ev-sound]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Generated/GameEvents/EventPlayerSound.g.cs
[css-ev-grenade]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Generated/GameEvents/EventGrenadeThrown.g.cs
[css-ev-smoke]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Generated/GameEvents/EventSmokegrenadeDetonate.g.cs
[css-ev-beep]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Generated/GameEvents/EventBombBeep.g.cs
[css-ev-planted]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Generated/GameEvents/EventBombPlanted.g.cs
[css-ev-begindefuse]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Generated/GameEvents/EventBombBegindefuse.g.cs
[css-ev-defused]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Generated/GameEvents/EventBombDefused.g.cs
[css-ev-exploded]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Generated/GameEvents/EventBombExploded.g.cs
[css-ev-roundend]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Generated/GameEvents/EventRoundEnd.g.cs
[css-ev-freezeend]: https://github.com/roflmuffin/CounterStrikeSharp/blob/v1.0.379/managed/CounterStrikeSharp.API/Generated/GameEvents/EventRoundFreezeEnd.g.cs
[bc-readme]: https://github.com/XBribo/CS2-Bot-Locker/blob/71319b0477ec688f8bdc2fe0633ef992a7cd700a/README.md
[bc-tech]: https://github.com/XBribo/CS2-Bot-Locker/blob/71319b0477ec688f8bdc2fe0633ef992a7cd700a/TECH.md
[bc-license]: https://github.com/XBribo/CS2-Bot-Locker/blob/71319b0477ec688f8bdc2fe0633ef992a7cd700a/LICENSE
[bc-api]: https://github.com/XBribo/CS2-Bot-Locker/blob/71319b0477ec688f8bdc2fe0633ef992a7cd700a/csharp/BotControllerApi/IBotControllerApi.cs
[bc-types]: https://github.com/XBribo/CS2-Bot-Locker/blob/71319b0477ec688f8bdc2fe0633ef992a7cd700a/csharp/BotControllerApi/Types.cs
[bc-injector]: https://github.com/XBribo/CS2-Bot-Locker/blob/71319b0477ec688f8bdc2fe0633ef992a7cd700a/src/features/recorder/InputInjector.cpp
[bc-recorder]: https://github.com/XBribo/CS2-Bot-Locker/blob/71319b0477ec688f8bdc2fe0633ef992a7cd700a/src/features/recorder/MotionRecorder.cpp
[bc-controller]: https://github.com/XBribo/CS2-Bot-Locker/blob/71319b0477ec688f8bdc2fe0633ef992a7cd700a/src/features/controller/BotController.cpp
[bc-gamedata]: https://github.com/XBribo/CS2-Bot-Locker/blob/71319b0477ec688f8bdc2fe0633ef992a7cd700a/configs/addons/BotController/gamedata.json
[bc-sigs]: https://github.com/XBribo/cs2-bot-signatures
[nav-readme]: https://github.com/ed0ard/CS2-Bot-Nav/blob/0d1d04f8eb748e3434462d2a799ca89ab299e583/README.md
[nav-src]: https://github.com/ed0ard/CS2-Bot-Nav/blob/0d1d04f8eb748e3434462d2a799ca89ab299e583/BotNav.cs
[nav-csproj]: https://github.com/ed0ard/CS2-Bot-Nav/blob/0d1d04f8eb748e3434462d2a799ca89ab299e583/BotNav.csproj
[nav-license]: https://github.com/ed0ard/CS2-Bot-Nav/blob/0d1d04f8eb748e3434462d2a799ca89ab299e583/LICENSE
[dt-readme]: https://github.com/unicbm/demotracer/blob/1a44ca9b8c9fda5482bb327763f658ccfa7cbdf7/README.md
[dt-server]: https://github.com/unicbm/demotracer/blob/1a44ca9b8c9fda5482bb327763f658ccfa7cbdf7/server/README.md
[dt-controller]: https://github.com/unicbm/demotracer/blob/1a44ca9b8c9fda5482bb327763f658ccfa7cbdf7/server/runtime/dtr-controller/README.md
[dt-controller-upstream]: https://github.com/unicbm/demotracer/blob/1a44ca9b8c9fda5482bb327763f658ccfa7cbdf7/server/runtime/dtr-controller/UPSTREAM.md
[dt-commands]: https://github.com/unicbm/demotracer/blob/1a44ca9b8c9fda5482bb327763f658ccfa7cbdf7/docs/COMMANDS.md
[dt-combat]: https://github.com/unicbm/demotracer/blob/1a44ca9b8c9fda5482bb327763f658ccfa7cbdf7/server/plugins/DemoTracer/src/DemoTracer/Playback/DemoTracerCombat.cs
[dt-gamedata]: https://github.com/unicbm/demotracer/blob/1a44ca9b8c9fda5482bb327763f658ccfa7cbdf7/server/runtime/dtr-controller/configs/addons/dtr-controller/gamedata.json
[retakes-bomb]: https://github.com/B3none/cs2-retakes/blob/2fde4a9cc21e791d6909b98bacc833aa5c54bdad/RetakesPlugin/Services/BombService.cs
[opp-aim]: https://github.com/lengran/OpenPrefirePrac/blob/44fb66eab70fb3b1b7112ed3c30cc68fb977dd26/OpenPrefirePrac.cs
[scope-bomb]: https://scope.gg/guides/bomb_complete_guide_en/
[cs2-defuse-delay]: https://twogpedia.com/News/CS2_to_Change_Defuse_Mechanic

| Ref | What was used from it |
| --- | --- |
| [css-changelog] | .NET 10 (v1.0.369), Trace API (v1.0.372), KHook (v1.0.375), game-update fixes (v1.0.375–v1.0.379) |
| [css-listeners], [css-docs-takedamage] | `OnTick`, `OnPlayerTakeDamagePre/Post`, `OnEntityTakeDamagePre` semantics |
| [css-schema-bot] | `CCSBot` perception and look fields (`IsEnemyVisible`, `VisibleEnemyParts`, `Enemy`, `LookYaw/Pitch`, `IsStuck`) |
| [bc-tech], [bc-api], [bc-types] | Bot-Controller's C# API, locks, injection semantics, replay buffer format |
| [bc-injector], [bc-recorder], [bc-controller] | What the native hooks actually write (buttons and moves only in the live path; view and origin in replay) |
| [nav-readme], [nav-src] | Bot-Nav API, 0.1 s reissue, 40-unit auto-release, hard-coded signatures |
| [dt-server], [dt-controller], [dt-commands], [dt-combat], [dt-gamedata] | Windows-only runtime, perception-keeping replay, contact handoff, empty Linux signatures |
| [retakes-bomb] | `planted_c4` spawn recipe |
| [opp-aim] | CSS-only bot aim (`Teleport` angles + `EyeAngles`) |
| [scope-bomb], [cs2-defuse-delay] | Secondary sources on plant and defuse input; treat as hints only |
