/** K6: `pos.death_context` metrics, every slot: the share of his deaths by an enemy that carry each label (docs/coach/sight.md). */
import type { AnalysisContext } from '../../analyze/context';
import { DEATH_CONTEXT, DEATH_LABELS, type DeathContext, type DeathLabel } from '../../derive/sight/death-context';
import type { MetricDef } from '../types';

/** The slot's labelled deaths (empty without a sight mesh). */
export function deathContexts(ctx: AnalysisContext, slot: number): DeathContext[] {
  const t = ctx.table(DEATH_CONTEXT);
  return t.available ? t.rows.filter((r) => r.death.victim === slot) : [];
}

const LABEL_TEXT: Readonly<Record<DeathLabel, string>> = {
  unseen: 'Deaths to a killer you had not seen in the 3 s before (side or behind)',
  crossfire: 'Deaths with two or more enemies seeing you',
  repeek: 'Deaths within seconds of re-peeking the angle you had just fought',
  objective: 'Deaths while planting or defusing',
  open: 'Deaths in the open: the killer saw you for the whole approach',
};

export const DEATH_CONTEXT_METRICS: readonly MetricDef[] = DEATH_LABELS.map((l): MetricDef => ({
  id: `pos.death_context.${l}_share`, label: LABEL_TEXT[l], unit: '%', better: 'lower', area: 'positioning', minN: 2,
  compute(ctx, slot) {
    const d = deathContexts(ctx, slot);
    return d.length === 0 ? null : { value: d.filter((x) => x.labels.includes(l)).length / d.length, n: d.length };
  },
}));
