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
  along the view, crouched shorter, the dead lying flat and grey; name tags over the viewer's living teammates, and
  over an enemy only while the viewer sees it (`sees`: never through walls). The viewer is the human, else the
  spectated player.
- **Effects**: 3D tracers of the last 10 ticks' bullets (`Sim3DHost.shots()`), the muzzle flash on the viewmodel,
  smokes (grey domes), molotov fires (orange discs), grenades in flight, the bomb (red, blinking when planted).
- **First person**: the camera at the eye, the held weapon's low-poly viewmodel with hands (A1, "Viewmodels" below)
  drawn in its own pass and camera (viewmodel_fov), crosshair, hit marker (white; red for a headshot), the scope
  overlay while zoomed (the viewmodel hidden, as in CS2).
- **Sound** (A1): CS2's sound events with positional HRTF audio, CS2's distance curves and occlusion on the mesh,
  starting with the first click or key; placeholders until John's CS2 files are packed. docs/cs2-sounds.md.
- **HUD**: score and round clock (the bomb timer once planted, red; green while defusing), the bomb line (carrier,
  planted, who is defusing and how long is left, defused), the kill feed, the radar minimap (the CS2 radar around the
  camera, every pawn as a dot, the view cone), the team panel (HP bar, mode: REPLAY / LIVE / YOU), HP / armor and
  weapon / ammo of the pawn being viewed, the mode line, the headroom meter (Performance, below), and the
  end-of-round summary line 2 s after the round end. While spectating: the spectator panel and an edge vignette (below).
