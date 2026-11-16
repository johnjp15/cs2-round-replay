/**
 * `aim.spray`: per bullet number, where the recoil-compensated aim (the bullet's zero-spread direction = view + punch
 * × 2) was relative to the target's chest, split into up and right, for the weapon and distance band the player
 * sprayed most. Consecutive bullet numbers with the same verdict form segments: "on target for bullets 1–3, 1.8°
 * high over bullets 4–10". A bucket is off when its median offset leaves the silhouette's angular half-size at that
 * distance and is at least offDeg.
 */
import type { AnalysisContext } from '../../analyze/context';
import { median, spraysOf } from '../../derive/aim/select';
import type { SprayRow } from '../../derive/aim/sprays';
import { AIM_TUNING, bandOf } from '../../derive/aim/tuning';
import { dirOf } from '../../derive/aim/geom';
import { SHOTS } from '../../derive/aim/shots';
import type { Finding, MetricValue } from '../../model/report';
import { deg, pct, plural, roundClock, span, units, weaponName } from '../../report/format';
import { evidence, label, line, path } from '../annotate';
import { confidence, isBelowMedian, isStrength, makeFinding, perMatch, pickClearest, roundsPlayedBy } from '../common';
import type { Detector } from '../types';
import { lobbyMedian } from './util';

const ID = 'aim.spray';
const t = AIM_TUNING.spray;
const body = AIM_TUNING.body;
const DEG = 180 / Math.PI;

export type Verdict = 'on' | 'high' | 'low' | 'left' | 'right' | 'high-left' | 'high-right' | 'low-left' | 'low-right';

export interface Bucket {
  n: number;
  count: number;
  up: number;
  right: number;
  dist: number;
  verdict: Verdict;
}

export interface Segment {
  from: number;
  to: number;
  verdict: Verdict;
  up: number;
  right: number;
}

/** The verdict of a median offset at a distance. */
export function verdictOf(up: number, right: number, dist: number): Verdict {
  const d = Math.max(1, dist);
  const hi = Math.max(t.offDeg, Math.atan((body.top - body.centre) / d) * DEG);
  const lo = Math.max(t.offDeg, Math.atan((body.centre - body.bottom) / d) * DEG);
  const side = Math.max(t.offDeg, Math.atan(body.halfWidth / d) * DEG);
  const v = up > hi ? 'high' : up < -lo ? 'low' : '';
  const h = right > side ? 'right' : right < -side ? 'left' : '';
  if (v === '' && h === '') return 'on';
  return (v !== '' && h !== '' ? `${v}-${h}` : v || h) as Verdict;
}

/** Median offset per bullet number (buckets with at least minBucket bullets), bullet 1 to maxBullet. */
export function sprayProfile(sprays: readonly SprayRow[]): Bucket[] {
  const out: Bucket[] = [];
  for (let n = 1; n <= t.maxBullet; n++) {
    const b = sprays.flatMap((s) => s.bullets.filter((x) => x.n === n));
    if (b.length < t.minBucket) continue;
    const up = median(b.map((x) => x.up));
    const right = median(b.map((x) => x.right));
    const dist = median(b.map((x) => x.dist));
    out.push({ n, count: b.length, up, right, dist, verdict: verdictOf(up, right, dist) });
  }
  return out;
}

/** Consecutive buckets with the same verdict. */
export function segments(profile: readonly Bucket[]): Segment[] {
  const out: Segment[] = [];
  let cur: Bucket[] = [];
  const flush = (): void => {
    const a = cur[0];
    const b = cur[cur.length - 1];
    if (a === undefined || b === undefined) return;
    out.push({ from: a.n, to: b.n, verdict: a.verdict, up: cur.reduce((s, x) => s + x.up, 0) / cur.length, right: cur.reduce((s, x) => s + x.right, 0) / cur.length });
  };
  for (const b of profile) {
    const last = cur[cur.length - 1];
    if (last !== undefined && (b.verdict !== last.verdict || b.n !== last.n + 1)) {
      flush();
      cur = [];
    }
    cur.push(b);
  }
  flush();
  return out;
}

/** "on target for bullets 1–3, 1.8° high over bullets 4–10, 1.2° right from bullet 11". */
export function describe(segs: readonly Segment[]): string {
  return segs.map((s) => {
    const range = s.from === s.to ? `bullet ${s.from}` : `bullets ${span(s.from, s.to)}`;
    if (s.verdict === 'on') return `on target for ${range}`;
    const parts: string[] = [];
    if (s.verdict.startsWith('high')) parts.push(`${deg(s.up)} high`);
    if (s.verdict.startsWith('low')) parts.push(`${deg(-s.up)} low`);
    if (s.verdict.endsWith('right')) parts.push(`${deg(s.right)} right`);
    if (s.verdict.endsWith('left')) parts.push(`${deg(-s.right)} left`);
    return `${parts.join(' and ')} over ${range}`;
  }).join(', ');
}

