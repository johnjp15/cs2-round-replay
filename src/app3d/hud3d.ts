/**
 * H1: the 3D page's HUD (DOM over the canvas; docs/app3d.md "HUD"): crosshair and hit marker, score and round clock
 * (bomb timer once planted), the bomb line, the kill feed, the radar minimap (the CS2 radar around the viewer with
 * every alive pawn as a dot and the viewer's view cone), the team panel (HP, weapon, mode), HP / armor and ammo of
 * the pawn being viewed, the mode line (watching / you), fps and ticks/s. U1: the radar follows CS2's rules
 * (radar3d.ts: teammates always, enemies while spotted, the "?" ghost, the fading X; or everyone, the panel toggle),
 * the spectator panel and edge vignette while spectating, the crosshair at the aim and the scope overlay of the
 * viewed pawn. Text nodes and attributes are only written when they change. The clock and names reuse the 2D app's pure HUD model (src/app/hud-model.ts).
 *
 * H6, CS2's HUD, team-correct for the viewed pawn (the human, else the spectated one; its team, never a constant):
 * the score CT left, T right (CS2's `hudteamcounter.xml`: ScoreCT in GameScore__BGL, ScoreT in GameScore__BGR); once
 * planted the clock gives way to the pulsing C4 icon for both teams (`BombStatus`, `BombPlantedPulse__*`), green when
 * defused: no bomb countdown for anyone; the defuse progress bar only for the defusing CT; the C4 carrier marked in
 * the team panel only for Ts; the "The bomb has been planted" alert (CS2's `CSGOHudAlerts`); the win banner
 * ("Counter-Terrorists Win" + the reason); the kill feed's 6 s (scene.ts); the money and "+$300" award flashes
 * (economy.ts). Pure view helpers: bombHud, plantAlert, winBanner.
 */
import type { Observe, PawnObs, PawnStatus, PlayerId, RoundEndReason, Team } from '../contracts/index';
import type { RoundClock } from '../core/index';
import { clockView, hasAmmo, weaponName } from '../app/hud-model';
import type { BombState, Scene } from '../app/scene';
import type { CashAward } from './economy';
import { radarPx, type RadarTransform } from './coords';
import type { RadarRules, RadarTracker } from './radar3d';
import type { SpectatePanel } from './spectate';

export interface HudFrame {
  readonly scene: Scene;
  readonly clock: RoundClock;
  /** The pawn whose HP / ammo is shown (the human, else the followed pawn). */
  readonly viewer: PlayerId;
  readonly human: PlayerId | null;
  /** H6: the viewed pawn's team (the HUD shows what that team sees of the bomb). */
  readonly viewerTeam: Team | null;
  /** H6: the viewed pawn's money (null: unknown) and its award flashes now. */
  readonly money: { readonly cash: number | null; readonly flashes: readonly CashAward[] };
  /** Viewer position and yaw for the minimap (the camera's). */
  readonly at: { readonly x: number; readonly y: number; readonly yaw: number };
  readonly mode: string;
  /** The mode line's style: playing, watching (nobody controlled) or the human dead and spectating. */
  readonly modeKind: 'you' | 'watching' | 'dead';
  readonly crosshair: boolean;
  /** H6 (#85): the death fade's black over the view, 0..1 (0: none). */
  readonly deathFade?: number;
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
  /** W3: CS2's team-damage notices (team-damage.ts): feed lines "<x> attacked a teammate" and the human's hint. */
  readonly teamDamage?: { readonly feed: readonly string[]; readonly hint: string | null };
}