- **Bar**: Start, Pause, Restart, Take control of cart (E), Camera (V), Radar (CS2 rules / show everyone), speed
  0.25–4×, the settings (CS2's sensitivity, zoom_sensitivity_ratio, viewmodel_fov, and **Recoil tracking**), and FPS
  limit, Res (render scale) and Low latency (Performance, below). These and the radar toggle are kept in localStorage,
  `cs2-sim3d-settings`.

## Controls

Watching (default, every device) and dead: spectating, as CS2 (below). P pause.

**E** or the button takes control of cart from that tick (the speed drops to 1×; the pointer is locked): mouse look,
W / S forward / back and A / D strafe relative to the view (CS2's), Space jump, Ctrl or C duck, Shift walk, mouse 1
fire / throw, mouse 2 scope (the input's ATTACK2: the scope is the engine's, H2b: levels and FOVs from
data/weapons.json, scoped accuracy and speed, a reload or a bolt cycle drops it), R reload, 1–5 weapon slots (as the 2D app), E use (plant, defuse). Esc frees the mouse. Dead,
the camera spectates again (your living teammates first, as CS2 competitive's mp_forcecamera 1). G (drop) is not implemented: the engine has no dropped weapons yet (H4).

Duck, walk, jump and use are rebindable under **Keys** in the bar (one localStorage setting
with the 2D page; Reset keys = CS2's defaults).

**Ctrl+W** (crouch forward) is "close tab" on Windows and Linux. **⛶ Fullscreen** in the bar enters fullscreen and,
in Chromium browsers (Chrome, Edge, Opera, Brave; feature-detected `navigator.keyboard.lock`), locks the keyboard, so
Ctrl+W / S / T / N reach the page and are blocked there: Ctrl+W just crouches forward. Under the lock a **short Esc
frees the mouse** (the page does it, the browser no longer does) and **holding Esc leaves fullscreen** (a hint line
says so); leaving fullscreen unlocks. Firefox and Safari have no Keyboard Lock: there, and anywhere outside fullscreen,
a `beforeunload` guard while you control a living pawn makes Ctrl+W (or ⌘W on a Mac) show the "Leave site?" dialog
instead of closing the tab; moving Duck to C or Alt avoids it entirely. On macOS Ctrl+W is no shortcut, and **⌘W can't
be captured by any page**, so only the dialog stands between it and the tab. Details and the per-browser table:
docs/app.md "Ctrl+W, fullscreen and key bindings".

## Spectating (U1)

`src/app3d/spectate.ts` (pure), `main.ts`, `hud3d.ts`. Watching (nobody controlled) or dead:

| Input | First person (default) | Third person | Free fly |
| --- | --- | --- | --- |
| Mouse 1 / Space | next player | next player (the click that grabs the pointer only grabs it) | mouse 1: first person on the next player (once the pointer is grabbed); Space flies up |
| Mouse 2 | previous player | previous player | first person on the previous player |
| Mouse | nothing (the view is theirs) | orbits | looks |
| V | → third person | → free fly | → first person |
| Z / X | previous / next player (kept from H1) | same | same |
| E | take control of cart (when allowed) | same | same |

- **First person** is through the spectated player's eyes exactly as they'd see it: their eye height (duck eased),
  view angles (interpolated), their viewmodel (the box gun, flashing when they fire), their HP / armor / weapon /
  ammo in the HUD, and their crosshair at their aim, moving with the recoil-tracked camera, the scope overlay
  instead while scoped. The angles, crosshair and scope come from `Sim3DHost.aimView(id, view, tracking)` (H2b's
  weapon mechanics: camera = view + tracking × the recoil + the screen shake, crosshair = where the next bullet goes;
  `spectatedView` in main.ts, with the viewer's Recoil tracking setting). The crosshair offset is the projection of the aim
  direction through the camera (`aimOffsetPx`). No crosshair in third person or free fly.
- **Who**: watching, every living player in id order; dead, your living teammates (everyone once they're dead).
  When the spectated player dies the camera moves on after 2 s.
- **Unmistakable**: the line under the score says "Watching" (or "You: cart (dead) · spectating") vs "You: cart";
  the bottom panel says SPECTATING and the name in team colour, with the mode (1st person / 3rd person / free camera),
  HP, armor, weapon, kills this round and the controls' hints; a soft vignette darkens the screen edges. The panel's
  text nodes are written only when they change.

## Radar (U1)

`src/app3d/radar3d.ts` (pure; tests/app3d-radar.test.ts) feeds every tick's `Observe` to both teams' spotting; the
minimap (redrawn at 10 Hz) shows the viewer's team view: the human's team, else the spectated player's.

| Rule (CS2 rules, the default) | Value | Source |
| --- | --- | --- |
| Teammates | always shown | [SPOT] cs_player.cpp: a player's spot rules are SPOT_RULE_ENEMY \| SPOT_RULE_ALWAYS_SEEN_BY_FRIEND |
| Enemy spotted | while any living teammate (you included) sees it (`sees`: FOV, walls, smoke) | [SPOT] cs_entity_spotting.cpp CanPlayerSeeTargetEntityFunctor |
| Spotting cadence (the dot appears and lingers up to this late) | 0.5 s (`SPOT_INTERVAL_S`; every 32 ticks) | [SPOT] `ENTITY_SPOT_FREQUENCY 0.5f` |
| Last seen | the dot becomes the "?" ghost at the last spotted position, fading linearly over 6 s (`GHOST_FADE_S`) | [RADAR] `GHOST_FADE_TIME 6.0f`, SetupIconsFromStates |
| Dead | an X at the death position, fading over 4 s (`DEAD_FADE_S`); an enemy only if it was spotted when it died | [RADAR] `DEAD_FADE_TIME 4.0f` |
| Bomb carrier | the bomb icon on the carrier's dot (Ts always; CTs while the carrier is spotted) | [RADAR] HasC4 → m_bBombIsSpotted; [SPOT] weapon_c4.cpp SPOT_RULE_CT \| SPOT_RULE_ALWAYS_SEEN_BY_T |
| Dropped bomb | Ts only (the sim has no bomb spotting for CTs) | [SPOT] weapon_c4.cpp |
| Planted bomb | everyone (`PLANTED_BOMB_FOR_ALL`; the brief: CS:GO's rule would need a CT to spot it) | — |

Sources: the CS:GO source as mirrored in SwagSoftware/Kisak-Strike (commit `4c2fdc31`, read 2026-11-07):
**[RADAR]** `game/client/cstrike15/Scaleform/HUD/sfhudradar.cpp`, **[SPOT]** `game/server/cstrike15/`. CS2's radar
code isn't public; it shows the same "?" and fading X, but the timings are **unverified** for CS2 (hence tunables).
"Radar: show everyone" (the toggle) draws every pawn, the dead as X without fading, and the bomb always.

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
| Aim punch | bullets: view + punch × weapon_recoil_scale (2) + the inaccuracy cone; camera: view + punch × 2 × view_recoil_tracking (default 0.45, the **Recoil tracking** setting, 0–1) + the view punch (screen shake); crosshair: at the bullets' direction (view + punch × 2). The punch is H2's (src/engine/weapons), in the host since H2b | CS:GO cvars | **unverified** (both are hidden in CS2: not in the dump) |
| Eye height | 64 standing, 46 ducked | Source view offsets (`damage.eyeHeight`) | as the sim |
| Duck transition (camera) | 0.4 s down, 0.2 s up, SimpleSpline (3x² − 2x³) | [SDK] TIME_TO_DUCK, TIME_TO_UNDUCK, SetDuckedEyeOffset | **unverified** for CS2 (the shared movement ducks the hull at once; M1 owns that) |

**Mouse counts.** The page uses pointer lock and reads `movementX / movementY`. It first asks for
`requestPointerLock({ unadjustedMovement: true })` (Chromium: raw mouse counts, the OS pointer acceleration bypassed,
like CS2's raw input; `view().raw` says whether it was granted); Safari and Firefox ignore or reject the option, so
there the deltas are the OS pointer's pixels: with the OS acceleration off and 1:1 pointer scaling one pixel is one
count. DPI changes counts per inch, not this formula (cm/360 = 360 / (0.022 × sensitivity × DPI) × 2.54).

**Firing (H2b).** The human's input carries the plain view (yaw, pitch). The host's weapon mechanics
(src/engine/weapons, docs/weapons.md) add the aim punch × 2 and the inaccuracy / spread cone to every bullet, punch
the view, tag on hits and own the scope; the app only draws what `Sim3DHost.aimView` returns, so nothing in the
headless host depends on the view code.

**Recoil tracking** (settings field, 0–1, default 0.45; CS:GO's `view_recoil_tracking`, hidden in CS2): how much of
the recoil the camera follows, i.e. "how much the screen moves vs how much the crosshair moves". The bullets don't
change: they always go to view + punch × 2, and the crosshair is drawn there. At 0.45 (CS:GO / CS2 feel) the camera
climbs with 45 % of the spray and the crosshair climbs the rest on screen; at 0 the screen stays still (only the
screen shake) and the crosshair alone climbs the full pattern; at 1 the camera follows the bullets and the crosshair
stays at the centre. Kept in localStorage with the sensitivity (`recoilTracking`). `npm run check:browser:3d` checks
the kick and recovery (screenshot app3d-g-spray-kick.jpg) and the 0 / 1 ends of the setting.

## Viewmodels (A1)

`src/app3d/viewmodels/`: low-poly procedural models, boxes and cylinders only (no Valve models), at real size in
Source units with a key light baked into the vertex colours (unlit materials like the world): AK-47 (wood furniture,
curved steel mag), M4A4, M4A1-S (long suppressor), AWP (green, big scope), SSG 08, Desert Eagle (silver), Glock-18,
USP-S (suppressor), P2000, knife, C4 (bricks, keypad, display), HE, flashbang, smoke, molotov, incendiary, decoy.
120–700 triangles each, built once, one held at a time, gloves and sleeves in the team's colour.

- **Position**: the grip at a per-class hold point in view space plus CS2's `viewmodel_offset_x 1`, `_y 1`, `_z −1`
  (defaults, convar dump), toed in 2.6°, drawn at `viewmodel_fov` 60. The hold points are fitted by eye to CS2's
  default composition (**assumed**).
- **Animations** (`pose.ts`, pure, tested), timed by the weapon state machine (`tracker.ts` reads the host's
  `deployEndTick` / `reloadEndTick` / `grenadePrimed` and the `shot` events, in game ticks, so they follow pause,
  speed and seek): deploy (rises over the first 45 % of the deploy time), fire (35 ms flash at the muzzle, kick, bolt or
  slide; the AWP / SSG 08 bolt worked at 38–60 % of the cycle, with its sounds), reload (tilt, mag out at the
  `clipout` fraction, new mag in at `clipin`, bolt at `bolt`, the same fractions as the reload sounds; AK-47: 0.17 /
  0.52 / 0.78 of 2.5 s), knife slash (0.4 s), C4 plant (lowered, keypad tapping), grenade pin pulled and arm back while
  primed, the throw. Scoped: hidden. Walking bob.
- **World models**: every other player's held weapon in its right hand (the same models, one merged mesh), swapped
  when the weapon changes; on death it lies on the floor beside the body (the dropped weapon).

![AK-47](img/app3d-viewmodel-ak47-idle.jpg)
![AK-47 mid-reload, mag out](img/app3d-viewmodel-ak47-reload.jpg)

Also `app3d-viewmodel-{ak47-fire,m4a1s,awp,deagle,usps,knife,c4,he}.jpg` in docs/img, and `app3d-viewmodel-world.jpg`: spectating Sp4rtaN in first person (CT sleeves; U1's spectator view shows the spectated player's viewmodel). The reload screenshot shows a dead player's dropped AK-47 on the floor.

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

## Scenarios (H3)

`?scenario=<name>` picks a scenario from `data/scenarios/` (default `mirage-sp4rtan-1v3`, the recorded round) and
`?map=<package>` its map; the bar's **Scenario** and **Map** pickers (`src/app3d/scenarios3d.ts`) reload the page
with them. A free-play scenario (no recording) builds its Session from the map package's CS2 nav and facts
(`FreePlayCore`, docs/scenarios.md): every bot is live, E (or the button) takes over **the player you spectate**,
the floors and the radar use the map's own radar and transform, and the summary is the round's result. The
single-file page embeds the default scenario only (its pickers list just it); free play needs `npm run build:3d`.

## Data, build and deploy

Normal build: the JSON and binary files are fetched next to the page (assets3d.ts). Single file
(vite.single.3d.config.ts): `./assets3d` is redirected to `assets3d-embedded.ts`; the round, nav, sight mask, tracks,
movement mesh and clips are gzip + base64, the radar a data: URI, Three.js (0.187) bundled into the inlined script;
the build fails if anything but index.html is written. **Sizes**: dist-single-3d/index.html 1,488 KB (gzip 739 KB),
locked by cs2/tools/encrypt.cjs ≈ 1,990 KB (budget 3 MB; the 2D locked page is ≈ 1.5 MB). `tools/stage-web-apps.sh`
stages both pages (`cs2/sim/`, `cs2/sim3d/`) and adds the sim3d card and README row once; the web-apps workflow
(`git add -A cs2`) needs no change.

## Test API

`window.__cs2sim3d.test` (src/app3d/main.ts), for automated comparisons (V0's frame-by-frame check against the
round's video) and screenshots. Deterministic: the same tick, camera and viewport give the same pixels (the check
renders twice in two browsers and compares: identical).

| Call | What it does |
| --- | --- |
| `freeze(true)` | the frame loop stops drawing (and a running round pauses); `freeze(false)` resumes drawing |
| `seekTick(k)` | runs (or rewinds through the Session's checkpoints) the round to observe tick `k`, synchronously; returns the tick reached; tracers are cleared, the round is left paused |
| `eyes(id)` | the camera through a player's eyes: its sim position, eye 64 / 46, its sim yaw / pitch |
| `pose(x, y, z, yaw, pitch)` | a free camera (Source units and degrees: yaw counter-clockwise from +x, pitch + = down) |
| `render()` | draws one frame now, exactly at the current tick: no interpolation between ticks, the duck eased fully, effect animations at time tick × 15.625 ms, no muzzle flash or hit marker; returns `state()` |
| `state()` | `{tick, t, phase, camera: {mode, followed, eye, yaw, pitch, vfovDeg, hfovDeg, width, height}}` of the last frame drawn |

Example: `const t = window.__cs2sim3d.test; t.freeze(true); t.seekTick(1184); t.eyes('cart'); t.render();` then
screenshot `#view`. The other hooks (`stats`, `session`, `takeControl`, `aimAt`, `mouse`, `camera`, `fly`, `seek`,
`view`, `summary`) are the browser check's.

## Performance (P1)

The goal is CS2-like smoothness on an Apple M-series Mac: **at most 2 ms of main-thread time per frame** (500+ fps
capability), **at most 0.5 ms per sim tick**, and the mouse applied to the view at render time from the newest input.

**The frame loop** (`frame-driver.ts`, the **FPS** setting):

- **Uncapped** (the default): frames run back to back, each in its own task. It uses MessageChannel, so there's no
  4 ms timer clamp, and input and rendering still happen between frames. It runs as fast as the main thread allows
  and keeps one CPU core busy, like an uncapped game.
- **60 / 120 / 144 / 240 / 360 / 500 / Custom** (20–1000): paced to that rate. The loop sleeps until about 1.5 ms
  before the frame is due, then spins on tasks. If it falls more than one frame behind it drops that debt rather
  than bursting to catch up.
- **VSync**: `requestAnimationFrame`, one frame per display refresh. It uses the least power.
- A hidden tab always falls back to rAF, which the browser stops, so a background tab doesn't burn a core.

**The browser realities:**

- A browser shows at most one frame per display refresh. The compositor presents the newest frame at each vsync
  and drops the rest. So at "2400 fps uncapped" on a 120 Hz display you still *see* 120 frames a second, but each
  of them was drawn from mouse input at most ~0.4 ms old instead of up to a whole refresh old. That's the
  latency win, the same reason CS2 players run uncapped.
- **Low latency** (`desynchronized: true` on the WebGL context; reloads the page) lets Chrome put the canvas on
  screen without waiting for the compositor. Latency is lower, but frames may tear. Safari and Firefox ignore it;
  the setting's tooltip says whether it is active.
- The sim is the same in every mode. `FixedLoop` (src/app/loop.ts) runs the 64 Hz ticks that the elapsed time owes,
  so 256 ticks a second at 4×, whatever the frame rate.

**Input:**

- Mouse movement comes from `pointerrawupdate` where the browser has it (Chromium on https or localhost), otherwise
  from `mousemove`. Either way it is under pointer lock with raw counts in Chrome (`unadjustedMovement`).
- `pointerrawupdate` fires at the mouse's own rate rather than once per display frame.
- Each frame takes the counts accumulated since the previous frame, turns the view, sends the human's input to the
  sim, and draws with that view. The camera never waits for a 64 Hz tick.

**The meter** (the HUD's perf line, updated 4 times a second):

`1.60 ms · 625 fps-eq · 2400 fps uncapped · display 120 Hz (120 shown) · 64 ticks/s · 1×`

| field | what it means |
| --- | --- |
| `1.60 ms` | The median main-thread time of the page's own frame work, over the last 600 frames: input, sim ticks, scene, Three.js render calls, HUD. The browser's compositing and the GPU are not in it. |
| `625 fps-eq` | 1000 / that time: the frame rate this machine's main thread could sustain if nothing capped it. This is the "500+ fps" number. |
| `2400 fps uncapped` | The rate the loop actually ran over the last second, and its limit mode. |
| `display 120 Hz (120 shown)` | The display's refresh, measured from rAF intervals, and the most frames it can show: the lower of the loop rate and the refresh. This is the vsync cap, made visible. |

**The renderer** (`renderer3d.ts`):

- Unlit, baked colours: `MeshBasicMaterial`, colours per vertex. No shadows, no post-processing, no MSAA.
- An opaque WebGL2 context with `powerPreference: 'high-performance'`.
- The device pixel ratio is capped at 1.5, times **Res** (0.25–2).
- The static world is two draw calls: the tiles of world-mesh.ts are joined once at start-up. ~73k triangles are
  trivial for any GPU, and the 40 culled per-tile draws cost more CPU than they saved. Nothing is uploaded per frame
  except the tracer buffer, and only while there are tracers.
- Pawns and effects come from fixed pools.
- No per-frame allocations in the render path.
- The HUD's DOM is updated at most once per sim tick or every 15.6 ms, and only nodes whose text changed are
  written (hud3d.ts). The minimap is redrawn at 10 Hz.

**The summary at the round end** (src/app/run-entries.ts, both apps):

- `summarize(model, log)` takes ~150–250 ms on a whole round. About 90 % of that is parsing the session log's JSON
  lines.
- The 3D page used to call it on every frame from 2 s after the round end: 12 fps-equivalent and ~9 MB of garbage a
  frame (PR #32).
- Now the log is parsed a few lines per frame (2 ms budget) once the round is over, and the summary is computed
  once per (round end, deaths) on the parsed entries.

**The bench** (`?bench=1`, `bench3d.ts`; `npm run build:3d && npm run bench:3d`, Playwright on port 4182, one page
load per scenario):

- **Output:** per-phase p50 / p95 / p99 frame times, the fps-equivalent, the sim's ms per tick, draw calls and JS
  heap allocated per frame.
- **Scenarios:**
  - `watch-1x-raf`: the vsync loop.
  - `watch-1x-loop`: the page's own uncapped driver.
  - `watch-{1,4}x-uncapped` and `fp-1x-uncapped`: frames back to back from the bench, with a mouse sweep in first
    person.
  - `watch-1x-480hz`: a synthetic 480 Hz clock, so many frames per tick, which is what an uncapped loop does on a
    fast machine.
  - `inround-5s-120hz` and `postend-5s-120hz`: 5 s of round time at a synthetic 120 Hz before and after
    `round_end`, the round-end regression.
- **Opening it in Chrome or Safari** on a Mac (`…/sim3d/?bench=1`) runs it there and shows the table over the view.
- **`--dir <build>`** benches another build, for before/after comparisons.
- **Committed results:** docs/perf/.
- **In the sandbox** WebGL is software (lavapipe) on two shared cores, usually with other agents' test suites on
  them. There the phase times are the numbers to compare. The "ran fps" there is bounded by the software GPU.

## Browser check

`tools/browser-check3d.ts` (port 4180, or `--port <n>` / `CHECK3D_PORT`; `--single` serves the single file). It screenshots (a) the start, (b) Lokier
at B from cart's window (18.5 s, cart's eyes), (c) the plant (27.6 s, behind barely), (d) Sp4rtaN behind donk
(49.95 s), (e) the defuse (64 s), (f) first person after taking control; A1 (`tools/browser-check3d-a1.ts`, also runnable
alone): audio starts on a click, a shot schedules `fire.<gun>`, R runs the reload animation for the state machine's
reload time (measured in game ticks) with its three sounds, the viewmodel screenshots; `--port` / `CHECK3D_PORT`
when 4180 is taken; checks the FOV (vertical 73.74°), that E
takes control (YOU, 1×), that mouse counts turn the view by exactly counts × 1.25 × 0.022°, and that mouse 1 fires
(ammo drops); measures fps and ticks/s at 1× and 4×. U1's spectating checks: at the start cart's radar shows the five
Ts and exactly the CTs a T sees (the rest hidden), the toggle shows all ten and is stored; first person through
Sp4rtaN's eyes shows his HP / armor / ammo / weapon, the crosshair, the panel ("SPECTATING sp4rtan 1st person"),
the vignette and "Watching"; mouse 1 / mouse 2 / Space switch player; V cycles 1st → 3rd (no crosshair) → free →
1st; playing on at 4×, an enemy spotted earlier turns into the "?" ghost. Screenshots `app3d-spectate-*.jpg`.

WebGL in the sandbox's headless Chromium is software (lavapipe or SwiftShader) on two shared cores: a bare WebGL
canvas that only clears reaches 26–50 fps at 1280 × 800 and 56–60 at 640 × 400, so the frame rate is measured at
640 × 400 (the rendering itself is cheap: 37k triangles in 0.7 ms with `gl.finish`). On a machine whose load per
core is above 1.25 during the run (other agents' test suites), the rates are reported but not asserted. Results:
logs/browser-check3d.json; the numbers of the H1 run are in the PR.

![The defuse](img/app3d-e-defuse.jpg)
![First person after taking control](img/app3d-f-first-person.jpg)

![Spectating Sp4rtaN in first person: his viewmodel, crosshair and HUD, the spectator panel](img/app3d-spectate-first-person.jpg)
![Third person: no crosshair](img/app3d-spectate-third-person.jpg)
![The "?" on cart's radar where Sp4rtaN was last spotted](img/app3d-spectate-radar-ghost.jpg)
