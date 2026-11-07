/**
 * Recoil: the per-bullet recoil table generated from a weapon's recoil parameters and `m_nRecoilSeed`, the aim punch
 * it drives (kick per shot, decay per tick) and the screen-shake view punch. Units: degrees; pitch is Source's
 * (+ = down), yaw + = left (counter-clockwise, like the repo's yaw). docs/weapons.md, "Recoil".
 *
 * Model (CS:GO's, with its console defaults as tunables; the generator reproduces the community-published CS:GO
 * spray envelopes of 10 spray weapons within 0.5 %, and CS2's are 6 % smaller: `weaponModel.recoilScale` is fitted):
 * - Table, per mode: a `ValveUniformRandom` seeded with the recoil seed; for bullet j:
 *   `angle_j' = angle + U(−angleVariance, +angleVariance)`, `mag_j' = magnitude + U(−magVariance, +magVariance)`;
 *   full-auto weapons smooth consecutive bullets, `x_j = x_{j−1} + (x_j' − x_{j−1}) × recoilVariance` (j > 0), and
 *   damp the first `recoilSuppressionShots` magnitudes by lerp(j / shots, suppressionFactor, 1). 64 entries.
 * - Kick per shot (table entry at ⌊recoilIndex⌋): aim punch velocity += (−cos a × mag, sign × sin a × mag); view punch
 *   += the same × recoilViewPunchExtra.
 * - Per tick dt: |punch| ← max(0, |punch| e^(−decayExp·dt) − decayLin·dt); punch += vel·dt/2; vel ×= e^(−velDecay·dt);
 *   punch += vel·dt/2. View punch ×= e^(−viewPunchDecay·dt).
 * - The bullet leaves along view + punch × recoilScale.
 */
import { roundNumber, type WeaponModelTuning } from '../../contracts/index';
import type { WeaponDef, WeaponTable } from './table';
import { ValveUniformRandom } from './valve-random';

export const RECOIL_TABLE_SIZE = 64;
const DEG = Math.PI / 180;

/** Pitch / yaw pair in degrees. */
export interface Angle2 {
  readonly pitch: number;
  readonly yaw: number;
}

export const ZERO_ANGLE: Angle2 = { pitch: 0, yaw: 0 };

export interface RecoilEntry {
  /** Degrees from straight up (positive toward +yaw with recoilYawSign 1). */
  readonly angle: number;
  readonly magnitude: number;
}

/** Recoil tables of one weapon: [primary, alt]. */
export type RecoilTables = readonly [readonly RecoilEntry[], readonly RecoilEntry[]];

type TableTuning = Pick<WeaponModelTuning, 'recoilVariance' | 'recoilSuppressionShots' | 'recoilSuppressionFactor'>;

/** The 64-entry recoil table of `w` in `mode` (0 primary, 1 alt). Float32 like the game; deterministic. */
export function recoilTable(w: WeaponDef, mode: 0 | 1, m: TableTuning): RecoilEntry[] {
  const rnd = new ValveUniformRandom(w.recoil.seed);
  const out: RecoilEntry[] = [];
  const angle = w.recoil.angle[mode];
  const angleVar = w.recoil.angleVariance[mode];
  const mag = w.recoil.magnitude[mode];
  const magVar = w.recoil.magnitudeVariance[mode];
  let a = 0;
  let r = 0;
  for (let j = 0; j < RECOIL_TABLE_SIZE; j++) {
    const aNew = Math.fround(angle + rnd.randomFloat(-angleVar, angleVar));
    const rNew = Math.fround(mag + rnd.randomFloat(-magVar, magVar));
    if (w.fullAuto && j > 0) {
      a = Math.fround(a + (aNew - a) * m.recoilVariance);
      r = Math.fround(r + (rNew - r) * m.recoilVariance);
    } else {
      a = aNew;
      r = rNew;
    }
    let stored = r;
    if (w.fullAuto && j < m.recoilSuppressionShots) {
      const f = m.recoilSuppressionFactor + (1 - m.recoilSuppressionFactor) * (j / m.recoilSuppressionShots);
      stored = Math.fround(r * f);
    }
    out.push({ angle: a, magnitude: stored });
  }
  return out;
}

/** Both modes' tables for every weapon of the table, by id (sorted). Build once per tuning. */
export function buildRecoilTables(table: WeaponTable, m: TableTuning): Record<string, RecoilTables> {
  const out: Record<string, RecoilTables> = {};
  for (const id of table.ids) {
    const w = table.weapons[id] as WeaponDef;
    out[id] = [recoilTable(w, 0, m), recoilTable(w, 1, m)];
  }
  return out;
}

