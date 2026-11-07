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
  /** Placeholder sample rate (synth.ts). */
  placeholderRate: 24000,
  /** Grenade bounce: a flying grenade whose vertical speed flips from falling to rising by more than this (units/s) bounced. */
  bounceMinSpeed: 60,
} as const;
