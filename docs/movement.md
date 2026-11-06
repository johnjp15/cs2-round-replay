# 2D movement model and Sim2DHost (`src/sim2d/movement.ts`, `src/sim2d/host.ts`)

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
const host = new Sim2DHost(nav, tuning, roster);   // roster: the ten {id, team}; the host does not read round.json
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
| `set_mode` | Records mode and goal per pawn (`pawnState(id)`); the host does not act on them. |
| `log` | Ignored (the app reads Core logs from the Act / SessionLog). |
| `damage`, `block_damage`, `unblock_damage` | C2: see `docs/combat.md` (scripted damage is applied in the next `tick()`). |
| `plant`, `defuse_start`, `defuse_stop`, `end_round`, unknown types | Noted as `unsupported in v0` in `unhandled()`; nothing else happens (bomb and round rules: C3). |
| `control(c)` | Noted as `unsupported in v0`. |

- **Spawn state** (before Core sets a pawn up): pos (0, 0, 0), 100 HP, 0 armor, no helmet, knife only
  (0/0), mode REPLAY.
- **Human**: `human` defaults to `cart`; `setHuman(id | null)` changes it. `setHumanInput(input)` drives the
  human pawn instead of any Core input for it, until replaced or cleared with `null`, which hands the pawn
  back to Core. `input.id` must be the human pawn.
- **observe()**: all roster pawns sorted by id, `sees: []` (C4), the last tick's events in emission order
  (C2), `t = tick / 64`.
- **snapshot() / restore()**: version 2 adds the combat state (`docs/combat.md`, Snapshot) to
  `{tick, human, humanInput, inputs, pawns}`, via `toJsonValue`. It is exact because the state is canonical.
  `restore` checks the version and roster. `unhandled()` and `combatLog()` are diagnostics and are not part of
  snapshots.
- **Determinism**: no randomness or clocks. `apply` and `setHumanInput` canonicalize what they receive, and
  the movement state is rounded to the log's 6 decimals after each tick. So `observe()` is canonical, the
  logged acts alone reproduce the logged observes (tested), and snapshots round-trip exactly. Caveat:
  `Math.cos`/`Math.sin` (wish direction) and `Math.hypot` (nav clamp tie-breaks) are not bit-specified
  across JS engines. Node and the browser normally agree after the 6-decimal rounding, but this is not
  proven for V8 vs. JavaScriptCore.

## Not modelled yet (differences from CS2)

Jumping, air movement and falling; stamina and landing slowdown; tagging (slowdown when hit); scoped
speeds (AWP 100); crouch transition time (crouch is instant); surface friction; sub-tick input; step-up
and ledges (z just follows the nav floor). Whether WALK and DUCK stack in CS2 is to be checked. The player
hull is implicit: nav areas are player-centre space.
