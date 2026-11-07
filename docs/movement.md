# Movement model and Sim2DHost (`src/sim2d/movement.ts`, `src/sim2d/host.ts`)

**G3:** with the 3D world loaded (the app and every harness and test run since G3), pawns move in 3D on CS2 Mirage's
collision mesh with Source's movement (`stepMove3d`, "3D movement" below): they jump, fall, climb stairs and stand on
boxes, and the 2D view shows height. The ground-only model (`stepMove`) below is still what a session without the 3D
world uses, and on flat ground the 3D model moves exactly as it does (tested).

Source-style ground movement at 64 Hz, close enough to CS2 that tuning found in the 2D sim carries
over to the CS2 plugin and back. The movement functions are pure (`MoveState` in, `MoveState` out), and
every parameter comes from `data/tuning.json` → `movement`. `Sim2DHost` implements `IHost` on top of them.
Weapons, damage, grenades and sounds (C2) are in `docs/combat.md`.

## Conventions

- World frame: Source units on Mirage, `x` east, `y` north (`docs/conventions.md`).
- **Yaw** in degrees counter-clockwise from +x: 0 = east, 90 = north. **Forward** = (cos yaw, sin yaw).
- **Side**: positive = strafe **right** = yaw − 90° = (sin yaw, −cos yaw). Facing north (yaw 90) with
  side = +1 moves east.
- `forward`, `side` in −1..1 (`PawnInput`). If |(forward, side)| > 1 the pair is normalized, so a diagonal
  (1, 1) runs at full speed, not √2 × full speed. Partial stick scales the wish speed.
- `dt = 1/64` s (`TICK_DT`). Ground only: `vel.z` is always 0 and `pos.z` is the nav floor height.

## One tick (`stepMove`)

In this order:

1. **Look and stance** from the input: `yaw`, `pitch`; `crouching = DUCK held`. No input (`null`) keeps
   yaw/pitch and releases all buttons.
2. **Friction** (Source):
   - speed = |vel|
   - control = max(speed, `svStopSpeed`)
   - drop = control × `svFriction` × dt
   - vel ← vel × max(speed − drop, 0) / speed
3. **Wish** from the input (`wishFromInput`):
   - wishdir = unit(f × forwardVec + s × rightVec), with (f, s) normalized when longer than 1
   - wishspeed = `runSpeedByWeapon[weapon]` × (WALK ? `walkFactor` : 1) × (DUCK ? `crouchFactor` : 1) × min(1, |(f, s)|)
   - accelScale = max(wishspeed, `accelScaleFloor` × `runSpeedByWeapon[weapon]`) (see below)
4. **Accelerate** (Source):
   - addspeed = wishspeed − dot(vel, wishdir)
   - if addspeed > 0: accelspeed = min(`svAccelerate` × dt × accelScale, addspeed); vel += accelspeed × wishdir
5. **Position**: `nav.clampMove(pos, pos + vel × dt)`. If the move was clipped (wall), vel ← actual
   displacement / dt, so a wall slide keeps its tangential speed and loses the blocked part.
   z ← `nav.zAt(newPos)` (with the old z as a hint for stacked areas).
   A pawn that starts the tick **off** walkable space (e.g. teleported into a hole) moves unclamped until it
   is back on the mesh, instead of being frozen (`clampMove` would return `from`).

Items without a `runSpeedByWeapon` entry (e.g. a defuser) use the knife's speed.

### `accelScaleFloor` (new tunable, default 1)

With plain Source scaling (accelScale = wishspeed, i.e. `accelScaleFloor` = 0) a **crouching pawn cannot
move**. AK crouch: wishspeed = 215 × 0.34 = 73.1. Acceleration is then 5.5 × 73.1 / 64 = 6.28 u/s per tick,
less than the friction floor below `svStopSpeed` (80 × 5.2 / 64 = 6.5 u/s per tick). The pawn peaks at
6.28 u/s and never builds speed. Walking still works, but it takes 0.59 s to reach 95 % instead of 0.14 s.
CS:GO scaled ground acceleration by max(250, wishspeed) × the weapon's speed factor, as far as I know (not
verified against CS2 source). That is `accelScaleFloor` = 1: walking, crouching and partial stick accelerate
at the weapon's run rate. **Running is identical under both settings**, because accelScale = wishspeed
there. Calibrate this with the CS2 probe: measure time-to-95 % while crouched and walking.
`tests/movement.test.ts` pins down both behaviours.

## Tunables (`data/tuning.json` → `movement`)

| Key | Value | Meaning |
| --- | --- | --- |
| `svAccelerate` | 5.5 | `sv_accelerate` |
| `svFriction` | 5.2 | `sv_friction` |
| `svStopSpeed` | 80 | `sv_stopspeed` (friction uses at least this speed) |
| `walkFactor` | 0.52 | WALK speed multiplier |
| `crouchFactor` | 0.34 | DUCK speed multiplier (stacks with WALK in this model; check in CS2) |
| `accelScaleFloor` | 1 | see above |
| `runSpeedByWeapon` | knife 250, ak47 215, awp 200, ssg08 230, deagle 230, m4a4/m4a1 225, famas 220, galil 215, **glock 240, c4 250, smoke/flash/he/molotov 245** | run speed of the held item (bold = added in C1, CS:GO/CS2 item max speeds) |

