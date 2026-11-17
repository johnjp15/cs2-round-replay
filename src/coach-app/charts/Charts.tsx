/**
 * Renderers for `MatchReport.charts` (docs/coach/contracts.md "Charts"): scatter, bars, series and round boards, one
 * small set of marks drawn in SVG. A mark with a `link` opens that finding's evidence (the same deep link as Watch).
 * K6 fills `aim.placement` (a scatter), K8 the strategy boards.
 */
import { useEffect, useState } from 'preact/hooks';
import type { ChartCategory, ChartLink, ChartPayload, ColorRole, MatchReport } from '../../coach/model/report';
import { loadMap, toRadar, type MapView } from '../maps';
import { finiteRange, fmt, linePath, scale, ticks } from '../viewers/svg';

/** Href of a chart link (null when the finding or evidence is not in the report). */
export type LinkHref = (link: ChartLink) => string | null;

const roleClass = (r: ColorRole | undefined): string => `role-${r ?? 'neutral'}`;

function Legend(props: { cats: readonly ChartCategory[] }) {
  if (props.cats.length < 2) return null;
  return (
    <ul class="ch-legend">
      {props.cats.map((c) => <li key={c.key}><i class={`sw ${roleClass(c.role)}`} />{c.label}</li>)}
    </ul>
  );
}

function Linked(props: { href: string | null; children: preact.ComponentChildren }) {
  return props.href ? <a href={props.href} class="ch-link">{props.children}</a> : <>{props.children}</>;
}

const W = 420;
const H = 260;
const M = { l: 44, r: 12, t: 12, b: 32 };

function Scatter(props: { c: Extract<ChartPayload, { kind: 'scatter' }>; href: LinkHref }) {
  const { c } = props;
  const [x0, x1] = [c.x.min, c.x.max];
  const [dx0, dx1] = finiteRange(c.points.map((p) => p.x), c.rings ? c.rings.flatMap((r) => [r, -r]) : []);
  const [dy0, dy1] = finiteRange(c.points.map((p) => p.y), c.rings ? c.rings.flatMap((r) => [r, -r]) : []);
  const sx = scale(x0 ?? dx0, x1 ?? dx1, M.l, W - M.r);
  const sy = scale(c.y.min ?? dy0, c.y.max ?? dy1, H - M.b, M.t);
  const cat = new Map(c.categories.map((k) => [k.key, k]));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={c.title}>
      {ticks(sx.d0, sx.d1, 4).map((v) => <g key={`x${v}`} class="ch-grid"><line x1={sx(v)} x2={sx(v)} y1={M.t} y2={H - M.b} /><text x={sx(v)} y={H - M.b + 14} text-anchor="middle">{fmt(v, Math.abs(v) < 10 && v % 1 ? 1 : 0)}</text></g>)}
      {ticks(sy.d0, sy.d1, 4).map((v) => <g key={`y${v}`} class="ch-grid"><line x1={M.l} x2={W - M.r} y1={sy(v)} y2={sy(v)} /><text x={M.l - 4} y={sy(v) + 3} text-anchor="end">{fmt(v, Math.abs(v) < 10 && v % 1 ? 1 : 0)}</text></g>)}
      {(c.rings ?? []).map((r) => <ellipse key={r} class="ch-ring" cx={sx(0)} cy={sy(0)} rx={Math.abs(sx(r) - sx(0))} ry={Math.abs(sy(r) - sy(0))} />)}
      {c.points.map((p, i) => {
        const k = cat.get(p.cat);
        return (
          <Linked key={i} href={p.link ? props.href(p.link) : null}>
            <circle class={`ch-dot ${roleClass(k?.role)}`} cx={sx(p.x)} cy={sy(p.y)} r={4.5}><title>{`${p.label ?? ''}${p.label ? ': ' : ''}${fmt(p.x, 1)} ${c.x.unit}, ${fmt(p.y, 1)} ${c.y.unit}${k ? ` (${k.label})` : ''}`}</title></circle>
          </Linked>
        );
      })}
      <text class="ch-axis" x={W - M.r} y={H - 2} text-anchor="end">{c.x.label} ({c.x.unit})</text>
      <text class="ch-axis" x={4} y={M.t - 2}>{c.y.label} ({c.y.unit})</text>
    </svg>
  );
}

function Bars(props: { c: Extract<ChartPayload, { kind: 'bars' }> }) {
  const { c } = props;
  const bh = 16;
  const gap = 8;
  const lw = 120;
  const h = c.bars.length * (bh + gap) + 20;
  const [lo, hi] = finiteRange(c.bars.map((b) => b.value), [0, c.ref?.value ?? 0]);
  const sx = scale(Math.min(0, lo), hi || 1, lw, W - 56);
  const cat = new Map((c.categories ?? []).map((k) => [k.key, k]));
  return (
    <svg viewBox={`0 0 ${W} ${h}`} width="100%" role="img" aria-label={c.title}>
      {c.bars.map((b, i) => {
        const y = 4 + i * (bh + gap);
        const x0 = sx(0);
        const x1 = sx(b.value);
        return (
          <g key={i} class={`ch-bar ${b.user ? 'me' : roleClass(b.cat ? cat.get(b.cat)?.role : undefined)}`}>
            <title>{`${b.label}: ${fmt(b.value, 1)} ${c.unit}${b.n !== undefined ? ` (n ${b.n})` : ''}`}</title>
            <text class="ch-lbl" x={lw - 6} y={y + bh - 4} text-anchor="end">{b.label}</text>
            <rect x={Math.min(x0, x1)} y={y} width={Math.max(1, Math.abs(x1 - x0))} height={bh} rx={3} />
            <text class="ch-val" x={Math.max(x0, x1) + 4} y={y + bh - 4}>{fmt(b.value, Math.abs(b.value) < 10 && b.value % 1 ? 1 : 0)}{b.n !== undefined ? ` · n ${b.n}` : ''}</text>
          </g>
        );
      })}
      {c.ref && <g class="ch-ref"><line x1={sx(c.ref.value)} x2={sx(c.ref.value)} y1={0} y2={h - 16} /><text x={sx(c.ref.value)} y={h - 4} text-anchor="middle">{c.ref.label}</text></g>}
    </svg>
  );
}

