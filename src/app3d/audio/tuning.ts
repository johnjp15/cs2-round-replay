/**
 * A1: the audio tunables (docs/cs2-sounds.md). App-only: nothing here changes the simulation. Values with a CS2 source
 * cite it; the rest are marked **assumed**.
 *
 * [CVARS] SteamDatabase/GameTracking-CS2 `DumpSource2/convars.txt` (commit cce7bf1f, 2026-11-05).
 */
export const AUDIO_TUNING = {
  /** Settings defaults: [CVARS] `volume 1` (master), effects 1; the music slider scales the music cvars below. */
  defaults: { master: 1, effects: 1, music: 1 },
  /**
   * Music and announcer levels: [CVARS] `snd_roundstart_volume 0` (competitive: the round-start music is off),
   * `snd_roundend_volume 0.16`, `snd_mapobjective_volume 0.04` (bomb planted), `snd_tensecondwarning_volume 0.04`.
   * The announcer has no cvar of its own here; 0.5 is **assumed**.
   */
  music: { roundStart: 0, roundEnd: 0.16, mapObjective: 0.04, tenSecondWarning: 0.04, announcer: 0.5 },
  occlusion: {
    /** [CVARS] `snd_occlusion_rays 4`. */
    rays: 4,
    /** Units around the emitter the extra rays aim at. **Assumed** (about a player's half width). */
    spread: 16,
    /** Gain lost when every ray is blocked, × the event's `occlusion_intensity`. **Assumed.** */
    depth: 0.75,
    openLowpassHz: 20000,
    /** Low-pass when every ray is blocked and intensity is 1. **Assumed.** */
    occludedLowpassHz: 1200,
    /** Seconds between occlusion traces per voice. */
    recheckSec: 0.1,
  },
  /** Seconds a curve change takes on a playing voice (no zipper noise). */
  smoothSec: 0.03,
  /** Voices playing at once (oldest stolen beyond). */
  maxVoices: 40,
  /**
   * Bullet whiz: a shot of someone else passing the listener's ear within this many units plays `BulletBy.*`.
   * **Assumed** (CS:GO/CS2 play the near-miss within about a player's width).
   */
  whizRange: 60,
  /**
   * Footsteps: the host emits running steps (speed > `sound.footstepSpeed` 135, every 0.3 s; docs/combat.md). CS2's
   * walking (Shift) and crouch-walking make no footstep events at all, so they are silent at any range here too;
   * the listener's own walking steps play locally at `ownWalkGain` (0 = silent like CS2). **Assumed** 0.
   */
  ownWalkGain: 0,
  /** Sample rate of the placeholder WAVs the tools write (the page renders at its AudioContext's rate; A1 used 24 kHz there). */
  placeholderRate: 48000,
  /**
   * A2: the mix under the master. CS2's own mixer (its mixgroup volumes) is applied per event from the manifest
   * (engine.ts `mixgroupGain`), so the buses stay at 1; `headroomDb` lowers the whole mix before the limiter.
   * **Assumed.**
   */
  mix: {
    headroomDb: 3,
    bus: { weapons: 1, foley: 1, footsteps: 1, impacts: 1, grenades: 1, bomb: 1, ui: 1, music: 1 },
  },
  /**
   * A2: the master limiter: a fast compressor (its automatic make-up gain removed again, `makeupDb`, from the Web
   * Audio spec's formula (1 / gain at 0 dBFS)^0.6) and a soft clipper (linear to `clipKnee`, never beyond
   * `clipCeiling`), so no sum of sounds can clip. **Assumed** settings (CS2's own master dynamics aren't public).
   */
  limiter: {
    thresholdDb: -4,
    kneeDb: 2,
    ratio: 20,
    attackSec: 0.002,
    releaseSec: 0.15,
    /** 0.6 × the compressor's reduction of a 0 dBFS input: −(T + (0 − T) / ratio) × 0.6. */
    makeupDb: 0.6 * (4 - 4 / 20),
    clipKnee: 0.85,
    clipCeiling: 0.98,
  },
  /**
   * A2: cue timing. A cue carries its tick; ticks map to audio time 1 / (64 × speed) s apart after a jitter buffer of
   * `bufferSec` (one tick), re-anchored when a tick arrives later than now (up to `lateSec`) or more than
   * `maxAheadSec` ahead. `stealFadeSec`: fade of an instance stopped by CS2's instance_limit when the event has no
   * fade-time curve of its own (CS2 fades shots over 0.1 s, `fadetime_volume_mapping_curve`).
   */
  timing: { bufferSec: 1 / 64, maxAheadSec: 0.045, lateSec: 0.25, stealFadeSec: 0.1 },
  /** A2: seconds without a simulated tick after which the game counts as paused (loops fade out). */
  pauseAfterSec: 0.3,
  /** Grenade bounce: a flying grenade whose vertical speed flips from falling to rising by more than this (units/s) bounced. */
  bounceMinSpeed: 60,
} as const;
