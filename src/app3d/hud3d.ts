/**
 * H1: the 3D page's HUD (DOM over the canvas; docs/app3d.md "HUD"): crosshair and hit marker, score and round clock
 * (bomb timer once planted), the bomb line, the kill feed, the radar minimap (the CS2 radar around the viewer with
 * every alive pawn as a dot and the viewer's view cone), the team panel (HP, weapon, mode), HP / armor and ammo of
 * the pawn being viewed, the mode line (watching / you), fps and ticks/s. Text nodes are only written when they
 * change. The clock and names reuse the 2D app's pure HUD model (src/app/hud-model.ts).
 */
import type { Observe, PawnObs, PawnStatus, PlayerId } from '../contracts/index';
import type { RoundClock } from '../core/index';
import { clockView, hasAmmo, weaponName } from '../app/hud-model';
import type { Scene } from '../app/scene';
import { radarPx, type RadarTransform } from './coords';

export interface HudFrame {
  readonly scene: Scene;
  readonly clock: RoundClock;
  /** The pawn whose HP / ammo is shown (the human, else the followed pawn). */
  readonly viewer: PlayerId;
  readonly human: PlayerId | null;
  /** Viewer position and yaw for the minimap (the camera's). */
  readonly at: { readonly x: number; readonly y: number; readonly yaw: number };
  readonly mode: string;
  readonly crosshair: boolean;
  /** H2b: crosshair offset from the centre (CSS px, + right / down): where the bullets go under recoil. */
  readonly crosshairPx: { readonly x: number; readonly y: number };
  /** ms since the human's last hit, and whether it was a headshot (null: none recently). */
  readonly hit: { readonly ageMs: number; readonly head: boolean } | null;
  readonly perf: string;
  readonly summary: string | null;
  readonly tick: number;
  readonly nowMs: number;
}

function el(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (e === null) throw new Error(`#${id} missing`);
  return e;
}

/** Minimap: how many radar pixels the 208 px map shows across (5 units each: 3,000 units). */
const MINIMAP_SPAN_PX = 600;
/** The minimap is redrawn at most this often (ms): 10 Hz. */
const MINIMAP_MS = 100;

export class Hud3D {
  /** H2b: the crosshair's current CSS transform (null = centred). */
  private crosshairTransform: string | null = null;
  private readonly cache = new Map<string, string>();
  private readonly minimap: HTMLCanvasElement;
  private readonly mctx: CanvasRenderingContext2D | null;
  private readonly radar: CanvasImageSource;
  private readonly transform: RadarTransform;
  /** When the minimap and the perf line were last drawn (they change slowly; redrawing a 2D canvas every frame costs compositing). */
  private minimapAt = -1e9;
  private perfAt = -1e9;

  constructor(radar: CanvasImageSource, transform: RadarTransform) {
    this.radar = radar;
    this.transform = transform;
    this.minimap = el('minimap') as HTMLCanvasElement;
    this.mctx = this.minimap.getContext('2d');
    el('hud').hidden = false;
  }

  private text(id: string, value: string): void {
    if (this.cache.get(id) === value) return;
    this.cache.set(id, value);
    el(id).textContent = value;
  }

  private html(id: string, value: string): void {
    if (this.cache.get(id + ':html') === value) return;
    this.cache.set(id + ':html', value);
    el(id).innerHTML = value;
  }

  private attr(id: string, name: string, value: string | null): void {
    const k = `${id}@${name}`;
    if (this.cache.get(k) === (value ?? '\0')) return;
    this.cache.set(k, value ?? '\0');
    const e = el(id);
    if (name === 'hidden') e.hidden = value !== null;
    else if (value === null) e.removeAttribute(name);
    else e.setAttribute(name, value);
  }

