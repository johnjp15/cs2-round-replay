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
| Sight (`sees`), guard spot, grenade effects | G6's `MeshSight` on the CS2 **world** mesh (no player clips): eye → the target's head, chest, both sides, legs; FOV, flash, smoke (`computeSees`) | `src/sim2d/mesh-sight.ts`, `vision.ts`: the same implementation as Sim2DHost (H1's `MeshSight3` was removed with G6) |
| Weapons, grenades, bomb, round rules, hearing | unchanged | `src/sim2d/weapons.ts`, `grenades.ts`, `bomb.ts`, `round.ts` |
| LIVE AI | the 2D AI on the Mirage 2D nav (`sees` and its guard-spot test on MeshSight, as in 2D) | `src/sim2d/ai.ts` (H3 makes it generic on the CS2 nav) |
| Puppets, scripted damage, snaps, teleports | unchanged (the same snapped tracks, input plans and snaps) | the Core |

Its public surface is Sim2DHost's plus `shots()` (the bullets of the last tick: eye, impact, victim, hitgroup,
hitbox; the renderer's tracers and hit marker) and `world()` (the mesh sight). The constructor takes the movement
mesh and the world mesh (`Sim3DWorld`); `sim3dHostFactory(worldMesh(geometryBin))` makes the Session's factory.
Snapshots are Sim2DHost's version 5 plus `engine: 'sim3d'`.

### Duplication

The class is a copy of Sim2DHost (its phases are private and src/sim2d is not edited while G5 / G6 work there). The
copy differs in `stepPawnWeapon` (the bullet), the constructor and the 3D-only movement branch (G6: `currentSees`
now calls the same `computeSees` on the same MeshSight as Sim2DHost). When G5 (engine hook `blocked_hit`) and G6
(MeshSight, sight snapping) merged, the same changes went into the copy; the
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
distance. A blocked pair (the Core's `block_damage`) is traced and logged but not applied, as in 2D. Since H2b the
direction is the weapon mechanics' (view + aim punch × `recoilScale` 1.884 + the inaccuracy cone) and the human's and LIVE pawns'
bullets go through walls (`meshSolidQuery` + `penetrate`); puppets' outcomes are traced along their scripted view as
before. Bots and puppets compensate recoil (B1): their view at each shot is the aim − the punch offset, so their sprays
stay on the target (docs/weapons.md "Bots and puppets compensate recoil"). docs/weapons.md "In the 3D host".

## Sight

G6's `MeshSight` (src/sim2d/mesh-sight.ts, `docs/vision.md`), constructed on the world mesh with
`meshSightOptionsFromTuning`, through `computeSees` (src/sim2d/vision.ts) exactly as Sim2DHost: V sees T when V is
alive and not blind, T alive, T within `ai.fovDeg / 2` of V's yaw, no active smoke crosses the 2D segment, and one of
the segments from V's eye to T's aim points (head = `bandHeights.head` 64, chest 48, chest ± `ai.sightSideUnits` 12,
legs 16; crouched × 46 / 64) crosses no world triangle. The LIVE AI's guard spot and the flash / HE effects use it too
(`MeshGrenadeNav`); grenade throws clamp on the 2D mask as in 2D. H1's own `MeshSight3` (head at the hitbox centre,
z + 63; no shared eye line, no hints) is gone: one implementation. Scripted hits whose eye-to-victim line is blocked are
logged (`script: scripted hit through geometry`, `combatLog()`), as in 2D.

## Results (headless, `npm run harness3d`, seed 1)

- **Nobody plays** (tests/sim3d-golden.test.ts): 4,517 ticks, digest `9f07df0b`, the 2D golden master's (W2's pistols; `7168c0a5` at T1; `150f77b4` at G6; `a2883aa0` before #30, `cbb335eb` between #30 and G6; H2b's weapon mechanics leave it byte-identical: puppets' outcomes are traced along their scripted view, and nobody is mechanical in a run nobody plays); kills on 32, 794, 816, 1142, 1203,
  2829, 3222, 3766, 4442 (all nine, the recording's), every damage event identical to the 2D golden master's, plant
  1761, defuse 3955 → 4275, "Played it like the tape: CT defuse, 0.72 s left". Against the 2D golden master
  (`fixtures/golden/round-nohuman`, `tools/fixture-diff.ts`): since G6 **identical in every line**, `sees` included
  (both hosts use one MeshSight; before G6, with H1's `MeshSight3` against the radar mask, 1,539 of 4,517 lines
  differed, only in `sees`). The Core's aim reads `sees` since G6 (puppets track only what they see), so identical
  `sees` is what keeps the 3D run on the 2D one.
- **3D aim** (tests/sim3d-aim.test.ts): cart, the human from the start, plays his recording to the window; on the
  first tick from 17.97 s (1150) on with an open line from his eye to Lokier's head he stops, aims yaw and pitch at the
  head hitbox and fires: the bullet enters `head` 512 units away (an AK-47 headshot that kills, by `bulletDamage`).
  G6: with pass 5's tracks the window opens before cart's recorded spray, inside his recorded duel with Lokier (G5), so
  the engine reports the hit as `blocked_hit {cart, lokier, ak47, head}` and the duel lands the tape's kill (before G6
  the open tick was 19.86 s, after the duel). The same shot 10° off misses everyone. H2b: with CS2's spread cart first
  stands still 16 ticks (running, the AK's cone is too wide for a head at 500 u) and the bullet enters `head` 502 u
  away; a shot at his head while the window wall is between goes through it (one surface, 23 of 36 damage left, hits
  the chest) and, inside the duel, is a `blocked_hit` with no damage.
- **The follow-recording script** (`--human cart --script fixtures/scripts/cart-follows-recording.json`; numbers after
  G5's merge): in 2D cart kills Lokier at 18.80 s (HS) and the round "Played it like the tape" (G5's recorded duels).
  In 3D it **does not match yet**: the script's pitch is 0 (the recording has no pitch; 2D picks the hitgroup from
  pitch bands with a 3° tolerance and a 16-unit body circle, so a level shot at a pawn 110 units below still hits),
  a level 3D ray from the window passes over Lokier's head, so no bullet reaches him, G5 gets no `blocked_hit` for
  the recorded duel and the round leaves the tape: barely kills Lokier at 20.45 s and the bomb explodes ("You changed
  history: Ts win"). Two things are missing, both outside H1: the tracks are snapped for the 2D sight, and through the
  window the mesh line from cart's eye to Lokier's head is open only at 17.61–17.63 s and from 19.86 s (G6's sight
  snapping, pass 5, re-snaps them); and the script needs a 3D aim (a pitch and a yaw precise to the head hitbox, which
  a 10 Hz video track isn't) — H4's card ("the follow-recording run in 3D with G5's duel rules"). The `takeover-duel`
  scenario's human-bot aims with the 2D bands and misses the same way. True 3D aim does hit: tests/sim3d-aim.test.ts.
- **Takeover at 30 s**: the first 1,920 lines are the watching run's, byte for byte; line 1,920 names cart the human.
- Cost: ≈ 0.93 ms per tick in Node for the whole step (Core, host, log), as the 2D host (1.0 ms); ≈ 39 sight
  segments per tick.

## World items (W2, `src/sim3d/items.ts`)

Guns lying in the world: in the host's state and snapshot (`items`, `nextItemSeq`; so checkpoints, rewind and seek
carry them), never in `observe()` (CS2's observe has none). `Sim3DHost.worldItems()` is what the renderer draws (the
viewmodel geometry at world scale, on its side: `WorldItemMeshes`, src/app3d/viewmodels/rig.ts).

| Rule | Value | Source |
| --- | --- | --- |
| Death drop | the most valuable gun (weapon-table price; tie: primary); the C4 drops as before (bomb.ts); grenades, defuser stay | `mp_death_drop_gun` default 1 = "their best" ([totalcsgo](https://totalcsgo.com/commands/mpdeathdropgun)) |
| Death drop start | eye − 12 units, the pawn's velocity | Source SDK 2013 `CBaseCombatCharacter::Weapon_Drop` (`Weapon_ShootPosition() - Vector(0,0,12)`) |
| G (`DROP` button, its press) | the active gun, 400 u/s along the view; the best weapon left is drawn. Not the knife, grenades or C4 | `Weapon_Drop`: `BodyDirection3D() * 400` for players |
| Flight | `sv_gravity` 800, a 4×4×4 box swept on the world mesh; a floor (n·z ≥ 0.7) stops it, a wall keeps 30 % of the bounce | gravity: CS2 default; box and bounce assumed |
| E (`USE` press) | the gun within 80 units of the eye, ≥ 0.8 dot off the view, in plain sight, nearest the view line; a full slot swaps (the old gun is thrown as by G); the new gun is drawn. Not while a CT could defuse | Source SDK 2013 `PLAYER_USE_RADIUS 80.f` (baseplayer_shared.h), `CBasePlayer::FindUseEntity` (`dot < 0.8` skipped) |
| Touch | a gun within the standing hull (16 + 2 units half width, 72 high) whose slot (1 primary, 2 pistol) is empty is picked up, not drawn; not one the pawn itself dropped in the last 64 ticks | CS2 weapon touch (walk-over pickup into an empty slot); hull 32 × 72; the 1 s delay is assumed |
| Who picks up | the human only. A puppet's recorded pickup (`give`, Sp4rtaN's AK-47 at 19.6 s) takes the nearest gun of that kind within 256 units off the floor | the tape |

Not done: grenade world items (CS2 drops the held grenade on death, `mp_death_drop_grenade`; picking them up would
follow the grenade limits), G on the C4 (bomb.ts would give it straight back to its T), the defuser drop. The loadout
ledger (src/core/loadout.ts) learns a picked-up gun when it is held; a gun the human drops stays in its ledger entry
(Observe shows no drops), which only matters to a resync rewind (CS2), not to this host's exact snapshots.

## The CS2 port

What the 3D host does that CS2 provides natively: docs/port-notes.md "3D host (H1)".
