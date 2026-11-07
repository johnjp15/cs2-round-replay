# CS2 probe results (template)

Copy this file for a run and fill it in; keep this template blank. One run log per probe session. Cards are in
[`README.md`](README.md).

## Run

| Field | Value |
| --- | --- |
| Date (UTC) | |
| Agent / session | |
| Host (OS, CPU, RAM) | |
| CS2 build (`version`) | |
| Metamod build (`meta version`) | |
| CounterStrikeSharp (`css_plugins list` / `probe_status`) | |
| Bot-Controller (version, `ApiVersion`, fork commit if any) | |
| CS2-Bot-Nav (`ModuleVersion`) | |
| cs2probe harness commit | |
| Launch line | |
| Cvars not recognised by this build | |
| Where raw CSVs and demos are stored | |

## Summary

| Card | Result (PASS / PARTIAL / FAIL / not run) | Chosen route / fallback taken | Notes |
| --- | --- | --- | --- |
| P0 coordinate check | | | |
| P0b movement calibration | | | |
| P1 locked-bot track | | | |
| P2 view angles | | route: | |
| P3 attack cadence | | | |
| P4 scripted damage | | route: | |
| P5 REPLAY → LIVE | | variant: | |
| P6 visibility cost | | | |
| P7 round start (A) | | clock route: | |
| P7 bomb timings (B) | | plant input: | |
| P8 takeover (G4) | | restriction / release route: | |

## P0 — coordinate check

| # | Spot | requested (x, y, z+16) | settled (x, y, z) | dx, dy | dz | on ground | hull solid | ground z | OK |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | B plant | −1982, 311, −144 | | | | | | | |
| 2 | Top of T Ramp | 240, −1500, −160 | | | | | | | |
| 3 | Apartments window | −1764, 794, −32 | | | | | | | |
| 4 | Truck | −2387, 815, −111 | | | | | | | |
| 5 | Shop | −2364, −674, −152 | | | | | | | |
| 6 | Catwalk | −726, 243, −156 | | | | | | | |
| 7 | Tunnel stairs | −786, 391, −302 | | | | | | | |
| 8 | Palace Alley | 785, −1144, −248 | | | | | | | |
| T1–T10 | track samples (eradicate, snarlbot) | | | | | | | | |

Global offset found (if any): ____

## P0b — movement calibration

Cvars (`find …` output):

```text
```

| Weapon | v_ss run (3 runs) | VData MaxSpeed | fitted a | fitted f | fitted s | fit RMS |
| --- | --- | --- | --- | --- | --- | --- |
| knife | | | | | | |
| ak47 | | | | | | |
| awp | | | | | | |
| ssg08 | | | | | | |
| deagle | | | | | | |
| m4a4 | | | | | | |

| Case (ak47) | v_ss | ratio to run | footstep radius | notes |
| --- | --- | --- | --- | --- |
| walk (bit 1<<16) | | | | |
| walk (bit 1<<17) | | | | |
| crouch | | | | |
| analog 0.5 | | | | |
| analog 0.25 | | | | |
| strafe right | | heading: | | |
| diagonal | | heading: | | |

Input latency (ticks): ____ · WALK bit: ____ · `DuckAmount` notes: ____

## P1 — locked-bot track

| Run | track | lookahead | nudges | mean e | p95 e | max e | max \|dz\| | nudge ticks | snaps | final e | latency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | eradicate | 0.15 | off | | | | | | | | |

Best lookahead: ____

## P2 — view angles

| Route | hold error yaw/pitch (max) | usercmd view error | shot error (18 shots) | lag @6/12/24 °/tick | move heading error | persistence | cost µs (10 bots) | result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | | | | | | | | |
| A′ (+V_angle) | | | | | | | | |
| A2 | | | | | | | | |
| B (fork) | | | | | | | | |
| C | | | | | | | | |

Client check notes: ____

## P3 — attack cadence

| Case | presses | shots fired | shot ticks | latency | notes |
| --- | --- | --- | --- | --- | --- |
| single taps ×10 | 10 | | | | |
| round(i·6.4) taps | 10 | | | | |
| 7-tick taps | 10 | | | | |
| hold 58 | — | | | | |
| hold 60 | — | | | | |
| hold 64 | — | | | | |
| 900 ms duration | 1 | | | | |

| Weapon | Damage | HeadshotMult | ArmorRatio (/2) | CycleTime → rpm | measured rpm | MaxClip1 | reserve | reload s | scope ok |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ak47 | | | | | | | | | — |
| awp | | | | | | | | | |
| ssg08 | | | | | | | | | |
| deagle | | | | | | | | | — |
| m4a4 | | | | | | | | | — |

