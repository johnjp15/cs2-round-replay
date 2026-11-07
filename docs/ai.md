# LIVE AI in the 2D sim (C4: `src/sim2d/ai.ts`, `Sim2DHost`)

When something unscripted happens to a puppet, the Core (B4) sends `set_mode {id, mode: 'LIVE', goal}` and from then
on the **engine** drives that pawn. In CS2 that is the native bot AI, unlocked (`docs/cs2-adapter.md`, risk 5). In the
2D sim it is this small bot: it follows its goal, fights, plants and defuses, deterministically from the host's seed.

## Control

- **Who is LIVE.** A pawn whose last `set_mode` is `LIVE`. Every `set_mode LIVE` starts its goal afresh (route from its
  first waypoint, nothing remembered but the random-draw count); `set_mode REPLAY` drops the AI state and Core inputs
  drive the pawn again.
- **Inputs.** Core inputs for a LIVE pawn are ignored. The human's input still wins on the human's own pawn (the Core
  should never set it LIVE). Actions still apply to LIVE pawns (`teleport`, `set_hp`, `give`, `set_weapon`, damage…);
  a teleported LIVE pawn re-plans from where it lands.
- **When it thinks.** At the start of `tick()`, before the movement locks, for each LIVE, alive pawn in id order. It
  reads only what the pawn could know: its own state (its defuse progress bar included), its `sees` (the same lists
  `observe()` reported for this state), the previous tick's events (sounds, the bomb), where its own team's planted bomb
  is, the bomb's explode tick and the round's phase as the round shows them (`observe.round`). So it has the Core's
  latency: what it sees on tick k changes its input on tick k.
- **Weapon switches** it asks for are applied at once, with the deploy time, like a `set_weapon`.
- **Randomness:** each draw is `new Rng(seed).fork('ai:' + id).fork('d' + n).next()` for the pawn's n-th draw
  (`src/contracts/rng.ts`). The host's seed is `Sim2DVision.seed` (the Session's seed); pawns never share a stream,
  and a snapshot only needs each pawn's draw count. No `Math.random`.
- **Snapshot** version 4: each pawn carries `ai` (plain data) and `aiDraws`, the host `aiSeed`. F added two optional
  fields to `ai` (`escape`, `abandoned`); a state without them reads as none.
- **`host.aiDebug(id)`** → `{id, role, behaviour, target, targetVisible, lastKnown, dest, path, routeIndex, repaths,
  sinceTick}` for a LIVE pawn, else null. Not in `observe()`. The app (F) shows `behaviour`, `target` and the goal
  (`role` → `dest`) under the pawn's row in the status panel (Tab), and with the tracks overlay (T) its `path` as a faint
  dashed magenta line from the pawn with a ring at the next waypoint (`docs/app.md`). 2D debug: the Core never reads it.

## Roles (`goal.role`, exact strings)

Every role first walks `goal.route` waypoint by waypoint (each reached within `ai.arriveUnits`, 24), then does what
the table says; the bomb's blast (next section) comes before both.