## Measured model values

**2D model values; compare against the CS2 probe.** From `tests/movement.test.ts` and the same setup,
on open ground (T Spawn, heading south), no wall contact, `accelScaleFloor` = 1:

| Case | Cap (u/s) | To 95 % of cap from rest | To cap | Stop from cap, no input |
| --- | ---: | --- | --- | --- |
| AK-47 run | 215 | 28 ticks = **0.4375 s** | 36 ticks = 0.5625 s | 24 ticks = **0.375 s**, **30.9 units** |
| AK-47 walk | 111.8 | 9 ticks = 0.141 s (0.594 s with floor 0) | | 17 ticks = 0.266 s, 12.7 units |
| AK-47 crouch | 73.1 | 6 ticks = 0.094 s (never with floor 0: peaks at 6.28) | | 12 ticks = 0.188 s, 5.9 units |
| AK-47 crouch + walk | 38.0 | | | |
| Knife run | 250 | 28 ticks = 0.4375 s | | 26 ticks = 0.406 s, 37.1 units |
| AWP run | 200 | 29 ticks = 0.453 s | | 24 ticks = 0.375 s, 28.3 units |

AK-47 from rest covers 180.9 units in the first second. Speed rises monotonically and never exceeds the
cap with straight input. With friction applied before acceleration, the speed after a tick at cap is exactly
the cap. Source ground strafing can gain at most ≈ 0.4 % above the cap at the optimal wish angle.

## Can the recorded tracks be followed? (`tests/follow-track.test.ts`)

Each T pawn starts at rest on its first sample and is driven along its 10 Hz track by a test-only
pure-pursuit controller. The physics are unchanged and nothing snaps. The test measures the 2D error
against the recording at every sample of the alive window. Run
`npx vitest run tests/follow-track.test.ts --reporter=verbose` to print the table.

- **literal** controller (as specified): target = track at t + 0.15 s (`replay.lookaheadSec`); input =
  direction to the target in the pawn's yaw frame, yaw = bearing of recorded travel; forward/side scaled
  by distance / (max speed × 0.15), clamped to 1; WALK while the recorded speed < 120
  (`replay.walkSpeedThreshold`).
- **wall-aware** controller: the same, plus two rules any replay controller needs. (1) If the straight
  line to the target is not walkable, steer at the latest track point (within the last 2 s) that is, with
  the same speed demand. (2) Don't hold WALK while more than `replay.driftNudgeUnits` (24) behind the
  recorded position.

**2D model values; compare against the CS2 probe.** Errors in units.

| player | controller | samples | RMS | max (at t) | rec. speed > model max | > 2× (spikes) | ticks on a wall | chords off-mesh |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| barely | literal | 589 | 63.8 | 264 (46.2 s) | 11.9 % | 2 | 4.7 % | 1 |
| barely | wall-aware | 589 | 68.4 | 268 (49.0 s) | 11.9 % | 2 | 1.4 % | 1 |
| cart | literal | 695 | 903.8 | 1374 (41.4 s) | 9.1 % | 8 | 69.6 % | 4 |
| cart | wall-aware | 695 | **21.2** | 152 (14.5 s) | 9.1 % | 8 | 0.2 % | 4 |
| donk | literal | 504 | 545.0 | 749 (48.4 s) | 6.2 % | 2 | 70.8 % | 0 |
| donk | wall-aware | 504 | 17.5 | 107 (14.5 s) | 6.2 % | 2 | 0.0 % | 0 |
| eradicate | literal | 128 | 6.5 | 32 (11.3 s) | 3.9 % | 1 | 0.0 % | 0 |
| eradicate | wall-aware | 128 | 5.7 | 32 (11.3 s) | 3.9 % | 1 | 0.0 % | 0 |
| snarlbot | literal | 179 | 8.1 | 33 (14.4 s) | 3.9 % | 0 | 0.9 % | 1 |
| snarlbot | wall-aware | 179 | 8.1 | 33 (14.4 s) | 3.9 % | 0 | 0.5 % | 1 |

"rec. speed > model max" counts samples whose speed from the previous sample beats the held weapon's run
speed; "> 2×" counts samples above twice that. "Chords off-mesh" are consecutive samples whose straight line
crosses non-walkable space. The test asserts cart's wall-aware RMS < 24. With `accelScaleFloor` = 0 the
wall-aware RMS values are barely 69.8, cart 22.8, donk 20.0, eradicate 10.0 and snarlbot 11.5, so the
conclusion does not depend on the floor.

**Verdict.** Away from a few events the tracks are physically followable. With the wall-aware controller,
cart's samples outside the post-spike windows have RMS 6.6 (649 of 695 samples), donk 5.5, barely 7.6,
eradicate 5.7 and snarlbot 8.1. What the model can't follow:

