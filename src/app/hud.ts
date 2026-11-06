/**
 * HUD: DOM laid over the canvas (index.html `#hud`). Text stays crisp, the layout responds with CSS,
 * and the status panel scrolls and collapses like any element. Everything it shows comes from pure
 * helpers (hud-model.ts, scene.ts); this file writes it into the page, touching an element only when
 * its content changes.
 *
 * - Top centre: score with team names, and the round clock, which turns into the red bomb timer
 *   (with a draining bar) after the plant.
 * - Top right: the kill feed, "killer [weapon] victim" with a headshot mark, team colours. Wherever it would
 *   cover the scoreboard (or the collapsed panel button), it moves down below it.
 * - Left: the status panel (Tab): each pawn's mode, trigger and since-time, for a LIVE pawn the 2D engine's AI
 *   state (behaviour, target, goal: Sim2DHost.aiDebug), and the last 20 Core logs.
 * - Bottom left: cart's HP, armor, weapon and ammo.
 * - Bottom right: frame rate and tick rate.
 *
 * `occupiedRects()` reports where all this is on the stage, so the renderer keeps pawn labels out of it, together with
 * B5's end-of-round summary (`#summary`, over the map: a side panel, or a bottom sheet on phones) and the timeline
 * (`#timeline`, below the map today) while they show.
 */
import type { PlayerId, RoundData, Team } from '../contracts/index';
import type { RoundClock } from '../core/index';
import { aiDebugLine, clockView, rectsOverlap, scoreView, statusBadge, youView, weaponName, type AiDebugSource, type ClockView, type ScreenRect } from './hud-model';
import type { KillEntry, Scene } from './scene';

export interface HudFrame {
  readonly scene: Scene;
  readonly clock: RoundClock;
  /** The pawn the human plays, or null when spectating. */
  readonly human: PlayerId | null;
  /** Whose status the bottom-left card shows (cart). */
  readonly you: PlayerId;
  /** ready / running / paused. */
  readonly phase: 'ready' | 'running' | 'paused';
  readonly speed: number;
  readonly panelOpen: boolean;
  /** Render tick (fractional), for kill-feed aging. */
  readonly tick: number;
  readonly fps: number;
  readonly tps: number;
  /** The 2D engine's LIVE AI debug view (Sim2DHost.aiDebug) for the status panel; null or absent: none. */
  readonly ai?: AiDebugSource | null;
}

/** Space kept between the kill feed and what it moves below (CSS px). */
const FEED_GAP = 6;

