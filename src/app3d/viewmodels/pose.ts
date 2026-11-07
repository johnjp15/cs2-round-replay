/**
 * A1: the viewmodel's animation pose (pure; tested in Node). Every animation is driven by the weapon state machine's
 * real timings (docs/weapons.md: deploy `deployEndTick`, reload `reloadEndTick`, cycle time), passed in as seconds:
 *
 *  - deploy: the weapon rises from below the screen over the first 45 % of its deploy time and settles;
 *  - fire: a 35 ms kick back and up, the bolt / slide back and home (pistols' slide, the AK's bolt handle); the
 *    AWP / SSG 08 bolt is worked between 38 % and 60 % of the cycle, timed with its bolt sounds;
 *  - reload: tilt, mag out at the `clipout` fraction, the new mag in at `clipin`, the bolt at `bolt` (the same
 *    fractions as the reload sounds: audio/events.ts RELOAD_STAGES), back to rest by 95 %;
 *  - knife swing: a 0.4 s slash from right to left; C4: lowered and tapping the keypad while planting; grenades:
 *    pin pulled and the arm back while primed, the throw forward (then hidden until the next deploy).
 *
 * Coordinates are the model's offset from its rest position (Source units: x right, y up, z back) and its rotation
 * (radians: x pitch up, y yaw left, z roll left).
 */
import { RELOAD_STAGES, gunOf } from '../audio/events';
import type { WeaponModel } from './models';

export interface Timed {
  /** Seconds since it started. */
  readonly t: number;
  /** Its full duration (s), from the weapon state machine. */
  readonly dur: number;
}

export interface VmAnim {
  readonly weapon: string;
  /** Seconds since the last shot (large when none). */
  readonly sinceShot: number;
  /** Cycle time of the gun (s). */
  readonly cycle: number;
  readonly reload: Timed | null;
  readonly deploy: Timed | null;
  /** Seconds since a knife swing started, or null. */
  readonly swing: number | null;
  /**
   * W2 hooks for W1's knife animations (absent / null: not playing). `stab`: seconds since a heavy attack (mouse 2)
   * started; `inspect`: seconds since an inspect started. vmPose gives each a simple placeholder pose (phases `stab`,
   * `inspect`); W1 fills in the sequencing.
   */
  readonly stab?: number | null;
  readonly inspect?: number | null;
  /** Seconds since the plant started (USE held with the C4), or null. */
  readonly plant: number | null;
  readonly primed: boolean;
  /** Seconds since the grenade left the hand, or null. */
  readonly thrown: number | null;
  /** 0..1: horizontal speed / 250 (bob). */
  readonly speed: number;
  /** Seconds (bob phase). */
  readonly time: number;
}

export interface VmPose {
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
  /** Mag offset from its seat (units) and whether it's drawn. */
  magY: number;
  magZ: number;
  magVisible: boolean;
  /** Bolt / slide travel back (units). */
  bolt: number;
  pinVisible: boolean;
  visible: boolean;
  flash: boolean;
  /** For tests and the browser check: what is playing and how far (0..1). */
  phase: 'idle' | 'deploy' | 'fire' | 'reload' | 'swing' | 'stab' | 'inspect' | 'plant' | 'primed' | 'throw';
  progress: number;
}

export function freshPose(): VmPose {
  return { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, magY: 0, magZ: 0, magVisible: true, bolt: 0, pinVisible: true, visible: true, flash: false, phase: 'idle', progress: 0 };
}

const FLASH_SEC = 0.035;
const KICK_SEC = 0.06;
const SWING_SEC = 0.4;
/** W2 placeholders: a heavy stab (CS2's secondary attack is ~1 s between stabs) and an inspect. */
export const STAB_SEC = 0.9;
export const INSPECT_SEC = 3.2;
const THROW_SEC = 0.25;

function smooth(x: number): number {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
}

/** 0 → 1 over [a, b]. */
function ramp(t: number, a: number, b: number): number {
  return b <= a ? (t >= b ? 1 : 0) : smooth((t - a) / (b - a));
}