- **Speed spikes (tracking noise).** The tracks jump 100–200 units in 0.1–0.3 s between otherwise smooth
  stretches. Cart at 14.2 → 14.5 s: 204 units in 0.3 s (1,084 / 586 / 507 u/s), then walking at 41 u/s
  again. Cart also jumps at 12.9 s (666, 709 u/s) and 20.9–22.8 s (340–602 u/s). Barely jumps at 44.8 and
  45.3 s (890, 910 u/s). These look like keyframes stitched together, not movement: no CS2 player runs
  1,084 u/s. The pawn falls behind and needs 1–3 s to catch up. With the wall-aware controller, 91 % of
  cart's squared error sits in four windows (12.9, 14.3, 20.4–22.6 and 22.9 s). The 20.4 s window is mixed:
  a 25-unit-cell corner at the Apartments → Balcony step slows the pawn to 76 u/s, then the track runs the
  Balcony drop (z −28 → −135) at 240–390 u/s, above the 215 cap.
- **Sustained over-speed.** Donk holds an AWP (200 u/s) but his track covers 13.2 → 14.6 s at 271 u/s
  on average (peak 406). That is above even the glock's 240 (his quick-switch weapon). The pawn ends up
  107 units behind.
- **A jump through a wall between levels.** Barely, at 44.7 → 44.8 s, goes from Tunnel Stairs
  (−772, 379, z −320) to Catwalk (−772, 290, z −166): 89 units across and 154 up in 0.1 s, and the chord is
  not walkable. The pawn has to go round by Tunnel, which accounts for 98.8 % of barely's squared error (max
  268).
- **The literal controller on the patch mesh.** Pure pursuit with a 0.15 s lookahead cuts corners by about
  5–10 units. In patch regions the walkable space is a staircase of 25-unit cells (`docs/nav.md`, patch areas).
  The cut line then runs into a hole, and a near head-on wall hit has almost no tangential speed to slide
  with, which is correct physics. Cart stalls that way at (−1875, 802) in Apartments at 19.9 s, falls behind
  and never recovers: 69.6 % of its ticks end up on walls. Donk does the same after his over-speed stretch.
  This is a controller problem, not a movement one. Core's replay controller needs the wall-aware rule (or a
  nav path) and drift handling (`driftNudgeUnits` / `driftSnapUnits`).

B2 built that controller into the Core (`src/core/puppet.ts`): wall-aware pursuit plus track preprocessing and
unseen snaps at teleport points. Its whole-round results (all ten pawns, no human) are in `docs/core.md`, "Puppets".

## Sim2DHost (movement and bookkeeping; combat in `docs/combat.md`)

```ts
const host = new Sim2DHost(nav, tuning, roster, { score, roundTimeSec });   // roster: the ten {id, team}; options optional (C3)
for (;;) {
  const o = host.observe();       // already canonical (6 decimals)
  const a = core.step(o);
  log.append(o, a, controls);
  host.apply(a);                  // stores inputs, applies actions in order
  host.tick();                    // advances 1/64 s
}
```

`IHost` has no `tick()`: the driver (app or test) owns the clock. For the CS2 host the game advances itself.

| Input / action | Behaviour |
| --- | --- |
| `inputs` | Replace the stored set; persist across ticks until the next `apply`. Pawns without an input get no command (friction only, buttons released). Inputs for unknown pawns and duplicates (first kept) are noted. |
| `teleport` | Sets pos (as given) and yaw, zeroes vel. The next tick snaps z to the nav floor. |
| `set_hp` | Sets hp and armor (≥ 0); `alive = hp > 0`, so `set_hp 0` kills and `set_hp > 0` revives (restart/setup). Reads B1's `helmet` boolean when present. |
| `give` | Adds or replaces the inventory entry `{item, clip, reserve}`; each grenade `give` adds another entry (C2). Items are strings, so unknown items are kept. |
| `set_weapon` | Switches the active item if it is in the inventory, starting its deploy (C2; instant when the same act teleported the pawn). Otherwise it is noted as `not in inventory`, and a `defuser` as `item cannot be held`. Ammo in `observe()` is the active item's entry. |
| `set_mode` | Records mode and goal per pawn (`pawnState(id)`). LIVE (C4): the LIVE AI drives the pawn and Core inputs for it are ignored (`docs/ai.md`); REPLAY hands it back. |
| `log` | Ignored (the app reads Core logs from the Act / SessionLog). |
| `damage`, `block_damage`, `unblock_damage` | C2: see `docs/combat.md` (scripted damage is applied in the next `tick()`). |
| `plant`, `defuse_start`, `defuse_stop`, `end_round` | C3: queued and applied in the next `tick()` after the scripted damage (`docs/combat.md`, "Bomb and round rules"). |
| unknown types | Noted as `unsupported in v0` in `unhandled()`; nothing else happens. |
| `control(c)` | Noted as `unsupported in v0`. |

- **Spawn state** (before Core sets a pawn up): pos (0, 0, 0), 100 HP, 0 armor, no helmet, knife only
  (0/0), mode REPLAY.
- **Human**: `human` defaults to `cart`; `setHuman(id | null)` changes it. `setHumanInput(input)` drives the
  human pawn instead of any Core input for it, until replaced or cleared with `null`, which hands the pawn
  back to Core. `input.id` must be the human pawn.
- **observe()**: all roster pawns sorted by id, `sees` (C4: FOV, sight mask and level check, smoke, blindness;
  `docs/vision.md`; cached per state), the last tick's events in emission order (C2), `t = tick / 64`, and `round`
  (C3: phase, score, clock, bomb).
