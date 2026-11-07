/**
 * Aim a throw at a landing spot (docs/grenades.md, "Aiming at a landing"): search pitch, yaw and strength for the
 * throw whose detonation lands nearest the target, by simulating it on the host's world. For the recorded round the
 * target is `utility[].landing` (V0's measured spot, `data/round.json`); a host calls this once per scripted throw and
 * releases the grenade with the returned angles. Deterministic: a fixed grid, then local refinement.
 */
import type { Vec3 } from '../../contracts/index';
import { simulateThrow } from './step';
import type { GrenadeConfig, GrenadeWorld, ThrowRequest } from './types';

export interface AimOptions {
  /** Strengths to try (1 = ATTACK, 0.5 = both, 0 = ATTACK2). Default all three. */
  readonly strengths?: readonly number[];
  /** Yaw search half-width around the direct bearing, degrees. Default 15. */
  readonly yawSpan?: number;
  /** Pitch range, degrees (negative = up). Default −60…+30. */
  readonly pitchMin?: number;
  readonly pitchMax?: number;
  /** Coarse grid steps, degrees. Default 3 (yaw) and 5 (pitch). */
  readonly yawStep?: number;
  readonly pitchStep?: number;
  /** Refinement rounds (each halves the steps around the best). Default 3. */
  readonly refine?: number;
  /** Give up on a throw that has not detonated after this long (s). Default 12. */
  readonly maxSec?: number;
}

export interface AimSolution {
  readonly pitch: number;
  readonly yaw: number;
  readonly strength: number;
  /** Where the best throw detonates (null if no throw detonated). */
  readonly landing: Vec3 | null;
  /** 3D distance from the target to `landing` (Infinity if none). */
  readonly error: number;
  /** Seconds from release to detonation. */
  readonly sec: number;
  /** Throws simulated. */
  readonly evaluated: number;
}

export function aimAtLanding(
  base: Omit<ThrowRequest, 'pitch' | 'yaw' | 'strength'>,
  target: Vec3,
  world: GrenadeWorld,
  cfg: GrenadeConfig,
  opts: AimOptions = {},
): AimSolution {
  const strengths = opts.strengths ?? [1, 0.5, 0];
  const span = opts.yawSpan ?? 15;
  const pMin = opts.pitchMin ?? -60;
  const pMax = opts.pitchMax ?? 30;
  let yStep = opts.yawStep ?? 3;
  let pStep = opts.pitchStep ?? 5;
  const maxSec = opts.maxSec ?? 12;
  const yaw0 = (Math.atan2(target.y - base.eye.y, target.x - base.eye.x) * 180) / Math.PI;
  let evaluated = 0;
  let best: AimSolution = { pitch: 0, yaw: yaw0, strength: strengths[0] ?? 1, landing: null, error: Infinity, sec: 0, evaluated: 0 };
  const seen = new Set<string>();
  const tryThrow = (pitch: number, yaw: number, strength: number): void => {
    if (pitch < pMin || pitch > pMax) return;
    const key = `${pitch.toFixed(4)}|${yaw.toFixed(4)}|${strength}`;
    if (seen.has(key)) return;
    seen.add(key);
    evaluated++;
    const r = simulateThrow({ ...base, pitch, yaw, strength }, world, cfg, { maxSec });
    if (r.detonation === null) return;
    const p = r.detonation.pos;
    const error = Math.hypot(p.x - target.x, p.y - target.y, p.z - target.z);
    if (error < best.error) best = { pitch, yaw, strength, landing: p, error, sec: r.ticks / 64, evaluated: 0 };
  };
  for (const s of strengths) {
    for (let dy = -span; dy <= span + 1e-9; dy += yStep) {
      for (let p = pMin; p <= pMax + 1e-9; p += pStep) tryThrow(p, yaw0 + dy, s);
    }
  }
  for (let k = 0; k < (opts.refine ?? 3); k++) {
    yStep /= 2;
    pStep /= 2;
    const c = best;
    for (const dy of [-yStep, 0, yStep]) for (const dp of [-pStep, 0, pStep]) tryThrow(c.pitch + dp, c.yaw + dy, c.strength);
  }
  return { ...best, evaluated };
}