| role | behaviour |
| --- | --- |
| `hold` | Go to `goal.hold` (else the last route point, else stay), then face the most likely enemy approach and stay. |
| `rotate` | The same as `hold`: via the route to `goal.hold`, then hold. |
| `take_site`, `plant` | A T with the c4 goes to its plant spot and plants: `goal.hold` if it is in a bombsite, else the centre (area-weighted centroid of the nav place) of the bombsite nearest to the end of the route (or to the pawn). Inside a bombsite and within `ai.plantSpotUnits` (150) of the spot it draws the c4 and holds USE; the engine locks it in place and plants after 3.2 s (`docs/combat.md`). Without the c4 it holds at `goal.hold`; once the bomb is planted it guards it (next row). |
| `guard_bomb` | A T after the plant holds a spot within `ai.guardMaxUnits` (800) of the bomb with sight to it (`goal.hold` if that qualifies, else the nearest walkable point on rings of 300, 450, 600, 750 units every 15° with eye-to-bomb sight), facing the bomb. Before the plant: `hold`. |
| `retake`, `defuse` | A CT goes to the planted bomb once it knows where it is (from the bomb's beeps, which only these roles listen to), walks to within `ai.defuseRangeFactor` × `bomb.defuseRange` (0.6 × 62 units), and holds USE only while no enemy is in its `sees` (it fights first). The engine defuses in 5 s with a kit, 10 s without. No bomb yet: `hold`. |
| `hunt` | Go to the last known enemy position (seen or heard, at most `ai.memorySec` old); reaching it without contact forgets it and holds there (`searching`). Nothing known: `hold`. |
| `rejoin` (G1) | Heading back to its recorded track (docs/core.md "Rejoin"): the Core picked `goal.hold`, a point of its reference track it can reach in time (route empty). Go there by the nav path, **running** (never WALK, even near a known enemy: time matters more than noise), keeping the held item (the Core may have drawn the c4 for a planter going back into his plant window), and wait there facing the likely approach. It still fights what it sees (it draws its best gun for that, as always). The Core switches it to REPLAY on the way, usually long before it arrives. `aiDebug().behaviour` is `rejoining`. |
| anything else | `hold` (aiDebug reports `hold`). |

### The bomb's blast (F)

- **After the round.** Once `observe.round.phase` is `over` with the bomb still ticking (the Ts won by elimination, or an
  `end_round` was forced), every LIVE pawn of either team, whatever its role and route, gets out of the blast: it runs
  (no WALK) to the nearest point at least `bomb.radius` + `ai.blastMarginUnits` (1,750 + 64 units, 3D) from the bomb,
  then holds there, facing the enemy's approach, also after the explosion (`escapeSpot`: a Dijkstra over the nav areas
  from the pawn, the first area with such a point by walking distance; a pawn already clear just holds). It still
  fights whatever it sees on the way.
- **A defuse too late.** A LIVE CT with `retake` or `defuse` gives the defuse up and saves himself the same way when it
  can't finish before the explosion (`canFinishDefuse`): while defusing, if its progress bar ends at or after the
  explode tick (the engine's rule); otherwise if the time left is less than the walk to within the defuse range (the
  nav path at the held weapon's run speed) + the defuse (`bomb.defuseKitSec` 5 s with a kit, else `bomb.defuseSec` 10 s)
  + `ai.defuseMarginSec` (0.25 s). Once given up it stays given up for that goal. CS players do this: with 4 s left and
  no time to reach the bomb, you run.

**Facing while holding** (computed on arrival): (1) toward a known enemy position (at most `memorySec` old): the first leg
of the nav path from the spot to it; else (2) the most likely approach: the last leg of the nav path from the enemy
side's spawn (place `T Spawn` for a CT, `CT Spawn` for a T) to the spot, reversed; else (3) the goal route's last leg
reversed; else the current yaw. While moving it looks where it goes, or at a heard sound.

`aiDebug().behaviour` is one of `route moving holding planting guarding defusing hunting searching reacting fighting
escaping rejoining` (G1: `rejoining` for the `rejoin` role, moving or waiting).

## Navigation

- `nav.path` from the pawn to its current destination (route waypoint or spot); each tick it skips ahead to the furthest
  later path point it can walk to in a straight line, and if the next point isn't walkable from where it actually is (a
  corner cut short), it re-plans from there.
- Runs; holds WALK within `ai.walkNearEnemyUnits` (600) of a known enemy position. Eases off in the last 48 units.
- **Stuck:** if the remaining path length hasn't dropped by `ai.stuckProgressUnits` (16) in `ai.stuckSec` (1 s), it
  re-plans and strafes sideways (seeded side) for `ai.unstickSec` (0.4 s). `aiDebug().repaths` counts these.