function Series(props: { c: Extract<ChartPayload, { kind: 'series' }> }) {
  const { c } = props;
  const [x0, x1] = finiteRange(...c.series.map((s) => s.x));
  const [y0, y1] = finiteRange(...c.series.map((s) => s.y));
  const sx = scale(c.x.min ?? x0, c.x.max ?? x1, M.l, W - M.r);
  const sy = scale(c.y.min ?? Math.min(0, y0), c.y.max ?? y1, H - M.b, M.t);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={c.title}>
      {ticks(sy.d0, sy.d1, 4).map((v) => <g key={v} class="ch-grid"><line x1={M.l} x2={W - M.r} y1={sy(v)} y2={sy(v)} /><text x={M.l - 4} y={sy(v) + 3} text-anchor="end">{fmt(v, v % 1 ? 1 : 0)}</text></g>)}
      {ticks(sx.d0, sx.d1, 5).map((v) => <text key={v} class="ch-grid" x={sx(v)} y={H - M.b + 14} text-anchor="middle">{fmt(v, v % 1 ? 1 : 0)}</text>)}
      {c.series.map((s) => <path key={s.name} class={`ch-line ${roleClass(s.role)}`} d={linePath(s.x, s.y, sx, sy)}><title>{s.label}</title></path>)}
      <text class="ch-axis" x={W - M.r} y={H - 2} text-anchor="end">{c.x.label} ({c.x.unit})</text>
      <text class="ch-axis" x={4} y={M.t - 2}>{c.y.label} ({c.y.unit})</text>
    </svg>
  );
}

function Boards(props: { c: Extract<ChartPayload, { kind: 'boards' }>; map: string; href: LinkHref }) {
  const [mv, setMv] = useState<MapView | null>(null);
  useEffect(() => { let live = true; void loadMap(props.map).then((m) => { if (live) setMv(m); }); return () => { live = false; }; }, [props.map]);
  const v = mv?.view ?? { x: 0, y: 0, size: 1024 };
  const pt = (x: number, y: number): [number, number] => (mv ? toRadar(mv.radar, x, y) : [x, y]);
  return (
    <div class="ch-boards">
      {props.c.boards.map((b) => {
        const body = (
          <figure class={`ch-board ${b.highlight ? 'hl' : ''}`} data-testid="board">
            <svg viewBox={`${v.x} ${v.y} ${v.size} ${v.size}`} role="img" aria-label={`Round ${b.round}: ${b.caption}`}>
              {mv?.upper && <image href={mv.upper.src} x={0} y={0} width={mv.radar.width} height={mv.radar.height} opacity={0.55} />}
              {b.zones.map((z, i) => <polygon key={i} class={`ch-zone ${roleClass(z.role)}`} points={z.polygon.map(([x, y]) => pt(x, y).join(',')).join(' ')}><title>{z.label ?? ''}</title></polygon>)}
              {b.dots.map((d, i) => {
                const [x, y] = pt(d.x, d.y);
                const r = v.size / 60;
                return (
                  <g key={i} class={`ch-bdot ${roleClass(d.role)}`}>
                    <title>{d.label ?? ''}</title>
                    {d.shape === 'cross'
                      ? <path d={`M${x - r},${y - r}L${x + r},${y + r}M${x - r},${y + r}L${x + r},${y - r}`} stroke-width={r / 2} />
                      : <circle cx={x} cy={y} r={r} class={d.shape === 'ring' ? 'ring' : ''} stroke-width={r / 2.5} />}
                  </g>
                );
              })}
            </svg>
            <figcaption><b>R{b.round}</b> {b.caption}</figcaption>
          </figure>
        );
        const href = b.link ? props.href(b.link) : null;
        return <Linked key={b.round} href={href}>{body}</Linked>;
      })}
    </div>
  );
}

/** One chart payload with its title, caption and legend. */
export function Chart(props: { id: string; c: ChartPayload; report: MatchReport; href: LinkHref }) {
  const { c } = props;
  const cats = c.kind === 'scatter' ? c.categories : c.kind === 'bars' ? (c.categories ?? []) : c.kind === 'boards' ? (c.legend ?? []) : c.series.map((s) => ({ key: s.name, label: s.label, role: s.role }));
  return (
    <figure class={`chart chart-${c.kind}`} data-testid="chart" data-chart={props.id} data-kind={c.kind}>
      <h4>{c.title}</h4>
      {c.kind === 'scatter' && <Scatter c={c} href={props.href} />}
      {c.kind === 'bars' && <Bars c={c} />}
      {c.kind === 'series' && <Series c={c} />}
      {c.kind === 'boards' && <Boards c={c} map={props.report.match.meta.map} href={props.href} />}
      <Legend cats={cats} />
      {c.caption && <figcaption class="dim">{c.caption}</figcaption>}
    </figure>
  );
}
