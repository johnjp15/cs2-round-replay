/**
 * H1: the 3D page's HUD (DOM over the canvas; docs/app3d.md "HUD"): crosshair and hit marker, score and round clock
 * (bomb timer once planted), the bomb line, the kill feed, the radar minimap (the CS2 radar around the viewer with
 * every alive pawn as a dot and the viewer's view cone), the team panel (HP, weapon, mode), HP / armor and ammo of
 * the pawn being viewed, the mode line (watching / you), fps and ticks/s. U1: the radar follows CS2's rules
 * (radar3d.ts: teammates always, enemies while spotted, the "?" ghost, the fading X; or everyone, the panel toggle),
 * the spectator panel and edge vignette while spectating, the crosshair at the aim and the scope overlay of the
 * viewed pawn. Text nodes and attributes are only written when they change. The clock and names reuse the 2D app's pure HUD model (src/app/hud-model.ts).
 */
import type { Observe, PawnObs, PawnStatus, PlayerId, Team } from '../contracts/index';
import type { RoundClock } from '../core/index';
import { clockView, hasAmmo, weaponName } from '../app/hud-model';
import type { Scene } from '../app/scene';
import { radarPx, type RadarTransform } from './coords';
import type { RadarRules, RadarTracker } from './radar3d';
import type { SpectatePanel } from './spectate';

export interface HudFrame {
  readonly scene: Scene;
  readonly clock: RoundClock;
  /** The pawn whose HP / ammo is shown (the human, else the followed pawn). */
  readonly viewer: PlayerId;
  readonly human: PlayerId | null;
  /** Viewer position and yaw for the minimap (the camera's). */
  readonly at: { readonly x: number; readonly y: number; readonly yaw: number };
  readonly mode: string;
  /** The mode line's style: playing, watching (nobody controlled) or the human dead and spectating. */
  readonly modeKind: 'you' | 'watching' | 'dead';
  readonly crosshair: boolean;
  /** The crosshair's offset from the screen centre (px; the aim punch), rounded by the caller. */
  readonly crosshairAt: { readonly x: number; readonly y: number };
  /** The scope overlay (the viewed pawn scoped in first person). */
  readonly scope: boolean;
  /** The radar: whose team's view (null: everyone) under which rules, from the tracker. */
  readonly radar: { readonly tracker: RadarTracker; readonly team: Team | null; readonly rules: RadarRules };
  /** The bottom spectator panel, or null while playing. */
  readonly spectate: SpectatePanel | null;
  /** ms since the human's last hit, and whether it was a headshot (null: none recently). */
  readonly hit: { readonly ageMs: number; readonly head: boolean } | null;
  readonly perf: string;
  readonly summary: string | null;
  readonly tick: number;
  readonly nowMs: number;
  /** W2: the viewed pawn's carried items (the engine's inventory), for the slot list; absent or null: hidden. */
  readonly items?: readonly string[] | null;
}

/** W2: CS2's slot of an item (1 primary, 2 pistol, 3 knife, 4 grenades, 5 C4), or null (the defuser). */
export function slotOfItem(item: string): 1 | 2 | 3 | 4 | 5 | null {
  if (['ak47', 'm4a4', 'awp', 'ssg08'].includes(item)) return 1;
  if (['deagle', 'glock', 'usps'].includes(item)) return 2;
  if (item === 'knife') return 3;
  if (['he', 'flash', 'smoke', 'molotov'].includes(item)) return 4;
  if (item === 'c4') return 5;
  return null;
}

/** W2: the slot list's HTML: one row per carried item in slot order (grenades in carry order), the held one marked. */
export function slotsHtml(items: readonly string[], held: string): string {
  const rows = items
    .map((it, i) => ({ it, i, slot: slotOfItem(it) }))
    .filter((r): r is { it: string; i: number; slot: 1 | 2 | 3 | 4 | 5 } => r.slot !== null)
    .sort((a, b) => a.slot - b.slot || a.i - b.i);
  let heldMarked = false;
  return rows
    .map((r) => {
      const on = !heldMarked && r.it === held;
      if (on) heldMarked = true;
      return `<div${on ? ' class="on"' : ''}>${weaponName(r.it)}<b>${r.slot}</b></div>`;
    })
    .join('');
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
    this.attr('mode', 'class', `slab ${f.modeKind}`);
    // W2: the slot list (1–5) of the viewed pawn while it is alive.
    const slots = f.items !== undefined && f.items !== null && v !== null && v.alive ? slotsHtml(f.items, v.weapon) : '';
    this.html('slots', slots);
    this.attr('slots', 'hidden', slots === '' ? '' : null);
    const sp = f.spectate;
    this.attr('spec', 'hidden', sp === null ? '' : null);
    this.attr('vignette', 'hidden', sp === null ? '' : null);
    if (sp !== null) {
      this.attr('spec', 'class', `slab ${sp.team === 'T' ? 't' : 'ct'}`);
      this.text('spec-name', sp.name);
      this.text('spec-mode', sp.mode);
      this.text('spec-stats', sp.stats);
      this.text('spec-hints', sp.hints);
    }
    if (f.nowMs - this.perfAt >= 500) {
      this.perfAt = f.nowMs;
      this.text('perf', f.perf);
    }
    this.attr('crosshair', 'hidden', f.crosshair ? null : '');
    this.attr('crosshair', 'style', f.crosshairAt.x === 0 && f.crosshairAt.y === 0 ? null : `transform:translate(${f.crosshairAt.x}px,${f.crosshairAt.y}px)`);
    this.attr('scope', 'hidden', f.scope ? null : '');
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
    const r = f.radar;
    const marks = r.team === null ? r.tracker.marks(o, 'T', 'all') : r.tracker.marks(o, r.team, r.rules);
    for (const m of marks) {
      const [x, y] = toMap(m.x, m.y);
      if (x < -10 || y < -10 || x > W + 10 || y > W + 10) continue;
      ctx.globalAlpha = m.alpha;
      const colour = m.team === 'T' ? '#ebc75e' : '#8bbcf3';
      if (m.kind === 'dead') {
        ctx.fillStyle = 'rgba(220,220,220,0.85)';
        ctx.font = 'bold 22px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('×', x, y);
      } else if (m.kind === 'ghost') {
        // CS2's last-seen marker: a "?" in the enemy's colour where it was last spotted.
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.beginPath();
        ctx.arc(x, y, 12, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = 'bold 24px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText('?', x, y);
        ctx.fillStyle = colour;
        ctx.fillText('?', x, y);
      } else {
        ctx.fillStyle = colour;
        ctx.beginPath();
        ctx.arc(x, y, m.id === f.viewer ? 9 : 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = m.id === f.human ? 3 : 1.5;
        ctx.strokeStyle = m.id === f.human ? '#ffffff' : 'rgba(0,0,0,0.8)';
        ctx.stroke();
        if (m.bomb) {
          ctx.fillStyle = '#ff5450';
          ctx.fillRect(x + 5, y - 13, 10, 7);
        }
      }
    }
    ctx.globalAlpha = 1;
    const b = r.team === null ? r.tracker.bomb(o, 'T', 'all') : r.tracker.bomb(o, r.team, r.rules);
    if (b !== null) {
      const [x, y] = toMap(b.x, b.y);
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
