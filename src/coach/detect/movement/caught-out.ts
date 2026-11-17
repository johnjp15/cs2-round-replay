/** `move.caught_out`: deaths with the knife or a grenade in hand (not while throwing at the enemy who killed you). */
import { DEATHS_IN_HAND } from '../../derive/movement/index';
import { caughtOutDeaths } from '../../derive/movement/select';
import { MOVEMENT_TUNING } from '../../derive/movement/tuning';
import type { MetricValue } from '../../model/report';
import { rowAtOrAfter } from '../../model/raw';
import { pct, plural, roundClock, units, weaponName } from '../../report/format';
import { evidence, label, line } from '../annotate';
import { confidence, makeFinding, perMatch, pickClearest, roundsPlayedBy } from '../common';
import type { Detector } from '../types';
import { rowFeet } from '../aim/util';

const ID = 'move.caught_out';
const t = MOVEMENT_TUNING.caughtOut;

export const CAUGHT_OUT: Detector = {
  id: ID,
  area: 'movement',
  scope: 'micro',
  run(ctx, slot, metric) {
    const mv = metric(`${ID}.share`);
    const caught = caughtOutDeaths(ctx, slot);
    const deaths = ctx.table(DEATHS_IN_HAND).filter((d) => d.victim === slot);
    if (caught.length < t.minInstances) return [];
    const rate = ctx.raw.header.tickRate || 64;
    const knives = caught.filter((d) => d.weapon === 'knife').length;
    const picked = pickClearest(caught, (d) => (d.weapon === 'knife' ? 2 : 1), (d) => d.tick, (d) => d.round, 3);
    return [makeFinding({
      id: `${ID}.deaths`, area: 'movement', scope: 'micro', polarity: 'fix',
      title: 'Have your gun out where enemies can be',
      summary: `${caught.length} of your ${plural(deaths.length, 'death')} came with ${knives > 0 ? `the knife (${knives})` : ''}${knives > 0 && caught.length > knives ? ' or ' : ''}${caught.length > knives ? `a grenade (${caught.length - knives})` : ''} in hand${mv !== null && Number.isFinite(mv.value) ? ` (${pct(mv.value)})` : ''}.`,
      why: 'Drawing a gun takes about a second; an enemy who meets you with a knife or a grenade out wins that duel for free.',
      advice: [{ text: 'Switch to the gun before the last corner where an enemy could be; run with the knife only behind your own lines, and throw grenades from cover, then draw at once.' }],
      metrics: mv === null ? [] : [mv as MetricValue],
      evidence: picked.map((d) => {
        const row = Math.max(0, rowAtOrAfter(ctx.raw.ticks, d.tick) - 1);
        const me = rowFeet(ctx, row, slot);
        const k = rowFeet(ctx, row, d.attacker);
        const dist = Math.hypot(k[0] - me[0], k[1] - me[1], k[2] - me[2]);
        const text = `killed with the ${weaponName(d.weapon)} in hand, ${units(dist)} from the killer`;
        return evidence('replay', d.round, d.tick, rate * 5, rate * 2, [slot, d.attacker], [
          line(k, me, d.tick - rate, d.tick + rate, 'enemy', 'killer'),
          label(me, text, d.tick - rate * 3, d.tick + rate * 2, 'bad'),
        ], `${roundClock(ctx.match, d.tick)}: ${text}`);
      }),
      instances: caught.length, opportunities: deaths.length, rounds: caught.map((d) => d.round),
      confidence: confidence(t.precision, caught.length, t.nScale), impact: perMatch(caught.length * t.costDeath, roundsPlayedBy(ctx, slot)),
    })];
  },
};
