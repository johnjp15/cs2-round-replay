# Sound: what was wrong and what A2 changed (backlog #44)

John (11-07 11:03): "Fix the sound. It's really bad right now." (12:36): "the sound feels messy and broken." Everything
below was measured, not read off the code: the placeholders rendered offline and analysed
(`tools/audio-analyze.ts`), the mix recorded from a real headless Chromium playing the round
(`tools/audio-check.ts`), and the director's cues checked against the simulation's events (`tests/a2-sound.test.ts`).
The pipeline and the CS2 data are described in [cs2-sounds.md](cs2-sounds.md); the real CS2 files still need John's
extraction (#17), and they still override every placeholder event for event (checked: below, "Real sounds").

## The round, 15–35 s, nobody playing (headless Chromium, 1×)

`npx tsx tools/audio-check.ts --tag <before|after> [--dir <dist-3d>]`. "Before" is `origin/main` at `ab7cd10` (A1's
engine), "after" this branch; same page, same round, same window (seek to 15 s, play to 35 s: the B fight, the kills
at 17.8 s and 18.8 s, a smoke, the plant at 27.5 s and its beeps). Sources are counted by hooking
`AudioBufferSourceNode.start / stop` in the page, so both builds are measured the same way.

| | before (A1) | after (A2) |
| --- | ---: | ---: |
| sound sources started in the 20 s | 262 | 133 |
| started per second: mean / worst second | 11.9 / 36 | 5.8 / 21 |
| sources playing at once: mean / worst 100 ms | 3.7 / 19 | 2.2 / 10 |
| 100 ms windows with > 12 at once | 3 | 0 |
| layers not started because the listener is past their CS2 curve | 0 (started at gain 0) | 141 |
| one-shot instances cut by CS2's `instance_limit` (0.1 s fade) | 0 | 5 |
| footsteps per pawn per second, worst | – | 4 (host: one per 0.3 s) |
| shot cues = shot events / step cues = footstep events | – | 8 = 8 / 199 = 199 |
| mix before the limiter: peak, samples over 0 dBFS | – | +0.8 dBFS, 20 |
| output: peak, samples over 0 dBFS, RMS | −1.8 dBFS, 0, −26.3 dBFS | −3.0 dBFS, 0, −29.6 dBFS |
| a sound 200 u to the right: left / right RMS (yaw 0 and 90) | – | 0.063 / 0.245 (right, correct) |
| cue lead over its tick's arrival: median / p90 / max | 0 (played on arrival) | 13 / 31 / 42 ms |
| spacing error between consecutive cues vs their ticks: median / p90 | 21 / 71 ms (on arrival) | 0 / 54 ms |

The box is a loaded 2-core VM (the page ran at 0.94–0.97× real time), so the p90 / max timing numbers are the
simulation stalling, the same for both; the median is the fair comparison. Every voice of the after run is in
`logs/audio/voices-after.csv` (start, event, source, distance, gain after the CS2 curve and occlusion in dB, length)
and the recordings in `logs/audio/mix-15-35-*.wav` (gitignored, not committed).

What was messy: every layer of every sound took a voice even when CS2 plays nothing there (the AK-47's distant layer
under 800 u, footsteps past 1,100 u, i.e. most of the map's steps), so half the starts were silent voices crowding
the pool; one shooter's shots stacked their 0.4 s tails; the C4 beep was the loudest thing in the game (below); every
placeholder sat at the same loudness, so footsteps were 3 dB under gunshots. What was broken: 90 of the 145
placeholders clicked (no envelope), 80 sounded the same as another event, the molotov loop's seam jumped, the
placeholders were rendered at 24 kHz (nothing above 12 kHz), and the round-start music cue started a voice at gain 0.

## The placeholders (offline render and analysis)

`npx tsx tools/audio-analyze.ts --tag <tag>` renders every sound exactly as the page does (`renderSynth` is pure PCM;
an OfflineAudioContext adds nothing for a single buffer) at 48 kHz into `logs/audio/<tag>/*.wav`, and measures peak,
RMS, the loudest 50 ms, DC, clicks (|first sample| > 0.02 or the last 1 ms > 0.01), attack, spectral centroid, band
shares, and a spectrum + envelope fingerprint (two events whose fingerprints match ≥ 0.995 "sound the same").

| | before | after |
| --- | ---: | ---: |
| sounds | 145 | 146 (+ `c4.beep.10s`) |
| with any problem | 102 | 0 |
| click at start or end | 90 | 0 |
| the same as another CS2 event's sound | 80 | 0 |
| DC offset > 0.005 | 59 | 0 |
| loop seam jump | 1 | 0 |
| clipping | 0 | 0 |
| render rate | 24 kHz | the context's (48 kHz) |
| variants per sound | 1 | footsteps 4, shots 3, impacts 3, hits / bounces / landings 2 |

Loudest 50 ms, mean by kind (dBFS): shots −13.9 → −11.8, footsteps −17.0 → −24.0, landings −13.6 → −20.0, hits −13.6
→ −15.5, reload clicks −21.7 → −22.0, the C4 beep **−6.1** → −16.0.

Per sound (duration ms / peak dBFS / loudest 50 ms dBFS / spectral centroid Hz / % energy 60–120 Hz):

| sound | before | before problems | after | after problems |
| --- | --- | --- | --- | --- |
| `fire.ak47` | 420 / -1.9 / -13.5 / 1554 / 55 | — | 450 / -1.0 / -9.6 / 1048 / 50 | — |
| `fire.m4a4` | 380 / -1.9 / -13.4 / 1297 / 67 | — | 400 / -1.0 / -10.1 / 1311 / 29 | — |
| `fire.awp` | 900 / -1.9 / -12.3 / 2804 / 3 | — | 1200 / -1.0 / -7.7 / 1391 / 7 | — |
| `fire.deagle` | 550 / -1.9 / -13.6 / 1877 / 13 | — | 550 / -1.0 / -8.8 / 928 / 57 | — |
| `fire.glock` | 250 / -1.9 / -13.5 / 721 / 24 | — | 280 / -1.0 / -11.5 / 1710 / 0 | — |
| `fire.usps` | 160 / -6.9 / -17.6 / 221 / 9 | — | 200 / -1.6 / -19.0 / 2030 / 0 | — |
| `step.CT.concrete` | 120 / -3.1 / -16.6 / 1706 / 32 | — | 110 / -10.8 / -24.0 / 1570 / 34 | — |
| `step.T.wood` | 120 / -3.1 / -16.3 / 1158 / 40 | — | 110 / -12.5 / -24.0 / 527 / 47 | — |
| `land.concrete` | 200 / -1.4 / -13.5 / 1187 / 44 | — | 220 / -7.5 / -20.0 / 439 / 49 | — |
| `reload.ak47.clipout` | 100 / -5.2 / -22.0 / 783 / 19 | DC, click at start, same as 24 others | 130 / -9.0 / -22.0 / 1698 / 0 | — |
| `reload.ak47.clipin` | 100 / -5.2 / -21.1 / 1059 / 19 | DC, click at start, same as 36 others | 100 / -6.4 / -22.0 / 2225 / 0 | — |
| `draw.ak47` | 120 / -8.0 / -24.2 / 1749 / 16 | click at start, same-as | 160 / -7.2 / -24.0 / 2664 / 0 | — |
| `impact.concrete` | 100 / -5.2 / -22.2 / 1219 / 19 | DC, click at start, same-as | 120 / -3.2 / -20.0 / 3785 / 0 | — |
| `hit.flesh` | 140 / -3.1 / -15.5 / 495 / 60 | — | 140 / -8.9 / -17.0 / 130 / 67 | — |
| `hit.head.helmet` | 350 / -1.9 / -11.4 / 1735 / 0 | click at end, same-as | 350 / -3.7 / -14.0 / 1735 / 0 | — |
| `c4.beep` | 120 / -3.1 / -6.1 / 2350 / 0 | click at end | 100 / -14.1 / -16.0 / 2417 / 0 | — |
| `pop.he` | 1400 / 0.0 / -8.3 / 1364 / 10 | click at start | 1600 / -1.1 / -6.3 / 532 / 49 | — |
| `burn.molotov` | 2000 / -6.9 / -21.6 / 2062 / 7 | loop seam jump 0.15 | 2000 / -8.9 / -24.2 / 1278 / 10 | — |
| `whiz` | 120 / -5.2 / -13.9 / 8530 / 0 | — | 120 / -6.8 / -18.1 / 6063 / 0 | — |

How they're made now (`src/app3d/audio/synth.ts`): every sound has a raised-cosine fade-in (0.3 ms for transients,
2 ms otherwise) and a 6 ms fade-out, a 25 Hz high-pass (no DC), and is normalised to its own loudness (`Synth.level`)
with its peak soft-limited under −1 dBFS. Shots are layered: a high-passed crack (4 ms), a band-passed body, a sine
thump sweeping down to 55–150 Hz, a mechanical click and a Schroeder reverb tail; suppressed guns a "pfft" instead
of the crack. Footsteps are a heel and a toe tap 25–45 ms apart with a low thud, the surface in the cut-off, grit and
(metal) ring. Foley follows a tap pattern per event (mag out: two taps and a slide; mag in: insert and latch; bolt:
back and forward; pistol slides faster), pitched per gun. The C4 beep is a clean sine with a 1.5 ms attack.

### Levels (**assumed**)

CS2's files carry their own loudness, which the public dumps don't give; the placeholders' levels (`Synth.level`,
loudest 50 ms) are chosen so the mix reads like CS2's: shots −7 to −11 dBFS (suppressed −18), hits −13 to −17,
landings −20, footsteps −24, foley −22 to −28, the C4 beep −16. Effective levels at the listener (placeholder level ×
event volume × CS2 curve × mixgroup, before the master):

