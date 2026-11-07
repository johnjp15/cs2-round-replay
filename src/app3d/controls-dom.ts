/**
 * H1: the DOM side of the first-person controls: held keys and mouse buttons (src/app/input.ts bindings), mouse
 * movement under pointer lock, and the extra keys of the 3D page. The mapping to PawnInput is input3d.ts.
 *
 * Keys go through `keyMap` (the key-binding setting, src/app/keybinds.ts). Bound keys never do their browser default;
 * while the player controls a pawn neither does any Ctrl combination (src/app/input.ts blocksShortcut: Ctrl is duck,
 * Ctrl+W crouch forward). Chromium and Firefox still act on Ctrl+W / Ctrl+T / Ctrl+N unless the keyboard is locked in
 * fullscreen: src/app/play-guard.ts.
 */
import { DEFAULT_KEY_MAP, NO_CONTROLS, blocksShortcut, bindingForKey, bindingForMouseButton, type Binding, type HeldControl, type HeldControls, type WeaponSlot } from '../app/input';

export interface ControlsHooks {
  /** A weapon slot press (1–5). */
  onSlot(slot: WeaponSlot): void;
  /** A key the page handles itself (E while watching, V, Z / X, P, …): return true to swallow it. */
  onKey(code: string): boolean;
  /** Mouse 1 went down (with pointer lock or not). */
  onFire(): void;
  /** Mouse 2 went down (the scope). */
  onAttack2(): void;
  /** True while the player controls a pawn (Ctrl combinations are then moves, not browser shortcuts). */
  playing?(): boolean;
}

export class ControlsDom {
  private held: Record<HeldControl, boolean> = { ...NO_CONTROLS };
  private dx = 0;
  private dy = 0;
  /** Mouse counts moved since the last take (tests and automation add to it too). */
  readonly element: HTMLElement;
  private map: ReadonlyMap<string, Binding> = DEFAULT_KEY_MAP;

  constructor(element: HTMLElement, hooks: ControlsHooks) {
    this.element = element;
    window.addEventListener('keydown', (e) => {
      if (e.metaKey) {
        // macOS sends no keyup for keys released while ⌘ is down.
        this.release();
        return;
      }
      const b = bindingForKey(e.code, this.map);
      // Bound keys never scroll or search; Ctrl+anything is a move while playing (Ctrl+W = crouch forward).
      if (b !== null || blocksShortcut(e, false, hooks.playing?.() ?? false)) e.preventDefault();
      if (!e.repeat && hooks.onKey(e.code)) {
        e.preventDefault();
        return;
      }
      if (b === null) return;
      if (b.kind === 'hold') this.held[b.control] = true;
      else if (!e.repeat) hooks.onSlot(b.slot);
    });
    window.addEventListener('keyup', (e) => {
      const b = bindingForKey(e.code, this.map);
      if (b === null) return;
      e.preventDefault();
      if (b.kind === 'hold') this.held[b.control] = false;
    });
    window.addEventListener('blur', () => this.release());
    element.addEventListener('mousedown', (e) => {
      const b = bindingForMouseButton(e.button);
      if (b !== null && b.kind === 'hold') {
        this.held[b.control] = true;
        if (b.control === 'attack') hooks.onFire();
        if (b.control === 'attack2') hooks.onAttack2();
      }
      if (document.pointerLockElement !== element) void this.lock();
    });
    window.addEventListener('mouseup', (e) => {
      const b = bindingForMouseButton(e.button);
      if (b !== null && b.kind === 'hold') this.held[b.control] = false;
    });
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== element) return;
      this.dx += e.movementX;
      this.dy += e.movementY;
    });
  }

  /** Whether the last lock got raw (unadjusted) mouse movement. */
  raw = false;

  /**
   * Ask for pointer lock (it needs a user gesture; failures are ignored: the mouse then doesn't turn the view). First
   * with `unadjustedMovement: true` (Chromium: raw counts, the OS pointer acceleration bypassed, like CS2's raw input),
   * else plain (Safari and Firefox ignore or reject the option: their deltas are the OS-accelerated pointer's pixels;
   * with acceleration off and 1:1 scaling one pixel is one count).
   */
  async lock(): Promise<void> {
    const el = this.element as HTMLElement & { requestPointerLock(o?: { unadjustedMovement?: boolean }): Promise<void> | void };
    try {
      const r = el.requestPointerLock({ unadjustedMovement: true }) as unknown;
      if (r instanceof Promise) await r;
      this.raw = true;
      return;
    } catch {
      // Not supported (NotSupportedError) or not allowed now: try without.
    }
    try {
      const r = el.requestPointerLock() as unknown;
      if (r instanceof Promise) await r;
      this.raw = false;
    } catch {
      // Not allowed now (no gesture, or the user pressed Esc a moment ago).
    }
  }

  /** Key → control (the key-binding setting); setting it lets go of every held key. */
  get keyMap(): ReadonlyMap<string, Binding> {
    return this.map;
  }

  set keyMap(m: ReadonlyMap<string, Binding>) {
    this.map = m;
    this.release();
  }

  get locked(): boolean {
    return document.pointerLockElement === this.element;
  }

  controls(): HeldControls {
    return { ...this.held };
  }

  /** Mouse movement since the last call (counts), then reset. */
  takeMouse(): { dx: number; dy: number } {
    const m = { dx: this.dx, dy: this.dy };
    this.dx = 0;
    this.dy = 0;
    return m;
  }

  /** Automation (tools/browser-check3d.ts): add mouse movement as if the pointer were locked. */
  addMouse(dx: number, dy: number): void {
    this.dx += dx;
    this.dy += dy;
  }

  /** Let go of every key and button (focus lost, takeover, death). */
  release(): void {
    this.held = { ...NO_CONTROLS };
  }
}