## P4 — scripted damage

Leak test: ____ leaked events in ____ s.

| Route | run | HP @64 | HP @70 | HP @76 | HP @89 | death tick | attacker / weapon / hs | client kill feed | scoreboard K/D | money | result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | | | | | | | | | | |
| 3 | 1 | | | | | | | | | | |
| 2 | 1 | | | | | | | | | | |

Headshot variant (lokier → eradicate): ____ · Scoreboard fixes needed: ____

## P5 — REPLAY → LIVE

| Variant | run | min speed / pre | ticks < 50 % | max path dev | waypoints reached | first visible → native visible → first shot (s) | aim error | MoveTo interruptions | result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a | 1 | | | | | | | | |
| b | 1 | | | | | | | | |

Perception staleness notes: ____

## P6 — visibility cost

| Case | traces/tick | block p50 µs | block p99 µs | max µs | tick interval p99 ms | CPU % |
| --- | --- | --- | --- | --- | --- | --- |
| baseline | 0 | — | — | — | | |
| enemies | 50 | | | | | |
| all pairs | 90 | | | | | |
| 4 rays | 200 | | | | | |

Agreement with native: ____ % (best FOV ____°) · Smoke: raw sees through = __, sphere test = __, native = __ ·
Smoke lifetime ____ s · Molotov ____ s

## P7 — round start

| Clock route | run | remaining at t = 0 (s) | HUD | max start distance | kits OK (n/10) | first-kill tick | fields | score | result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 1 | | | | | | | | |

`RoundTime` per `mp_roundtime_defuse` value: ____

| Bomb case | input | plantSec | timer (C4Blow − now) | explosion after | defuse time | events in order | round_end |
| --- | --- | --- | --- | --- | --- | --- | --- |
| engine plant | ATTACK | | | | — | | |
| engine plant | USE | | | | — | | |
| spawned planted_c4 | — | — | | | — | | |
| defuse with kit | USE | — | — | — | | | |
| defuse without kit | USE | — | — | — | | | |
| defuse abort | USE | — | — | — | — | | — |

## P8 — takeover (G4)

| Variant | run | position jump (u) | velocity / view continuous | E → `bot_takeover` (ticks) | → player input moves pawn (ticks) | injector fights player (ticks) | result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| a (unlocked) | 1 | | | | | — | |
| b (lock kept) | 1 | | | | | | |

Restriction route that blocks donk and keeps cart: ____. Release route: ____ (ticks until the bot drives the pawn
again: ____; pawn alive and in place: ____). Second takeover in the round: as is / after clearing the flags /
impossible.

## Proposed `data/tuning.json` changes

| Key | Current | Measured | Proposed | Card / run | Notes |
| --- | --- | --- | --- | --- | --- |
| movement.svAccelerate | 5.5 | | | P0b | |
| movement.svFriction | 5.2 | | | P0b | |
| movement.svStopSpeed | 80 | | | P0b | |
| movement.walkFactor | 0.52 | | | P0b | |
| movement.crouchFactor | 0.34 | | | P0b | |
| movement.runSpeedByWeapon.* | see file | | | P0b | |
| replay.lookaheadSec | 0.15 | | | P1 | |
| replay.driftNudgeUnits | 24 | | | P1 | |
| replay.driftSnapUnits | 96 | | | P1 | |
| replay.walkSpeedThreshold | 120 | | | P0b | |
| replay.crouchSpeedThreshold | 60 | | | P0b | |
| replay.maxTurnRateDegPerTick | 12 | | | P2 | |
| replay.hearingRangeUnits | 1500 | | | P0b | |
| weapons.* | see file | | | P3 | |
| bomb.plantSec | 3.2 | | | P7 | |
| bomb.timerSec | 40 | | | P7 | |
| bomb.defuseSec | 10 | | | P7 | |
| bomb.defuseKitSec | 5 | | | P7 | |
| grenades.smokeSec | 18 | | | P6 | |
| grenades.molotovSec | 7 | | | P6 | |
| ai.fovDeg | 106 | | | P6 | |
| ai.reactionSec | 0.25 | | | P5 | |
| ai.aimErrorDeg | 2.5 | | | P5 | |

## Contract findings confirmed or refuted

| Finding (`cs2-adapter.md`) | Confirmed / refuted | Evidence |
| --- | --- | --- |
| F7 taps drop shots at 6.4-tick cadence | | P3 |
| F8 one-tick input latency | | P1, P3 |
| F5 traces see through smoke | | P6 |
