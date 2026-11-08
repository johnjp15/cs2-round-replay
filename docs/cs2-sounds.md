# Sound: CS2's sound events in the 3D app (A1), and the recipe for the real files

A2's fixes and their before / after measurements (mix, placeholders, timing): [audio.md](audio.md).

The 3D page (`cs2/sim3d/`) plays every game sound through a Web Audio engine built on **CS2's own sound events**:
the names, file lists, volumes, pitch ranges, distance curves and occlusion intensities come from CS2's
`soundevents/*.vsndevts`. Until John extracts the sound files from his CS2 install, every event plays a
procedurally generated placeholder; once the extracted folder is packed, the build embeds the real files and
uses them instead, event by event. Valve's files are never committed and never sit next to the page as plain
files: they only exist inside the encrypted single page.

## Pieces

| Piece | What it does |
| --- | --- |
| `src/app3d/audio/events.ts` | The sound table: 145 sounds by id (`fire.ak47`, `reload.awp.clipin`, `step.CT.concrete`, `c4.beep`, …), each with its CS2 sound event(s), mix bus, positional or in-the-head, and a placeholder recipe. Reload-stage timing fractions per gun (`RELOAD_STAGES`, shared with the viewmodel animations). |
| `tools/cs2-sound-events.ts` | Builds the manifest `data/audio/cs2-sound-events.json` (and the page's compact `cs2-sound-runtime.json`) from a checkout of the public [SteamDatabase/GameTracking-CS2](https://github.com/SteamDatabase/GameTracking-CS2) (commit `cce7bf1f`, 2026-11-05): resolves `base` inheritance and child events (`Weapon_AK47.Single` → `Weapon_AK47.SingleDistant`), records the `.vsnd` files and their sizes in `pak01_dir.txt`. Uses `tools/kv3.ts` (a KeyValues3 text reader). 155 events, 315 files, none missing; one dead reference in CS2's own data (`explo_gas_can_01`, child of `BaseExplosionEffect.Sound`) dropped. |
| `src/app3d/audio/director.ts` | Turns each simulated tick into cues (pure, tested): shots, reload stages at the state machine's reload time, footsteps and landings, hits / headshot dink / attacker feedback / kill confirm / the victim's own hit, deaths, world impacts and ricochets, bullet whiz, grenade throw / bounce / pop / molotov burn loop / extinguish, bomb plant / beeps / defuse / explosion, round-end music and announcer. Seeks and rewinds reset it silently. |
| `src/app3d/audio/engine.ts` | The Web Audio graph, started on the first click or key: per voice source → low-pass → gain → HRTF `PannerNode` → bus → effects / music → master → limiter (compressor + soft clip). Listener at the camera. Voice pool (40 world + 10 in-head). A2: CS2 mixgroup volumes, `instance_limit`, no voice past the curve, tick-scheduled cues, lazy 48 kHz placeholders with variants; see [audio.md](audio.md). |
| `src/app3d/audio/spatial.ts`, `tuning.ts` | Attenuation and occlusion (below), all tunables with their sources. |
| `src/app3d/audio/synth.ts`, `tools/gen-placeholder-sounds.ts` | Placeholders: deterministic synthesized bursts (gun crack + body + thump, clicks, steps, beeps, booms, hiss, crackle loop, dink, stings). The page renders them at audio start (nothing embedded); the tool writes them as WAVs, and with `--as-cs2 <dir>` at the CS2 paths, as a stand-in for John's folder. |
| `tools/pack-sounds.ts` | John's decompiled folder → `local/cs2-sound-bank.json` (mono Opus, base64). `--list` prints the files to extract. |
| `src/app3d/audio/bank.ts` | The build embeds `local/cs2-sound-bank.json` if it exists (`import.meta.glob`, so no file = placeholders, no error). |
| `src/app3d/audio/mount.ts` | The three calls main.ts makes; the volume sliders (Vol, FX, Music; localStorage); `window.__cs2a1` for the browser check. |

## Attenuation, occlusion, mixing (CS2's numbers)

- **Distance**: every CS2 sound event has its own `distance_volume_mapping_curve`: points `[distance in units,
  volume, slopeIn, slopeOut, modeIn, modeOut]`. The engine evaluates it each frame for each playing voice as a cubic
  Hermite spline through the points with the given slopes, flat before the first point and after the last, × the
  event's `volume`. It passes exactly through every point (tested); the shape between points and the meaning of the
  two mode numbers are not documented publicly, so the in-between shape is **assumed**. Examples from the dump:
  AK-47 shot 0.8 at 25 u, 1.0 from 30–176 u, 0.74 at 440, 0.33 at 1,288, 0.015 at 2,500, while its
  `SingleDistant` layer rises from 0 at 800 u to 0.54 at 2,336 (far shots turn into the distant sound, as in CS2);
  running footsteps 0.45 at 50 u (your own are quieter), 1.0 at 117, 0.49 at 402, **silent from 1,100 u**; the planted
  C4 beep linear to 0 at 1,300 u. The `PannerNode` only gives direction (HRTF, `rolloffFactor 0`).
- **Occlusion**: CS2 traces `snd_occlusion_rays 4` rays (convar dump) and scales by the event's
  `occlusion_intensity` (AK shot 0.6, footsteps 0.375, C4 beep 0.2). Here: 4 segments from the ear to the emitter and
  to points 16 u left, right and above it, on the collision mesh (`MapGeometry.lineBlocked`), re-traced every 0.1 s per
  voice; gain `1 − blocked share × intensity × 0.75` and a low-pass from 20 kHz down to 1.2 kHz. Depth, spread and
  cut-offs are **assumed** (`tuning.ts`).
- **Position**: pawn sounds sit at the pawn's origin + the event's `position_offset` (shots 60 u up, steps 20 u). The
  listener's own sounds play in the head at the curve's nearest point.
- **Walking**: CS2's walk (Shift) and crouch-walk make no footstep events; the host emits steps only above 135 u/s
  (docs/combat.md), so walking is silent at any range (`ownWalkGain` 0).
- **Music / announcer** at CS2's competitive levels (convar dump): `snd_roundstart_volume 0` (off),
  `snd_roundend_volume 0.16`, `snd_mapobjective_volume 0.04` (bomb planted), announcer 0.5 (assumed). Default music
  kit `valve_cs2_01`, announcer `CS2_Classic`.
- **Whiz**: someone else's bullet passing within 60 u of the ear plays `BulletBy.Supersonic.Crack` at the closest point
  (range **assumed**).
- **Surfaces**: Mirage's CS2 collision mesh has no materials, so every step is `concrete` for now; the director takes
  a `surfaceAt(pos)` hook for X1's 2020 BSP materials (tile, wood, sand, metal are already in the table).

## The recipe for John: extracting the real sounds

You need ~200 files (~27 MB inside CS2, ~0.9 MB once packed). CS2 has no macOS build, so either use a Windows PC
with CS2 installed, or download just the needed VPK pieces on the Mac with DepotDownloader (CS2 is free; any Steam
account works).

### 1. Get `pak01_dir.vpk` (and the archive chunks the sounds live in)

- **Windows PC with CS2:** the file is
  `C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\pak01_dir.vpk`
  (the `pak01_NNN.vpk` chunks next to it are needed too; nothing to copy, just point VRF at it).
- **Mac, no CS2:** with [DepotDownloader](https://github.com/SteamRE/DepotDownloader) (its release build; the `-filelist`
  `regex:` syntax is DepotDownloader's, not tried here):
  ```sh
  echo 'regex:game/csgo/pak01_dir\.vpk' > files.txt
  depotdownloader -app 730 -os windows -filelist files.txt -username <steam login> -dir cs2
  ```
  Then list which chunks hold the sounds (step 2's tool, `--vpk_dir` prints each file's archive index), add those
  `pak01_NNN.vpk` names to `files.txt` (`regex:game/csgo/pak01_(dir|012|034)\.vpk` style) and run DepotDownloader again.

### 2. Decompile the sounds with ValveResourceFormat

Get **Source2Viewer-CLI** (ValveResourceFormat's command-line tool; download from <https://s2v.app/> or the
[GitHub releases](https://github.com/ValveResourceFormat/ValveResourceFormat/releases), macOS arm64 / Windows /
Linux builds; the exact asset name wasn't verified here). In this repo:

```sh
npx tsx tools/pack-sounds.ts --list > sound-paths.txt          # 195 paths like sounds/weapons/ak47/ak47_01.vsnd_c
# optional, Mac route: which chunks to download
Source2Viewer-CLI -i cs2/game/csgo/pak01_dir.vpk --vpk_dir -f "$(paste -sd, sound-paths.txt)"
# decompile: .vsnd_c → .wav / .mp3 at the same paths
Source2Viewer-CLI -i "<…>/game/csgo/pak01_dir.vpk" -f "$(paste -sd, sound-paths.txt)" -d -o ~/cs2-sounds
```

Options as in VRF's `CLI/Decompiler.cs` (commit `8eda5ed`): `-i` input VPK (also accepts `steam:730/game/csgo/…`),
`-f` comma-separated path prefixes inside the VPK, `-d` decompile, `-o` output folder, `--vpk_dir` list with archive
index. The output folder has `sounds/weapons/ak47/ak47_01.wav` etc.

### 3. Hand the folder over and pack it

Zip `~/cs2-sounds` and attach it to a Claude session (or put it at `/home/claude/cs2-sounds/`). The agent runs:

```sh
npx tsx tools/pack-sounds.ts /home/claude/cs2-sounds            # → local/cs2-sound-bank.json (gitignored)
npm run build:single:3d && npm run stage:web-apps -- <web-apps checkout>
```

`pack-sounds` trims each file to its `keepSec` (fire 1.6 s, music 4 s, default 2 s), encodes mono Opus at 32 kbps in
Ogg (ffmpeg), keeps one file per event first and adds variants (footsteps 4, others 2) while the total stays under
900 KB. Budget: the lock base64s the page again, so each packed KB costs ≈ 1.78 KB of locked page; 900 KB → ≈ +1.6 MB
on a ≈ 2.15 MB locked page, under the 4 MB limit. Events whose files are missing keep their placeholder.

**Decision for John:** the CI stage workflow builds from the repo, where the bank is not (gitignored), so a page
staged by CI has placeholders. To keep real sounds in CI-staged pages, commit the bank to this **private** repo with
`git add -f local/cs2-sound-bank.json` (it then only ever leaves the repo inside the encrypted page); otherwise stage
from a session that has the bank.

**Browsers:** Chrome and Firefox decode Ogg Opus (checked headless: 195 of 195 packed files decoded). Safari's support
for Ogg Opus in `decodeAudioData` is unverified (recent versions are reported to have it); a file that fails to decode
falls back to its placeholder.

## Every sound and its CS2 files

"Audible to": where the event's distance curve (with its child layers) reaches silence; "all map": its far layer
never does; "head": played in the listener's head (own weapon handling, feedback, music, announcer).

| Sound id | Bus | CS2 sound event(s) | Files (CS2 picks one) | Audible to (units) |
| --- | --- | --- | --- | ---: |
| `announce.ctwin` | ui | `Announcer.CTWin.CS2_Classic` | `sounds/vo/announcer/cs2_classic/` ctwin | head |
| `announce.defused` | ui | `Announcer.BombDefused.CS2_Classic` | `sounds/vo/announcer/cs2_classic/` bombdef | head |
| `announce.planted` | ui | `Announcer.BombPlanted.CS2_Classic` | `sounds/vo/announcer/cs2_classic/` bombpl | head |
| `announce.twin` | ui | `Announcer.TWin.CS2_Classic` | `sounds/vo/announcer/cs2_classic/` terwin | head |
| `bounce.flash` | grenades | `Flashbang.Bounce` | `sounds/weapons/flashbang/` grenade_hit1 | 1700 |
| `bounce.he` | grenades | `HEGrenade.Bounce` | `sounds/weapons/hegrenade/` he_bounce-1 | 1700 |
| `bounce.incgrenade` | grenades | `IncGrenade.Bounce` + `IncGrenade.Bounce_M` | `sounds/physics/weapons/` weapon_incendiary_impact_01, weapon_incendiary_impact_02 … (5) | 1700 |
| `bounce.molotov` | grenades | `Molotov.Bounce` | `sounds/physics/glass/` glass_bottle_impact_hard1, glass_bottle_impact_hard2, glass_bottle_impact_hard3 | 1700 |
| `bounce.smoke` | grenades | `SmokeGrenade.Bounce` + `SmokeGrenade.Bounce_Can` | `sounds/weapons/smokegrenade/` grenade_hit1, can_01, can_02 | 1700 |
| `burn.molotov` | grenades | `Inferno.Loop` | `sounds/weapons/molotov/` fire_loop_1 | 1200 |
| `c4.beep` | bomb | `C4.PlantSound` | `sounds/weapons/c4/` c4_beep2 | 1300 |
| `c4.beep.10s` | bomb | `C4.PlantSound_10sec` | `sounds/weapons/c4/` c4_beep2_10sec | 1300 |
| `c4.defuse.start` | bomb | `c4.disarmstart` | `sounds/weapons/c4/` c4_disarmstart | 2000 |
| `c4.defused` | bomb | `c4.disarmfinish` | `sounds/weapons/c4/` c4_disarmfinish | 2000 |
| `c4.explode` | bomb | `c4.explode` | `sounds/weapons/c4/` c4_explode1 | all map |
| `c4.initiate` | bomb | `c4.initiate` | `sounds/weapons/c4/` c4_initiate | 1102 |
| `c4.keypress` | bomb | `c4.keypressquiet` | `sounds/weapons/c4/` key_press1, key_press2 … (7) | 1102 |
| `c4.plant` | bomb | `c4.plant` | `sounds/weapons/c4/` c4_plant | 4100 |
| `cycle.awp.back` | foley | `Weapon_AWP.BoltBack` | `sounds/weapons/awp/` awp_boltback | 1100 |
| `cycle.awp.forward` | foley | `Weapon_AWP.BoltForward` | `sounds/weapons/awp/` awp_boltforward | 1100 |
| `cycle.ssg08.back` | foley | `Weapon_SSG08.BoltBack` | `sounds/weapons/ssg08/` ssg08_boltback | 1100 |
| `cycle.ssg08.forward` | foley | `Weapon_SSG08.BoltForward` | `sounds/weapons/ssg08/` ssg08_boltforward | 1100 |
| `death` | impacts | `Player.DeathBody.Onlooker` + `Player.DeathBody.Flesh` | `sounds/player/` player_damagebody_04, player_damagebody_05 … (9) | 1073 |
| `death.head` | impacts | `Player.DeathHeadShot.Onlooker` | `sounds/player/` headshot_noarmor_01, headshot_noarmor_02 … (5) | 1070 |
| `death.self` | impacts | `Player.DeathBody.Victim` + `Player.DeathBody.Flesh` | `sounds/player/` player_damagebody_04, player_damagebody_05 … (9) | head |
| `draw.ak47` | foley | `Weapon_AK47.Draw` | `sounds/weapons/ak47/` ak47_draw | 1107 |
| `draw.awp` | foley | `Weapon_AWP.Draw` | `sounds/weapons/awp/` awp_draw | 1107 |
| `draw.c4` | foley | `c4.draw` | `sounds/weapons/c4/` c4_draw_04, c4_draw_06 … (4) | 1107 |
| `draw.deagle` | foley | `Weapon_DEagle.Draw` | `sounds/weapons/deagle/` de_draw | 1107 |
| `draw.decoy` | foley | `Decoy.Draw` | `sounds/weapons/decoy/` decoy_draw_01, decoy_draw_02, decoy_draw_03 | 1107 |
| `draw.flash` | foley | `Flashbang.Draw` | `sounds/weapons/flashbang/` flashbang_throw_03 | 1107 |
| `draw.glock` | foley | `Weapon_Glock.Draw` | `sounds/weapons/glock18/` glock_draw | 1107 |
| `draw.he` | foley | `HEGrenade.Draw` | `sounds/weapons/hegrenade/` hegrenade_draw_06 | 1107 |
| `draw.incgrenade` | foley | `IncGrenade.Draw` | `sounds/weapons/hegrenade/` hegrenade_draw_01 | 1107 |
| `draw.knife` | foley | `Weapon_Knife.Deploy` | `sounds/weapons/knife/` knife_deploy1 | 1100 |
| `draw.m4a1s` | foley | `Weapon_M4A1.Draw` | `sounds/weapons/m4a1/` m4a1_draw | 1107 |
| `draw.m4a4` | foley | `Weapon_M4A1.Draw` | `sounds/weapons/m4a1/` m4a1_draw | 1107 |
| `draw.molotov` | foley | `Molotov.Draw` | `sounds/weapons/molotov/` molotov_draw_03 | 1107 |
| `draw.p2000` | foley | `Weapon_hkp2000.Draw` | `sounds/weapons/hkp2000/` hkp2000_draw | 1107 |
| `draw.smoke` | foley | `SmokeGrenade.Draw` | `sounds/weapons/smokegrenade/` smoke_grenade_draw_exp_01, smoke_grenade_draw_exp_03 … (8) | 1107 |
| `draw.ssg08` | foley | `Weapon_SSG08.Draw` | `sounds/weapons/ssg08/` ssg08_draw | 1107 |
| `draw.usps` | foley | `Weapon_USP.Draw` | `sounds/weapons/usp/` usp_draw | 1107 |
| `dry.pistol` | foley | `Default.ClipEmpty_Pistol` | `sounds/weapons/` clipempty_pistol | head |
| `dry.rifle` | foley | `Default.ClipEmpty_Rifle` | `sounds/weapons/` clipempty_rifle | head |
| `feedback.head` | impacts | `Player.DamageHeadShot.AttackerFeedback` | `sounds/player/` headshot_noarmor_01, headshot_noarmor_02 … (5) | head |
| `feedback.head.helmet` | impacts | `Player.DamageHeadShotArmor.AttackerFeedback` | `sounds/player/` headshot_armor_e1 | head |
| `fire.ak47` | weapons | `Weapon_AK47.Single` + `Weapon_AK47.SingleDistant` | `sounds/weapons/ak47/` ak47_02, ak47_01 … (4) | all map |
| `fire.awp` | weapons | `Weapon_AWP.Single` + `Weapon_AWP.SingleDistant` | `sounds/weapons/awp/` awp_01, awp_02, awp_distant | all map |
| `fire.deagle` | weapons | `Weapon_DEagle.Single` + `Weapon_DEagle.SingleDistant` | `sounds/weapons/deagle/` deagle_01, deagle_02, deagle-1-distant | all map |
| `fire.glock` | weapons | `Weapon_Glock.Single` + `Weapon_Glock.SingleDistant` + `Weapon_Glock.Element_CRB` + `Weapon_Glock.Element_Click` | `sounds/weapons/glock18/` glock_02, glock18-1-distant … (5) | all map |
| `fire.m4a1s` | weapons | `Weapon_M4A1.Silenced` | `sounds/weapons/m4a1/` m4a1_silencer_01 | 1400 |
| `fire.m4a4` | weapons | `Weapon_M4A4.Single` + `Weapon_M4A4.SingleDistant` | `sounds/weapons/m4a1/` m4a1_01, m4a1_02, m4a1_distant_01 | all map |
| `fire.p2000` | weapons | `Weapon_hkp2000.Single` + `Weapon_hkp2000.SingleDistant` | `sounds/weapons/hkp2000/` hkp2000_01, hkp2000_02 … (4) | all map |
| `fire.ssg08` | weapons | `Weapon_SSG08.Single` + `Weapon_SSG08.SingleDistant` | `sounds/weapons/ssg08/` ssg08_01, ssg08_distant | all map |
| `fire.usps` | weapons | `Weapon_USP.SilencedShot` | `sounds/weapons/usp/` usp_01, usp_02, usp_03 | 1400 |
| `hit.armor` | impacts | `Player.DamageKevlar` | `sounds/player/` kevlar1, kevlar2 … (5) | 594 |
| `hit.flesh` | impacts | `Flesh.BulletImpact` | `sounds/physics/flesh/` flesh_impact_bullet1, flesh_impact_bullet2 … (5) | 600 |
| `hit.head` | impacts | `Player.DamageHeadShot.Onlooker` | `sounds/player/` headshot_noarmor_01, headshot_noarmor_02 … (5) | 1070 |
| `hit.head.helmet` | impacts | `Player.DamageHeadShotArmor.Onlooker` | `sounds/player/` headshot_armor_e1 | 1070 |
| `impact.concrete` | impacts | `Concrete.BulletImpact` | `sounds/physics/concrete/` concrete_impact_bullet1, concrete_impact_bullet2 … (4) | 600 |
| `jump` | footsteps | `Default.WalkJump` | `sounds/player/footsteps/` jump_launch_01 | 494 |
| `kill.feedback` | ui | `Player.DeathBody.AttackerFeedback` | `sounds/physics/surfaces/` mud_impact_bullet1, mud_impact_bullet2 … (4) | head |
| `kill.feedback.head` | ui | `Player.DeathHeadShot.AttackerFeedback` | `sounds/player/` headshot_noarmor_01, headshot_noarmor_02 … (5) | head |
| `knife.hit` | impacts | `Weapon_Knife.Hit` | `sounds/weapons/knife/` knife_hit1, knife_hit2 | 1000 |
| `knife.hitwall` | impacts | `Weapon_Knife.HitWall` | `sounds/weapons/knife/` knife_hit_01, knife_hit_02 … (5) | 1000 |
| `knife.swing` | foley | `Weapon_Knife.Slash` | `sounds/weapons/knife/` knife_slash1, knife_slash2 | 800 |
| `land.concrete` | footsteps | `Land_Concrete.StepLeft` + `Land.Thud` | `sounds/player/` land2, land3 … (4) | 1100 |
| `land.metal` | footsteps | `Land_SolidMetal.StepLeft` + `Land.Thud` | `sounds/player/footsteps/` land_metal_solid_01, land_metal_solid_02 … (7) | 1100 |
| `land.sand` | footsteps | `Land_Sand.StepLeft` + `Land.Thud` | `sounds/player/footsteps/` land_sand_01, land_sand_02 … (7) | 1100 |
| `land.tile` | footsteps | `Land_Tile.StepLeft` + `Land.Thud` | `sounds/player/footsteps/` land_tile_01, land_tile_02 … (6) | 1100 |
| `land.wood` | footsteps | `Land_Wood.StepLeft` + `Land.Thud` | `sounds/player/footsteps/` wood_01, wood_02 … (16) | 1100 |
| `music.bomb` | music | `Music.BombPlanted.valve_cs2_01` | `sounds/music/valve_cs2_01/` bombplanted | head |
| `out.molotov` | grenades | `Molotov.Extinguish` | `sounds/weapons/molotov/` molotov_extinguish | 2500 |
| `pin.decoy` | foley | `Decoy.PullPin_Grenade` | `sounds/weapons/decoy/` pinpull | 1107 |
| `pin.flash` | foley | `Flashbang.PullPin_Grenade` | `sounds/weapons/flashbang/` pinpull | 1107 |
| `pin.he` | foley | `HEGrenade.PullPin_Grenade` | `sounds/weapons/hegrenade/` pinpull | 1107 |
| `pin.incgrenade` | foley | `IncGrenade.PullPin_Grenade` | `sounds/weapons/incgrenade/` pinpull | 1107 |
| `pin.molotov` | foley | `Molotov.PreThrow` | `sounds/weapons/molotov/` molotov_throw_01, molotov_throw_02 … (6) | 1100 |
| `pin.smoke` | foley | `SmokeGrenade.PullPin_Grenade` | `sounds/weapons/smokegrenade/` pinpull | 1107 |
| `pop.flash` | grenades | `Flashbang.Explode` + `Flashbang.ExplodeDistant` | `sounds/weapons/flashbang/` flashbang_explode1, flashbang_explode2 … (4) | 2800 |
| `pop.he` | grenades | `BaseGrenade.Explode` + `BaseGrenade.ExplodeDistant` + `BaseExplosionEffect.Sound` | `sounds/weapons/hegrenade/` hegrenade_detonate_02, hegrenade_detonate_03 … (5) | all map |
| `pop.molotov` | grenades | `Inferno.Fire.Ignite` | `sounds/weapons/molotov/` fire_ignite_1, fire_ignite_4, fire_ignite_5 | 1000 |
| `pop.smoke` | grenades | `BaseSmokeEffect.Sound` + `BaseSmokeEffect.SoundDistant` | `sounds/weapons/smokegrenade/` smoke_emit, sg_explode_distant | all map |
| `reload.ak47.bolt` | foley | `Weapon_AK47.BoltPull` | `sounds/weapons/ak47/` ak47_boltpull_01 | 1100 |
| `reload.ak47.clipin` | foley | `Weapon_AK47.Clipin` | `sounds/weapons/` magazine_slide_01 | 1100 |
| `reload.ak47.clipout` | foley | `Weapon_AK47.Clipout` | `sounds/weapons/ak47/` ak47_clipout_01 | 1100 |
| `reload.awp.bolt` | foley | `Weapon_AWP.BoltBack` | `sounds/weapons/awp/` awp_boltback | 1100 |
| `reload.awp.bolt2` | foley | `Weapon_AWP.BoltForward` | `sounds/weapons/awp/` awp_boltforward | 1100 |
| `reload.awp.clipin` | foley | `Weapon_AWP.Clipin` | `sounds/weapons/awp/` awp_clipin | 1100 |
| `reload.awp.clipout` | foley | `Weapon_AWP.Clipout` | `sounds/weapons/awp/` awp_clipout | 1100 |
| `reload.deagle.bolt` | foley | `Weapon_DEagle.Slideback` | `sounds/weapons/deagle/` de_slideback | 1100 |
| `reload.deagle.bolt2` | foley | `Weapon_DEagle.Slideforward` | `sounds/weapons/deagle/` de_slideforward | 1100 |
| `reload.deagle.clipin` | foley | `Weapon_DEagle.Clipin` | `sounds/weapons/` magazine_slide_01 | 1100 |
| `reload.deagle.clipout` | foley | `Weapon_DEagle.Clipout` | `sounds/weapons/deagle/` de_clipout | 1100 |
| `reload.glock.bolt` | foley | `Weapon_Glock.Slideback` | `sounds/weapons/glock18/` glock_slideback | 1100 |
| `reload.glock.bolt2` | foley | `Weapon_Glock.Sliderelease` | `sounds/weapons/glock18/` glock_sliderelease | 1100 |
| `reload.glock.clipin` | foley | `Weapon_Glock.Clipin` | `sounds/weapons/glock18/` glock_clipin | 1100 |
| `reload.glock.clipout` | foley | `Weapon_Glock.Clipout` | `sounds/weapons/glock18/` glock_clipout | 1100 |
| `reload.m4a1s.bolt` | foley | `Weapon_M4A1.BoltBack` | `sounds/weapons/m4a1/` m4a1_boltback | 1100 |
| `reload.m4a1s.bolt2` | foley | `Weapon_M4A1.BoltForward` | `sounds/weapons/m4a1/` m4a1_boltforward | 1100 |
| `reload.m4a1s.clipin` | foley | `Weapon_M4A1.Clipin` | `sounds/weapons/m4a1/` m4a1_clipin | 1100 |
| `reload.m4a1s.clipout` | foley | `Weapon_M4A1.Clipout` | `sounds/weapons/m4a1/` m4a1_clipout | 1100 |
| `reload.m4a4.bolt` | foley | `Weapon_M4A1.BoltBack` | `sounds/weapons/m4a1/` m4a1_boltback | 1100 |
| `reload.m4a4.bolt2` | foley | `Weapon_M4A1.BoltForward` | `sounds/weapons/m4a1/` m4a1_boltforward | 1100 |
| `reload.m4a4.clipin` | foley | `Weapon_M4A1.Clipin` | `sounds/weapons/m4a1/` m4a1_clipin | 1100 |
| `reload.m4a4.clipout` | foley | `Weapon_M4A1.Clipout` | `sounds/weapons/m4a1/` m4a1_clipout | 1100 |
| `reload.p2000.bolt` | foley | `Weapon_hkp2000.Slideback` | `sounds/weapons/hkp2000/` hkp2000_slideback | 1100 |
| `reload.p2000.bolt2` | foley | `Weapon_hkp2000.Sliderelease` | `sounds/weapons/hkp2000/` hkp2000_sliderelease | 1100 |
| `reload.p2000.clipin` | foley | `Weapon_hkp2000.Clipin` | `sounds/weapons/hkp2000/` hkp2000_clipin | 1100 |
| `reload.p2000.clipout` | foley | `Weapon_hkp2000.Clipout` | `sounds/weapons/hkp2000/` hkp2000_clipout | 1100 |
| `reload.ssg08.bolt` | foley | `Weapon_SSG08.BoltBack` | `sounds/weapons/ssg08/` ssg08_boltback | 1100 |
| `reload.ssg08.bolt2` | foley | `Weapon_SSG08.BoltForward` | `sounds/weapons/ssg08/` ssg08_boltforward | 1100 |
| `reload.ssg08.clipin` | foley | `Weapon_SSG08.Clipin` | `sounds/weapons/ssg08/` ssg08_clipin | 1100 |
| `reload.ssg08.clipout` | foley | `Weapon_SSG08.Clipout` | `sounds/weapons/ssg08/` ssg08_clipout | 1100 |
| `reload.usps.bolt` | foley | `Weapon_USP.Slideback` | `sounds/weapons/usp/` usp_slideback_01 | 1100 |
| `reload.usps.bolt2` | foley | `Weapon_USP.Sliderelease` | `sounds/weapons/usp/` usp_sliderelease_01 | 1100 |
| `reload.usps.clipin` | foley | `Weapon_USP.Clipin` | `sounds/weapons/usp/` usp_clipin_02 | 1100 |
| `reload.usps.clipout` | foley | `Weapon_USP.Clipout` | `sounds/weapons/usp/` usp_clipout_01 | 1100 |
| `ricochet` | impacts | `FX_RicochetSound.Ricochet` | `sounds/weapons/fx/rics/` bullet_ric_01, bullet_ric_02 … (6) | 237 |
| `round.lost` | music | `Music.LostRound.valve_cs2_01` | `sounds/music/valve_cs2_01/` lostround | head |
| `round.start` | music | `Music.StartRound.valve_cs2_01` | `sounds/music/valve_cs2_01/` startround_01 | head |
| `round.won` | music | `Music.WonRound.valve_cs2_01` | `sounds/music/valve_cs2_01/` wonround | head |
| `step.CT.concrete` | footsteps | `CT_Concrete.StepLeft` | `sounds/player/footsteps/` concrete_ct_01, concrete_ct_02 … (17) | 1100 |
| `step.CT.metal` | footsteps | `CT_SolidMetal.StepLeft` | `sounds/player/footsteps/` metal_solid_35, metal_solid_36 … (16) | 1100 |
| `step.CT.sand` | footsteps | `CT_Sand.StepLeft` | `sounds/player/footsteps/` sand_01, sand_02 … (12) | 1100 |
| `step.CT.tile` | footsteps | `CT_Tile.StepLeft` | `sounds/player/footsteps/` tile_01, tile_02 … (14) | 1100 |
| `step.CT.wood` | footsteps | `CT_Wood.StepLeft` | `sounds/player/footsteps/` wood_01, wood_02 … (14) | 1100 |
| `step.T.concrete` | footsteps | `T_Concrete.StepLeft` | `sounds/player/footsteps/` concrete_ct_01, concrete_ct_02 … (17) | 1100 |
| `step.T.metal` | footsteps | `T_SolidMetal.StepLeft` | `sounds/player/footsteps/` metal_solid_35, metal_solid_36 … (16) | 1100 |
| `step.T.sand` | footsteps | `T_Sand.StepLeft` | `sounds/player/footsteps/` sand_01, sand_02 … (12) | 1100 |
| `step.T.tile` | footsteps | `T_Tile.StepLeft` | `sounds/player/footsteps/` tile_01, tile_02 … (14) | 1100 |
| `step.T.wood` | footsteps | `T_Wood.StepLeft` | `sounds/player/footsteps/` wood_01, wood_02 … (15) | 1100 |
| `throw.decoy` | grenades | `Decoy.Throw` | `sounds/weapons/decoy/` decoy_throw_06 | 1100 |
| `throw.flash` | grenades | `Flashbang.Throw` | `sounds/weapons/flashbang/` flashbang_throw_03 | 1100 |
| `throw.he` | grenades | `HEGrenade.Throw` + `Grenade.Throw.Gear` | `sounds/items/` weapon_hegrenade_throw, gear_throw_10, gear_throw_07 | 1100 |
| `throw.incgrenade` | grenades | `IncGrenade.Throw` + `Grenade.Throw.Gear` | `sounds/weapons/incgrenade/` inc_grenade_throw_fire_01, inc_grenade_throw_fire_02 … (5) | 1100 |
| `throw.molotov` | grenades | `Molotov.Throw` | `sounds/weapons/molotov/` molotov_throw_01, molotov_throw_02 … (6) | 1100 |
| `throw.smoke` | grenades | `SmokeGrenade.Throw` + `Grenade.Throw.Gear` | `sounds/weapons/smokegrenade/` smoke_grenade_throw_04, gear_throw_10, gear_throw_07 | 1100 |
| `victim.body` | impacts | `Player.DamageBody.VictimFlesh` | `sounds/physics/surfaces/` mud_impact_bullet1, mud_impact_bullet2 … (4) | head |
| `victim.head` | impacts | `Player.DamageHeadShot.Victim` | `sounds/player/` headshot_noarmor_01, headshot_noarmor_02 … (5) | head |
| `victim.head.helmet` | impacts | `Player.DamageHeadShotArmor.Victim` | `sounds/player/` headshot_armor_e1 | head |
| `whiz` | impacts | `BulletBy.Supersonic.Crack` + `BulletBy.Supersonic.TailM` | `sounds/weapons/fx/nearmiss/` bulletby_supersonic_crack_01, bulletby_supersonic_crack_03 … (15) | all map |
| `zoom.awp.in` | foley | `Weapon_AWP.Zoom` | `sounds/weapons/awp/` zoom | head |
| `zoom.awp.out` | foley | `Weapon_AWP.ZoomOut` | `sounds/weapons/awp/` zoom | head |
| `zoom.ssg08.in` | foley | `Weapon_SSG08.Zoom` | `sounds/weapons/ssg08/` ssg08_zoom_in | head |
| `zoom.ssg08.out` | foley | `Weapon_SSG08.ZoomOut` | `sounds/weapons/` weapon_zoom_out_03 | head |
