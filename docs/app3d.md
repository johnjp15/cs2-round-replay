# The 3D app (H1)

`src/app3d` + `sim3d/index.html`: the round in first person on CS2's Mirage, published at
`https://johnjp15.github.io/cs2/sim3d/` behind the same lock as the 2D page (`cs2/sim/`, unchanged). The engine is
`Sim3DHost` (docs/sim3d.md) in the 2D app's own `Session` (src/app/session.ts: checkpoints, takeover, the input tape,
seek), so watching, taking control and restarting behave exactly as in 2D.

```sh
npm run dev:3d            # http://localhost:5173 (the 3D page)
npm run build:3d          # dist-3d/ (npm run preview:3d serves it)
npm run build:single:3d   # dist-single-3d/index.html: one self-contained page
npm run check:browser:3d  # after build:3d: headless Chromium, screenshots, fps, takeover and firing (port 4180)
```

![Lokier at B from cart's window, through cart's eyes at 18.5 s](img/app3d-b-lokier-window.jpg)

## What's on screen

- **World**: the CS2 collision mesh (data/geometry/mirage-geometry.bin, no player clips), flat shaded, in Mirage's
  colours (below). Sky and distance fog.
- **Players**: capsules in team colours (T yellow-orange, CT blue; the human lighter), a dark visor at eye height
  along the view, crouched shorter, the dead lying flat and grey; name tags over the human's teammates (everyone's
  while watching).
- **Effects**: 3D tracers of the last 10 ticks' bullets (`Sim3DHost.shots()`), the muzzle flash on the viewmodel,
  smokes (grey domes), molotov fires (orange discs), grenades in flight, the bomb (red, blinking when planted).
- **First person**: the camera at the eye, a box viewmodel coloured by weapon drawn in its own pass and camera
  (viewmodel_fov), crosshair, hit marker (white; red for a headshot), the scope overlay while zoomed.
- **HUD**: score and round clock (the bomb timer once planted, red; green while defusing), the bomb line (carrier,
  planted, who is defusing and how long is left, defused), the kill feed, the radar minimap (the CS2 radar around the
  camera, every pawn as a dot, the view cone), the team panel (HP bar, mode: REPLAY / LIVE / YOU), HP / armor and
  weapon / ammo of the pawn being viewed, the mode line, fps and ticks/s, and the end-of-round summary line 2 s after
  the round end.
- **Bar**: Start, Pause, Restart, Take control of cart (E), Camera (V), speed 0.25–4×, and the CS2 settings
  (sensitivity, zoom_sensitivity_ratio, viewmodel_fov; kept in localStorage).

## Controls

Watching (default, every device): third person behind the followed pawn (the mouse orbits once the pointer is
locked: click), V cycles third person → through its eyes → free fly (WASD, Space up, Ctrl down, Shift fast), Z / X
the previous / next living player, P pause. When the followed pawn dies the camera moves on after 2 s.