function el<T extends HTMLElement>(id: string, type: new () => T): T {
  const e = document.getElementById(id);
  if (!(e instanceof type)) throw new Error(`index.html: #${id} missing`);
  return e;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function teamClass(team: Team | null): string {
  return team === 'CT' ? 'ct' : team === 'T' ? 't' : 'world';
}

/** Headshot mark: a small drawn crosshair over a head (no game assets). */
const HEADSHOT_SVG =
  '<svg class="hs" viewBox="0 0 16 16" aria-label="headshot" role="img"><circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 0.8v4M8 11.2v4M0.8 8h4M11.2 8h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="8" r="1.6" fill="currentColor"/></svg>';

export class Hud {
  private readonly round: Pick<RoundData, 'meta' | 'players'>;
  private readonly root: HTMLElement;
  private readonly clockBox: HTMLElement;
  private readonly clockText: HTMLElement;
  private readonly clockNote: HTMLElement;
  private readonly bombBar: HTMLElement;
  private readonly ctScore: HTMLElement;
  private readonly tScore: HTMLElement;
  private readonly killfeed: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly pawnRows: HTMLElement;
  private readonly logList: HTMLElement;
  private readonly you: HTMLElement;
  private readonly youName: HTMLElement;
  private readonly youNote: HTMLElement;
  private readonly youHp: HTMLElement;
  private readonly youArmor: HTMLElement;
  private readonly youWeapon: HTMLElement;
  private readonly youAmmo: HTMLElement;
  private readonly perf: HTMLElement;
  private readonly scoreboard: HTMLElement;
  private readonly panelToggle: HTMLElement;
  /** Other page elements over (or next to) the map that labels keep out of: B5's summary overlay and timeline. */
  private readonly others: HTMLElement[];
  /** The HUD's rectangles after the last update (stage CSS px). */
  private occupied: ScreenRect[] = [];
  private readonly last = new Map<HTMLElement, string>();
  private readonly lastAttr = new Map<HTMLElement, Map<string, string>>();

  constructor(round: Pick<RoundData, 'meta' | 'players'>, onPanelToggle: () => void) {
    this.round = round;
    this.root = el('hud', HTMLElement);
    this.clockBox = el('clock', HTMLElement);
    this.clockText = el('clock-text', HTMLElement);
    this.clockNote = el('clock-note', HTMLElement);
    this.bombBar = el('bomb-bar', HTMLElement);
    this.ctScore = el('ct-score', HTMLElement);
    this.tScore = el('t-score', HTMLElement);
    this.killfeed = el('killfeed', HTMLElement);
    this.panel = el('panel', HTMLElement);
    this.pawnRows = el('pawn-rows', HTMLElement);
    this.logList = el('log', HTMLElement);
    this.you = el('you', HTMLElement);
    this.youName = el('you-name', HTMLElement);
    this.youNote = el('you-note', HTMLElement);
    this.youHp = el('you-hp', HTMLElement);
    this.youArmor = el('you-armor', HTMLElement);
    this.youWeapon = el('you-weapon', HTMLElement);
    this.youAmmo = el('you-ammo', HTMLElement);
    this.perf = el('perf', HTMLElement);
    this.scoreboard = el('scoreboard', HTMLElement);
    this.panelToggle = el('panel-toggle', HTMLElement);
    this.others = ['summary', 'timeline'].map((id) => document.getElementById(id)).filter((e): e is HTMLElement => e !== null);
    el('ct-name', HTMLElement).textContent = round.meta.teams.CT;
    el('t-name', HTMLElement).textContent = round.meta.teams.T;
    el('panel-toggle', HTMLButtonElement).addEventListener('click', (e) => {
      onPanelToggle();
      (e.currentTarget as HTMLButtonElement).blur();
    });
    this.root.hidden = false;
  }

  update(f: HudFrame): void {
    const o = f.scene.cur;
    this.updateClock(f, clockView(o, f.clock, f.scene.bomb, f.scene.roundEnd));
    const score = scoreView(o, this.round.meta.score, f.scene.roundEnd);
    this.text(this.ctScore, String(score.ct));
    this.text(this.tScore, String(score.t));
    this.html(this.killfeed, this.killFeedHtml(f));
    this.attr(this.panel, 'data-open', String(f.panelOpen));
    if (f.panelOpen) {
      this.html(this.pawnRows, this.pawnRowsHtml(f));
      this.html(this.logList, this.logHtml(f));
    }
    this.updateYou(f);
    this.text(this.perf, `${Math.round(f.fps)} fps   ${Math.round(f.tps)} ticks/s   tick ${o.tick}`);
    this.placeKillFeed(f.panelOpen);
    this.occupied = this.measure();
  }

  /**
   * Where the HUD is on the stage (CSS px, the canvas's coordinates), as of the last update: the scoreboard, the
   * kill feed (when it has rows), the status panel (its button when collapsed), your status, the rates, and the
   * summary overlay and the timeline when they show (a hidden element has no size and is left out).
   */
  occupiedRects(): readonly ScreenRect[] {
    return this.occupied;
  }

  private measure(): ScreenRect[] {
    const base = this.root.getBoundingClientRect();
    const out: ScreenRect[] = [];
    const add = (e: HTMLElement): void => {
      const r = e.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) out.push({ x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height });
    };
    add(this.scoreboard);
    if (this.killfeed.childElementCount > 0) add(this.killfeed);
    add(this.panel);
    add(this.you);
    if (this.perf.textContent !== '') add(this.perf);
    for (const e of this.others) add(e);
    return out;
  }

  /**
   * Keep the kill feed off the scoreboard: from its CSS spot (top right), it moves down below the scoreboard if it
   * would cover it (desktop windows narrower than about 1,100 px, phones in landscape), and below the panel button
   * too when the panel is collapsed and they meet (phones). An open panel sits above the feed (CSS z-index).
   */
  private placeKillFeed(panelOpen: boolean): void {
    const feed = this.killfeed;
    // Measure from the CSS position (top right), then push down past whatever it meets (at most twice).
    feed.style.top = '';
    if (feed.childElementCount === 0) return;
    const box = (e: HTMLElement): ScreenRect => {
      const r = e.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    };
    const obstacles = [box(this.scoreboard), ...(panelOpen ? [] : [box(this.panelToggle)])];
    let r = box(feed);
    let top: number | null = null;
    for (let pass = 0; pass < 2; pass++) {
      const hit = obstacles.find((o) => rectsOverlap(r, o));
      if (hit === undefined) break;
      top = hit.y + hit.h + FEED_GAP;
      r = { ...r, y: top };
    }
    if (top !== null) feed.style.top = `${Math.round(top - this.root.getBoundingClientRect().top)}px`;
  }

  private updateClock(f: HudFrame, c: ClockView): void {
    this.attr(this.clockBox, 'data-mode', c.mode);
    this.text(this.clockText, c.text);
    this.attr(this.bombBar, 'style', c.bombLeft === null ? 'transform: scaleX(0)' : `transform: scaleX(${c.bombLeft.toFixed(4)})`);
    const parts: string[] = [];
    if (c.winner !== null) parts.push(`${this.round.meta.teams[c.winner]} win`);
    else if (c.mode === 'bomb') parts.push('Bomb planted');
    else if (c.mode === 'defusing') parts.push('Defusing');
    if (f.phase === 'ready') parts.push('Press Start');
    else if (f.phase === 'paused') parts.push('Paused');
    else if (f.speed !== 1) parts.push(`${f.speed}× speed`);
    const note = parts.length === 0 ? this.round.meta.hudRound : parts.join(', ');
    this.text(this.clockNote, note);
  }

  private killFeedHtml(f: HudFrame): string {
    const feed = f.scene.killFeed;
    const rows = feed.visible(f.tick).map((k) => this.killRow(k, f.human, Math.min(1, feed.lifeLeft(k, f.tick) / 0.1)));
    return rows.join('');
  }

  private killRow(k: KillEntry, human: PlayerId | null, fade: number): string {
    const mine = human !== null && (k.killer === human || k.victim === human);
    const opacity = fade >= 1 ? '' : ` style="opacity:${(Math.round(fade * 10) / 10).toFixed(1)}"`;
    const killer = k.killer === null ? '' : `<span class="who ${teamClass(k.killerTeam)}">${k.killer}</span>`;
    return (
      `<li class="kill${mine ? ' mine' : ''}"${opacity}>${killer}` +
      `<span class="gun">${escapeHtml(weaponName(k.weapon))}</span>${k.headshot ? HEADSHOT_SVG : ''}` +
      `<span class="who ${teamClass(k.victimTeam)}">${k.victim}</span></li>`
    );
  }

  private pawnRowsHtml(f: HudFrame): string {
    const o = f.scene.cur;
    const rows: string[] = [];
    // Ts then CTs, each in id order.
    for (const team of ['T', 'CT'] as const) {
      for (const p of o.pawns) {
        if (p.team !== team) continue;
        const st = f.scene.statusOf(p.id);
        const badge = statusBadge(st?.mode ?? null, p.id === f.human, p.alive);
        const since = st === null ? '' : f.clock.hudClock(st.sinceTick);
        const trigger = st?.trigger ?? null;
        rows.push(
          `<tr class="${teamClass(team)}${p.id === f.human ? ' me' : ''}">` +
            `<td class="nm"><i class="chip" style="--pc:${this.colorOf(p.id)}"></i>${p.id}</td>` +
            `<td><span class="badge ${badge.tone}">${badge.text}</span></td>` +
            `<td class="trig">${trigger === null ? '<span class="none">–</span>' : escapeHtml(trigger)}</td>` +
            `<td class="since">${since}</td></tr>`,
        );
        // LIVE: what the 2D engine's AI is doing (behaviour, target, goal). 2D debug; the Core doesn't see it.
        const line = badge.tone === 'alert' && f.ai !== undefined && f.ai !== null && p.alive ? aiDebugLine(f.ai.aiDebug(p.id)) : null;
        if (line !== null) rows.push(`<tr class="${teamClass(team)} ai"><td colspan="4">${escapeHtml(line)}</td></tr>`);
      }
    }
    return rows.join('');
  }

  private logHtml(f: HudFrame): string {
    const logs = f.scene.logs;
    if (logs.length === 0) return '<li class="empty">No Core messages yet.</li>';
    const out: string[] = [];
    for (let i = logs.length - 1; i >= 0; i--) {
      const l = logs[i];
      if (l === undefined) continue;
      out.push(`<li class="${l.level}"><span class="at">${f.clock.hudClock(l.tick)}</span>${escapeHtml(l.text)}</li>`);
    }
    return out.join('');
  }

  private updateYou(f: HudFrame): void {
    const p = f.scene.pawn(f.you);
    if (p === null) return;
    const y = youView(p);
    this.attr(this.you, 'data-team', y.team);
    this.attr(this.you, 'data-band', y.alive ? y.band : 'dead');
    this.text(this.youName, y.id);
    this.text(this.youNote, f.human === y.id ? 'you' : f.human === null ? 'spectating' : '');
    this.text(this.youHp, String(y.hp));
    this.text(this.youArmor, String(y.armor));
    this.text(this.youWeapon, y.alive ? y.weapon : 'Dead');
    this.text(this.youAmmo, y.alive ? (y.ammo ?? '') : '');
  }

  private colorOf(id: PlayerId): string {
    return this.round.players.find((p) => p.id === id)?.color ?? '#888';
  }

  private text(e: HTMLElement, s: string): void {
    if (this.last.get(e) === s) return;
    this.last.set(e, s);
    e.textContent = s;
  }

  private html(e: HTMLElement, s: string): void {
    if (this.last.get(e) === s) return;
    this.last.set(e, s);
    e.innerHTML = s;
  }

  private attr(e: HTMLElement, name: string, value: string): void {
    let m = this.lastAttr.get(e);
    if (m === undefined) {
      m = new Map();
      this.lastAttr.set(e, m);
    }
    if (m.get(name) === value) return;
    m.set(name, value);
    e.setAttribute(name, value);
  }
}
