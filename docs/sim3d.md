# The 3D engine: Sim3DHost (H1)

`src/sim3d` is the second host behind `IHost` (docs/contracts.md): the 3D game the 3D app (`src/app3d`,
docs/app3d.md) and `tools/harness3d.ts` run. The Core (`src/core`) and the contracts are shared unchanged: the
3D host is driven exactly as the 2D one, through the app's `Session` (src/app/session.ts), which now takes a host
factory (`SessionConfig.host`, default `defaultHost` = Sim2DHost; `SessionHost` is Sim2DHost's public surface).

## What it is

`Sim3DHost` (src/sim3d/host.ts) is Sim2DHost with the parts that were 2D made 3D and everything else kept:

| Part | 3D host | From |
| --- | --- | --- |
| Movement | Source movement on the CS2 collision mesh (world + player clips): `stepMove3d`, pawn collision with `HullClamp` | `src/sim2d/movement.ts`, `collision.ts` (G3), as Sim2DHost with a mesh |
| View angles | per pawn `yaw` and `pitch` (MoveState; Source: pitch positive = down) from the Core's, the AI's or the human's input | as 2D (2D used pitch only to pick a band) |
| Bullets | **3D hitscan**: a ray from the eye along the view direction, nearest of the world mesh and the hitboxes; hitgroup = the hitbox's; CS damage (`bulletDamage`) | new: `src/sim3d/hitscan.ts`, `src/engine/hitboxes.ts` |
| Sight (`sees`) | eye → the target's head, chest, both sides, legs on the CS2 **world** mesh (no player clips), FOV, flash, smoke | new: `src/sim3d/sight.ts` (G6's MeshSight idea) |
| Weapons, grenades, bomb, round rules, hearing | unchanged | `src/sim2d/weapons.ts`, `grenades.ts`, `bomb.ts`, `round.ts` |
| LIVE AI | the 2D AI on the Mirage 2D nav (its line-of-sight queries on the 2D sight mask; `sees` from the 3D sight) | `src/sim2d/ai.ts` (H3 makes it generic on the CS2 nav) |
| Puppets, scripted damage, snaps, teleports | unchanged (the same snapped tracks, input plans and snaps) | the Core |

Its public surface is Sim2DHost's plus `shots()` (the bullets of the last tick: eye, impact, victim, hitgroup,
hitbox; the renderer's tracers and hit marker) and `world()` (the mesh sight). The constructor takes the movement
mesh and the world mesh (`Sim3DWorld`); `sim3dHostFactory(worldMesh(geometryBin))` makes the Session's factory.
Snapshots are Sim2DHost's version 5 plus `engine: 'sim3d'`.

### Duplication

The class is a copy of Sim2DHost (its phases are private and src/sim2d is not edited while G5 / G6 work there). The
copy differs in `currentSees`, `stepPawnWeapon` (the bullet), the constructor and the 3D-only movement branch. When
G5 (engine hook `blocked_hit`) and G6 (MeshSight, sight snapping) merge, the same changes go into the copy; the
engine refactor after them (H4) folds the two hosts into one with pluggable sight and bullets.

## Hitboxes

`src/engine/hitboxes.ts` (pure, imports only contracts): a head sphere and capsules, posed from the feet, the yaw and
the posture, sized to the 72 / 54 Source hull and to the heights the bots aim at (`damage.bandHeights`). Standing,
units above the feet, `f` forward along the yaw, `l` to the left:

| box | hitgroup | shape | from (f, l, z) | to (f, l, z) | radius |
| --- | --- | --- | --- | --- | --- |
| head | head | sphere | (0, 0, 63) | | 5 |
| neck | neck | capsule | (0, 0, 55.5) | (0, 0, 58) | 3.5 |
| chest | chest | capsule | (0, 5.5, 48.5) | (0, −5.5, 48.5) | 7 |
| stomach | stomach | capsule | (0, 4, 35.5) | (0, −4, 35.5) | 6.5 |
| arm_l / arm_r | arm | capsule | (0, ±11, 52) | (12, ±5, 41) | 3 |
| leg_l / leg_r | leg | capsule | (0, ±4, 29) | (0, ±4.5, 4.5) | 4.5 |

Crouched, every z × 46 / 64 (as the aim bands), no end below its radius. A ray takes the box it enters first.
Approximations against CS2 (whose hitboxes ride the animated skeleton): a fixed rest pose (no gun-holding arms, no
stride, no lean), a spherical head. H2's penetration and H4 may refine them.

