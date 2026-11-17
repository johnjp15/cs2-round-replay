/**
 * Rank strip: the lobby's values of one metric as dots on its axis, better always to the right. The user in the
 * accent colour with a ring, the lobby median as a tick, tied values stacked on one spot (and counted), players without
 * enough samples left out (counted under the strip). Hover a dot for the player and value.
 */
import type { MetricValue } from '../../coach/model/report';
import { lobbyRankInfo, metricValue, rankPhrase } from '../../coach/report/format';

export interface RankStripProps {
  mv: MetricValue;
  user: number;
  /** Display name per slot. */
  names: readonly string[];
  /** Side class per slot for the dot colour (`t`, `ct` or ''): the user's teammates and opponents. */
  sides?: readonly string[];
  width?: number;
}

/** Rank direction: from the metric, else inferred from the user's rank. */
export function betterOf(mv: MetricValue): 'higher' | 'lower' {
  if (mv.better) return mv.better;
  const higher = mv.lobby.filter((v) => Number.isFinite(v) && v > mv.value).length + 1;
  return higher === mv.lobbyRank ? 'higher' : 'lower';
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] ?? NaN) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
}

export function RankStrip(props: RankStripProps) {
  const { mv } = props;
  const W = props.width ?? 280;
  const pad = 10;
  const dotR = 4.5;
  const pts = mv.lobby.map((v, slot) => ({ v, slot })).filter((d) => Number.isFinite(d.v));
  const missing = mv.lobby.length - pts.length;
  if (pts.length === 0) return null;
  const lo = Math.min(...pts.map((d) => d.v));
  const hi = Math.max(...pts.map((d) => d.v));
  const flip = betterOf(mv) === 'lower';
  const span = hi - lo || 1;
  const xOf = (v: number): number => {
    const f = hi === lo ? 0.5 : (v - lo) / span;
    return pad + (flip ? 1 - f : f) * (W - 2 * pad);
  };
  // Stack tied values: same value → same x, one above the other.
  const groups = new Map<number, number[]>();
  for (const d of [...pts].sort((a, b) => a.slot - b.slot)) groups.set(d.v, [...(groups.get(d.v) ?? []), d.slot]);
  const maxStack = Math.max(...[...groups.values()].map((g) => g.length));
  const rowH = 9;
  const H = 16 + Math.max(1, maxStack) * rowH + 14;
  const base = H - 16;
  const med = median(pts.map((d) => d.v));
  const info = lobbyRankInfo(mv);
  const userTied = info !== null && info.tied > 1;
  const label = `${mv.label ?? mv.id}: you ${metricValue(mv.value, mv.unit)}, ${rankPhrase(info)}; lobby median ${metricValue(med, mv.unit)}`;
  return (
    <figure class="rank-strip" data-testid="rank-strip" data-tied={userTied ? String(info?.tied) : '1'}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={label}>
        <line x1={pad} x2={W - pad} y1={base} y2={base} class="rs-axis" />
        {Number.isFinite(med) && (
          <g class="rs-median">
            <line x1={xOf(med)} x2={xOf(med)} y1={base - maxStack * rowH - 4} y2={base + 4} />
            <text x={xOf(med)} y={H - 2} text-anchor="middle">median</text>
          </g>
        )}
        <text x={pad} y={H - 2} class="rs-end">worse</text>
        <text x={W - pad} y={H - 2} class="rs-end" text-anchor="end">better</text>
        {[...groups.entries()].map(([v, slots]) => {
          // The user's dot sits at the bottom of its stack.
          const ordered = [...slots].sort((a, b) => (a === props.user ? -1 : b === props.user ? 1 : a - b));
          return ordered.map((slot, k) => {
            const me = slot === props.user;
            const cx = xOf(v);
            const cy = base - dotR - 2 - k * rowH;
            return (
              <g key={slot} class={`rs-dot ${me ? 'me' : props.sides?.[slot] ?? ''}`} data-slot={slot}>
                <title>{`${props.names[slot] ?? `#${slot}`}: ${metricValue(v, mv.unit)}${slots.length > 1 ? ` (tied, ${slots.length} players)` : ''}`}</title>
                <circle cx={cx} cy={cy} r={me ? dotR + 1.5 : dotR} />
              </g>
            );
          });
        })}
      </svg>
      <figcaption class="rs-cap">
        {rankPhrase(info) || 'unranked'}
        {missing > 0 ? ` · ${missing} without enough samples` : ''}
      </figcaption>
    </figure>
  );
}