| case | before (dBFS) | after (dBFS) |
| --- | ---: | ---: |
| own AK-47 shot | -14.6 | -12.2 |
| enemy AK-47 at 500 u | -15.8 | -13.3 |
| enemy AK-47 at 1,500 u | -24.4 | -21.9 |
| enemy running step at 300 u | -21.3 | -27.6 |
| own step | -24.1 | -30.8 |
| C4 beep at 300 u | **-9.6** (louder than a shot next to you) | -21.0 |
| bullet hitting a wall at 300 u | -35.5 | -40.8 |
| enemy reload at 300 u | -41.3 | -39.2 |

## The mix (`engine.ts`, `tuning.ts`)

- **CS2's mixer**: each layer × its event's mixgroup `vol` in `Default_Mix` of CS2's
  `game/csgo/pak01_dir/scripts/soundmixers.txt` (GameTracking-CS2 `cce7bf1`, now in the manifest's `mixers`):
  Weapons 0.6, WeaponsDistant 0.6, Footsteps 0.8, BulletImpacts 0.3, Explosions 0.7, Explosions­Distant 0.7, Foley /
  UI / PlayerDamage / music 1. A1 had all buses at 1.
- **Distance**: the CS2 curve per event, unchanged (spatial.ts); new: a layer whose curve is 0 at the listener isn't
  started at all (CS2 plays nothing there).
- **Instance limits**: CS2's `instance_limit` per entity and event (`Weapon_AK47.Single` 1, `C4.PlantSound` 1, …,
  now in the manifest) with the event's fade (`fadetime_volume_mapping_curve`, 0.1 s for shots).