- **Vision and AI setup** (C4): `new Sim2DHost(nav, tuning, roster, options, {mask, seed})`. `mask` is the sight mask
  (`data/mirage-vismask.json`; null = the nav mesh's line of sight), `seed` the LIVE AI's seed. The Session passes both.
- **Collision and locks** (C3): pawns don't overlap alive enemies (radius 16 circles, teammates pass through), and a
  planting or defusing pawn doesn't move (`docs/combat.md`, "Collision" and "Bomb and round rules").
- **snapshot() / restore()**: version 4 (C4) adds the LIVE AI state and seed; version 3 added the combat, bomb and round state (`docs/combat.md`, Snapshot) to
  `{tick, human, humanInput, inputs, pawns}`, via `toJsonValue`. It is exact because the state is canonical.
  `restore` checks the version and roster. `unhandled()` and `combatLog()` are diagnostics and are not part of
  snapshots.
- **Determinism**: no randomness or clocks. `apply` and `setHumanInput` canonicalize what they receive, and
  the movement state is rounded to the log's 6 decimals after each tick. So `observe()` is canonical, the
  logged acts alone reproduce the logged observes (tested), and snapshots round-trip exactly. Caveat:
  `Math.cos`/`Math.sin` (wish direction) and `Math.hypot` (nav clamp tie-breaks) are not bit-specified
  across JS engines. Node and the browser normally agree after the 6-decimal rounding, but this is not
  proven for V8 vs. JavaScriptCore.

## 3D movement (G3, `stepMove3d`)

Source's `CGameMovement::PlayerMove` / `FullWalkMove` (Source SDK 2013, `game/shared/gamemovement.cpp`; CS2 keeps
the structure) on `MapGeometry` (G2's CS2 collision mesh merged with the player clips, `docs/geometry.md`). The
standing hull is 32 × 32 × 72, crouched 32 × 32 × 54; every trace is a swept box with Source's 1/32 skin
(`traceBox`). Per tick (`MoveState` has `pos`, `vel` (with z), `onGround`, `crouching`, `jumpHeld`, `stamina`):

1. Look; stamina recovers (`staminaRecoveryRate` per second); the fall speed is −vel.z if airborne.
2. Duck (instant, as `stepMove`): DUCK crouches. In the air the feet tuck up by `airDuckLift` (the hull shrinks from
   the top on the ground, from the bottom in the air, as in Source); releasing stands up when the standing hull fits.
3. Jump (`CheckJumpButton`): a **fresh** JUMP press (`jumpHeld` false) on the ground sets vel.z = `jumpImpulse`.
   CS2 takes off precisely (the sub-tick jump update): no half tick of gravity before the first move, so the apex is
   impulse² / 2g = 57.0 units at 64 Hz too and the jump lands on tick 48 from flat ground (tested: apex 56.9975).
   Holding JUMP jumps once (`sv_autobunnyhopping 0`).
4. On the ground: friction, the stamina slowdown (speed × (staminaMax − stamina) / staminaMax), ground acceleration
   exactly as `stepMove`, then `WalkMove`: a straight move if it isn't blocked, else `StepMove` (the better of the
   plain slide and up `stepSize` → move → down), then `StayOnGround`. In the air: `AirAccelerate` (the wish speed
   for the acceleration capped at `airMaxWishSpeed`, the full wish speed for the add) and `TryPlayerMove` (4 bumps,
   up to 5 clip planes, `ClipVelocity` with overbounce 1) between two half steps of gravity.
5. `CategorizePosition`: on the ground if a trace 2 units down hits a surface with normal z ≥ `standableNormal`
   while vel.z ≤ 140 (`NON_JUMP_VELOCITY`); the pawn is put on it. A landing (airborne → ground) gives `landSpeed`
   (the fall speed), fall damage (below) and the landing stamina cost (`staminaLandCost` × landSpeed, capped at
   `staminaMax`).

**Fall damage** (`fallDamageFor`): none below `fallSafeSpeed` (580 u/s, a drop of about 222 units with the 2-unit
ground check: tested 222 → 0, 223 → 3 HP); above it `floor((speed − 580) × 100 / (1024 − 580) × fallDamageScale)`
(`PLAYER_MAX_SAFE_FALL_SPEED`, `PLAYER_FATAL_FALL_SPEED` in Source's `shareddefs.h`: 1024 u/s is lethal). The host
applies it as world damage (`hurt(null, …, 'generic')`); a landing faster than `landSoundSpeed` makes a sound.

**Stairs on the decimated mesh.** G2's mesh is vertex-clustered on an 8-unit grid, so stair risers lean and their
tops can slope into the next tread. `standsOn` (the ground test) also accepts a floor 8 units up within 4 units of the
hull's edge (`STEP_EDGE_UP`, `STEP_EDGE_MARGIN`), so a pawn walks up and down the Tunnel Stairs instead of being
launched off a leaning riser (tested). A pawn that starts inside the mesh (a teleport, a snap, a restore) is moved to
the nearest free spot by `unstick` (rings of offsets out to 32 units, ±18 up and down), as Source's `CheckStuck`.

**Playable space.** Players stand only where CS2's own nav mesh says they can: the player clips (`docs/geometry.md`
"Player clips") cover wall tops, roofs, ledges and out-of-map floors a pawn could reach by walking, dropping or
jumping. B-site and A-site boxes, the Catwalk and the Balcony are nav-covered, so pawns stand on them (tested: a jump
onto the B-site west ledge lands at −126.6; the clips stop a jump onto the wall top at (−1379, −1040)).