function advice(seg: Segment, weapon: string): string {
  const w = weaponName(weapon);
  const parts: string[] = [];
  if (seg.verdict.startsWith('high')) parts.push(`pull down harder from bullet ${seg.from}: the ${w} keeps climbing there and your hand stops following it`);
  if (seg.verdict.startsWith('low')) parts.push(`ease off the downward pull from bullet ${seg.from}: you over-compensate and drag under the target`);
  if (seg.verdict.endsWith('right')) parts.push(`move the mouse further left over bullets ${span(seg.from, seg.to)}: your aim ends right of the target`);
  if (seg.verdict.endsWith('left')) parts.push(`move the mouse further right over bullets ${span(seg.from, seg.to)}: your aim ends left of the target`);
  const s = parts.join('; and ');
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

function sprayEvidence(ctx: AnalysisContext, s: SprayRow, seg: Segment | null, slot: number): Finding['evidence'][number] {
  const rate = ctx.raw.header.tickRate || 64;
  const first = s.bullets[0];
  const last = s.bullets[s.bullets.length - 1];
  const shots = ctx.table(SHOTS);
  const aimPts: [number, number, number][] = [];
  const tgtPts: [number, number, number][] = [];
  const ticks: number[] = [];
  for (const b of s.bullets) {
    const sh = shots.shots[b.shot];
    if (sh === undefined) continue;
    const d = dirOf(sh.pitch, sh.yaw);
    aimPts.push([sh.eye[0] + d[0] * b.dist, sh.eye[1] + d[1] * b.dist, sh.eye[2] + d[2] * b.dist]);
    tgtPts.push([b.at[0], b.at[1], b.at[2] + body.centre]);
    ticks.push(b.tick);
  }
  const t0 = first?.tick ?? 0;
  const t1 = last?.tick ?? t0;
  const eye = shots.shots[first?.shot ?? 0]?.eye ?? [0, 0, 0];
  let segText = `${s.hits} of ${s.bullets.length} hit`;
  if (seg !== null) {
    const own = s.bullets.filter((b) => b.n >= seg.from && b.n <= seg.to);
    const up = median(own.map((b) => b.up));
    const right = median(own.map((b) => b.right));
    const from = own[0]?.n ?? seg.from;
    const to = own[own.length - 1]?.n ?? seg.to;
    segText = describe([{ from, to, verdict: verdictOf(up, right, median(own.map((b) => b.dist))), up, right }]);
  }
  const end = tgtPts[tgtPts.length - 1] ?? eye;
  return evidence('spray', s.round, t0, rate, t1 - t0 + rate, [slot, s.target], [
    line(eye, tgtPts[0] ?? eye, t0 - rate, t1 + rate, 'neutral', `${units(s.dist)}`, true),
    path(aimPts, ticks, t0, t1 + rate, 'user', 'your compensated aim'),
    path(tgtPts, ticks, t0, t1 + rate, 'enemy', 'target chest'),
    label(end, segText, t0, t1 + rate, seg === null || seg.verdict === 'on' ? 'good' : 'bad'),
  ], `${roundClock(ctx.match, t0)}: ${s.bullets.length}-bullet ${weaponName(s.weapon)} spray at ${units(s.dist)}, ${segText}; ${s.hits} hit`);
}

export const SPRAY: Detector = {
  id: ID,
  area: 'aim',
  scope: 'mechanics',
  run(ctx, slot, metric) {
    const mv = metric(`${ID}.on_target_share`);
    if (mv === null || !Number.isFinite(mv.value)) return [];
    const sprays = spraysOf(ctx, slot);
    // The weapon and band with the most spray bullets; the weapon alone when that group is too small.
    const groups = new Map<string, SprayRow[]>();
    for (const s of sprays) {
      const k = `${s.weapon}|${bandOf(s.dist)}`;
      const g = groups.get(k);
      if (g === undefined) groups.set(k, [s]);
      else g.push(s);
    }
    const count = (g: readonly SprayRow[]): number => g.reduce((a, s) => a + s.bullets.length, 0);
    const ranked = [...groups.entries()].sort((a, b) => count(b[1]) - count(a[1]) || (a[0] < b[0] ? -1 : 1));
    const top = ranked[0];
    if (top === undefined) return [];
    const [weapon, band] = top[0].split('|') as [string, string];
    let group = top[1];
    let where = `with the ${weaponName(weapon)} at ${band} range`;
    if (count(group) < t.minBullets) {
      group = sprays.filter((s) => s.weapon === weapon);
      where = `with the ${weaponName(weapon)}`;
    }
    const bullets = count(group);
    const prof = sprayProfile(group);
    const segs = segments(prof);
    // Only drift from bullet `bulletFrom` on that reaches bullet 4 is spray control; bullet 1 is placement.
    const off = segs.filter((s) => s.verdict !== 'on' && s.from >= t.bulletFrom && s.to >= 4 && s.to > s.from);
    const rounds = roundsPlayedBy(ctx, slot);
    const metrics = [mv, metric(`${ID}.vertical_drift_deg`), metric(`${ID}.horizontal_drift_deg`), metric(`${ID}.hit_share`)].filter((m): m is MetricValue => m !== null);
    const conf = confidence(t.precision, bullets, t.nScale);
    const out: Finding[] = [];
    const worst = [...off].sort((a, b) => Math.hypot(b.up, b.right) * (b.to - b.from + 1) - Math.hypot(a.up, a.right) * (a.to - a.from + 1) || a.from - b.from)[0];
    if (worst !== undefined && bullets >= t.minBullets && isBelowMedian(mv)) {
      const inSeg = (n: number): boolean => n >= worst.from && n <= worst.to;
      const offBullets = (s: SprayRow): number => s.bullets.filter((b) => inSeg(b.n) && !b.onTarget).length;
      const drifting = group.filter((s) => offBullets(s) > 0);
      const ev = pickClearest(drifting, offBullets, (s) => s.bullets[0]?.tick ?? 0, (s) => s.round, 3);
      out.push(makeFinding({
        id: `${ID}.drift`, area: 'aim', scope: 'mechanics', polarity: 'fix',
        title: worst.verdict.startsWith('high') ? 'Pull down through the spray' : worst.verdict.startsWith('low') ? 'Stop over-pulling the spray' : 'Hold the spray on the target sideways',
        summary: `${where.charAt(0).toUpperCase() + where.slice(1)} your sprays were ${describe(segs)} (${plural(group.length, 'spray')}, ${plural(bullets, 'bullet')}).`,
        why: `${pct(mv.value)} of your spray bullets from bullet ${t.bulletFrom} crossed the target (lobby median ${pct(lobbyMedian(mv))}); ${plural(drifting.length, 'spray')} left it over bullets ${span(worst.from, worst.to)}.`,
        advice: [{ text: advice(worst, weapon), drill: `10 minutes of the ${weaponName(weapon)} pattern on a recoil workshop map (e.g. Recoil Master): bullets 1–10 on a wall target at 15 m, then full magazines.` }],
        metrics, evidence: ev.map((s) => sprayEvidence(ctx, s, worst, slot)),
        instances: drifting.length, opportunities: group.length, rounds: drifting.map((s) => s.round),
        confidence: conf, impact: perMatch(drifting.length * t.costPerSpray, rounds),
      }));
    } else if (isStrength(mv, t.minBullets)) {
      const good = [...sprays].sort((a, b) => b.hits - a.hits || (a.bullets[0]?.tick ?? 0) - (b.bullets[0]?.tick ?? 0)).filter((s) => s.hits >= 3);
      if (good.length > 0) {
        const ev = pickClearest(good, (s) => s.hits + s.hits / s.bullets.length, (s) => s.bullets[0]?.tick ?? 0, (s) => s.round, 2);
        out.push(makeFinding({
          id: `${ID}.controlled`, area: 'aim', scope: 'mechanics', polarity: 'strength',
          title: 'Controlled sprays',
          summary: `${pct(mv.value)} of your spray bullets crossed the target (lobby median ${pct(lobbyMedian(mv))}); ${where} your sprays were ${segs.length > 0 ? describe(segs) : 'on target'}.`,
          why: 'Your recoil control turns long fights into kills.',
          advice: [], metrics, evidence: ev.map((s) => sprayEvidence(ctx, s, null, slot)),
          instances: good.length, opportunities: sprays.length, rounds: good.map((s) => s.round),
          confidence: conf, impact: perMatch(good.length * t.costPerSpray, rounds),
        }));
      }
    }
    return out;
  },
};