## Bullets

`traceShot3`: eye = feet + 64 (46 crouched), direction = `viewDir(yaw, pitch)`, length `damage.maxRange` (8192). The
world mesh is traced first (`MapGeometry.traceLine`, the nearest crossing); then every pawn that can be hit (alive,
not the shooter, an enemy unless `damage.friendlyFire`) has its hitboxes tested up to the wall; the nearest entry
wins (ties: lower id). Damage: `bulletDamage(gun, distance, hitgroup, armor, helmet)` with the eye-to-impact
distance. A blocked pair (the Core's `block_damage`) is traced and logged but not applied, as in 2D. No spread,
recoil or penetration yet: H2's `src/engine/weapons` supplies them; the app already sends the firing angles (view +
aim punch × 2, zero punch for now; docs/app3d.md).

## Sight

`MeshSight3` (src/sim3d/sight.ts): V sees T when V is alive and not blind, T alive, T within `ai.fovDeg / 2` of V's
yaw (2D bearing, as the contract), no active smoke crosses the 2D segment, and one of the segments from V's eye to
T's aim points crosses no world triangle: head (z + 63), chest (48), chest ± 12 to either side, legs (16); crouched
× 46 / 64. Each direction is traced on its own (sight is not symmetric). Glass and bullet-pass railings aren't in the
mesh (docs/geometry.md), so they are open. When G6's `MeshSight` lands on main, `sees` switches to it.

## Results (headless, `npm run harness3d`, seed 1)

- **Nobody plays** (tests/sim3d-golden.test.ts): 4,517 ticks, digest `a2883aa0`; kills on 32, 794, 816, 1142, 1203,
  2829, 3222, 3766, 4442 (all nine, the recording's), every damage event identical to the 2D golden master's, plant
  1761, defuse 3955 → 4275, "Played it like the tape: CT defuse, 0.72 s left". Against the 2D golden master
  (`fixtures/golden/round-nohuman`, `72b58704`, `tools/fixture-diff.ts`): **0 acts differ**, no control, event or
  round difference, every observed pawn field identical except `sees` (1,539 of 4,517 lines differ, only in `sees`,
  from tick 1). Pitch is identical too (the puppets' pitch is the Core's aim, applied the same way). The Core never
  branches on `sees` in a run nobody plays, so the mesh sight changes nothing else.
- **3D aim** (tests/sim3d-aim.test.ts): cart, the human from the start, plays his recording to the window; on the
  first tick from 18.4 s on with an open line from his eye to Lokier's head (19.86 s with today's snapped tracks) he
  stops, aims yaw and pitch at the head hitbox and fires: the bullet enters `head` 415.8 units away and does the
  AK-47's headshot damage (`bulletDamage`; Lokier dies, HS). The same shot 10° off misses everyone; a shot at his head
  while the wall is between (17.81 s) stops on the wall 222 units out. Today's tracks were snapped for the 2D sight:
  through the window the mesh line from cart's eye to Lokier's head is blocked most of 17.6–19.7 s (G6's pass 5
  re-snaps the tracks so every recorded duel is in sight on the mesh; after that merge the open tick moves earlier).
- **The follow-recording script** (`--human cart --script fixtures/scripts/cart-follows-recording.json`): in 2D cart
  kills Lokier at 18.50 s (HS) and the round ends "Same result, different round: CT defuse, 0.72 s left; 2 kills
  changed". In 3D his shots miss: the script's pitch is 0 (the recording has no pitch; 2D picks the hitgroup from
  pitch bands with a 3° tolerance and lets level shots at a pawn 110 units below hit), and a level 3D ray from the
  window passes over Lokier's head; Lokier kills cart at 21.55 s and barely kills Lokier at 22.28 s; plant 1814,
  defuse 3955 → 4275, "Same result, different round: CT defuse, 1.55 s left; 4 kills changed". The same holds for
  the `takeover-duel` scenario (the human-bot aims with the 2D bands). True 3D aim needs a pitch: the scripted-human
  test aims at the head hitbox and hits. H4: give the follow script and the human-bot the 3D aim (and G5's duel rules).
- **Takeover at 30 s**: the first 1,920 lines are the watching run's, byte for byte; line 1,920 names cart the human.
- Cost: ≈ 0.93 ms per tick in Node for the whole step (Core, host, log), as the 2D host (1.0 ms); ≈ 39 sight
  segments per tick.

## The CS2 port

What the 3D host does that CS2 provides natively: docs/port-notes.md "3D host (H1)".
