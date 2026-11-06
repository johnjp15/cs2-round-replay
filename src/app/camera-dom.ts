/**
 * Camera gestures on the canvas: mouse wheel zooms about the cursor, drag pans, two-finger pinch zooms
 * and pans, double-click / double-tap returns to the full map. The camera maths is in camera.ts; this
 * file only reads events and calls back.
 *
 * Mouse drag uses the left button only while the human isn't playing (the left button fires); the
 * middle button pans at any time. Touch pans and pinches always (spectating on a phone). input-dom.ts
 * ignores touch and the middle button, so the two listeners never fight over a pointer.
 */
import { wheelFactor } from './camera';
import type { Point2 } from './radar';

export interface CameraInputOptions {
  /** True while mouse buttons drive the human pawn (left = fire). */
  readonly playing: () => boolean;
  readonly onZoom: (at: Point2, factor: number) => void;
  readonly onPan: (dx: number, dy: number) => void;
  readonly onReset: () => void;
}

/** Two-finger tap gap / double-tap window (ms) and slop (px). */
const DOUBLE_TAP_MS = 320;
const TAP_SLOP_PX = 10;

export class CameraInput {
  private readonly target: HTMLElement;
  private readonly options: CameraInputOptions;
  /** Active pan/pinch pointers by id, in canvas CSS px. */
  private readonly pointers = new Map<number, Point2>();
  private readonly off: (() => void)[] = [];
  private lastTap: { at: Point2; time: number } | null = null;
  private downAt: Point2 | null = null;
  private moved = false;

  constructor(target: HTMLElement, options: CameraInputOptions) {
    this.target = target;
    this.options = options;
    this.listen('wheel', (e) => this.onWheel(e as WheelEvent), { passive: false });
    this.listen('pointerdown', (e) => this.onDown(e as PointerEvent));
    this.listen('pointermove', (e) => this.onMove(e as PointerEvent));
    this.listen('pointerup', (e) => this.onUp(e as PointerEvent));
    this.listen('pointercancel', (e) => this.pointers.delete((e as PointerEvent).pointerId));
    this.listen('dblclick', (e) => {
      if (!this.options.playing()) {
        e.preventDefault();
        this.options.onReset();
      }
    });
  }

  /** True while a pan or pinch is in progress. */
  get dragging(): boolean {
    return this.pointers.size > 0;
  }

  dispose(): void {
    for (const f of this.off) f();
    this.off.length = 0;
  }

  private listen(type: string, f: (e: Event) => void, opts?: AddEventListenerOptions): void {
    this.target.addEventListener(type, f, opts);
    this.off.push(() => this.target.removeEventListener(type, f, opts));
  }

  private local(e: { clientX: number; clientY: number }): Point2 {
    const rect = this.target.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    // Pixel deltas from trackpads are small and many; line/page deltas come from wheels.
    const scale = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
    const dy = e.deltaY * scale;
    // Trackpad pinch arrives as ctrl+wheel with small deltas: make it as quick as a wheel notch.
    this.options.onZoom(this.local(e), wheelFactor(e.ctrlKey ? dy * 4 : dy));
  }

  private pans(e: PointerEvent): boolean {
    if (e.pointerType === 'touch') return true;
    if (e.button === 1) return true;
    return e.button === 0 && !this.options.playing();
  }

  private onDown(e: PointerEvent): void {
    if (!this.pans(e)) return;
    if (e.button === 1) e.preventDefault();
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    this.target.setPointerCapture(e.pointerId);
    if (this.pointers.size === 1) {
      this.downAt = p;
      this.moved = false;
    } else {
      this.moved = true;
    }
  }

  private onMove(e: PointerEvent): void {
    const before = this.pointers.get(e.pointerId);
    if (before === undefined) return;
    const now = this.local(e);
    if (this.pointers.size === 1) {
      this.pointers.set(e.pointerId, now);
      if (this.downAt !== null && Math.hypot(now.x - this.downAt.x, now.y - this.downAt.y) > TAP_SLOP_PX) this.moved = true;
      this.options.onPan(now.x - before.x, now.y - before.y);
      return;
    }
    // Pinch: zoom by the change in finger spread about the midpoint, and pan by the midpoint's move.
    const others = [...this.pointers.entries()].filter(([id]) => id !== e.pointerId);
    const other = others[0]?.[1];
    this.pointers.set(e.pointerId, now);
    if (other === undefined) return;
    const d0 = Math.hypot(before.x - other.x, before.y - other.y);
    const d1 = Math.hypot(now.x - other.x, now.y - other.y);
    const m0 = { x: (before.x + other.x) / 2, y: (before.y + other.y) / 2 };
    const m1 = { x: (now.x + other.x) / 2, y: (now.y + other.y) / 2 };
    if (d0 > 4 && d1 > 4) this.options.onZoom(m1, d1 / d0);
    this.options.onPan(m1.x - m0.x, m1.y - m0.y);
  }

  private onUp(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    if (e.pointerType !== 'touch' || this.pointers.size > 0 || this.moved) {
      if (this.pointers.size === 0) this.downAt = null;
      return;
    }
    // A touch tap: two in a row near each other reset the view (dblclick does this for mice).
    const at = this.local(e);
    const now = e.timeStamp;
    const last = this.lastTap;
    if (last !== null && now - last.time < DOUBLE_TAP_MS && Math.hypot(at.x - last.at.x, at.y - last.at.y) < TAP_SLOP_PX * 3) {
      this.lastTap = null;
      this.options.onReset();
    } else {
      this.lastTap = { at, time: now };
    }
    this.downAt = null;
  }
}
