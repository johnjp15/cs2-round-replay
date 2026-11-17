/**
 * Spray plot, bullet by bullet, from `Evidence.series`: left, where each bullet's recoil-compensated aim went relative
 * to the target's chest (the body outline at that distance; filled = hit, ring = crossed the body, hollow = miss;
 * numbered); right, your crosshair's pull against the ideal pull that would have put every bullet on the chest.
 */
import type { Evidence, EvidenceSeries } from '../../coach/model/report';
import { finiteRange, fmt, linePath, scale } from './svg';

function find(ev: Evidence, name: string): EvidenceSeries | undefined {
  return ev.series?.find((s) => s.name === name);
}

const S = 250;

export function SprayPlot(props: { ev: Evidence }) {
  const { ev } = props;
  const ax = find(ev, 'aim_x');
  const ay = find(ev, 'aim_y');
  if (!ax || !ay) return <p class="dim" data-testid="spray-plot">No spray data in this report (re-analyze the demo).</p>;
  const vx = find(ev, 'view_x');
  const vy = find(ev, 'view_y');
  const ix = find(ev, 'ideal_x');
  const iy = find(ev, 'ideal_y');
  const dist = find(ev, 'distance');
  const d = (dist?.values[0] ?? 1000) || 1000;
  // Body outline (28 × 63 units around the chest at 48.5 of 71) in degrees at the spray's distance.
  const deg = (u: number): number => (Math.atan(u / d) * 180) / Math.PI;
  const body = { x0: -deg(14), x1: deg(14), y0: -deg(40.5), y1: deg(22.5) };
  const [lo1, hi1] = finiteRange(ax.values, ay.values, [body.x0, body.y0, body.x1, body.y1]);
  const m1 = Math.max(Math.abs(lo1), Math.abs(hi1), 1) * 1.15;
  const s1x = scale(-m1, m1, 10, S - 10);
  const s1y = scale(-m1, m1, S - 10, 10);
  const marks = ax.marks ?? [];
  const pull = vx && vy && ix && iy;
  const [lo2, hi2] = pull ? finiteRange(vx.values, vy.values, ix.values, iy.values, [0]) : [0, 1];
  const m2 = Math.max(Math.abs(lo2), Math.abs(hi2), 1) * 1.1;
  const s2x = scale(-m2, m2, 10, S - 10);
  const s2y = scale(-m2, m2, S - 10, 10);
  const ring = (r: number) => <circle class="sp-ring" cx={s1x(0)} cy={s1y(0)} r={Math.abs(s1x(r) - s1x(0))} />;
  return (
    <figure class="viewer spray-plot" data-testid="spray-plot">
      <div class="sp-panels">
        <svg viewBox={`0 0 ${S} ${S}`} role="img" aria-label="Where each bullet's compensated aim went relative to the target">
          <line class="sp-axis" x1={s1x(0)} x2={s1x(0)} y1={6} y2={S - 6} />
          <line class="sp-axis" y1={s1y(0)} y2={s1y(0)} x1={6} x2={S - 6} />
          {[1, 3].filter((r) => r < m1).map((r) => <g key={r}>{ring(r)}<text class="sp-lbl" x={s1x(r) + 2} y={s1y(0) - 2}>{r}°</text></g>)}
          <rect class="sp-body" x={s1x(body.x0)} y={s1y(body.y1)} width={s1x(body.x1) - s1x(body.x0)} height={s1y(body.y0) - s1y(body.y1)} rx={3} />
          <path class="sp-trail" d={linePath(ax.values, ay.values, s1x, s1y)} />
          {ax.values.map((x, i) => {
            const y = ay.values[i] ?? NaN;
            if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
            const n = ax.x[i] ?? i + 1;
            return (
              <g key={i} class={`sp-b ${marks[i] ?? 'miss'}`}>
                <title>{`bullet ${n}: ${fmt(Math.abs(x), 1)}° ${x >= 0 ? 'right' : 'left'}, ${fmt(Math.abs(y), 1)}° ${y >= 0 ? 'high' : 'low'}${marks[i] === 'hit' ? ', hit' : marks[i] === 'on' ? ', on the body' : ''}`}</title>
                <circle cx={s1x(x)} cy={s1y(y)} r={5} />
                <text x={s1x(x) + 7} y={s1y(y) + 3}>{n}</text>
              </g>
            );
          })}
          <text class="sp-title" x={8} y={16}>Where the bullets went</text>
        </svg>
        {pull && (
          <svg viewBox={`0 0 ${S} ${S}`} role="img" aria-label="Your crosshair's pull against the ideal pull">
            <line class="sp-axis" x1={s2x(0)} x2={s2x(0)} y1={6} y2={S - 6} />
            <line class="sp-axis" y1={s2y(0)} y2={s2y(0)} x1={6} x2={S - 6} />
            <path class="sp-ideal" d={linePath(ix.values, iy.values, s2x, s2y)} />
            <path class="sp-view" d={linePath(vx.values, vy.values, s2x, s2y)} />
            {vx.values.map((x, i) => (Number.isFinite(x) && Number.isFinite(vy.values[i] ?? NaN)
              ? <circle key={i} class="sp-vdot" cx={s2x(x)} cy={s2y(vy.values[i] ?? 0)} r={3}><title>{`bullet ${ax.x[i] ?? i + 1}: crosshair ${fmt(x, 1)}°, ${fmt(vy.values[i] ?? 0, 1)}° · ideal ${fmt(ix.values[i] ?? NaN, 1)}°, ${fmt(iy.values[i] ?? NaN, 1)}°`}</title></circle>
              : null))}
            <text class="sp-title" x={8} y={16}>Your pull against the ideal</text>
          </svg>
        )}
      </div>
      <figcaption class="viewer-cap">
        Degrees from the target's chest at {fmt(d)} units · <span class="lg hit">●</span> hit <span class="lg on">◉</span> on the body <span class="lg miss">○</span> miss
        {pull && <> · <span class="lg view">—</span> your crosshair <span class="lg ideal">—</span> {ix.label.replace(/^Ideal crosshair/, 'ideal')}</>}
      </figcaption>
    </figure>
  );
}