## Combat

- **Target:** the nearest enemy in `sees`; it keeps its target while it is out of sight for up to `ai.targetLostSec`
  (0.5 s), aiming at where it was last seen, then drops it.
- **Reaction:** nothing changes for `ai.reactionSec` × (1 ± `ai.reactionJitter`) (0.25 s ± 30 %, seeded) after a target
  is acquired. G7: a `hold` pawn, while the target is in sight, stops (counter-strafes) and turns toward it meanwhile, instead of
  walking on to its hold spot (other roles react on the move, as before): before G7 a LIVE Lokier who saw cart in the
  Apartments corridor walked off Truck toward his hold spot during his reaction and lost sight before he could shoot.
  Then it turns at up to `ai.turnRateDegPerTick` (12°) in yaw and pitch and
  counter-strafes: it pushes against its velocity while faster than `ai.counterStrafeSpeed` (40 u/s), then stands.
- **Aim:** at acquisition it draws a yaw and a pitch offset ~ N(0, `ai.aimErrorDeg` = 2.5°) and a band: head with
  probability `ai.headshotAimRatio` (0.35), else chest (pitch from `aimPitch`, `docs/combat.md`). The offset halves
  every `ai.aimSettleSec` (0.15 s) once it is engaged. Each shot adds a fresh N(0, `ai.aimResidualDeg` = 0.5°) to yaw and
  pitch for that tick only.
- **Recoil control (B1, 3D host):** the wanted yaw and pitch are the target's minus `self.aimPunch` (the weapon's aim
  punch × recoilScale the next shot will get), so the spray stays on the target like a player pulling down; the errors
  above stay centred on the target. The 2D host has no recoil and passes none (docs/weapons.md).
- **Fire:** when the view is within `ai.fireConeDeg` (1.5°) of the aim point and the settling offset is within the
  target's angular radius (asin(16 / distance); pitch: `damage.hitToleranceDeg`):
  - automatic guns hold ATTACK, starting within `ai.sprayStartFactor` (2) × that radius;
  - semi-automatic guns tap: ATTACK for one tick when the gun is ready, released the next, and not before
    `ai.semiAutoSettleFactor` × `aimSettleSec` (0.15 s) on target.
- **Reload:** RELOAD when the magazine is empty, or when it is at most `ai.reloadClipFraction` (30 %) full with no
  target. **Weapons:** it draws its best gun (primary, else secondary, with ammo) when holding the knife, a grenade or the
  c4 outside a plant.

## Hearing

From the previous tick's `sound` events: an enemy `shot` or `footstep` within `replay.hearingRangeUnits` (1500) whose
source isn't in its `sees` becomes the last known enemy position (unless an enemy is in sight), and with no target it
turns toward it for `ai.soundLookSec` (1.5 s). Sounds with `source: null` (bomb beeps) are ignored, except by a CT with
the `retake` or `defuse` role, which learns the bomb's position from them. Ts know where their planted bomb is (the
round shows it).

## Tuning (`data/tuning.json` → `ai`)

