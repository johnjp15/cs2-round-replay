/**
 * The timeline scrubber under the map (B5): where the round is, the checkpoints, the round end and the human's
 * replayable future ("tape"); drag or tap it to seek, `[` / `]` for ±5 s. The mapping is pure and tested
 * (tests/timeline.test.ts); `TimelineDom` is the thin DOM layer the app wires to Session.beginSeek.
 */
import { TICK_RATE } from '../core/index';

/** Ticks the timeline spans: the longest recorded track plus the hold, like the golden master (4,517 = 70.6 s). */
export function timelineSpanTicks(trackEndTicks: readonly number[], holdLastPositionSec: number): number {
  let end = 0;
  for (const t of trackEndTicks) if (t > end) end = t;
  return end + Math.round(holdLastPositionSec * TICK_RATE) + 2;
}

/** 0..1 along the bar for a tick (clamped). */
export function tickToFraction(tick: number, span: number): number {
  if (span <= 0) return 0;
  const f = tick / span;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/** The tick at a fraction of the bar (clamped to 0..span, whole ticks). */
export function fractionToTick(f: number, span: number): number {
  const c = f < 0 ? 0 : f > 1 ? 1 : f;
  return Math.round(c * span);
}

/** The tick under a pointer at `clientX` over a bar starting at `left` and `width` px wide. */
export function pointerToTick(clientX: number, left: number, width: number, span: number): number {
  return width <= 0 ? 0 : fractionToTick((clientX - left) / width, span);
}

/** CSS percentage (3 decimals) for a tick: `left` of a mark, `width` of the fill. */
export function percentOf(tick: number, span: number): string {
  return `${Math.round(tickToFraction(tick, span) * 100_000) / 1000}%`;
}

/** Video time m:ss.t of a tick ("0:44.6"). */
export function formatVideoTime(tick: number): string {
  const tenths = Math.floor((Math.max(0, tick) * 10) / TICK_RATE + 1e-9);
  const sec = Math.floor(tenths / 10);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}.${tenths % 10}`;
}

/** Seconds to seek by for a key (`[` back 5 s, `]` ahead 5 s), else null. */
export function seekStepForKey(code: string): number | null {
  if (code === 'BracketLeft') return -5;
  if (code === 'BracketRight') return 5;
  return null;
}

/** The seek target (video seconds, ≥ 0) `delta` seconds from `tick`. */
export function stepTarget(tick: number, deltaSec: number): number {
  return Math.max(0, tick / TICK_RATE + deltaSec);
}

/** How far a seek's forward stepping has got, 0..1, from the tick it began stepping at (1 when there is none). */
export function seekFraction(start: number, target: number, tick: number): number {
  const total = target - start;
  if (total <= 0) return 1;
  const f = (tick - start) / total;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/** One checkpoint mark. */
export interface TimelineMark {
  readonly tick: number;
  readonly auto: boolean;
}

/** What the bar shows on a frame. */
export interface TimelineView {
  readonly tick: number;
  readonly span: number;
  readonly marks: readonly TimelineMark[];
  /** The round end (observe tick), or null. */
  readonly endTick: number | null;
  /** The human's replayable future reaches this tick, or null. */
  readonly tapeEnd: number | null;
  /** A seek in progress: its target and 0..1 progress; null when none. */
  readonly seek: { readonly target: number; readonly fraction: number } | null;
}

export interface TimelineCallbacks {
  /** Seek to a tick (pointer released on the bar, or a key on the focused bar). */
  readonly onSeek: (tick: number) => void;
}

/**
 * DOM: `#timeline` holds `#scrub` (role slider) with the fill, tape, marks, end mark and thumb, and `#scrub-time`.
 * Dragging shows the target (thumb and time) and seeks on release; a tap seeks at once. Arrow keys on the focused
 * bar seek ±1 s, Page keys ±5 s, Home / End to the ends.
 */
export class TimelineDom {
  private readonly bar: HTMLElement;
  /** The visible track inside the bar's padding: pointer positions map onto it, like the marks. */
  private readonly track: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly tape: HTMLElement;
  private readonly marks: HTMLElement;
  private readonly end: HTMLElement;
  private readonly thumb: HTMLElement;
  private readonly time: HTMLElement;
  private readonly cb: TimelineCallbacks;
  private drag: number | null = null;
  private dragTick = 0;
  private span = 1;
  private tick = 0;
  private marksKey = '';
  private text = '';

  constructor(root: HTMLElement, cb: TimelineCallbacks) {
    const q = (sel: string): HTMLElement => {
      const e = root.querySelector<HTMLElement>(sel);
      if (e === null) throw new Error(`timeline: ${sel} missing`);
      return e;
    };
    this.bar = q('#scrub');
    this.track = q('.scrub-track');
    this.fill = q('.scrub-fill');
    this.tape = q('.scrub-tape');
    this.marks = q('.scrub-marks');
    this.end = q('.scrub-end');
    this.thumb = q('.scrub-thumb');
    this.time = q('#scrub-time');
    this.cb = cb;
    this.bar.addEventListener('pointerdown', (e) => this.onDown(e));
    this.bar.addEventListener('pointermove', (e) => this.onMove(e));
    this.bar.addEventListener('pointerup', (e) => this.onUp(e));
    this.bar.addEventListener('pointercancel', () => {
      this.drag = null;
    });
    this.bar.addEventListener('keydown', (e) => this.onKey(e));
  }

  /** True while a finger or mouse drags the thumb. */
  get dragging(): boolean {
    return this.drag !== null;
  }

  update(v: TimelineView): void {
    this.span = v.span;
    this.tick = v.tick;
    const shown = this.drag !== null ? this.dragTick : v.seek !== null ? v.seek.target : v.tick;
    this.fill.style.width = percentOf(v.tick, v.span);
    const tapeFrom = v.tick;
    const tapeTo = v.tapeEnd === null ? v.tick : Math.max(v.tick, v.tapeEnd);
    this.tape.style.left = percentOf(tapeFrom, v.span);
    this.tape.style.width = percentOf(tapeTo - tapeFrom, v.span);
    this.thumb.style.left = percentOf(shown, v.span);
    this.end.hidden = v.endTick === null;
    if (v.endTick !== null) this.end.style.left = percentOf(v.endTick, v.span);
    const key = v.marks.map((m) => `${m.tick}${m.auto ? 'a' : 'm'}`).join(',') + `/${v.span}`;
    if (key !== this.marksKey) {
      this.marksKey = key;
      this.marks.replaceChildren(
        ...v.marks.map((m) => {
          const i = document.createElement('i');
          i.className = m.auto ? 'mark' : 'mark mine';
          i.style.left = percentOf(m.tick, v.span);
          return i;
        }),
      );
    }
    const text = v.seek !== null ? `Seeking ${Math.round(v.seek.fraction * 100)}%` : `${formatVideoTime(shown)} / ${formatVideoTime(v.span)}`;
    if (text !== this.text) {
      this.text = text;
      this.time.textContent = text;
    }
    this.bar.setAttribute('aria-valuenow', (shown / TICK_RATE).toFixed(1));
    this.bar.setAttribute('aria-valuemax', (v.span / TICK_RATE).toFixed(1));
    this.bar.setAttribute('aria-valuetext', formatVideoTime(shown));
    this.bar.dataset['seeking'] = String(v.seek !== null);
  }

  private tickAt(e: PointerEvent): number {
    const r = this.track.getBoundingClientRect();
    return pointerToTick(e.clientX, r.left, r.width, this.span);
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    this.drag = e.pointerId;
    this.dragTick = this.tickAt(e);
    this.bar.setPointerCapture(e.pointerId);
    this.bar.focus({ preventScroll: true });
  }

  private onMove(e: PointerEvent): void {
    if (this.drag !== e.pointerId) return;
    this.dragTick = this.tickAt(e);
  }

  private onUp(e: PointerEvent): void {
    if (this.drag !== e.pointerId) return;
    this.dragTick = this.tickAt(e);
    this.drag = null;
    this.cb.onSeek(this.dragTick);
  }

  private onKey(e: KeyboardEvent): void {
    const sec = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : e.key === 'PageDown' ? -5 : e.key === 'PageUp' ? 5 : null;
    // Keep the keys from the window listeners (arrows also move cart).
    if (sec !== null) {
      e.preventDefault();
      e.stopPropagation();
      this.cb.onSeek(Math.round(stepTarget(this.tick, sec) * TICK_RATE));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      e.stopPropagation();
      this.cb.onSeek(e.key === 'Home' ? 0 : this.span);
    }
  }
}
