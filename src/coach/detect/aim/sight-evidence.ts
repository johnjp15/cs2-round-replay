/**
 * K6: evidence builders shared by the sight-based detectors (aim and positioning): the observer's view cone at a
 * moment, the sight line to the enemy, a label with the angle and the time.
 */
import type { AnalysisContext } from '../../analyze/context';
import type { FirstSight } from '../../derive/sight/firsts';
import type { Annotation, ColorRole, Evidence } from '../../model/report';
import { deg, ms, roundClock, units } from '../../report/format';
import { evidence, label, line } from '../annotate';

type P3 = [number, number, number];

/** Half the horizontal field of view at the los tuning's screen aspect (53.1° at 16:9). */
export function viewHalfAngle(ctx: AnalysisContext): number {
  const t = ctx.los?.tuning;
  if (!t) return 53.1;
  const tanV = Math.tan((t.fovDeg * Math.PI) / 360) / t.fovAspect;
  return Math.round(((Math.atan(tanV * t.aspect) * 180) / Math.PI) * 10) / 10;
}

/** A view cone annotation. */
export function cone(ctx: AnalysisContext, apex: P3, yaw: number, length: number, tick0: number, tick1: number, role: ColorRole, text?: string): Annotation {
  const r = (x: number): number => Math.round(x * 10) / 10;
  return { kind: 'cone', apex: [r(apex[0]), r(apex[1]), r(apex[2])], yaw: r(yaw), halfAngle: viewHalfAngle(ctx), length: Math.round(length), tick0, tick1, role, ...(text !== undefined ? { label: text } : {}) };
}

/** Where the enemy's head was against the crosshair, in words: "2.1° right, 0.4° high of your crosshair". */
export function offsetText(f: FirstSight): string {
  const h = Math.abs(f.right) < 0.05 ? '' : `${deg(Math.abs(f.right))} ${f.right > 0 ? 'right' : 'left'}`;
  const v = Math.abs(f.up) < 0.05 ? '' : `${deg(Math.abs(f.up))} ${f.up > 0 ? 'above' : 'below'}`;
  return [h, v].filter((s) => s !== '').join(', ') || 'on the crosshair';
}

/** A first sight as a duel evidence moment: cone at the first sight, the sight line, a label with angle and times. */
export function firstSightEvidence(ctx: AnalysisContext, user: number, f: FirstSight, who: string, caption: string): Evidence {
  const rate = ctx.raw.header.tickRate || 64;
  const end = f.duel.killTick ?? f.tick + rate;
  const times = [f.damageMs !== null ? `${ms(f.damageMs)} to damage` : f.shotMs !== null ? `${ms(f.shotMs)} to first shot` : 'no shot'].join('');
  const role: ColorRole = f.outcome === 'won' ? 'good' : f.outcome === 'lost' ? 'bad' : 'neutral';
  const ann: Annotation[] = [
    cone(ctx, f.eye, f.viewYaw, Math.min(1500, f.dist + 150), f.tick, end, 'user', 'your view at first sight'),
    line(f.eye, f.head, f.tick, end, 'enemy', `sight line to ${who}, ${units(f.dist)}`),
    label(f.head, `${deg(f.angle)} off (${offsetText(f)}); ${times}`, f.tick, end, role),
  ];
  return evidence('duel', f.round, f.tick, rate * 3, Math.max(rate, end - f.tick + rate), [user, f.enemy], ann, `${roundClock(ctx.match, f.tick)}: ${caption}`);
}
