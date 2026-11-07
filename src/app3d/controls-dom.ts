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
  /** True while fullscreen Keyboard Lock is on (Ctrl+W / S / T / N are then blocked even when watching). */
  keyboardLocked?(): boolean;
  /** W1 (#40): a wheel notch over the game while playing or under pointer lock (deltaY > 0 = down). */
  onWheel?(deltaY: number): void;
}

/**
 * W1 (#35, #53): zooming the page by Ctrl / ⌘ + wheel or a trackpad pinch never happens on the game page: Chromium
 * and Firefox send a pinch as a `wheel` with ctrlKey, Safari as `gesture*` events. Both are cancelled (listeners
 * must be non-passive: a window wheel listener is passive by default in Chromium).
 */
export function blocksWheelZoom(e: { readonly ctrlKey: boolean; readonly metaKey: boolean }): boolean {
  return e.ctrlKey || e.metaKey;
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
      if (b !== null || blocksShortcut(e, false, hooks.playing?.() ?? false, hooks.keyboardLocked?.() ?? false)) e.preventDefault();
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
    // W1 (#35, #53): no page zoom from Ctrl / ⌘ + wheel or a pinch, anywhere on the page; under pointer lock (or over
    // the view while playing) the wheel is the game's: no scrolling, and a notch may jump (onWheel).
    window.addEventListener(
      'wheel',
      (e) => {
        if (blocksWheelZoom(e)) e.preventDefault();
        const mine = document.pointerLockElement === element || (e.target === element && (hooks.playing?.() ?? false));
        if (!mine) return;
        e.preventDefault();
        if (e.deltaY !== 0) hooks.onWheel?.(e.deltaY);
      },
      { passive: false, capture: true },
    );
    for (const g of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(g, (e) => e.preventDefault(), { passive: false });
    // W1 (#53): Ctrl+W (crouch forward) never closes the tab where a page can stop it: cancelled in the capture phase
    // before anything else sees it (Chromium honours this only under fullscreen Keyboard Lock, play-guard.ts). Not
    // stopped: the movement listener below still needs the W.
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.ctrlKey && !e.metaKey && (e.code === 'KeyW' || e.code === 'KeyS')) e.preventDefault();
      },
      { capture: true },
    );
    // P1: mouse movement at the device's event rate: `pointerrawupdate` (Chromium, secure pages) isn't coalesced to
    // the display's frames like mousemove, so an uncapped frame loop turns the view with the newest counts. Only one of
    // the two is listened to (they report the same movement).
    const move = (e: MouseEvent): void => {
      if (document.pointerLockElement !== element) return;
      this.dx += e.movementX;
      this.dy += e.movementY;
    };
    this.rawEvents = 'onpointerrawupdate' in window && window.isSecureContext;
    document.addEventListener(this.rawEvents ? ('pointerrawupdate' as 'pointermove') : 'mousemove', move);
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

  /** Mouse movement comes from `pointerrawupdate` (event rate) rather than mousemove. */
  rawEvents = false;

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
