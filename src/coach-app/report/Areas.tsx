/**
 * Skill areas: per area every metric (label, value, n, rank strip), every finding (fixes, strengths, observations;
 * those already among the top fixes marked) and the charts of `MatchReport.charts` whose area it is. An area with
 * metric values or findings is "analyzed": without findings it says "nothing to flag"; an area nothing measured says
 * "not analyzed".
 */
import type { FindingArea, MatchReport, MetricValue } from '../../coach/model/report';
import { metricValue } from '../../coach/report/format';
import { Chart, type LinkHref } from '../charts/Charts';
import { FindingRow, type CardContext } from './Cards';
import { RankStrip } from './RankStrip';

export const AREAS: { id: FindingArea; label: string }[] = [
  { id: 'aim', label: 'Aim' }, { id: 'movement', label: 'Movement' }, { id: 'utility', label: 'Utility' },
  { id: 'positioning', label: 'Positioning' }, { id: 'trading', label: 'Trades' }, { id: 'decisions', label: 'Decisions' },
  { id: 'economy', label: 'Economy' }, { id: 'strategy', label: 'Strategy' },
];

const PREFIX: Record<string, FindingArea> = { aim: 'aim', move: 'movement', util: 'utility', pos: 'positioning', trade: 'trading', dec: 'decisions', eco: 'economy', strat: 'strategy', sense: 'decisions' };

export function metricArea(m: MetricValue): FindingArea | null {
  return m.area ?? PREFIX[m.id.split('.')[0] ?? ''] ?? null;
}

function MetricRow(props: { ctx: CardContext; m: MetricValue }) {
  const { m } = props;
  return (
    <li class="metric-row" data-testid="metric-row" data-id={m.id}>
      <div class="mr-text">
        <span class="mr-label">{m.label ?? m.id}</span>
        <span class="mr-val"><b>{metricValue(m.value, m.unit)}</b> <span class="dim">n {m.n}</span></span>
      </div>
      <RankStrip mv={m} user={props.ctx.report.user} names={props.ctx.names} sides={props.ctx.sides} width={240} />
    </li>
  );
}

export function SkillAreas(props: { ctx: CardContext; report: MatchReport; topFixes: string[]; href: LinkHref }) {
  const { report } = props;
  const charts = report.charts ?? {};
  return (
    <section class="areas" aria-labelledby="areas-h" data-testid="areas">
      <h2 id="areas-h">Skill areas</h2>
      {AREAS.map((a) => {
        const metrics = report.metrics.filter((m) => metricArea(m) === a.id);
        const measured = metrics.filter((m) => m.lobby.some((v) => Number.isFinite(v)));
        const fi = report.findings.map((f, i) => (f.area === a.id ? i : -1)).filter((i) => i >= 0);
        const chartIds = Object.keys(charts).filter((k) => charts[k]?.area === a.id).sort();
        const analyzed = measured.length > 0 || fi.length > 0 || chartIds.length > 0;
        const status = !analyzed ? 'not analyzed' : fi.length === 0 ? 'nothing to flag' : `${fi.length} finding${fi.length > 1 ? 's' : ''}`;
        return (
          <details key={a.id} class={`area ${analyzed ? '' : 'na'}`} open={fi.length > 0 || chartIds.length > 0} data-testid="area" data-area={a.id}>
            <summary><span class="area-name">{a.label}</span><span class="area-n" data-testid="area-status">{status}</span></summary>
            {fi.length > 0 && <div class="area-findings">{fi.map((i) => { const f = report.findings[i]; return f ? <FindingRow key={f.id} ctx={props.ctx} f={f} fi={i} top={props.topFixes.includes(f.id)} /> : null; })}</div>}
            {chartIds.length > 0 && <div class="area-charts">{chartIds.map((k) => { const c = charts[k]; return c ? <Chart key={k} id={k} c={c} report={report} href={props.href} /> : null; })}</div>}
            {measured.length > 0 && <ul class="metric-list">{measured.map((m) => <MetricRow key={m.id} ctx={props.ctx} m={m} />)}</ul>}
          </details>
        );
      })}
    </section>
  );
}
