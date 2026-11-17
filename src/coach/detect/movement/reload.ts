/** `move.reload`: reloads started with an enemy near (and visible, with a map pack) or more than half a magazine; deaths while reloading. */
import type { AnalysisContext } from '../../analyze/context';
import { DEATHS_IN_HAND, RELOADS, type DeathInHand, type ReloadRow } from '../../derive/movement/index';
import { MOVEMENT_TUNING } from '../../derive/movement/tuning';
import type { Finding, MetricValue } from '../../model/report';
import { pct, plural, roundClock, units, weaponName } from '../../report/format';
import { evidence, circle, label, line } from '../annotate';
import { confidence, isBelowMedian, makeFinding, perMatch, pickClearest, roundsPlayedBy } from '../common';
import type { Detector } from '../types';
import { rowFeet } from '../aim/util';
import { rowAtOrAfter } from '../../model/raw';

const ID = 'move.reload';
const t = MOVEMENT_TUNING.reload;

type Item = { kind: 'death'; d: DeathInHand } | { kind: 'reload'; r: ReloadRow };

function itemTick(x: Item): number {
  return x.kind === 'death' ? x.d.tick : x.r.tick;
}

function ev(ctx: AnalysisContext, x: Item, slot: number): Finding['evidence'][number] {
  const rate = ctx.raw.header.tickRate || 64;
  const tick = itemTick(x);
  const row = Math.min(rowAtOrAfter(ctx.raw.ticks, tick), ctx.raw.ticks.count - 1);
  const me = rowFeet(ctx, row, slot);
  if (x.kind === 'death') {
    const k = rowFeet(ctx, row, x.d.attacker);
    const text = `died reloading the ${weaponName(x.d.weapon)} (${x.d.clip === 255 ? '?' : x.d.clip} in the clip)`;
    return evidence('replay', x.d.round, tick, rate * 5, rate * 2, [slot, x.d.attacker], [
      line(k, me, tick - rate, tick + rate, 'enemy', 'killer'),
      circle(me, 40, tick - rate * 3, tick + rate, 'bad', 'reloading'),
      label(me, text, tick - rate * 3, tick + rate * 2, 'bad'),
    ], `${roundClock(ctx.match, tick)}: ${text}`);
  }
  const r = x.r;
  const anns = [circle(me, 40, tick - rate, tick + rate * 2, 'bad', 'reload'), label(me, `reload with ${r.clip}/${r.clipSize}`, tick - rate, tick + rate * 2, 'bad')];
  if (r.nearest >= 0) anns.push(line(me, rowFeet(ctx, row, r.nearest), tick - rate, tick + rate * 2, 'enemy', units(r.nearestDist)));
  const why = [r.enemyNear ? `an enemy ${units(r.nearestDist)} away${ctx.los !== null ? ' and in sight' : ''}` : '', r.halfFull ? `${r.clip} of ${r.clipSize} still in the magazine` : ''].filter((s) => s !== '').join(', ');
  return evidence('replay', r.round, tick, rate * 5, rate * 3, [slot, r.nearest], anns, `${roundClock(ctx.match, tick)}: reloaded the ${weaponName(r.weapon)} with ${why}${r.diedReloading ? '; died before it finished' : ''}`);
}

export const RELOAD: Detector = {
  id: ID,
  area: 'movement',
  scope: 'micro',
  run(ctx, slot, metric) {
    const share = metric(`${ID}.exposed_share`);
    const deathsMv = metric(`${ID}.deaths`);
    const reloads = ctx.table(RELOADS).filter((r) => r.p === slot);
    const exposed = reloads.filter((r) => r.exposed);
    const deaths = ctx.table(DEATHS_IN_HAND).filter((d) => d.victim === slot && d.reloading);
    const rounds = roundsPlayedBy(ctx, slot);
    const metrics = [share, deathsMv].filter((m): m is MetricValue => m !== null);
    const near = exposed.filter((r) => r.enemyNear).length;
    const full = exposed.filter((r) => r.halfFull).length;
    if (deaths.length === 0 && !(exposed.length >= t.minInstances && isBelowMedian(share))) return [];
    const items: Item[] = [...deaths.map((d): Item => ({ kind: 'death', d })), ...exposed.filter((r) => !r.diedReloading).map((r): Item => ({ kind: 'reload', r }))];
    const picked = pickClearest(items, (x) => (x.kind === 'death' ? 10 : (x.r.enemyNear ? 2 : 0) + (x.r.halfFull ? 1 : 0) + 1 / Math.max(1, x.r.nearestDist / 500)), itemTick, (x) => (x.kind === 'death' ? x.d.round : x.r.round), 3);
    return [makeFinding({
      id: `${ID}.exposed`, area: 'movement', scope: 'micro', polarity: 'fix',
      title: 'Reload behind cover, not by habit',
      summary: exposed.length === 0
        ? `You died ${deaths.length === 1 ? 'once' : `${deaths.length} times`} while reloading (${plural(reloads.length, 'reload')} in the match).`
        : `You started ${exposed.length} of ${plural(reloads.length, 'reload')} with an enemy within ${units(t.nearUnits)}${ctx.los !== null ? ' in sight' : ''} (${near}) or more than half a magazine left (${full})${deaths.length > 0 ? `, and died ${deaths.length === 1 ? 'once' : `${deaths.length} times`} while reloading` : ''}.`,
      why: `A reload takes 2–3 s in which you cannot shoot${share !== null && Number.isFinite(share.value) ? `; ${pct(share.value)} of your reloads were exposed` : ''}.`,
      advice: [{ text: 'After a kill, check the magazine: with more than half left, swap to the pistol or reposition first; reload only behind cover and with no enemy close.' }],
      metrics, evidence: picked.map((x) => ev(ctx, x, slot)),
      instances: exposed.length + deaths.filter((d) => !exposed.some((r) => r.diedReloading && r.tick <= d.tick)).length, opportunities: reloads.length,
      rounds: [...exposed.map((r) => r.round), ...deaths.map((d) => d.round)],
      confidence: confidence(t.precision, reloads.length + 3 * deaths.length, t.nScale),
      impact: perMatch(deaths.length * t.costDeath + near * t.costNear + (exposed.length - near) * t.costFull, rounds),
    })];
  },
};