  update(f: HudFrame): void {
    const o: Observe = f.scene.cur;
    const cv = clockView(o, f.clock, f.scene.bomb, f.scene.roundEnd);
    this.text('clock', cv.text);
    this.attr('clock', 'class', cv.mode === 'round' || cv.mode === 'over' ? null : cv.mode);
    this.text('score-t', String(o.round.score.t));
    this.text('score-ct', String(o.round.score.ct));
    this.text('bombline', bombLine(o));
    // Kill feed.
    const feed = f.scene.killFeed
      .visible(f.tick)
      .map((k) => {
        const cls = (t: string | null): string => (t === 'T' ? 't' : t === 'CT' ? 'ct' : '');
        const you = f.human !== null && (k.killer === f.human || k.victim === f.human) ? ' you' : '';
        return `<div class="slab${you}"><span class="${cls(k.killerTeam)}">${k.killer ?? ''}</span><span class="w">${weaponName(k.weapon)}${k.headshot ? ' ◎' : ''}</span><span class="${cls(k.victimTeam)}">${k.victim}</span></div>`;
      })
      .join('');
    this.html('killfeed', feed);
    // Team panel.
    const rows = (team: 'T' | 'CT'): string =>
      o.pawns
        .filter((p) => p.team === team)
        .map((p) => teamRow(p, f.scene.statusOf(p.id), f.human))
        .join('');
    this.html('teams', rows('T') + '<div style="height:6px"></div>' + rows('CT'));
    // The viewed pawn.
    const v = o.pawns.find((p) => p.id === f.viewer) ?? null;
    this.text('hp', v === null ? '–' : String(Math.round(v.hp)));
    this.text('armor', v === null ? '–' : String(Math.round(v.armor)));
    this.text('weapon', v === null ? '' : `${v.id} · ${weaponName(v.weapon)}`);
    this.text('clip', v !== null && hasAmmo(v.weapon) ? String(v.ammo.clip) : '–');
    this.text('reserve', v !== null && hasAmmo(v.weapon) ? `/ ${v.ammo.reserve}` : '');
    this.text('mode', f.mode);
    if (f.nowMs - this.perfAt >= 500) {
      this.perfAt = f.nowMs;
      this.text('perf', f.perf);
    }
    this.attr('crosshair', 'hidden', f.crosshair ? null : '');
    const xf = f.crosshairPx.x === 0 && f.crosshairPx.y === 0 ? null : `translate(${f.crosshairPx.x}px, ${f.crosshairPx.y}px)`;
    if (xf !== this.crosshairTransform) {
      this.crosshairTransform = xf;
      el('crosshair').style.transform = xf ?? '';
    }
    const showHit = f.hit !== null && f.hit.ageMs < 180;
    this.attr('hitmarker', 'hidden', showHit ? null : '');
    this.attr('hitmarker', 'class', showHit && f.hit?.head === true ? 'head' : null);
    if (f.summary === null) this.attr('summary', 'hidden', '');
    else {
      this.html('summary', f.summary);
      this.attr('summary', 'hidden', null);
    }
    if (f.nowMs - this.minimapAt >= MINIMAP_MS) {
      this.minimapAt = f.nowMs;
      this.drawMinimap(o, f);
    }
  }

  private drawMinimap(o: Observe, f: HudFrame): void {
    const ctx = this.mctx;
    if (ctx === null) return;
    const W = this.minimap.width;
    const c = radarPx(this.transform, f.at.x, f.at.y);
    const half = MINIMAP_SPAN_PX / 2;
    const k = W / MINIMAP_SPAN_PX;
    ctx.clearRect(0, 0, W, W);
    ctx.globalAlpha = 0.9;
    ctx.drawImage(this.radar, c.px - half, c.py - half, MINIMAP_SPAN_PX, MINIMAP_SPAN_PX, 0, 0, W, W);
    ctx.globalAlpha = 1;
    const toMap = (x: number, y: number): [number, number] => {
      const q = radarPx(this.transform, x, y);
      return [(q.px - c.px + half) * k, (q.py - c.py + half) * k];
    };
    // View cone of the camera.
    const [vx, vy] = toMap(f.at.x, f.at.y);
    const a = (-f.at.yaw * Math.PI) / 180;
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.moveTo(vx, vy);
    ctx.arc(vx, vy, 70, a - 0.65, a + 0.65);
    ctx.closePath();
    ctx.fill();
    for (const p of o.pawns) {
      const [x, y] = toMap(p.pos.x, p.pos.y);
      if (x < -10 || y < -10 || x > W + 10 || y > W + 10) continue;
      ctx.fillStyle = !p.alive ? 'rgba(200,200,200,0.5)' : p.team === 'T' ? '#ebc75e' : '#8bbcf3';
      if (!p.alive) {
        ctx.font = 'bold 18px sans-serif';
        ctx.fillText('×', x - 5, y + 6);
        continue;
      }
      ctx.beginPath();
      ctx.arc(x, y, p.id === f.viewer ? 9 : 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = p.id === f.human ? 3 : 1.5;
      ctx.strokeStyle = p.id === f.human ? '#ffffff' : 'rgba(0,0,0,0.8)';
      ctx.stroke();
    }
    const b = o.round.bomb;
    if (b.pos !== null && b.state !== 'carried') {
      const [x, y] = toMap(b.pos.x, b.pos.y);
      ctx.fillStyle = b.state === 'defused' ? '#4cc982' : '#ff5450';
      ctx.fillRect(x - 6, y - 4, 12, 8);
    }
  }
}

function bombLine(o: Observe): string {
  const b = o.round.bomb;
  switch (b.state) {
    case 'carried':
      return b.carrier === null ? '' : `C4: ${b.carrier}`;
    case 'dropped':
      return 'C4 dropped';
    case 'planted':
      return b.defuser !== null && b.defuseEndTick !== null ? `${b.defuser} defusing · ${Math.max(0, (b.defuseEndTick - o.tick) / 64).toFixed(1)} s` : 'Bomb planted';
    case 'defused':
      return `Defused by ${b.defuser ?? '?'}`;
    case 'exploded':
      return 'Bomb exploded';
  }
}

function teamRow(p: PawnObs, st: PawnStatus | null, human: PlayerId | null): string {
  const mode = p.id === human ? 'YOU' : (st?.mode ?? '');
  const cls = mode === 'LIVE' ? 'live' : mode === 'YOU' ? 'human' : '';
  const hp = p.alive ? Math.max(0, Math.min(100, p.hp)) : 0;
  return `<div class="row ${p.team === 'T' ? 't' : 'ct'}${p.alive ? '' : ' dead'}"><span class="n">${p.id}</span><span class="bar"><i style="width:${hp}%"></i></span><span class="m ${cls}">${p.alive ? mode : '✕'}</span></div>`;
}