### Constants (`data/tuning.json` → `movement`)

| Key | Value | Source |
| --- | ---: | --- |
| `gravity` | 800 | CS2 `sv_gravity` default |
| `jumpImpulse` | 301.99338 | CS2 `sv_jump_impulse` default (= √(2 × 800 × 57), Source's `GAMEMOVEMENT_JUMP_HEIGHT` 57) |
| `airAccelerate` | 12 | CS2 `sv_airaccelerate` default |
| `airMaxWishSpeed` | 30 | CS2 `sv_air_max_wishspeed` default (Source's hard-coded 30 in `AirAccelerate`) |
| `maxVelocity` | 3500 | CS2 `sv_maxvelocity` default |
| `stepSize` | 18 | CS2 `sv_stepsize` default |
| `standableNormal` | 0.7 | Source `gamemovement.cpp` (a surface with normal z ≥ 0.7 is ground) |
| `staminaMax` | 80 | CS2 `sv_staminamax` default |
| `staminaLandCost` | 0.05 | CS2 `sv_staminalandcost` default (the cost formula, cost × land speed, is **estimated**) |
| `staminaRecoveryRate` | 60 | CS2 `sv_staminarecoveryrate` default |
| `fallSafeSpeed` | 580 | Source `PLAYER_MAX_SAFE_FALL_SPEED` |
| `fallFatalSpeed` | 1024 | Source `PLAYER_FATAL_FALL_SPEED` |
| `fallDamageScale` | 1 | CS2 `sv_falldamage_scale` default |
| `landSoundSpeed` | 260 | **estimated** (Source plays a land sound above about 260 u/s fall speed; tunable) |
| `airDuckLift` | 9 | **estimated** (half the 18-unit hull difference, as Source's in-air duck; tunable) |

Fixed in code from Source: the 2-unit ground check, `NON_JUMP_VELOCITY` 140, 4 bumps, 5 clip planes, overbounce 1, the
1/32 trace skin (G2), the hulls. The convar defaults are CS2's (`cvarlist`; the values match the CS:GO / CS2 defaults
documented by command references such as [csdb.gg](https://csdb.gg/commands/server/sv_gravity)); they were not
re-measured in a live CS2 session for this task. Algorithms: Source SDK 2013's `gamemovement.cpp` (CS2's movement is
a descendant; the sub-tick changes are only the precise take-off and the input timing, which a 64 Hz sim without
sub-tick input ignores).

### Sight, aim and sound in 3D

`sees` still comes from the 2D sight mask (`docs/vision.md`) with its level check, now on the real z. Eye and aim
heights use the pawn's real z (feet + `damage.eyeHeight` standing, + `damage.crouchEyeHeight` crouched; the hit bands
from the feet), so an airborne or crouched pawn is aimed at where it is. Not modelled: jump inaccuracy (CS2's spread while airborne; scripted shots don't jump), and sight is not traced
against the CS2 mesh (G2 "Sight at eye height" has the data for that).

### Tests (`tests/movement3d.test.ts`)

CS2 values; jump apex 56.9975 and landing on tick 48 with the parabola in between; one jump per press; the air wish
cap; a ceiling 100 up stops the rise at 28; on flat ground the 3D model equals `stepMove` tick for tick; up and down
the Tunnel Stairs; a wall stop at 100 − 16 − skin and a 45° slide along a wall; a jump onto the B-site west ledge; a
crouch jump clears a ledge a plain jump doesn't; the clips keep a jump off a wall top; walking off the Balcony (no
damage); fall damage at 222 / 223 units, large and fatal falls; the landing slowdown and its recovery.

## Not modelled yet (differences from CS2)

Tagging (slowdown when hit); scoped speeds (AWP 100); crouch transition time (crouch is instant); surface friction;
sub-tick input; ladders (Mirage's two: the nav has no ladder links and the 3D world treats them as walls); surfing and
bunny-hop speed gain beyond what the air acceleration gives; jump inaccuracy. Whether WALK and DUCK stack in CS2 is to be checked. The player
hull is implicit against the world (nav areas are player-centre space); between pawns it is a 16-unit circle
(C3, `docs/combat.md`, "Collision").

## CS2 verification (M1, `tests/movement-cs2.test.ts`)

M1 checked every movement number and formula against primary sources and pinned the model to them with a numeric
battery. The test file transcribes the Source functions independently of the model (`refFriction`, `refAccelerate`,
`refGroundTick`, `refAir`) and compares the model with them tick by tick; the pinned numbers below are what those
formulas give with CS2's constants.

### Sources

| Id | Source | Used for |
| --- | --- | --- |
| C1 | CS2 convar dump: [SteamDatabase/GameTracking-CS2 `DumpSource2/convars.txt`](https://github.com/SteamDatabase/GameTracking-CS2/blob/cce7bf1f190144c1c08fb0fe75fd3c9514f2637f/DumpSource2/convars.txt) at `cce7bf1f` (2026-11-05), dumped from the game | every convar default and description quoted below |
| C2 | CS2 `weapons.vdata` (same repo and commit; copy and table from H2, `docs/weapons.md` S1) | `m_flMaxSpeed` per item (primary / alt mode), `m_flFlinchVelocityModifierLarge/Small` |
| S1 | [Source SDK 2013](https://github.com/ValveSoftware/source-sdk-2013) `src/game/shared/gamemovement.cpp` at `e1f1fd42` | the algorithms (CS2's movement is a descendant; CS2's own code is not public) |
| S2 | Source SDK 2013 `src/game/shared/shareddefs.h` and `src/game/shared/tf/tf_gamemovement.cpp` at `e1f1fd42` | fall-damage constants, duck times, the bunny-hop speed clamp |
| R1 | CS2 release notes 2026-01-21 / 01-22, as reproduced by [patched.gg](https://patched.gg/games/counter-strike-2/counter-strike-2-update-2026-01-21) ([01-22](https://patched.gg/games/counter-strike-2/counter-strike-2-update-2026-01-22)) | the 2026 jump code: "Landing time is now calculated with subtick precision", "Jumping and landing no longer affect stamina; speed penalty is now a function of landing time", `sv_bhop_time_window`, `sv_legacy_jump`; "Landing vertical velocity now affects landing speed penalties similar to sv_legacy_jump stamina" |
| R2 | CS2 release notes 2024-10-28 ([dust2.us](https://www.dust2.us/news/54642/valve-finally-fixes-movement-issue-plaguing-cs2-since-launch)) | "Improved jump height consistency to be within 0.015625 of a unit regardless of distance from the map origin" |
| W1 | [CS:GO Mapper's Reference](https://developer.valvesoftware.com/wiki/Counter-Strike:_Global_Offensive/Mapper%27s_Reference) (Valve Developer Community) | hulls 32×32×72 / 54, eye 64.093811 / 46.076218, block heights (jump 54 / 55 at 64 / 128 tick, jump-then-crouch 63 / 64, crouch jump 65 / 66), run-off fall damage from 223 units at 64 tick, slope limit 45.573° |
| W2 | [zer0k-z/cs2-movement-issues](https://github.com/zer0k-z/cs2-movement-issues) `readme.md` at `26f1716d` (2026-01-21) | CS2 sub-tick splitting ("Every time a key is pressed or released, the tick simulation is split into two shorter simulations", l. 131), the 0.25 air `m_surfaceFriction` in CS2 (l. 76), 66-unit crouch-jump boxes (l. 148), the 2025-09-17 "timestep-independence of subtick movement acceleration" change (l. 169) |
| W3 | [r/GlobalOffensive, "Analysis of movement in CS2: subtick and more"](https://www.reddit.com/r/GlobalOffensive/comments/170nzzj/analysis_of_movement_in_cs2_subtick_and_more) (2023-10-05) and a [follow-up measurement](https://lemy.lol/post/13806714) | measured: 21.48 u/s after one knife tick, 10.74 u/s for a half-tick (sub-tick) press, "0 to 250 u/s takes 35 ticks with desubticked binds"; `sv_jump_impulse 302.0728` (= √(2·800·57.03)) "restores the exact same jump height as in CS:GO" |
| K1 | [KZGlobalTeam/cs2kz-metamod](https://github.com/KZGlobalTeam/cs2kz-metamod) `src/kz/mode/kz_mode_vnl.h`, `kz_mode_ckz.h` at `317449df` | a second copy of the vanilla convars (agrees with C1), CS2's `m_flDuckSpeed` (8 rested, 6.0234375 after a fresh duck) and `m_flVelocityModifier` fields |

Not used: the leaked CS:GO source code (`cstrike15`), which turns up in code searches. Nothing here comes from it.

### Convars (C1), model vs CS2

| CS2 convar | CS2 default (C1) | Model | |
| --- | ---: | ---: | --- |
| `sv_accelerate` | 5.5 | `svAccelerate` 5.5 | ✓ |
| `sv_accelerate_use_weapon_speed` | true | `accelScaleFloor` 1 (acceleration at the weapon's run rate) | ✓ formula: see "Ground acceleration" |
| `sv_friction` / `sv_stopspeed` | 5.2 / 80 | 5.2 / 80 | ✓ |
| `sv_airaccelerate` / `sv_air_max_wishspeed` | 12 / 30 | 12 / 30 | ✓ |
| `sv_gravity` / `sv_jump_impulse` | 800 / 301.99338 ("sqrt(2*gravity*height)", so height 57) | 800 / 301.99338 | ✓ |
| `sv_maxvelocity` / `sv_stepsize` | 3500 / 18 | 3500 / 18 | ✓ |
| `sv_standable_normal` / `sv_walkable_normal` | 0.7 / 0.7 | `standableNormal` 0.7 | ✓ |
| `sv_staminamax` / `sv_staminarecoveryrate` | 80 ("Maximum stamina penalty") / 60 ("units/sec") | 80 / 60 | ✓ |
| `sv_staminalandcost` / `sv_staminajumpcost` | 0.05 / 0.08, both "sv_legacy_jump only" | `staminaLandCost` 0.05; no jump cost | see M1-8 |
| `sv_legacy_jump` | false ("pre-2026 jump code") | — | the model follows the 2026 code where it is known (R1) |
| `sv_enablebunnyhopping` / `sv_autobunnyhopping` | false ("Allow jump speed to exceed 1.1x max speed") / false | no clamp (**M1-2**) / one jump per press ✓ | |
| `sv_jump_precision_enable` | true | precise take-off (no gravity before the first move) | ✓ (apex below) |
| `sv_jump_spam_penalty_time` / `sv_bhop_time_window` | 0.015625 / 0.007812 | per-tick fresh press | equivalent at 64 Hz without sub-tick input |
| `sv_timebetweenducks` | 0.4 ("Minimum time before recognizing consecutive duck key") | not modelled | M1-6 |
| `sv_falldamage_scale` | 1 | 1 | ✓ |
| `sv_min_jump_landing_sound` | 260 | `landSoundSpeed` 260 (was "estimated"; now verified) | ✓ |
| `sv_step_move_vel_min` | 64 ("Min velocity for step move") | not modelled | M1-9 |
| `mp_tagging_scale` | 1 ("Scalar for player tagging modifier when hit") | not modelled | M1-4 |
| `sv_ladder_scale_speed` | 0.78 | no ladders | (known gap) |
| `sv_wateraccelerate` | 10 | no water on Mirage | n/a |
| `sv_maxspeed` | 320 | the item speed is always lower | n/a |

Item speeds (C2 `m_flMaxSpeed`, primary / alt): knife 250, AK-47 215, M4A4 / M4A1-S 225, FAMAS 220, Galil 215, AWP 200 / **100**,
SSG 08 230 / **230** (CS2 does not slow the scoped Scout; the task card's 150 is wrong), Deagle 230, Glock / USP-S / P2000 240,
C4 250, grenades 245, AUG / SG 553 220 / 150 and 210 / 150, SCAR-20 / G3SG1 215 / 120, Negev 150, M249 195. Every entry of
`runSpeedByWeapon` matches (tested); the alt (scoped) speeds are M1-5.

### Ground acceleration and counter-strafing (pinned)

Per tick on the ground (S1 `FullWalkMove` → `Friction` l. 1610, `WalkMove` → `Accelerate` l. 1820):
friction `v ← v · max(v − max(v, 80) · 5.2 / 64, 0) / v`, then `v += min(5.5 / 64 · scale, wishspeed − v·wishdir) · wishdir`.
Source's `scale` is the wish speed (l. 1841). CS2's `sv_accelerate_use_weapon_speed true` makes it the weapon's speed;
the exact CS2 expression is not public, but the measured first tick (W3: 21.48 u/s with a knife = 5.5 × 250 / 64) and
"0 → 250 in 35 ticks" (W3) both match this formula exactly. Walking and crouching use the same rate (`accelScaleFloor` 1).

| Case (64 Hz) | Formula result | Model |
| --- | --- | --- |
| AK-47 from rest | +18.477 u/s first tick; 95 % (204.25) on tick 28 = 0.438 s; 215 on tick 36 | identical (tick by tick) |
| Knife from rest | +21.484; 95 % on tick 28; 250 on tick **35** (W3 measured 35) | identical |
| AK walk (215 × 0.52 = 111.8) | 111.8 on tick 10 (0.156 s) | identical |
| AK crouch (215 × 0.34 = 73.1) | 73.1 on tick 6 (0.094 s) | identical |
| **AK counter-strafe** from 215, opposite key held | 179.05, 146.03, 115.69, 87.81, **62.20** (≤ 73.1, accurate: tick 5 = 78 ms), 37.22, 12.25, then −12.73 (tick 8: moving the other way) | identical |
| AK counter-strafe, opposite key 7 ticks then release | 5.75 on tick 8, **0 on tick 9** (141 ms), 10.09 units travelled | identical |
| AK release only (friction) | accurate on tick 13 (203 ms), 0 on tick 24 (375 ms), 30.9 units | identical |
| Knife counter-strafe from 250 | ≤ 85 (0.34 × 250) on tick 5 | identical |

So the classic CS2 counter-strafe (tap the opposite key for about 110 ms) is exactly what the formula gives at 64 Hz:
accurate after 5 ticks, stopped after 7–9; releasing alone takes 13 ticks to be accurate. "Accurate" uses CS2's
movement-inaccuracy onset of 34 % of max speed (H2, `docs/weapons.md`, `moveStartFraction`). Sub-tick (below) moves
these by a fraction of a tick, not more.

### Jumping, air, falling, steps (pinned)

- **Jump apex 56.9975** and landing on tick 48 (0.75 s). CS2 uses `sv_jump_precision_enable` (no half tick of gravity
  before the first move, unlike S1 `FullWalkMove`'s `StartGravity` at l. 2027 before `CheckJumpButton` l. 2084), so the
  apex is impulse² / 2g = 57.0 less the 64 Hz discretisation. Consistent with W3 (CS2's height is "57.03"-like) and W1/W2
  (66-unit crouch-jump boxes = 57 + the 9-unit in-air duck, W1's jump-then-crouch +9). Not measured in-game to 0.01.
- **Air** (S1 `AirAccelerate` l. 1705): wish capped at 30, accel `12 × wishspeed × dt × surfaceFriction` = 46.875 u/s
  per tick for a knife. Best air-strafe angle 90°: 250 → 251.794 per tick; along the velocity nothing; against it −46.875.
- **Gravity**: two half steps (S1 `StartGravity` l. 1257 / `FinishGravity`): from rest in the air vz −12.5, z −0.098 after a tick.
- **Fall damage**: (v − 580) × 100 / (1024 − 580) × `sv_falldamage_scale` (S2 `shareddefs.h` l. 415–421, non-HL2
  branch); W1's 64-tick "damage starts at 223 units" running off matches the G3 test (222 → 0, 223 → 3 HP).
- **Steps**: an 18-unit step is climbed, 19 is not; 0.7 = 45.573° (W1).

### Findings

| # | Behaviour | CS2 (source) | Model before M1 | Severity |
| --- | --- | --- | --- | --- |
| M1-1 | Ground speed below 1 u/s | zeroed after the acceleration (S1 `WalkMove` l. 1967–1973); friction skips speeds < 0.1 (l. 1624) | kept: 7 u/s → 0.5 u/s after a tick with no input (Source: 0) | low (stop tick ±1 in rare cases; the counter-strafe numbers above are unaffected) |
| M1-2 | Take-off speed clamp | `sv_enablebunnyhopping 0`: jump speed may not exceed 1.1 × max speed (C1 description; the crop as S2 `PreventBunnyJumping`, tf_gamemovement.cpp l. 1092–1112) | none: a 300 u/s knife take-off stays 300 (CS2: 275) | medium (bunny hops and jumps after a fast landing keep too much speed) |
| M1-3 | Air acceleration while rising slowly | `m_surfaceFriction` 0.25 after a ground check with no ground and 0 < vz ≤ 140 (S1 `CategorizePosition` l. 3866–3877; still in CS2 per W2 l. 76), and `AirAccelerate` multiplies by it (l. 1734) | full: 250 → 251.794 per tick at 90° (CS2: 250 → 250.275) | medium (air strafing on the second half of the rise is 4× too strong) |
| M1-4 | Tagging | hit → speed cap × `m_flFlinchVelocityModifierLarge/Small` × `mp_tagging_scale` (C1, C2; recovery rate not public) | no tagging | high for duels (a tagged AK runs 86 u/s, not 215); H2 computes the modifier, movement must take it |
| M1-5 | Scoped / alt-mode speeds | C2 `m_flMaxSpeed[1]`: AWP 100, SCAR-20 / G3SG1 120, AUG / SG 553 150 | the primary speed always | medium (a scoped AWP walks at 200) |
| M1-6 | Duck transition | gradual (`m_flDuckAmount` at `m_flDuckSpeed`, 8 rested / 6.02 after a fresh duck, K1; `sv_timebetweenducks` 0.4, C1); Source 2013 non-TF `TIME_TO_DUCK` 0.4 s (S2 l. 109) is not CS2's | instant | medium for crouch-peeks; **not fixed**: the rate formula is not public (plan for H4 below) |
| M1-7 | Sub-tick input | a key change splits the tick into two simulations (W2 l. 131; W3: a half-tick knife press gives 10.74, not 21.48) | per-tick input | low–medium (≤ 1 tick of counter-strafe precision for the human) |
| M1-8 | Landing penalty | 2026 code: no stamina on jump or landing; "speed penalty is now a function of landing time", scaled by the landing vertical velocity "similar to sv_legacy_jump stamina" (R1). Exact function not public | the legacy form: penalty += 0.05 × land speed (cap 80 %), recovers 60 %/s, ground speed × (100 − penalty) / 100; no jump cost (matches the 2026 notes) | low; **unverified** formula, kept. (The G3 text above said `(staminaMax − stamina) / staminaMax`; the code uses / 100, which fits "Maximum stamina penalty" 80 as a percentage cap) |
| M1-9 | `sv_step_move_vel_min` 64 | "Min velocity for step move" (C1); semantics not public | always tries StepMove | low; not changed |
| M1-10 | Eye heights | 64.093811 / 46.076218 (W1, CS:GO; CS2 not published) | `damage.eyeHeight` 64 / `crouchEyeHeight` 46 | low (0.09 units; not in the movement block, left to the damage owner) |
| M1-11 | WALK + DUCK | not verifiable from public sources | stacks (215 × 0.52 × 0.34 = 38.0) | low; unverified, unchanged |
| M1-12 | Doc citation | `GAMEMOVEMENT_JUMP_HEIGHT` is 21 in Source SDK 2013 (`gamemovement.h` l. 24, HL2); CS2's 57 comes from the `sv_jump_impulse` description | G3's table cited "Source's 57" | doc only |

Verified and unchanged (tested in `tests/movement-cs2.test.ts`): every convar above marked ✓, every item run speed, the
ground acceleration curve, counter-strafing and friction-only stops, walk and crouch caps and their acceleration, the
jump apex and airtime, one jump per press, the air acceleration at every angle while falling, gravity integration,
fall damage, steps, the slope limit.

**Unverified** (CS2's code is not public and no measurement was found): the exact CS2 expression behind
`sv_accelerate_use_weapon_speed` (matches the measured 21.48 / 35 ticks), the duck rate (M1-6), the landing-penalty
function (M1-8), the tagging recovery rate (H2's 0.4 / s, `docs/weapons.md`), WALK + DUCK stacking (M1-11), the
`sv_step_move_vel_min` rule (M1-9), whether tagging also slows the acceleration (the fix scales the cap only), and the
in-game jump apex to better than about 0.1 unit.
