/**
 * The end-of-round summary overlay (B5, D3's leftover): the headline, the result and the bomb against the recording,
 * the kill-by-kill comparison, the LIVE switches and the player's stats, with "Rewind 10 s", "Restart" and "Keep
 * watching". It appears `SUMMARY_DELAY_SEC` (2 s) of round time after the round end and never pauses the round: the
 * post-round kill (69.4 s) still happens behind it. A card at the bottom right on desktop, a bottom sheet on phones;
 * Escape, the close button or "Keep watching" dismiss it, the Summary button brings it back.
 *
 * `summaryView` (pure, tested) turns the Core's RoundSummary into display strings; `SummaryOverlay` fills the
 * `#summary` element of index.html.
 */
import type { KillRow, KillStatus, PlayerId, RoundObs, RoundSummary, Team } from '../contracts/index';
import { TICK_RATE, fixed2, resultShort, secText } from '../core/index';

/** Round time between the round end and the overlay. */
export const SUMMARY_DELAY_SEC = 2;

/** Units per metre (1 unit = 1 inch). */
const UNITS_PER_METRE = 39.37;

/** True once the round has been over for `delayTicks` (observe ticks after its `round_end`). */
export function summaryDue(round: RoundObs, tick: number, delayTicks: number): boolean {
  return round.phase === 'over' && round.endTick !== null && tick >= round.endTick + 1 + delayTicks;
}

export interface KillRowView {
  readonly status: KillStatus;
  /** "same", "Δt", "✗", "new" (short label for the status column). */
  readonly label: string;
  readonly killer: string;
  readonly killerTeam: Team | null;
  readonly victim: PlayerId;
  readonly victimTeam: Team;
  /** "50.35" or "–". */
  readonly recorded: string;
  readonly run: string;
  readonly note: string;
}

export interface SwitchView {
  readonly id: PlayerId;
  readonly time: string;
  readonly trigger: string;
  readonly reason: string;
}

export interface StatView {
  readonly label: string;
  readonly value: string;
}

export interface SummaryView {
  readonly headline: string;
  readonly verdict: RoundSummary['verdict'];
  readonly result: string;
  readonly recorded: string;
  readonly bomb: string;
  readonly recordedBomb: string;
  readonly kills: readonly KillRowView[];
  readonly switches: readonly SwitchView[];
  /** "cart (you)" or "cart (watched)". */
  readonly player: string;
  readonly stats: readonly StatView[];
}

const LABELS: Readonly<Record<KillStatus, string>> = { same: 'same', shifted: 'Δt', missed: '✗', new: 'new' };

function resultText(r: RoundSummary['result']): string {
  if (r.winner === null || r.reason === null || r.endTick === null) return `round still on · ${r.score.ct}–${r.score.t}`;
  return `${resultShort(r.winner, r.reason)} · ${r.score.ct}–${r.score.t} at ${secText(r.endTick)} s`;
}

function bombText(b: RoundSummary['bomb']): string {
  if (b.plantTick === null) return 'not planted';
  const parts = [`planted ${secText(b.plantTick)} s`];
  if (b.defuseTick !== null) parts.push(`defused ${secText(b.defuseTick)} s${b.marginSec === null ? '' : `, ${fixed2(b.marginSec)} s left`}`);
  if (b.explodeTick !== null) parts.push(`exploded ${secText(b.explodeTick)} s${b.marginSec !== null && b.marginSec < 0 ? ` (the defuse needed ${fixed2(-b.marginSec)} s more)` : ''}`);
  return parts.join(' · ');
}