/** The pose for this frame, written into `out` (no allocation). */
export function vmPose(a: VmAnim, m: WeaponModel, out: VmPose): VmPose {
  out.x = 0;
  out.y = 0;
  out.z = 0;
  out.rx = 0;
  out.ry = 0;
  out.rz = 0;
  out.magY = 0;
  out.magZ = 0;
  out.magVisible = true;
  out.bolt = 0;
  out.pinVisible = true;
  out.visible = true;
  out.flash = false;
  out.phase = 'idle';
  out.progress = 0;
  // Walking bob (a figure-of-eight at step rate).
  const bob = Math.min(1, a.speed);
  out.x += Math.sin(a.time * 2 * Math.PI * 1.6) * 0.35 * bob;
  out.y += -Math.abs(Math.cos(a.time * 2 * Math.PI * 1.6)) * 0.3 * bob;

  if (a.deploy !== null && a.deploy.t < a.deploy.dur) {
    const k = 1 - ramp(a.deploy.t, 0, Math.min(0.6, a.deploy.dur * 0.45));
    out.y -= 9 * k;
    out.rx -= 0.7 * k;
    out.rz += 0.25 * k;
    out.phase = 'deploy';
    out.progress = a.deploy.t / a.deploy.dur;
    return out;
  }
  if (a.reload !== null && a.reload.t < a.reload.dur && m.mag !== undefined) {
    const p = a.reload.t / a.reload.dur;
    const gun = gunOf(a.weapon);
    const st = gun === null ? { clipout: 0.2, clipin: 0.55, bolt: 0.8 } : RELOAD_STAGES[gun];
    const out1 = st.clipout ?? 0.2;
    const in1 = st.clipin ?? 0.55;
    const bolt = st.bolt ?? null;
    const tilt = ramp(p, 0, 0.12) * (1 - ramp(p, 0.86, 0.96));
    out.rz += 0.38 * tilt;
    out.rx += 0.12 * tilt;
    out.y -= 1.2 * tilt;
    // Mag: drops at clipout, the new one rises from below to its seat at clipin.
    if (p < out1) {
      out.magY = -0.8 * ramp(p, out1 - 0.06, out1);
    } else if (p < in1) {
      const k = (p - out1) / (in1 - out1);
      // Out and falling (0–25 %), gone (25–45 %), the new one rising into its seat (45–100 %).
      if (k < 0.45) {
        out.magY = -0.8 - 14 * ramp(k, 0, 0.25);
        out.magVisible = k < 0.25;
      } else {
        out.magY = -10 * (1 - ramp(k, 0.45, 1));
        out.magZ = 1.5 * (1 - ramp(k, 0.45, 1));
      }
    } else {
      out.y -= 0.6 * (1 - ramp(p, in1, in1 + 0.05));
    }
    if (bolt !== null && p >= bolt - 0.04) out.bolt = m.boltTravel * (ramp(p, bolt - 0.04, bolt) - ramp(p, bolt + 0.03, bolt + 0.08));
    out.phase = 'reload';
    out.progress = p;
    return out;
  }
  // W2: the knife at rest breathes (a slow 0.4 Hz rise and fall), held low right with the blade up and in.
  if (m.kind === 'knife') {
    out.y += Math.sin(a.time * 2 * Math.PI * 0.4) * 0.18;
    out.rx += Math.sin(a.time * 2 * Math.PI * 0.4 + 0.6) * 0.012;
  }
  if (m.kind === 'knife' && a.stab !== undefined && a.stab !== null && a.stab < STAB_SEC) {
    // Placeholder: draw back, thrust forward and in, recover.
    const p = a.stab / STAB_SEC;
    const back = ramp(p, 0, 0.25) * (1 - ramp(p, 0.25, 0.4));
    const thrust = ramp(p, 0.25, 0.42) * (1 - ramp(p, 0.55, 0.95));
    out.z += 3 * back - 9 * thrust;
    out.x -= 3 * thrust;
    out.y += 1.5 * thrust;
    out.rx -= 0.35 * thrust;
    out.phase = 'stab';
    out.progress = p;
    return out;
  }
  if (m.kind === 'knife' && a.inspect !== undefined && a.inspect !== null && a.inspect < INSPECT_SEC) {
    // Placeholder: lift the knife toward the screen centre and turn the blade flat to the camera, then back.
    const p = a.inspect / INSPECT_SEC;
    const k = ramp(p, 0, 0.2) * (1 - ramp(p, 0.8, 1));
    out.x -= 3 * k;
    out.y += 2 * k;
    out.z += 2 * k;
    out.ry += 1.1 * k;
    out.rz += 0.9 * k * Math.sin(Math.PI * ramp(p, 0.2, 0.8));
    out.phase = 'inspect';
    out.progress = p;
    return out;
  }
  if (m.kind === 'knife' && a.swing !== null && a.swing < SWING_SEC) {
    const p = a.swing / SWING_SEC;
    const s = Math.sin(Math.PI * p);
    out.x += -6 * ramp(p, 0.05, 0.6) + 3 * s;
    out.y += 2 * s;
    out.z += -4 * s;
    out.ry += 0.9 * s;
    out.rz += 0.8 * (ramp(p, 0, 0.5) - 0.5) * s;
    out.phase = 'swing';
    out.progress = p;
    return out;
  }
  if (m.kind === 'c4' && a.plant !== null) {
    const k = ramp(a.plant, 0, 0.35);
    // Held lower and tilted so the keypad faces the player.
    out.y -= 1.6 * k;
    out.z -= 1 * k;
    out.rx += 0.55 * k;
    // A key press every 0.45 s (the keypad tapping).
    const tap = (a.plant % 0.45) / 0.45;
    out.bolt = k * (tap < 0.25 ? Math.sin((tap / 0.25) * Math.PI) : 0);
    out.phase = 'plant';
    out.progress = Math.min(1, a.plant / 3.2);
    return out;
  }
  if (m.kind === 'grenade') {
    if (a.thrown !== null) {
      const p = a.thrown / THROW_SEC;
      out.z -= 10 * ramp(p, 0, 0.6);
      out.y += 3 * Math.sin(Math.PI * Math.min(1, p));
      out.rx += 0.6 * ramp(p, 0, 0.6);
      out.visible = p < 0.6;
      out.pinVisible = false;
      out.phase = 'throw';
      out.progress = Math.min(1, p);
      return out;
    }
    if (a.primed) {
      out.z += 3;
      out.y += 2;
      out.rx += 0.3;
      out.pinVisible = false;
      out.phase = 'primed';
      out.progress = 1;
      return out;
    }
  }
  // Fire: kick, bolt / slide.
  if (a.sinceShot < Math.max(KICK_SEC, a.cycle)) {
    const s = a.sinceShot;
    const k = s < KICK_SEC ? Math.exp(-s / 0.025) : 0;
    const heavy = m.kind === 'sniper' ? 1.8 : m.kind === 'pistol' ? 1.2 : 1;
    out.z += 1.4 * k * heavy;
    out.rx += 0.07 * k * heavy;
    out.y += 0.25 * k;
    out.flash = s < FLASH_SEC && m.kind !== 'knife' && m.kind !== 'c4' && m.kind !== 'grenade';
    if (m.kind === 'sniper') {
      // Bolt worked between 38 % and 60 % of the cycle (the bolt sounds), gun lowered meanwhile.
      const p = s / a.cycle;
      const w = ramp(p, 0.3, 0.38) * (1 - ramp(p, 0.62, 0.72));
      out.rz += 0.15 * w;
      out.y -= 0.8 * w;
      out.bolt = m.boltTravel * (ramp(p, 0.38, 0.48) - ramp(p, 0.5, 0.6));
    } else if (s < 0.05) {
      out.bolt = m.boltTravel * Math.sin(Math.PI * Math.min(1, s / 0.05));
    }
    out.phase = 'fire';
    out.progress = Math.min(1, s / Math.max(KICK_SEC, a.cycle));
  }
  return out;
}
