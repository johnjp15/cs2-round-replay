/**
 * DOM listeners behind input.ts: tracks which bound keys and mouse buttons are held and where the
 * cursor is over the canvas. All mapping lives in input.ts; this file only records events.
 *
 * - Keys by `KeyboardEvent.code`. Bound keys have their default action blocked while `active()`
 *   (a human is playing), except with ⌘ held, so browser shortcuts on the Mac keep working.
 *   Some Ctrl shortcuts (Ctrl+W, Ctrl+T, Ctrl+N on Windows/Linux) cannot be blocked: use C to crouch there.
 * - Mouse/pen pointers only; touch is ignored (no touch controls for the human yet).
 * - Everything is released when the window loses focus, so keys never stick.
 */
import { NO_CONTROLS, bindingForKey, bindingForMouseButton, type Binding, type HeldControl, type HeldControls, type WeaponSlot } from './input';
import type { Point2 } from './radar';

export interface InputDomOptions {
  /** True while input drives the human pawn. */
  readonly active: () => boolean;
  /** A weapon-slot key was pressed (not repeats). */
  readonly onSlot: (slot: WeaponSlot) => void;
}

export class InputDom {
  private readonly target: HTMLElement;
  private readonly options: InputDomOptions;
  private held: Record<HeldControl, boolean> = { ...NO_CONTROLS };
  private cursorCss: Point2 | null = null;
  private readonly off: (() => void)[] = [];

  constructor(target: HTMLElement, options: InputDomOptions) {
    this.target = target;
    this.options = options;
    this.listen(window, 'keydown', (e) => this.onKey(e as KeyboardEvent, true));
    this.listen(window, 'keyup', (e) => this.onKey(e as KeyboardEvent, false));
    this.listen(window, 'blur', () => this.release());
    this.listen(document, 'visibilitychange', () => {
      if (document.hidden) this.release();
    });
    this.listen(target, 'pointermove', (e) => this.onMove(e as PointerEvent));
    this.listen(target, 'pointerdown', (e) => this.onButton(e as PointerEvent, true));
    this.listen(target, 'pointerup', (e) => this.onButton(e as PointerEvent, false));
    this.listen(target, 'pointercancel', () => this.releaseMouse());
    this.listen(target, 'contextmenu', (e) => e.preventDefault());
  }

  /** What is held right now. */
  controls(): HeldControls {
    return { ...this.held };
  }

  /** Last mouse position over the canvas, in CSS px relative to it, or null before the mouse moved. */
  cursor(): Point2 | null {
    return this.cursorCss;
  }

  release(): void {
    this.held = { ...NO_CONTROLS };
  }

  dispose(): void {
    for (const f of this.off) f();
    this.off.length = 0;
  }

  private listen(t: EventTarget, type: string, f: (e: Event) => void): void {
    t.addEventListener(type, f);
    this.off.push(() => t.removeEventListener(type, f));
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (down && e.metaKey) {
      // macOS sends no keyup for keys released while ⌘ is down.
      this.release();
      return;
    }
    const b = bindingForKey(e.code);
    if (b === null) return;
    if (this.options.active()) e.preventDefault();
    this.apply(b, down, e.repeat);
  }

  private onMove(e: PointerEvent): void {
    if (e.pointerType === 'touch') return;
    const rect = this.target.getBoundingClientRect();
    this.cursorCss = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private onButton(e: PointerEvent, down: boolean): void {
    if (e.pointerType === 'touch') return;
    this.onMove(e);
    const b = bindingForMouseButton(e.button);
    if (b === null) return;
    if (this.options.active()) e.preventDefault();
    if (down) this.target.setPointerCapture(e.pointerId);
    this.apply(b, down, false);
  }

  private releaseMouse(): void {
    this.held.attack = false;
    this.held.attack2 = false;
  }

  private apply(b: Binding, down: boolean, repeat: boolean): void {
    if (b.kind === 'hold') {
      this.held[b.control] = down;
    } else if (down && !repeat) {
      this.options.onSlot(b.slot);
    }
  }
}
