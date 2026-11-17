/**
 * strategy area (K8): per-player metrics, computed for all ten players (null where the player had no round on that
 * side, or the map has no knowledge file). Definitions: docs/coach/strategy.md "Metrics".
 */
import { STRAT_ROTATIONS } from '../../derive/strategy/rotations';
import { THROWS } from '../../derive/utility/throws';
import { sideRounds } from '../../detect/strategy/common';
import type { MetricDef } from '../types';

/** As CT: share of rounds in which he contested a lane the Ts took (body, sight, damage or grenade, in time). */
const contestShare: MetricDef = {
  id: 'strat.lane.contest_share', label: 'CT rounds contesting a lane they took', unit: '%', better: 'higher', area: 'strategy', minN: 3,
  compute(ctx, slot) {
    const rs = sideRounds(ctx, slot, 'CT');
    if (rs.length === 0) return null;
    const n = rs.filter((r) => r.lanes.some((l) => l.taken && l.contesters.includes(slot))).length;
    return { value: n / rs.length, n: rs.length };
  },
};

/** As CT: share of the Ts' site hits where he was one of the hit site's defenders at the entry. */
const onHitShare: MetricDef = {
  id: 'strat.setup.on_hit_share', label: 'Hits you were on the site for', unit: '%', better: 'higher', area: 'strategy', minN: 3,
  compute(ctx, slot) {
    const hits = sideRounds(ctx, slot, 'CT').filter((r) => r.hit.site !== null && r.setup.onHitSiteAtEntry !== null);
    if (hits.length === 0) return null;
    return { value: hits.filter((r) => r.setup.hitSiteDefenders.includes(slot)).length / hits.length, n: hits.length };
  },
};

/** As CT site player: share of rounds with an early rotation that was punished, or a stay after the other site's call. */
const rotateMistakes: MetricDef = {
  id: 'strat.rotate.mistake_share', label: 'Rotation mistakes', unit: '%', better: 'lower', area: 'strategy', minN: 3,
  compute(ctx, slot) {
    const rows = ctx.table(STRAT_ROTATIONS).filter((r) => r.slot === slot);
    if (rows.length === 0) return null;
    return { value: rows.filter((r) => r.punished || r.stayed).length / rows.length, n: rows.length };
  },
};

/** As T: share of the team's site hits where he was first or second in. */
const entryShare: MetricDef = {
  id: 'strat.t_side.entry_share', label: 'Hits you entered first or second', unit: '%', better: 'higher', area: 'strategy', minN: 3,
  compute(ctx, slot) {
    const hits = sideRounds(ctx, slot, 'T').filter((r) => r.hit.site !== null);
    if (hits.length === 0) return null;
    return { value: hits.filter((r) => r.hit.roles[slot] === 'entry' || r.hit.roles[slot] === 'second').length / hits.length, n: hits.length };
  },
};

/** As T: share of the team's site hits where one of his grenades landed on the site or its lanes before the entry. */
const utilShare: MetricDef = {
  id: 'strat.t_side.util_share', label: 'Hits you threw utility for', unit: '%', better: 'higher', area: 'strategy', minN: 3,
  compute(ctx, slot) {
    const hits = sideRounds(ctx, slot, 'T').filter((r) => r.hit.site !== null);
    if (hits.length === 0) return null;
    return { value: hits.filter((r) => r.hit.util.throws.some((id) => ctx.table(THROWS)[id]?.thrower === slot)).length / hits.length, n: hits.length };
  },
};

export const STRATEGY_METRICS: readonly MetricDef[] = [contestShare, onHitShare, rotateMistakes, entryShare, utilShare];