**E** or the button takes control of cart from that tick (the speed drops to 1×; the pointer is locked): mouse look,
W / S forward / back and A / D strafe relative to the view (CS2's), Space jump, Ctrl or C duck, Shift walk, mouse 1
fire / throw, mouse 2 scope (AWP, SSG 08; the engine itself has no scope state yet, so scoped movement speed and
accuracy come with H2), R reload, 1–5 weapon slots (as the 2D app), E use (plant, defuse). Esc frees the mouse. Dead,
the camera spectates again. G (drop) is not implemented: the engine has no dropped weapons yet (H4).

## View: CS2's numbers, with sources

`src/app3d/view-cs2.ts`. Primary sources: **[CVARS]** CS2's convar dump, SteamDatabase/GameTracking-CS2
`DumpSource2/convars.txt` (commit `cce7bf1f`, fetched 2026-11-07); **[SDK]** Source SDK 2013
(ValveSoftware/source-sdk-2013: `src/game/client/in_mouse.cpp`, `view.cpp`, `src/game/shared/shareddefs.h`,
`gamemovement.cpp`).

| What | Value / rule | Source | Verified for CS2 |
| --- | --- | --- | --- |
| Mouse → yaw | yaw −= m_yaw × counts_x × sensitivity | [SDK] CInput::ScaleMouse, ApplyMouse | rule: Source; values: [CVARS] |
| Mouse → pitch | pitch += m_pitch × counts_y × sensitivity (mouse down = look down) | [SDK] ApplyMouse | as above |
| m_yaw, m_pitch | 0.022° per count | [CVARS] `m_yaw 0.022`, `m_pitch 0.022` | yes |
| sensitivity | default 1.25, range 0.0001–8 (settings field, `?sens=`) | [CVARS] | yes |
| Acceleration, smoothing | none (m_customaccel 0, no filter) | [SDK] ScaleMouse with m_customaccel 0 | CS2 has no mouse accel option in its dump: yes |
| Pitch limit | ±89° | [CVARS] `cl_pitchup 89`, `cl_pitchdown 89` | yes |
| FOV | 90° horizontal at 4:3, hor+: vertical 73.74° fixed, 106.26° horizontal at 16:9 | [SDK] `ScaleFOVByWidthRatio` (view.cpp); 90 = CS:GO's default_fov | the 90: **unverified** against a CS2 primary source (CS2 locks the FOV; `fov_desired 75` in the dump isn't applied in matchmaking) |
| Scoped FOVs | AWP 40 / 10, SSG 08 40 / 15, AUG and SG 553 45, autosnipers 40 / 15 (4:3 degrees) | CS:GO weapon data `zoom_fov_1/2` as documented by players | **unverified** for CS2; H2's table replaces them |
| Zoomed sensitivity | sensitivity × (zoomed FOV / 90) × zoom_sensitivity_ratio (linear in the FOV) | [SDK] view.cpp (`m_flFOVSensitivityAdjust`); [CVARS] `zoom_sensitivity_ratio 1` (0.01–3) | rule: Source; the default: yes |
| viewmodel_fov | 60, 60–68 (a 4:3 FOV, hor+ like the world's) | [CVARS] `viewmodel_fov 60 (min 60, max 68)`; [SDK] `fovViewmodel = ScaleFOVByWidthRatio(...)` | yes (CS:GO allowed 54) |
| Aim punch | bullets: view + punch × weapon_recoil_scale (2); camera: view + punch × 2 × view_recoil_tracking (0.45); the punch is zero until H2 / H4 | CS:GO cvars | **unverified** (both are hidden in CS2: not in the dump) |
| Eye height | 64 standing, 46 ducked | Source view offsets (`damage.eyeHeight`) | as the sim |
| Duck transition (camera) | 0.4 s down, 0.2 s up, SimpleSpline (3x² − 2x³) | [SDK] TIME_TO_DUCK, TIME_TO_UNDUCK, SetDuckedEyeOffset | **unverified** for CS2 (the shared movement ducks the hull at once; M1 owns that) |

**Mouse counts.** The page uses pointer lock and reads `movementX / movementY`. It first asks for
`requestPointerLock({ unadjustedMovement: true })` (Chromium: raw mouse counts, the OS pointer acceleration bypassed,
like CS2's raw input; `view().raw` says whether it was granted); Safari and Firefox ignore or reject the option, so
there the deltas are the OS pointer's pixels: with the OS acceleration off and 1:1 pointer scaling one pixel is one
count. DPI changes counts per inch, not this formula (cm/360 = 360 / (0.022 × sensitivity × DPI) × 2.54).

**Firing.** The human's input carries the firing angles (view + 2 × punch: the view while the punch is zero); the
headless host consumes only yaw and pitch, so nothing in it depends on the view code.

## Frames

Source: x east, y north, z up; yaw counter-clockwise from +x; pitch positive = down. Three.js: y up. The mapping is
the rotation (x, y, z)_Source → (x, z, −y)_Three (src/app3d/coords.ts; determinant +1, so windings are kept): Three
+x east, +y up, −z north. The camera uses Euler order YXZ with y = yaw − 90° and x = −pitch (tests/app3d-view.test.ts
checks it against the view direction).

## World colours

`src/app3d/world-mesh.ts` (pure; tests/app3d-world.test.ts). Up and down are decided by space, not the normal (the
mesh's winding is inconsistent): a near-horizontal triangle (|nz| ≥ 0.7) with free space 24 units above its centre is
a floor, otherwise an underside (dark). Floors are drawn with the CS2 radar (data/source/cs2/de_mirage.png) as their
texture, UVs from the radar transform (`px = (x − pos_x) / scale`, `py = (pos_y − y) / scale`, pos −3230 / 1713,
scale 5), after `floorArt` maps the stylized radar onto Mirage's sand: its brightness (boxes, steps, outlines) and
30 % of its hue (the levels, the wooden and tiled areas) survive; outside the playable area plain sand. Floors with
something solid within 256 units above are indoors and darker (Apartments, Connector, the underpass). Walls are a
sandstone ramp by height, shaded by how much they face the sun (two-sided), tinted 30 % toward the floor colour in
front of them, darker toward their foot, with ±3 % grain per triangle. The mesh is cut into 1024-unit tiles so the
renderer culls what is off screen; everything is unlit at run time (colours baked), ≈ 73k triangles.

## Data, build and deploy

Normal build: the JSON and binary files are fetched next to the page (assets3d.ts). Single file
(vite.single.3d.config.ts): `./assets3d` is redirected to `assets3d-embedded.ts`; the round, nav, sight mask, tracks,
movement mesh and clips are gzip + base64, the radar a data: URI, Three.js (0.187) bundled into the inlined script;
the build fails if anything but index.html is written. **Sizes**: dist-single-3d/index.html 1,488 KB (gzip 739 KB),
locked by cs2/tools/encrypt.cjs ≈ 1,990 KB (budget 3 MB; the 2D locked page is ≈ 1.5 MB). `tools/stage-web-apps.sh`
stages both pages (`cs2/sim/`, `cs2/sim3d/`) and adds the sim3d card and README row once; the web-apps workflow
(`git add -A cs2`) needs no change.

## Browser check

`tools/browser-check3d.ts` (port 4180; `--single` serves the single file). It screenshots (a) the start, (b) Lokier
at B from cart's window (18.5 s, cart's eyes), (c) the plant (27.6 s, behind barely), (d) Sp4rtaN behind donk
(49.95 s), (e) the defuse (64 s), (f) first person after taking control; checks the FOV (vertical 73.74°), that E
takes control (YOU, 1×), that mouse counts turn the view by exactly counts × 1.25 × 0.022°, and that mouse 1 fires
(ammo drops); measures fps and ticks/s at 1× and 4×.

WebGL in the sandbox's headless Chromium is software (lavapipe or SwiftShader) on two shared cores: a bare WebGL
canvas that only clears reaches 26–50 fps at 1280 × 800 and 56–60 at 640 × 400, so the frame rate is measured at
640 × 400 (the rendering itself is cheap: 37k triangles in 0.7 ms with `gl.finish`). On a machine whose load per
core is above 1.25 during the run (other agents' test suites), the rates are reported but not asserted. Results:
logs/browser-check3d.json; the numbers of the H1 run are in the PR.

![The defuse](img/app3d-e-defuse.jpg)
![First person after taking control](img/app3d-f-first-person.jpg)
