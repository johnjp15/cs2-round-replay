# P2: view angles per tick on a locked bot

## Goal

Find a way to set a locked bot's view (yaw and pitch) on every tick such that (a) the pawn's eye angles follow the
command, (b) a shot goes where the view points, and (c) injected forward/side move relative to that view.
Movement-doc item 2. This is the top risk in `cs2-adapter.md`: Bot-Controller has no live view API.

Depends on: S0.

## Routes under test (in this order; stop at the first that passes)

| Route | What the harness does every tick | Needs |
| --- | --- | --- |
| **A** | `pawn.Teleport(null, new QAngle(pitch, yaw, 0), null)`, then write `pawn.EyeAngles.X/Y`. Variant A′ also writes `pawn.V_angle`. Prior art: [OpenPrefirePrac's aim lock](https://github.com/lengran/OpenPrefirePrac/blob/44fb66eab70fb3b1b7112ed3c30cc68fb977dd26/OpenPrefirePrac.cs) (run on unlocked bots, in `Server.NextFrame`) | CSS only |
| **A2** | Call `CCSPlayerPawn::SetEyeAngles(pawn, QAngle*)` through `new MemoryFunctionVoid<nint, nint>(sig)`, with the Linux signature from Bot-Controller's [gamedata.json](https://github.com/XBribo/CS2-Bot-Locker/blob/71319b0477ec688f8bdc2fe0633ef992a7cd700a/configs/addons/BotController/gamedata.json) (`CCSPlayerPawn::SetEyeAngles`). Bot-Controller supersedes this function only for slots it is replaying | CSS + a copied signature |
| **B** | Fork of Bot-Controller: a `StartUsercmdView / UpdateUsercmdView / CancelUsercmdView` token. In `ApplyUsercmdControls` it sets `base.mutable_viewangles()` (x = pitch, y = normalised yaw, z = 0), clears subtick `pitch_delta`/`yaw_delta`, then calls the original `SetEyeAngles` and writes `v_angle`/old view angles, as `ApplyReplayUserCommand` and `OnReplayCommandPre` already do for replays | C++ fork, Linux build |
| **C** | Synthesized replay: a `ReplayTick` + `ReplayCommandFrame` buffer per tick with the view set, through `LoadReplay`/`StartReplay` | Released binary; positions become kinematic |

## Setup

- `exec cs2probe`, `mp_restartgame 1`; also `weapon_accuracy_nospread 1` and `sv_showimpacts 1` (if they exist in
  this build; note in `results.md` if not).
- Spot: Bombsite B, (−1675, 300, −168). There is open ground all round, so a shot pitched down 10° lands on the floor
  about 360 units away in any direction.
- `probe_spawn aim CT -1675 300 -168 0 weapon_ak47`, then `probe_lock aim all`.
- **Usercmd view readback:** before each case, `SetReplayPawn(slot, pawnHandle)` + `StartRecord(slot)`; afterwards
  `StopRecord(slot)` + `GetRecordedMotionExtended(slot)`. `commands[i].Pitch/Yaw` is the view the usercmd carried, and
  `ticks[i].Pre.Yaw/Pitch` is the pawn's view ([Types.cs](https://github.com/XBribo/CS2-Bot-Locker/blob/71319b0477ec688f8bdc2fe0633ef992a7cd700a/csharp/BotControllerApi/Types.cs)).
- `probe_log on p2-<route>-<case>` for every case. Also log `bullet_impact` (x, y, z) and `weapon_fire`.

## Steps (per route)

1. **Static hold:** yaw 0, 45, …, 315 at pitch 0, then pitch −30, +10, +30 at yaw 0. Hold each for 32 ticks with
   `probe_aim aim <yaw> <pitch> <route> 32`.
2. **Shot check:** at yaw 0, 45, …, 315 with pitch +10, and at yaw 0 with pitch +30: on tick 16 of each hold,
   `probe_press aim ATTACK 1 1 0`, then wait 32 ticks. That is 9 shots. Repeat the whole set twice (18 shots).
3. **Tracking:** command yaw = yaw₀ + 12°·k for k = 0..29 (12°/tick), then 24°/tick and 6°/tick. Log the achieved
   `EyeAngles.Y` per tick.
4. **Movement frame:** with yaw held at 90, `probe_move aim 1 0 64`. The velocity heading should be 90°. With yaw
   held at 0, `probe_move aim 0 1 64` (right, so −y). The heading should be −90°.
5. **Persistence:** set yaw 135 once, stop the route, and watch for 64 ticks: does the view stay, drift, or snap back?
6. **Client check (optional):** a connected client `spec_player aim`, first person. Does the view turn smoothly, and
   does the third-person model's head and body turn? Record a short clip or screenshots.
7. **Cost:** time the route's per-tick call with a Stopwatch for 10 bots (µs per tick).

## Measurements

| Quantity | Unit | `tuning.json` key |
| --- | --- | --- |
| \|commanded − `EyeAngles`\| at the end of each hold (yaw and pitch) | deg | — |
| \|commanded − usercmd view\| (from the recording readback) | deg | — |
| shot error = angle between the commanded direction and (impact − eye), eye = origin + `ViewOffset` | deg | — |
| tracking lag (ticks behind the command) at 6, 12 and 24°/tick | ticks | `replay.maxTurnRateDegPerTick` (largest rate with lag ≤ 1) |
| movement heading − commanded yaw | deg | — |
| persistence after release (stays / drifts / snaps) | — | — |
| per-tick cost for 10 bots | µs | — |

## Pass / fail

A route **PASSES** when all of these hold:

- `EyeAngles` within 0.5° of the command on the same or the next tick, for every hold;
- shot error ≤ 1.0° for 18 of 18 shots with no-spread on, or ≤ 2.0° without it;
- movement heading within 5° of the commanded yaw (so forward/side are relative to the set view);
- tracking lag ≤ 1 tick at 12°/tick;
- cost ≤ 200 µs per tick for 10 bots.

Record which route passed. If none passes, the card **FAILS**.

## Fallback

- **A passes `EyeAngles` but shots miss** (CS2 shoots from the command's view or input history): go to A2, then B.
- **A and A2 fail:** build route B (fork). Patch outline: `InputInjector.cpp` (new `UsercmdView` list per slot,
  applied in `ApplyUsercmdControls`; call `SetEyeAngles` from `PlayerRunCommandPre`), `exports.cpp`/`dispatch.*`
  (three exports), `csharp/BotControllerApi` (`IBotControllerApi` additions, `ApiVersion` 2). Build with Bot-Controller's
  `build.ps1 -Linux` (WSL) or CMake on Linux. Estimate 1–2 days including the toolchain. Offer the patch upstream.
- **Movement frame wrong but `EyeAngles` right:** the adapter computes forward/side against the usercmd's yaw (from
  the readback) instead of `EyeAngles`. Contract finding F8 covers the latency side.
- **Nothing works:** route C for REPLAY puppets (kinematic). Aim becomes cosmetic, and damage must use P4 Route 3,
  which doesn't depend on aim.

## Record

Fill in the P2 section of `results.md`: one table per route tried, plus the chosen route.
