# Vision in the 2D sim (C4 / A5: `src/sim2d/vision.ts`, `data/mirage-vismask.json`)

What a pawn can see, and what bullets and grenades can cross. The nav mesh stays the **movement** model; sight uses a
**mask built from the radar** (walls, and since F **cover**: boxes, crates, the Truck) plus a **level check** on the nav
floors.

Why: the nav mesh's `lineOfSight` treats everything that isn't walkable as a full-height wall, so drops, ledges,
windows and nav holes block sight. B3 found that 6 of the 13 recorded aimed engagements had no line of sight that
way, among them cart → Lokier through the Apartments window onto B, which really happened (`docs/core.md`, Known
limits).

## The mask (`tools/extract-vismask.ts`)

```sh
npx tsx tools/extract-vismask.ts          # data/mirage-vismask.json + logs/vismask-debug.png (+ -bsite.png, B site 3×)
npx tsx tools/extract-vismask.ts --check  # fails if the committed file is stale
npm run extract:vismask                   # the same as the first line
```

Input: `data/mirage-radar.jpg` (1024 × 1024, SHA-256 `e270489d…`, recorded in the file). Output: one cell per radar
pixel (5 units), the radar transform `px = (x + 3230) / 5`, `py = (1713 − y) / 5`. jpeg-js decodes the JPEG (a
devDependency; tools only, nothing at runtime).

On this radar, playable space is coloured (blue-grey floors, tan rooms, teal stairs, white props) and walls and
out-of-map space are black or near-black. The dark-grey grid lines and labels (L ≈ 55, chroma ≤ 6) are drawn in the
black background, never over floors. Steps, with the parameters written into the file's `params`:

| step | parameter | value | why |
| --- | --- | --- | --- |
| 1. classify | `lumOpen` | 72 | Open if luminance L = 0.299 R + 0.587 G + 0.114 B ≥ 72. Grid lines peak at ≈ 60; the darkest floor shading (CT spawn) is ≈ 72. |
| | `lumTeal`, `chromaTeal` | 28, 12 | Darker pixels are open only if blue-green (G ≥ R, B ≥ R) with L ≥ 28 and chroma ≥ 12: the dark teal Tunnel Stairs (L 30–50) are floor; JPEG ringing next to tan rooms is reddish and stays wall. |
| 2. close walls | `closeRadius` | 1 | Dilate then erode the walls with a 3 × 3 square: open cracks ≤ 2 cells wide inside walls are filled, so a lighter JPEG pixel can't open a hole through a wall. No doorway is that narrow (a player is 6.4 cells wide). This also removes the grid lines and labels (4,305 cells). |
| 3. open specks | `minOpenArea` | 64 | 8-connected open components < 64 cells become wall (4 components, 63 cells). |
| 4. wall specks | `minWallArea` | 6 | 4-connected wall components < 6 cells not touching the border become open (dark noise on floors: 6 components, 13 cells). Pillars and wall stubs are larger. |
| 5. thin lines | `openThinLines` | true | A wall cell with open cells on both sides along x or along y (a line one cell thick) becomes open, in one pass (184 cells). On this radar 1-px dark lines drawn over floors are windows and railings: the Apartments window over B, the Mid window of Sniper's Nest, the Tunnel Stairs railing. Full-height walls are black gaps of 2 cells or more, which this step never touches. |
| 6. cover (F) | `coverLumSeed`, `coverChroma` | 190, 24 | Boxes, crates and the Truck are drawn light grey to white (L 190–255, chroma ≤ 12) on floors that are L ≤ 156 (blue-grey 131, the grey bombsite squares 154) or colourful (tan rooms, chroma > 30). An open cell this light and grey seeds a prop. |
| | `coverLumEdge` | 170 | JPEG blurs box edges over 1–2 px: cells at least this light (and as grey) 8-connected to a seed through such cells join it (14,122 candidates). |
| | `coverOpenRadius` | 1 | An opening by a 3 × 3 square drops cover lines and slivers up to 2 cells thick (ledge highlights in Mid and on the T ramp). |
| | `coverMinArea`, `coverMinCore` | 12, 5 | 8-connected components smaller than 12 cells, or without a 5 × 5 square (25 × 25 units) inside, are dropped: the remaining 3-cell-wide highlight lines (the long one beside T spawn's ramp, 3 × 78) and door sills (the Shop door, 12 × 4). 19 dropped, 52 kept. |

Result: 738,507 wall cells (unchanged by cover), 12,413 cover cells in 52 components, 297,656 open. The file (49 KB,
format `vismask@2`) is run-length encoded, one row per line: each `rows` row lists run lengths alternating wall, open,
wall, … starting with wall (the first may be 0; cover counts as open there), and each `cover` row run lengths
alternating not cover, cover, … starting with not cover. A `vismask@1` file (no `cover`) still decodes, with no cover.
Same image in, same bytes out (`tests/vision.test.ts` rebuilds it and compares).

`logs/vismask-debug.png` shows the radar with walls tinted red, cells the cleanup closed in yellow and cells it opened
in cyan, cover in green and cover candidates the opening or the component filter dropped in orange;
`logs/vismask-debug-bsite.png` is B site at 3×; `logs/vision-labels.png` adds the labelled pairs (below). All are
gitignored.

![B site in the debug overlay: the box stacks in green, the black corner stacks (walls) in red, the dropped Shop door sill in orange](img/vismask-cover-bsite.jpg)

## Line of sight

**`VisMask.lineOfSight(a, b)`** (2D): an Amanatides–Woo DDA over the exact cells the segment crosses, measuring each
run of consecutive wall cells along the segment (in cells). A run longer than `ai.losWallTolerancePx` (1) blocks, so
grazing a corner (a tiny length in a wall cell) doesn't. A run that touches either end may be up to
`ai.losEndpointTolerancePx` (3) long: a pawn's centre a few units inside a wall cell. Outside the grid is wall. The
walk starts from the lexicographically smaller end, so `lineOfSight(a, b) === lineOfSight(b, a)` exactly.
`trace(a, b)` returns the longest run and where it starts (tools, tests).

**`Sight`** combines it with a **level check** on the nav floors (`NavMesh.floorsAt`), because the 2D mask can't
tell the Underpass from Catwalk above it:

- `flat(a, b)`: the mask (or, without one, the nav mesh's `lineOfSight`; the synthetic meshes in the tests).
- `clear(a, eyeA, b, eyeB)`: `flat`, and the straight 3D line between the two eyes (floor z + eye height) sampled every
  `ai.losLevelStepUnits` (16) against the floors under each sample. It is blocked where it is more than
  `ai.losLevelSlackUnits` (48) below every floor under a sample (inside the ground: a ledge face seen from below), or
  where, over one floor surface (floors matched sample to sample within `nav.stepHeight`), it is both more than 48
  below it and above it (through a slab: Catwalk over the Tunnel). Samples off the mesh don't constrain.
- `lineOfSight(a, b)`: `clear` with the standing eye height (`damage.eyeHeight`) at both ends; 2D only if a point
  has no z. This is what hitscan calls.

The slack is 48 because the nav's two-corner height model is off by tens of units on some sloped areas: at 24, the
Truck → Apartments line (Lokier's kill of eradicate) clipped a Balcony area 24 units under its modelled floor. The
Underpass → Catwalk line runs 69 units under the Catwalk floor.

### Cover (F)

The radar has no heights, so a box can't be treated as a wall (you see and shoot over a waist-high crate) nor as floor
(a pawn crouched or defusing behind it is hidden). `Sight.coverClear(a, b)` decides, for the straight line between the
two ends (each a point with a height above its floor, eye or body band, and a posture):

A run of cover cells along the 2D segment **blocks** unless

1. it is at most `ai.losCoverTolerancePx` (1) cells long along the line (grazing a box corner), or
2. it contains an end (a pawn's centre on a box: standing on it, or position error), or
3. an **upright** end is within `ai.losCoverNearUnits` (48) of it along the line: a standing pawn at a box looks and
   shoots over it, and is seen over it. Crouched, planting and defusing pawns are **low**: they never look over cover,
   so a defuser hugging a box is hidden from across the site; so is a target point on the ground (the AI's guard spot
   check on the planted bomb); or
4. the line passes over it: across the whole run it is at least `ai.losCoverHeightUnits` (72) above the lower end's
   floor (from the Apartments window or a balcony you see over the boxes on B).

It is symmetric in its ends, and only the mask's cover cells count (walls are the flat test's). The rule was chosen
against the recording: every recorded kill, damage and sighting stays visible (below; the three that touch cover all
have an end on or at a box: Lokier at the Truck at 12.5–12.75 s, on the B-site box at 18.8 s), and B3's aimed fire items
lose nothing.

### Who uses what

| user | query | note |
| --- | --- | --- |
| `sees` | `Sight.clear`, eye to eye (64, or 46 crouched), with postures | plus FOV, smoke and blindness (below). Crouched, planting or defusing (`SeePawn.busy`, a plant or defuse in progress) pawns are low for cover |
| bullets (`traceShot`) | `Sight.lineOfSight(shooter, impact)`, the impact point with the target's floor z; then `Sight.coverClear` from the shooter's eye to the hit band's point on the target | **Bullets use the mask**: you can shoot through the Apartments window, as cart and Lokier did. Windows and railings are shoot-through; a box stops a bullet under the cover rule (the shooter's and the victim's postures, `ScanPawn.busy`), and so is everything behind it on the ray; there is still no wall penetration. |
| grenades (throw clamp, flash, HE) | `Sight.flat` (`GrenadeSight`) | 2D: a grenade's arc is above eye level, so the level check would be wrong; grenades fly through windows, over drops and **over boxes** (cover is ignored) |
| LIVE AI guard spot | `Sight.clear(spot, eye, bomb, leg band, upright, low)` | a guard spot needs sight to the bomb over the boxes |
| B2's snap rule | `sees` of the human's pawn | through `Observe` (see below) |

## `sees` (contract F5)

Each tick, for every alive pawn V, `sees` lists every other alive pawn T, of either team, such that:

1. V isn't blind (`tick < blindUntilTick(V)` means blind);
2. T is within `ai.fovDeg / 2` (53°) of V's yaw (the bearing from V to T; the same point counts as in view);
3. `Sight.clear(V.pos, eyeV, T.pos, eyeT)` with eyes at `damage.eyeHeight` (64) above the floor, `crouchEyeHeight`
   (46) when crouched;
4. the 2D segment V–T crosses no active smoke (`smokeBlocks`).

Sorted by id. Dead pawns see nothing and can't be seen. Teammates are included (the Core's "don't snap a puppet the
human can see" needs them). Sight and smoke are symmetric, so `computeSees` traces each unordered pair once, and only
if one side looks at the other. The host caches it per state (recomputed after `tick()`, `apply()` and `restore()`),
and the LIVE AI reads the same lists at the start of a tick.

**Cost:** 0.073 ms per tick for 10 viewers × 9 targets (Node 22, recorded positions every 0.5 s of the round, 3.4
visible pairs per tick on average; `tests/vision.test.ts` asserts < 0.5 ms). A whole Session step goes from 0.421 to
0.449 ms per tick (full round, human cart). Cover adds a second walk over the cells of each line that passes the walls
and the level check: 0.063 → 0.077 ms per tick in the same test, back to back (3.4 visible pairs per tick, unchanged).

The CS2 adapter reproduces it with `Trace.TraceEndShape` eye to eye plus the same FOV, smoke and flash tests
(`docs/cs2-adapter.md`, `sees`); the level check is the 2D sim's stand-in for the 3D trace.

## Validation (`tests/vision.test.ts`, `tools/vision-labels.ts`)

```sh
npx tsx tools/vision-labels.ts           # the report below, logs/vision-labels.png
npx tsx tools/vision-labels.ts --write   # also rewrites tests/fixtures/vision-labels.json
npx tsx tools/vision-shots.ts            # B3's aimed fire items in the scripted round
```

**Must see** (from `data/round.json`, shooter or observer → target at that moment): every kill (`kpos` → `vpos`), every
damage entry with `apos` and `vpos`, and every `sightings[]` entry (each T named in `by` → the CT, both from the tracks
at `t0`; when `by` names several players and the recording's camera follows one of them at `t0`, only that one: at
58.6 s "cart / barely" is barely's POV, while cart is in Shop behind the Market wall). A pair is **untrusted** (listed,
not asserted) when an end isn't backed by an observed track sample (kills and damage: no observed sample within ±0.1 s
and 16 units; sightings: the sample at `t0` or a neighbour it is interpolated from is estimated or inferred).

**Must not see:** 12 hand-picked pairs across solid walls (each with its justification in the fixture), including the
brief's Shop ↔ B plant and Underpass ↔ Catwalk.

The fixture `tests/fixtures/vision-labels.json` is generated by the tool and checked against `round.json` by the test.

**Results:** must see **12 / 12** asserted pairs visible (the nav LOS: 9 / 12); must not see **0 / 12** visible (the 2D
mask alone: 1, Underpass ↔ Catwalk; the nav LOS: 0). With cover (F) both are unchanged: three asserted pairs cross
cover, each at an end (rule 2 or 3 above).

| pair | trusted | sight | 2D mask | nav LOS | longest wall run (cells) | mask flips with a sideways shift of |
| --- | --- | --- | --- | --- | ---: | --- |
| kill 0.5 snarlbot → incredibad | no (inferred) | blocked | blocked | blocked | 4.7 | 12 u |
| kill 12.4 snarlbot → snakelore | no (estimated) | visible | visible | blocked | 0 | 35 u |
| kill 12.75 lokier → eradicate | yes | visible | visible | visible | 0 | 16 u |
| kill 17.85 sp4rtan → snarlbot | no (inferred) | blocked | blocked | blocked | 61.7 | > 96 u |
| kill 18.8 cart → lokier | yes | visible | visible | **blocked** | 0 | 8 u |
| kill 44.2 barely → zwomp | excluded (level) | blocked | blocked | blocked | 4.3 | > 96 u |
| kill 50.35 sp4rtan → donk | yes | visible | visible | visible | 0 | 45 u |
| kill 58.85 sp4rtan → barely | excluded (position) | blocked | blocked | blocked | 11.0 | 25 u |
| kill 69.4 sp4rtan → cart | yes | visible | visible | visible | 0 | 78 u |
| damage 18.5 lokier → cart | yes | visible | visible | **blocked** | 0.3 | 3 u |
| damage 49.9 / 50 / 50.1 sp4rtan → donk | yes | visible | visible | visible | 0 | 33–34 u |
| sighting 12.5 eradicate → lokier | yes | visible | visible | visible | 0 | 33 u |
| sighting 12 snarlbot → snakelore | no (estimated) | visible | visible | blocked | 0 | 7 u |
| sighting 17.45 cart → lokier | yes | visible | visible | **blocked** | 0 | 70 u |
| sighting 44 barely → zwomp | excluded (level) | blocked | blocked | blocked | 4.4 | 91 u |
| sighting 49.9 donk → sp4rtan | yes | visible | visible | visible | 0 | 33 u |
| sighting 58.6 barely → sp4rtan | excluded (position) | blocked | blocked | blocked | 11.0 | 28 u |
| sighting 68.75 cart → sp4rtan | yes | visible | visible | visible | 0 | 81 u |

The 12 must-not-see pairs are all blocked by the full sight, 11 of them by walls 21–268 cells long that no shift up to
96 units opens; Underpass ↔ Catwalk is blocked by the level check.

**Investigated failures (excluded with evidence; none is a wallbang).** Four trusted pairs fail, all on barely's
recorded position:

- *barely → zwomp, 44.0 and 44.2 s (level).* barely's recorded spot is on the Tunnel Stairs (z −315 / −328), behind the
  stairwell's 5-cell south wall (radar y 271–276; no nav area there either) and 143 units below Zwomp on Catwalk. In 3D
  too his eye (z −251) is below the Catwalk floor (−172) at that wall, so nobody standing there sees Catwalk. His track
  then jumps 89 units and +154 z onto Catwalk in 0.1 s at 44.7 s (B3's discontinuity list): the recorded spot is wrong,
  he fired from the top of the stairs at Catwalk level.
- *sp4rtan ↔ barely, 58.6 and 58.85 s (position).* The line runs 4.6 cells (23 units) inside the south edge of the pillar
  at the east end of B site (radar x 341–351, y 269–283; also a hole in the nav mesh), 90 units from barely; moving
  barely 25–28 units sideways clears it. His track holds y 310–312 from 58.2 to 58.8 s while he "runs back toward the
  bomb" (narrative, 57.6 s), which lies due west at y 311: that straight run would go through the pillar, so he was
  south of it. The pillar is 55 × 75 units, far beyond AK penetration.

**B3's aimed fire items** (`tools/vision-shots.ts`, positions as the engine had them at each shot of the scripted round):
9 of the 13 items with a target have sight at one of their shots (the nav LOS: 7; B3 counted 6 blocked), 8 at every
shot, and 10 get an engine hit (hits are blocked by the Core's `block_damage`, so they only show in `combatLog()`). The
four without sight: snarlbot → incredibad at 0.48 s (incredibad's inferred spot; the hit still lands, because the
impact point on his circle is 16 units nearer), sp4rtan → snarlbot at 17.83 s (sp4rtan's inferred 700 u/s loop), and the
two barely items above. With cover (F) the table is identical, item by item (9 / 8 / 10).

**Cart's spray at the defusing sp4rtan (65.9–66.9 s), the case cover was meant for.** In the recording it hits nothing
("the defuser behind the B-site boxes"); in 2D the first four of its eleven shots have sight (the table above: 4 / 11),
and with B3's aim and no spread they hit. On this radar no box is on those lines: from cart's recorded spots
(−2214, −182) … (−2270, −160) to sp4rtan's (−2005, 345) the line crosses open floor and the bombsite square, passing
45 units east of the black corner stack (already wall, which blocks the later seven shots) and 55–80 units west of the
south-east box stack; the nav mesh's holes agree with the radar's boxes there. So cover can't stop them. What the tape
does show is cart looking elsewhere: his recorded view yaw during the spray tracks a fixed point near (−2210, 275)
within 0.8° RMS, 17–22° off sp4rtan's spot, while he walks west at 150–200 u/s (an AK that inaccurate at 570 units
misses anyway). B3 aims every recorded shot at its target; for the human's "perfect" follow script the shots the tape
shows missing now use his recorded view instead (`tools/follow-aim.ts`, `docs/golden.md`), and that run has no LIVE
switch. G5: the spray is also one of the human's recorded duels (`docs/core.md` "Recorded duels of the human"): from
his recorded spot his bullets on sp4rtan are blocked during it whatever the aim, so it hits nothing either way. The radar sighting window points the same way, mirrored: sp4rtan is on cart's radar until 65.2 s and off it
during the spray; in 2D the B-site stack hides the defusing sp4rtan from cart at the Shop door 64.5–65.1 s and opens as
cart walks west. A few tens of units of difference in the CS:GO 2020 box or sp4rtan's spot would explain both.

## Known failure modes

- **No height in the mask.** Props (the white Truck, the B and A site boxes) are cover with one rule for all (above):
  a 48-unit crate and a stack taller than a player are treated alike, and boxes drawn black (the B-site corner stacks)
  are walls. Low walls drawn black block completely. Postures are only crouched / planting / defusing; nobody in the
  2D sim jumps onto or over a box.
- **Thin lines are windows everywhere.** The Apartments' whole south wall over B (≈ 415 units) is a 1-px line, so the
  mask treats all of it as a window, and the Mid window of Sniper's Nest is wider than the real one.
- **Levels** are only caught where the nav mesh has both floors (stacked areas) or the upper floor's edge; through nav
  holes (36 % of recorded positions were off-mesh, `docs/nav.md`) the level check has nothing to test. A line within 48
  units of a floor passes.
- **Positions near obstacles.** Recorded positions are ±20–30 units; a line that grazes a pillar flips with a small
  shift (the "flips with" column). The labelled set shows where.
- **Smoke** is a 2D disc (`smokeBlocks`), full height, instantly full size; flashes need only the 2D mask.
- **Doors** don't exist; the radar is CS2's (2026), the recording CS:GO's (2020): props and boxes may have moved
  (`docs/cs2-adapter.md`, risk 10).