function noteOf(k: KillRow): string {
  if (k.status === 'shifted') return k.text;
  if (k.status === 'missed') return k.text.replace(/^didn't happen: /, '');
  if (k.status === 'new') return k.killer === null ? 'the bomb' : k.postRound ? 'after the round' : '';
  return k.postRound ? 'after the round' : '';
}

/** Display strings for a summary (teams from `teamOf`). */
export function summaryView(s: RoundSummary, teamOf: (id: PlayerId) => Team): SummaryView {
  const p = s.player;
  const rms = p.rmsFromRecording;
  const stats: StatView[] = [
    { label: 'Kills', value: String(p.kills) },
    { label: 'Damage', value: `${Math.round(p.damageDealt)} dealt · ${Math.round(p.damageTaken)} taken` },
    { label: 'Alive', value: `${fixed2(p.aliveSec)} s${p.deathTick === null ? '' : ` (died ${secText(p.deathTick)} s)`}` },
    { label: 'Off the recording', value: rms === null ? '–' : `${fixed2(rms / UNITS_PER_METRE)} m RMS` },
  ];
  return {
    headline: s.headline,
    verdict: s.verdict,
    result: resultText(s.result),
    recorded: resultText(s.recorded),
    bomb: bombText(s.bomb),
    recordedBomb: bombText(s.recordedBomb),
    kills: s.kills.map((k) => ({
      status: k.status,
      label: LABELS[k.status],
      killer: k.killer ?? 'bomb',
      killerTeam: k.killer === null ? null : teamOf(k.killer),
      victim: k.victim,
      victimTeam: teamOf(k.victim),
      recorded: k.recordedTick === null ? '–' : secText(k.recordedTick),
      run: k.runTick === null ? '–' : secText(k.runTick),
      note: noteOf(k),
    })),
    switches: s.switches.map((w) => ({ id: w.id, time: `${secText(w.tick)} s`, trigger: w.trigger ?? '', reason: w.reason })),
    player: `${p.id} (${p.human ? 'you' : 'watched'})`,
    stats,
  };
}

export interface SummaryCallbacks {
  readonly onRewind: () => void;
  readonly onRestart: () => void;
  /** Closed (Keep watching, the close button or Escape). */
  readonly onDismiss: () => void;
}

function cell(tag: string, text: string, cls = ''): HTMLElement {
  const e = document.createElement(tag);
  if (cls !== '') e.className = cls;
  e.textContent = text;
  return e;
}

/** Fills and shows `#summary` (index.html). */
export class SummaryOverlay {
  private readonly root: HTMLElement;
  private readonly cb: SummaryCallbacks;
  private readonly el: Record<'head' | 'result' | 'recorded' | 'bomb' | 'rbomb' | 'kills' | 'switches' | 'player' | 'stats', HTMLElement>;
  private view: SummaryView | null = null;

  constructor(root: HTMLElement, cb: SummaryCallbacks) {
    this.root = root;
    this.cb = cb;
    const q = (sel: string): HTMLElement => {
      const e = root.querySelector<HTMLElement>(sel);
      if (e === null) throw new Error(`summary: ${sel} missing`);
      return e;
    };
    this.el = {
      head: q('#sum-head'),
      result: q('#sum-result'),
      recorded: q('#sum-recorded'),
      bomb: q('#sum-bomb'),
      rbomb: q('#sum-rbomb'),
      kills: q('#sum-kills'),
      switches: q('#sum-switches'),
      player: q('#sum-player'),
      stats: q('#sum-stats'),
    };
    const click = (sel: string, f: () => void): void => {
      const b = q(sel);
      b.addEventListener('click', () => {
        f();
        b.blur();
      });
    };
    click('#sum-rewind', () => cb.onRewind());
    click('#sum-restart', () => cb.onRestart());
    click('#sum-keep', () => this.dismiss());
    click('#sum-close', () => this.dismiss());
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.open) this.dismiss();
    });
  }

  get open(): boolean {
    return !this.root.hidden;
  }

  /** The view last shown (tests, the console). */
  get current(): SummaryView | null {
    return this.view;
  }

  show(v: SummaryView): void {
    this.view = v;
    this.root.dataset['verdict'] = v.verdict;
    this.el.head.textContent = v.headline;
    this.el.result.textContent = v.result;
    this.el.recorded.textContent = v.recorded;
    this.el.bomb.textContent = v.bomb;
    this.el.rbomb.textContent = v.recordedBomb;
    this.el.kills.replaceChildren(
      ...v.kills.map((k) => {
        const tr = document.createElement('tr');
        tr.className = k.status;
        const who = document.createElement('td');
        who.className = 'who-cell';
        who.append(cell('span', k.killer, `who ${k.killerTeam === null ? 'world' : k.killerTeam.toLowerCase()}`), cell('span', ' → ', 'arrow'), cell('span', k.victim, `who ${k.victimTeam.toLowerCase()}`));
        tr.append(cell('td', k.label, 'st'), who, cell('td', k.recorded, 'num'), cell('td', k.run, 'num'), cell('td', k.note, 'note'));
        return tr;
      }),
    );
    this.el.switches.replaceChildren(
      ...(v.switches.length === 0
        ? [cell('li', 'Nobody: every bot replayed its recording.', 'empty')]
        : v.switches.map((w) => {
            const li = document.createElement('li');
            li.append(cell('span', w.time, 'at'), cell('b', w.id), cell('span', ` ${w.trigger}`, 'trig'), cell('span', ` · ${w.reason}`, 'why'));
            return li;
          })),
    );
    this.el.player.textContent = v.player;
    this.el.stats.replaceChildren(...v.stats.flatMap((s) => [cell('dt', s.label), cell('dd', s.value)]));
    this.root.hidden = false;
  }

  hide(): void {
    this.root.hidden = true;
  }

  private dismiss(): void {
    this.hide();
    this.cb.onDismiss();
  }
}

/** Ticks of the overlay delay. */
export const SUMMARY_DELAY_TICKS = Math.round(SUMMARY_DELAY_SEC * TICK_RATE);