- **Own sounds**: CS2's sound stack puts the local player's sounds at the listener (`soundstacks_csgo_mega.vsndstck`:
  `input_default_local_position = "@globals.output_listener_front"`), i.e. at the curve's nearest point: the AK's 0.8
  × 1.1 (vs 1.1 for an enemy 30–176 u away). So in CS2's data your own shot is *not* louder than a nearby enemy's; it
  is in-head (unfiltered stereo, `distance_unfiltered_stereo_mapping_curve`) and never occluded. A2 keeps that.
- **Limiter**: headroom +3 dB → a compressor (threshold −4 dBFS, ratio 20, attack 2 ms, release 150 ms, its automatic
  make-up gain taken back out) → a soft clipper (linear to 0.85, never past 0.98). Measured above: the mix reached
  +0.8 dBFS with 20 samples over 0 dBFS before it, −3.0 dBFS and none after. **Assumed** settings.
- **Occlusion** (unchanged, measured): over the whole round from cart's eye, 4 rays per shot / footstep: all 15
  events from pawns cart could see were fully open, 214 of the 215 from enemies he couldn't see fully blocked; it
  muffles what's behind walls, not everything.
- **Listener**: at the camera, oriented every drawn frame (`orientListener`); left / right checked above.
- **Paused**: loops (the molotov) fade out when no tick has come for 0.3 s and come back on resume.

