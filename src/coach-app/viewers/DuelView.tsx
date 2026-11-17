/**
 * Duel view: one fight on a time axis (ms from the evidence's focus, usually the first bullet), from
 * `Evidence.series` (src/coach/report/evidence-series.ts): your speed against the weapon's accurate-speed line, crouch
 * as a band, the angle from your crosshair to the target's head, and per bullet the game's inaccuracy against the same
 * shot standing; shots marked hit (filled) or miss (hollow) on every panel.
 */
import type { Evidence, EvidenceSeries } from '../../coach/model/report';
import { finiteRange, fmt, linePath, scale, ticks } from './svg';

const W = 560;
const L = 44;
const R = 12;

function find(ev: Evidence, name: string): EvidenceSeries | undefined {
  return ev.series?.find((s) => s.name === name);
}

export function DuelView(props: { ev: Evidence; tickRate: number }) {
  const { ev } = props;
  const speed = find(ev, 'speed');
  if (!speed) return <p class="dim" data-testid="duel-view">No duel data in this report (re-analyze the demo).</p>;
  const angle = find(ev, 'angle');
  const duck = find(ev, 'duck');
  const inacc = find(ev, 'inaccuracy');
  const standing = find(ev, 'standing');
  const shots = find(ev, 'shots');
  const rate = props.tickRate || 64;
  const msOf = (t: number): number => ((t - ev.focus) * 1000) / rate;
  const t0 = msOf(speed.x[0] ?? ev.tick0);
  const t1 = msOf(speed.x[speed.x.length - 1] ?? ev.tick1);
  const sx = scale(t0, t1, L, W - R);
  const shotMs = (shots?.x ?? []).map(msOf);
  const hits = shots?.marks ?? [];

  const panels: { key: string; h: number; body: (y0: number, h: number) => preact.JSX.Element }[] = [];
  panels.push({
    key: 'speed', h: 92, body: (y0, h) => {
      const top = Math.max(250, finiteRange(speed.values)[1]);
      const sy = scale(0, top, y0 + h, y0 + 16);
      const ref = speed.ref;
      return (
        <g>
          {duck && duck.x.map((t, i) => (duck.values[i] ?? 0) > 0.5 ? <rect key={i} class="dv-duck" x={sx(msOf(t))} width={Math.max(1, sx(msOf(t + 1)) - sx(msOf(t)))} y={y0} height={h} /> : null)}
          {ticks(0, top, 3).map((v) => <g key={v} class="dv-grid"><line x1={L} x2={W - R} y1={sy(v)} y2={sy(v)} /><text x={L - 4} y={sy(v) + 3} text-anchor="end">{fmt(v)}</text></g>)}
          {ref && <g class="dv-ref"><line x1={L} x2={W - R} y1={sy(ref.value)} y2={sy(ref.value)} /><text x={W - R} y={sy(ref.value) - 3} text-anchor="end">{ref.label} {fmt(ref.value)} u/s</text></g>}
          <path class="dv-line" d={linePath(speed.x.map(msOf), speed.values, sx, sy)} />
          <text class="dv-title" x={L} y={y0 + 10}>Speed (u/s){duck ? ' · shaded: crouched' : ''}</text>
        </g>
      );
    },
  });
  if (angle) {
    panels.push({
      key: 'angle', h: 72, body: (y0, h) => {
        const top = Math.max(2, Math.min(30, finiteRange(angle.values)[1]));
        const sy = scale(0, top, y0 + h, y0 + 16);
        return (
          <g>
            {ticks(0, top, 2).map((v) => <g key={v} class="dv-grid"><line x1={L} x2={W - R} y1={sy(v)} y2={sy(v)} /><text x={L - 4} y={sy(v) + 3} text-anchor="end">{fmt(v)}°</text></g>)}
            <path class="dv-line angle" d={linePath(angle.x.map(msOf), angle.values.map((v) => Math.min(v, top)), sx, sy)} />
            <text class="dv-title" x={L} y={y0 + 10}>Crosshair to the target's head</text>
          </g>
        );
      },
    });
  }
  if (inacc) {
    panels.push({
      key: 'inacc', h: 72, body: (y0, h) => {
        const top = finiteRange(inacc.values, standing?.values ?? [])[1] * 1.1 || 1;
        const sy = scale(0, top, y0 + h, y0 + 16);
        return (
          <g>
            {ticks(0, top, 2).map((v) => <g key={v} class="dv-grid"><line x1={L} x2={W - R} y1={sy(v)} y2={sy(v)} /><text x={L - 4} y={sy(v) + 3} text-anchor="end">{fmt(v)}</text></g>)}
            {inacc.x.map((t, i) => {
              const x = sx(msOf(t));
              const v = inacc.values[i] ?? 0;
              const s = standing?.values[i] ?? NaN;
              return (
                <g key={i}>
                  <title>{`bullet at ${fmt(msOf(t))} ms: inaccuracy ${fmt(v, 1)} mrad${Number.isFinite(s) ? `, standing ${fmt(s, 1)}` : ''}`}</title>
                  <line class="dv-bar" x1={x} x2={x} y1={sy(0)} y2={sy(v)} />
                  {Number.isFinite(s) && <line class="dv-standing" x1={x - 4} x2={x + 4} y1={sy(s)} y2={sy(s)} />}
                </g>
              );
            })}
            <text class="dv-title" x={L} y={y0 + 10}>Inaccuracy per bullet (mrad) · tick: the same shot standing</text>
          </g>
        );
      },
    });
  }
  let y = 4;
  const laid = panels.map((p) => { const at = y; y += p.h + 10; return { ...p, at }; });
  const H = y + 18;
  return (
    <figure class="viewer duel-view" data-testid="duel-view">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Duel view: ${ev.caption}`}>
        {laid.map((p) => <g key={p.key}>{p.body(p.at, p.h)}</g>)}
        {shotMs.map((m, i) => (
          <g key={i} class={`dv-shot ${hits[i] === 'hit' ? 'hit' : 'miss'}`}>
            <line x1={sx(m)} x2={sx(m)} y1={4} y2={H - 18} />
            <circle cx={sx(m)} cy={H - 12} r={4} />
          </g>
        ))}
        {ticks(t0, t1, 6).map((v) => <text key={v} class="dv-axis" x={sx(v)} y={H - 1} text-anchor="middle">{v === 0 ? '0' : `${v > 0 ? '+' : ''}${fmt(v)}`}</text>)}
      </svg>
      <figcaption class="viewer-cap">ms from the moment · <span class="lg hit">●</span> hit <span class="lg miss">○</span> miss</figcaption>
    </figure>
  );
}