| key | value | meaning |
| --- | ---: | --- |
| `fovDeg` | 106 | field of view (full angle) for `sees` and flashes |
| `reactionSec`, `reactionJitter` | 0.25, 0.3 | first sight → turning on the target, ± that fraction |
| `aimErrorDeg` | 2.5 | s.d. of the acquisition aim offset |
| `aimSettleSec` | 0.15 | the offset's half-life once engaged |
| `aimResidualDeg` | 0.5 | s.d. of the extra error on each shot |
| `headshotAimRatio` | 0.35 | share of acquisitions aimed at the head |
| `turnRateDegPerTick` | 12 | yaw and pitch limit |
| `fireConeDeg` | 1.5 | the view must be this close to the aim point to fire |
| `semiAutoSettleFactor` | 1 | semi-automatic guns wait this many `aimSettleSec` on target |
| `sprayStartFactor` | 2 | automatic guns fire within this × the target's angular radius |
| `targetLostSec` | 0.5 | keep an unseen target this long |
| `reloadClipFraction` | 0.3 | reload when no target and the magazine is at most this full |
| `walkNearEnemyUnits` | 600 | WALK this close to a known enemy position |
| `memorySec` | 8 | how long a seen or heard position stays known |
| `soundLookSec` | 1.5 | look toward a sound this long |
| `arriveUnits` | 24 | waypoint / spot reached |
| `stuckSec`, `stuckProgressUnits`, `unstickSec` | 1, 16, 0.4 | stuck detection and the sideways nudge |
| `counterStrafeSpeed` | 40 | counter-strafe above this speed when engaging |
| `plantSpotUnits` | 150 | plant this close to the plant spot (inside a bombsite) |
| `defuseRangeFactor` | 0.6 | walk to this fraction of `bomb.defuseRange` before USE |
| `guardMaxUnits` | 800 | a guard spot's largest distance from the bomb |
| `blastMarginUnits` | 64 | leave the blast to at least `bomb.radius` + this (3D) |
| `defuseMarginSec` | 0.25 | a defuse must be able to finish this long before the explosion |
| `losWallTolerancePx`, `losEndpointTolerancePx`, `losLevelStepUnits`, `losLevelSlackUnits` | 1, 3, 16, 48 | sight (`docs/vision.md`) |
| `losCoverTolerancePx`, `losCoverNearUnits`, `losCoverHeightUnits` | 1, 48, 72 | the 2D cover rule (`docs/vision.md`, "Cover"; hosts without 3D geometry) |
| `sightSideUnits` | 12 | G6: the left and right aim points of `sees`, off the body axis at chest height (`docs/vision.md`) |

`reactionSec` and `aimErrorDeg` are the CS2 probe's P5 targets (`docs/cs2-adapter.md`); the rest are 2D choices.

## Tests (`tests/live-ai.test.ts`)

| test | result |
| --- | --- |
| LIVE lokier (SSG 08) holding B vs a pawn walking (silent) past the Apartments window, 20 seeds | first sight → kill: mean **1.61 s** (0.36–3.75 s; the slow ones are a missed bolt-action shot + 1.25 s cycle) |
| LIVE sp4rtan alone with the planted bomb (B), from CT spawn, kit | walks there, starts at 11.30 s, defuses 5.00 s later (CT `bomb_defused`) |
| LIVE barely with the c4 from the Apartments, role `plant` | plants on B at 10.44 s, (−1792, 252), with the c4 drawn and USE held |
| Around corners, role `rotate`: Connector → Catwalk (5 corners, 1,906 u) and Jungle → B (7 corners, 2,228 u) | reached in 8.78 s and 9.95 s (budget: length / 225 + 2 s), 0 re-paths |
| Route waypoints, then hold | waypoints in order, holds at `goal.hold`; a waypoint off the mesh counts at its projection |
| Hearing | facing west on B, an enemy behind the Apartments wall (1,097 units, never in sight) fires once: within 0.5 s he faces within 20° of him, `lastKnown` set |
| Core inputs | a LIVE pawn's observes are identical with and without junk Core inputs; back to REPLAY they drive it |
| Determinism | two runs of a 4-pawn LIVE fight give the same digest, another seed another fight; snapshot mid-fight → identical continuation in the same and in a fresh host |
| Escape spot (F) | from the B plant: (−1613, −1563), 1,912 units from the bomb, a 2,081-unit walk (to CT spawn); a pawn already clear stays |
| After a T elimination win, bomb ticking (F) | LIVE barely (`guard_bomb`) never guards: escapes, holds 1,902 units out, survives the explosion on 100 HP, doesn't move after it |
| Forced `end_round`, bomb ticking (F) | a LIVE sp4rtan with `defuse` leaves instead: no `defuse_start`, alive on 100 HP |
| Defuse too late (F) | LIVE sp4rtan (kit, AK) ~700 units from the bomb with 6 s left: no defuse start, escapes, survives (T `bomb_exploded`); the same with 12 s left: walks there and defuses |
| Defuse in progress that can't finish (F) | zwomp (no kit) defusing with 9.5 s left goes LIVE: `defuse_stop` at once, runs, 1,857 units out at the blast, 100 HP |
| In the round (`tests/scenarios.test.ts`, F) | `flank-sp4rtan`: donk and barely, LIVE after the T win, survive the explosion (donk 1,826 units out, barely 1,564 units out on 74 HP; he went LIVE 5.7 s before it) instead of dying in it |