## Timing (`director.ts`, `engine.ts`)

- Cues carry their tick; the engine maps ticks to audio time 1 / (64 × speed) s apart after a one-tick jitter buffer
  (15.6 ms; the 3D view interpolates a tick behind the simulation anyway), so shots one tick apart stay one tick apart
  even when one frame runs several ticks (A1 played them all at the frame's time).
- Seeks and rewinds: the main loop never feeds the skipped ticks to the director; the first tick after a jump plays
  only its own events (A1 dropped them), the state (weapons, grenades in flight, bomb) is taken as it is.
- Footsteps: one cue per host footstep event (checked against the round: 199 = 199). The host steps every 0.3 s above
  135 u/s (docs/combat.md). Source SDK 2013's `CBasePlayer::SetStepSoundTime` uses 300 ms running, 400 ms walking
  (90–220 u/s by `GetStepSoundVelocities`), +100 ms ducked (`src/game/shared/baseplayer_shared.cpp`, ValveSoftware/
  source-sdk-2013 `e1f1fd4`); CS2's own rule isn't public. The host's cadence is simulation (the AI hears steps), so
  it is left as is; not touched here.
- The C4 beep: the host's fixed 1 s / 0.5 s beep stays as the AI's event; the sound now follows the plant
  (`c4BeepTicks`): next beep after max(0.15, 0.1 + 0.9 × left / 40) s, 1 s apart at the plant to 0.15 s at the end
  (CS:GO's planted-C4 cadence, **assumed** for CS2), and `C4.PlantSound_10sec` for the last 10 s (CS2 update
  2023-10-17: "New sound for final 10 seconds of bomb beeping"). A seek into a planted round picks it up.

## Real sounds

With a bank packed from stand-in files (`tools/gen-placeholder-sounds.ts --as-cs2` → `tools/pack-sounds.ts`), the
page decoded 196 of 196 files, used them for every event (`stats().audio.realFiles`), with the same cue counts and no
clipping. The mixgroup volumes, curves, instance limits and the limiter apply to the real files the same way.

## Checks

- `tests/a2-sound.test.ts`: the placeholder analysis (no clicks, DC, clipping, odd durations, duplicates), level
  order, CS2 mixgroup volumes, the soft-clip curve, the C4 cadence, and the director on the recorded round 15–20 s
  (one cue per shot and footstep event, on its tick; steps ≥ 19 ticks apart per pawn; nothing before the seek's
  landing; nothing twice; a rewind is silent).
- `tools/audio-check.ts` (above): exits 1 when the cue counts differ from the harness, the output clips, or left and
  right are swapped.
