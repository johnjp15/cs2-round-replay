/**
 * Minimal debug renderer on one canvas: the radar image, each pawn as a team-coloured dot with a
 * facing line and its name, dead pawns as an X, and a HUD with the round clock and tick counter.
 * D2 replaces this with the full renderer; the transforms it needs are in radar.ts.
 *
 * The canvas fills its CSS box; resize() matches the backing store to the box × devicePixelRatio and
 * fits the 1024 × 1024 radar inside it (contain, centred).
 */
import type { MapTransform, Observe, PlayerId } from '../contracts/index';
import { fitView, worldToScreen, yawToScreenDir, type View } from './radar';

export interface DebugFrame {
  readonly observe: Observe;
  /** RoundClock.hudClock(tick). */
  readonly clock: string;
  /** The pawn the human plays, or null when spectating. */
  readonly human: PlayerId | null;
  /** Short state label: ready / running / paused. */
  readonly phase: string;
  readonly speed: number;
  readonly fps: number;
  readonly tps: number;
}

const COLORS = {
  background: '#0d1117',
  T: '#f0b43c',
  CT: '#5ab0ff',
  dead: 'rgba(230, 237, 243, 0.55)',
  text: '#e6edf3',
  outline: 'rgba(0, 0, 0, 0.85)',
  hudBox: 'rgba(13, 17, 23, 0.72)',
  human: '#ffffff',
} as const;

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

/** Minimum radar margin (CSS px) so names at the edge stay readable. */
const MARGIN = 4;

export class DebugRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly radar: CanvasImageSource | null;
  private readonly map: MapTransform;
  private viewValue: View;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement, radar: CanvasImageSource | null, map: MapTransform) {
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('DebugRenderer: no 2D context');
    this.canvas = canvas;
    this.ctx = ctx;
    this.radar = radar;
    this.map = map;
    this.viewValue = fitView(map, 0, 0);
    this.resize();
  }

  /** Where the radar is on the canvas (CSS px); input.ts maps the mouse through it. */
  get view(): View {
    return this.viewValue;
  }

  /** Match the backing store to the canvas's CSS size and the device pixel ratio; refit the radar. */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (w === this.cssW && h === this.cssH && dpr === this.dpr) return;
    this.cssW = w;
    this.cssH = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.viewValue = fitView(this.map, w, h, MARGIN);
  }

  draw(f: DebugFrame): void {
    const { ctx } = this;
    const v = this.viewValue;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    if (this.radar !== null && v.side > 0) ctx.drawImage(this.radar, v.ox, v.oy, v.side, v.side);

    const r = clamp(v.side / 150, 3, 7);
    const font = Math.round(clamp(v.side / 70, 9, 13));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // Dead first, so the living are drawn on top.
    const pawns = [...f.observe.pawns].sort((a, b) => Number(a.alive) - Number(b.alive));
    for (const p of pawns) {
      const s = worldToScreen(v, p.pos);
      const color = COLORS[p.team];
      if (!p.alive) {
        ctx.strokeStyle = COLORS.outline;
        ctx.lineWidth = 4;
        cross(ctx, s.x, s.y, r);
        ctx.strokeStyle = COLORS.dead;
        ctx.lineWidth = 2;
        cross(ctx, s.x, s.y, r);
      } else {
        const d = yawToScreenDir(p.yaw);
        const len = r * 3;
        ctx.strokeStyle = COLORS.outline;
        ctx.lineWidth = 4;
        line(ctx, s.x, s.y, s.x + d.x * len, s.y + d.y * len);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        line(ctx, s.x, s.y, s.x + d.x * len, s.y + d.y * len);
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = COLORS.outline;
        ctx.stroke();
        if (p.id === f.human) {
          ctx.beginPath();
          ctx.arc(s.x, s.y, r + 3, 0, Math.PI * 2);
          ctx.strokeStyle = COLORS.human;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
      label(ctx, p.id, s.x, s.y - r - 3, font, p.alive ? COLORS.text : COLORS.dead);
    }
    this.drawHud(f, font);
  }

  private drawHud(f: DebugFrame, font: number): void {
    const { ctx } = this;
    const big = Math.round(font * 2);
    const pad = 8;
    const lines = [
      `tick ${f.observe.tick} · ${formatSpeed(f.speed)} · ${f.phase}`,
      f.human === null ? 'spectating' : `you: ${f.human}`,
      `${Math.round(f.fps)} fps · ${Math.round(f.tps)} ticks/s`,
    ];
    ctx.font = `600 ${font}px ${FONT}`;
    const width = Math.max(big * 2.6, ...lines.map((l) => ctx.measureText(l).width)) + pad * 2;
    const height = pad * 2 + big + lines.length * (font + 4);
    ctx.fillStyle = COLORS.hudBox;
    ctx.fillRect(pad, pad, width, height);
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = `700 ${big}px ${FONT}`;
    ctx.fillText(f.clock, pad * 2, pad * 1.5);
    ctx.font = `500 ${font}px ${FONT}`;
    let y = pad * 1.5 + big + 4;
    for (const l of lines) {
      ctx.fillText(l, pad * 2, y);
      y += font + 4;
    }
  }
}

export function formatSpeed(x: number): string {
  return `${x}×`;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function cross(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  line(ctx, x - r, y - r, x + r, y + r);
  line(ctx, x - r, y + r, x + r, y - r);
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string): void {
  ctx.font = `600 ${size}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.lineWidth = 3;
  ctx.strokeStyle = COLORS.outline;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}
