/**
 * Selections over the combat tables that the aim metrics and detectors share, so a metric and the finding built on it
 * count exactly the same shots.
 */
import type { AnalysisContext } from '../../analyze/context';
import type { ShotRow } from './shots';
import { SHOTS } from './shots';
import { SPRAYS, type SprayRow } from './sprays';
import { TARGETS, type TargetRow } from './targets';
import { AIM_TUNING, bandOf } from './tuning';

export interface FirstBullet {
  shot: ShotRow;
  target: TargetRow;
  band: string;
}

/**
 * First bullets of a slot: the first bullet of each burst, on the ground, with a target, from a gun (not the Zeus,
 * not a shotgun). `rifles` keeps the Leetify-comparable set: rifle kinds and not crouched.
 */
export function firstBullets(ctx: AnalysisContext, slot: number, rifles = false): FirstBullet[] {
  const { shots } = ctx.table(SHOTS);
  const { rows } = ctx.table(TARGETS);
  const cs = AIM_TUNING.counterStrafe;
  const out: FirstBullet[] = [];
  for (const s of shots) {
    if (s.p !== slot || s.n !== 1 || s.airborne || s.round === 0) continue;
    if (s.kind === '' || s.kind === 'shotgun' || s.kind === 'taser') continue;
    if (rifles && (!cs.kinds.includes(s.kind) || s.duck >= cs.crouchDuck)) continue;
    const t = rows[s.i];
    if (t === undefined || t.target < 0) continue;
    out.push({ shot: s, target: t, band: bandOf(t.dist) });
  }
  return out;
}

/** The slot's sprays with a target. */
export function spraysOf(ctx: AnalysisContext, slot: number): SprayRow[] {
  return ctx.table(SPRAYS).filter((s) => s.p === slot && s.round > 0);
}

/** Sprays of `minBullets`+ beyond `longUnits`, and whether each hit nothing after bullet `afterBullet`. */
export function longSprays(ctx: AnalysisContext, slot: number): { spray: SprayRow; wasted: boolean }[] {
  const r = AIM_TUNING.rangeDiscipline;
  return spraysOf(ctx, slot)
    .filter((s) => s.bullets.length >= r.minBullets && s.dist > r.longUnits)
    .map((spray) => ({ spray, wasted: !spray.bullets.some((b) => b.n > r.afterBullet && b.hit) }));
}

export function median(xs: readonly number[]): number {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  const m = s.length >> 1;
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

export function mean(xs: readonly number[]): number {
  const s = xs.filter((x) => Number.isFinite(x));
  return s.length === 0 ? NaN : s.reduce((a, b) => a + b, 0) / s.length;
}