## Map knowledge (H3)

The AI asks a `MapNav` (`src/sim2d/map-nav.ts`) for everything about the map: walkability, paths, straight walks, the
bomb sites (`inBombsite`, `bombsitePoint`), the spawns (`spawnCentre`, for the hold facing) and the blast escape. On
Mirage's recorded round it is the 2020 grid (`legacyMapNav`: the place names as before; behaviour, scenario outcomes
and golden digests unchanged). In free play it is CS2's nav of any map with the map package's facts (docs/nav.md
"CS2 nav"), and there the AI also jumps the nav's jump links, ducks through its crouch areas and jumps while unsticking.
Free play's roles and plan: docs/scenarios.md. The hosts take either (`Sim3DHost(nav: NavMesh | MapNav, …)`,
`Sim2DHost(…, aiNav)`).

## What B4 needs to know

- **Unblock first.** B3 sends `block_damage` for every pair of REPLAY enemies and for each puppet on itself. When a
  pawn goes LIVE, send `unblock_damage` for every pair involving it (both directions, and its self-pair if its grenades
  should hurt it), or its bullets do nothing and nobody's bullets hurt it.
- **Goals.** `route` is walked in order with the nav mesh between points, so a few waypoints at decision points (a
  doorway, the top of a ramp) are enough; points need not be walkable (they are snapped). `hold` is where it ends;
  null means "stay where the route ends". Its facing there is computed (above): to make it face a particular way, make
  the route arrive from the opposite side, or rely on a known enemy position.
- **Roles** are the strings in the table; any other string holds. A T needs `plant`/`take_site` *and* the c4 to plant;
  a CT needs `retake`/`defuse` to go to the bomb (it hears the beeps from anywhere); `guard_bomb` before the plant just
  holds.
- **Expect** it to stop and fight whatever it sees (enemies only) and to turn toward enemy shots and footsteps within
  1,500 units. It walks near known enemies, so it can be quiet. It doesn't throw grenades, jump or crouch. After the
  round, and when a defuse is too late, it leaves the bomb's blast whatever its goal (above).
- **Timing:** the set_mode applies in `apply()`; the AI first moves the pawn in the following `tick()`.
- **Status:** `aiDebug(id)` is the 2D host's; CS2 has its own bot state, so the Core must not depend on it.

## What G1 (rejoin) needs to know

- **Back to REPLAY** is `set_mode {id, mode: 'REPLAY', goal: null}`: the AI state is dropped and the Core's inputs drive
  the pawn from that tick's `tick()` on (velocity carries over; nothing is teleported). The Core sends the
  `block_damage`s first.
- **The approach** is an ordinary `set_mode LIVE` with role `rejoin`; every new plan starts the goal afresh (only sent
  when the pawn is calm, so no fight is cut short). The 2D AI walks the nav path, which has no one-way drops
  (`docs/nav.md`): a way back that needs the Balcony drop is walked round, so the Core measures straight walkable lines
  first and doesn't chase along a detour.
- **Run speed**: the planner assumes the held weapon's run speed × `replay.rejoinSpeedFactor`; the AI's easing off in
  the last 48 units and its reaction are what `replay.rejoinLeadSec` covers.