/** The punch state of one player (aim punch, its velocity, view punch). Degrees and degrees per second. */
export interface PunchState {
  readonly aim: Angle2;
  readonly aimVel: Angle2;
  readonly view: Angle2;
}

export const ZERO_PUNCH: PunchState = { aim: ZERO_ANGLE, aimVel: ZERO_ANGLE, view: ZERO_ANGLE };

/** The kick of one shot fired at recoil index `index` (velocity impulse, degrees per second). */
export function recoilKick(tables: RecoilTables, mode: 0 | 1, index: number, m: Pick<WeaponModelTuning, 'recoilYawSign'>): Angle2 {
  const t = tables[mode];
  const e = t[Math.max(0, Math.min(RECOIL_TABLE_SIZE - 1, Math.floor(index)))] as RecoilEntry;
  const a = e.angle * DEG;
  return { pitch: -Math.cos(a) * e.magnitude, yaw: m.recoilYawSign * Math.sin(a) * e.magnitude };
}

/** Punch after a shot's kick: aim velocity += kick; view punch += kick × recoilViewPunchExtra. */
export function applyKick(p: PunchState, kick: Angle2, m: Pick<WeaponModelTuning, 'recoilViewPunchExtra'>): PunchState {
  return {
    aim: p.aim,
    aimVel: { pitch: q(p.aimVel.pitch + kick.pitch), yaw: q(p.aimVel.yaw + kick.yaw) },
    view: { pitch: q(p.view.pitch + kick.pitch * m.recoilViewPunchExtra), yaw: q(p.view.yaw + kick.yaw * m.recoilViewPunchExtra) },
  };
}

type DecayTuning = Pick<WeaponModelTuning, 'recoilDecayExp' | 'recoilDecayLin' | 'recoilVelDecay' | 'viewPunchDecay'>;

/** One tick (dt seconds) of aim and view punch decay. */
export function decayPunch(p: PunchState, dt: number, m: DecayTuning): PunchState {
  let ap = p.aim.pitch;
  let ay = p.aim.yaw;
  const len = Math.hypot(ap, ay);
  if (len > 0) {
    const nl = Math.max(0, len * Math.exp(-m.recoilDecayExp * dt) - m.recoilDecayLin * dt);
    ap *= nl / len;
    ay *= nl / len;
  }
  let vp = p.aimVel.pitch;
  let vy = p.aimVel.yaw;
  ap += vp * dt * 0.5;
  ay += vy * dt * 0.5;
  const vd = Math.exp(-m.recoilVelDecay * dt);
  vp *= vd;
  vy *= vd;
  ap += vp * dt * 0.5;
  ay += vy * dt * 0.5;
  const pd = Math.exp(-m.viewPunchDecay * dt);
  return {
    aim: { pitch: q(ap), yaw: q(ay) },
    aimVel: { pitch: q(vp), yaw: q(vy) },
    view: { pitch: q(p.view.pitch * pd), yaw: q(p.view.yaw * pd) },
  };
}

/** The bullet's angular offset from the view: aim punch × recoilScale. */
export function punchOffset(p: PunchState, m: Pick<WeaponModelTuning, 'recoilScale'>): Angle2 {
  return { pitch: p.aim.pitch * m.recoilScale, yaw: p.aim.yaw * m.recoilScale };
}

/**
 * The weapon's spray pattern: the punch offset (degrees, [pitch, yaw]) of each bullet of a full magazine fired by
 * holding ATTACK while standing still, at `ticksPerSec` and the primary cycle time (no inaccuracy). Bullet 1 is
 * always [0, 0].
 */
export function sprayPattern(w: WeaponDef, tables: RecoilTables, m: WeaponModelTuning, ticksPerSec: number, shots = w.clip): [number, number][] {
  const dt = 1 / ticksPerSec;
  const cycle = w.cycleTime[0] * ticksPerSec;
  let p: PunchState = ZERO_PUNCH;
  let next = 0;
  let index = 0;
  const out: [number, number][] = [];
  for (let tick = 0; out.length < shots && tick < 100000; tick++) {
    if (tick + 1e-9 >= next) {
      const o = punchOffset(p, m);
      out.push([roundNumber(o.pitch), roundNumber(o.yaw)]);
      p = applyKick(p, recoilKick(tables, 0, index, m), m);
      index++;
      next = roundNumber(next + cycle);
    }
    p = decayPunch(p, dt, m);
  }
  return out;
}

function q(x: number): number {
  return roundNumber(x);
}