/** W2: CS2's slot of an item (1 primary, 2 pistol, 3 knife, 4 grenades, 5 C4), or null (the defuser). */
export function slotOfItem(item: string): 1 | 2 | 3 | 4 | 5 | null {
  if (['ak47', 'm4a4', 'm4a1s', 'awp', 'ssg08'].includes(item)) return 1;
  if (['deagle', 'glock', 'usps', 'p2000'].includes(item)) return 2;
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
    const bh = bombHud(o, f.scene.bomb, f.viewer, f.viewerTeam);
    this.text('clock-text', bh.icon === null ? cv.text : '');
    this.attr('clock', 'class', bh.icon === null ? null : `c4 ${bh.icon}`);
    this.text('score-t', String(o.round.score.t));
    this.text('score-ct', String(o.round.score.ct));
    // The defuse bar: the defuser's own HUD only.
    this.attr('defuse', 'hidden', bh.defuse === null ? '' : null);
    if (bh.defuse !== null) {
      this.text('defuse-text', bh.defuse.kit ? 'Defusing bomb WITH defuse kit.' : 'Defusing bomb WITHOUT defuse kit.');
      this.attr('defuse-bar', 'style', `transform:scaleX(${bh.defuse.progress.toFixed(3)})`);
    }
    // The plant alert, both teams.
    const al = plantAlert(o.round.bomb.plantTick ?? f.scene.bomb.plantTick, f.tick, f.clock.bombTimerSec);
    this.attr('alert', 'hidden', al === null ? '' : null);
    if (al !== null) {
      this.text('alert-sub', al.sub);
      this.attr('alert', 'style', al.opacity >= 1 ? null : `opacity:${al.opacity.toFixed(1)}`);
    }
    // The win banner.
    const wb = winBanner(o.round.winner, o.round.reason);
    this.attr('banner', 'hidden', wb === null ? '' : null);
    if (wb !== null) {
      this.attr('banner', 'class', wb.team === 'T' ? 't' : 'ct');
      this.text('banner-title', wb.title);
      this.text('banner-reason', wb.reason);
    }
    // Money and the award flashes.
    const m = f.money;
    this.attr('money', 'hidden', m.cash === null && m.flashes.length === 0 ? '' : null);
    this.text('money-val', m.cash === null ? '' : `$${m.cash}`);
    this.html('money-awards', m.flashes.map((a) => `<div class="${a.amount < 0 ? 'neg' : ''}" title="${a.text.trim()}">${a.amount < 0 ? '-' : '+'}$${Math.abs(a.amount)}</div>`).join(''));
    // Kill feed (CS2: 5 s + 1 s fade, 1.5× for the local player's own).
    const local = f.human;
    const kf = f.scene.killFeed;
    const feed = kf
      .visible(f.tick, local)
      .map((k) => {
        const cls = (t: string | null): string => (t === 'T' ? 't' : t === 'CT' ? 'ct' : '');
        const you = local !== null && (k.killer === local || k.victim === local) ? ' you' : '';
        const op = Math.round(kf.opacity(k, f.tick, local) * 10) / 10;
        return `<div class="slab${you}"${op >= 1 ? '' : ` style="opacity:${op.toFixed(1)}"`}><span class="${cls(k.killerTeam)}">${k.killer ?? ''}</span><span class="w">${weaponName(k.weapon)}${k.headshot ? ' ◎' : ''}</span><span class="${cls(k.victimTeam)}">${k.victim}</span></div>`;
      })
      .join('');
    const ff = (f.teamDamage?.feed ?? []).map((l) => `<div class="slab ff">${l}</div>`).join('');
    this.html('killfeed', feed + ff);
    const hint = f.teamDamage?.hint ?? null;
    this.attr('ffhint', 'hidden', hint === null ? '' : null);
    if (hint !== null) this.text('ffhint', hint);
    // Team panel.
    const rows = (team: 'T' | 'CT'): string =>
      o.pawns
        .filter((p) => p.team === team)
        .map((p) => teamRow(p, f.scene.statusOf(p.id), f.human, f.viewerTeam === 'T' && o.round.bomb.state === 'carried' && o.round.bomb.carrier === p.id))
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
    const black = Math.round((f.deathFade ?? 0) * 20) / 20;
    this.attr('deathfade', 'hidden', black > 0 ? null : '');
    this.attr('deathfade', 'style', black > 0 ? `opacity:${black}` : null);
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

/** H6: the clock's C4 icon (null: the round clock) and the defuse bar (only the defuser's own HUD). */
export interface BombHud {
  /** planted (pulsing: slow / medium / fast), defused, exploded, or null before the plant. */
  readonly icon: 'pulse-slow' | 'pulse-medium' | 'pulse-fast' | 'defused' | 'exploded' | null;
  readonly defuse: { readonly progress: number; readonly kit: boolean } | null;
}

/**
 * CS2 gives nobody a bomb countdown (the C4 icon replaces the clock for both teams) and shows the defuse progress only
 * to the defusing CT. The pulse quickens as the timer runs down (CS2's BombPlantedPulse__Slow / Medium / Fast are 0.8 /
 * 0.5 / 0.3 s cycles; when CS2 switches between them is in its C++, not the Panorama files: 10 s and 5 s left here,
 * unverified).
 */
export function bombHud(o: Observe, bomb: BombState, viewer: PlayerId, viewerTeam: Team | null): BombHud {
  const b = o.round.bomb;
  if (b.state === 'defused') return { icon: 'defused', defuse: null };
  if (b.state === 'exploded') return { icon: 'exploded', defuse: null };
  if (b.state !== 'planted') return { icon: null, defuse: null };
  const left = o.round.timeLeftSec;
  const icon = left > 10 ? 'pulse-slow' : left > 5 ? 'pulse-medium' : 'pulse-fast';
  let defuse: BombHud['defuse'] = null;
  if (viewerTeam === 'CT' && b.defuser === viewer && b.defuseEndTick !== null) {
    // The start from the Scene's defuse_start (restored after a seek); a kit defuse is 5 s, without 10 s.
    const start = bomb.defuser === viewer && bomb.defuseStartTick !== null ? bomb.defuseStartTick : null;
    const total = start === null ? null : b.defuseEndTick - start;
    const kit = total === null ? true : total <= 5.5 * 64;
    const len = total ?? (kit ? 5 : 10) * 64;
    defuse = { progress: Math.min(1, Math.max(0, 1 - (b.defuseEndTick - o.tick) / len)), kit };
  }
  return { icon, defuse };
}

/**
 * H6: CS2's "The bomb has been planted" alert (`Cstrike_TitlesTXT_Bomb_Planted`: "The bomb has been planted\n%s1
 * seconds till detonation"; `CSGOHudAlerts` in hudalerts.css: the 3.7 s FlashAnim, then the 1.0 s HideFlash fade), from
 * the plant tick; null when not showing.
 */
export const PLANT_ALERT_TICKS = Math.round(3.7 * 64);
export const PLANT_ALERT_FADE_TICKS = 64;
export function plantAlert(plantTick: number | null, tick: number, bombTimerSec: number): { sub: string; opacity: number } | null {
  if (plantTick === null) return null;
  const age = tick - plantTick;
  if (age < 0 || age >= PLANT_ALERT_TICKS + PLANT_ALERT_FADE_TICKS) return null;
  const opacity = age < PLANT_ALERT_TICKS ? 1 : Math.round((1 - (age - PLANT_ALERT_TICKS) / PLANT_ALERT_FADE_TICKS) * 10) / 10;
  return { sub: `${Math.round(bombTimerSec)} seconds till detonation`, opacity };
}

/**
 * H6: CS2's round-end banner (csgo_english.txt): `SFUI_WinPanel_CT_Win` "Counter-Terrorists Win" / `SFUI_WinPanel_T_Win`
 * "Terrorists Win", with the reason: `SFUI_Notice_Bomb_Defused` "The bomb has been defused", `SFUI_Notice_Target_Bombed`
 * "Target successfully bombed", `SFUI_Notice_Target_Saved` "Target has been saved" (time); none for an elimination.
 * (The video's CS:GO 2020 match had team names: "Sk8er bois Wins The Round".)
 */
export function winBanner(winner: Team | null, reason: RoundEndReason | null): { team: Team; title: string; reason: string } | null {
  if (winner === null) return null;
  const why = reason === 'bomb_defused' ? 'The bomb has been defused' : reason === 'bomb_exploded' ? 'Target successfully bombed' : reason === 'time' ? 'Target has been saved' : '';
  return { team: winner, title: winner === 'CT' ? 'Counter-Terrorists Win' : 'Terrorists Win', reason: why };
}

function teamRow(p: PawnObs, st: PawnStatus | null, human: PlayerId | null, c4: boolean): string {
  const mode = p.id === human ? 'YOU' : (st?.mode ?? '');
  const cls = mode === 'LIVE' ? 'live' : mode === 'YOU' ? 'human' : '';
  const hp = p.alive ? Math.max(0, Math.min(100, p.hp)) : 0;
  return `<div class="row ${p.team === 'T' ? 't' : 'ct'}${p.alive ? '' : ' dead'}"><span class="n">${p.id}${c4 ? '<b class="c4">C4</b>' : ''}</span><span class="bar"><i style="width:${hp}%"></i></span><span class="m ${cls}">${p.alive ? mode : '✕'}</span></div>`;
}
