/**
 * Keeps browser shortcuts from ending a round (both pages). Ctrl is CS2's duck, so Ctrl+W (crouch forward) is
 * constant, and on Windows / Linux it is also "close tab", which a page can't block with preventDefault in Chromium
 * or Firefox. docs/app.md "Keys".
 *
 * - **Fullscreen + Keyboard Lock** (the fix): the ⛶ Fullscreen button puts the page in fullscreen and, where the
 *   browser has the Keyboard Lock API (Chromium: Chrome, Edge, Opera, Brave), locks the game keys and the Ctrl
 *   shortcut keys, so Ctrl+W / Ctrl+T / Ctrl+N reach the page (which blocks them: input.ts blocksShortcut) instead of
 *   the browser. With Escape locked the browser wants Esc **held** to leave fullscreen; a short Esc is the page's:
 *   `onEscape` (the 3D page frees the mouse, as Esc does outside fullscreen). Leaving fullscreen unlocks.
 * - **Leave-site guard** (everywhere): while the player controls a pawn a `beforeunload` handler asks first, so an
 *   accidental Ctrl+W outside fullscreen, in Safari or Firefox, or ⌘W on a Mac (which no page can capture) brings up
 *   the browser's "Leave site?" dialog instead of closing the tab.
 * - A one-line hint says which of these applies when fullscreen starts.
 */
import { keyLabel, type KeyBinds } from './input';

/** The keys locked in fullscreen: every letter, digit and the keys the game or Ctrl shortcuts use. Not ⌘ / Windows. */
export const KEYBOARD_LOCK_CODES: readonly string[] = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => `Key${c}`),
  ...'0123456789'.split('').map((d) => `Digit${d}`),
  ...'12345'.split('').map((d) => `Numpad${d}`),
  'Escape',
  'Tab',
  'Space',
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
  'AltLeft',
  'AltRight',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'BracketLeft',
  'BracketRight',
  'Backquote',
  'Minus',
  'Equal',
  'Semicolon',
  'Quote',
  'Comma',
  'Period',
  'Slash',
  'Backslash',
  'F5',
];

/** The browser's Keyboard Lock API (navigator.keyboard), when it has one. */
interface KeyboardLock {
  lock(codes?: readonly string[]): Promise<void>;
  unlock(): void;
}

export function keyboardLockApi(nav: unknown = typeof navigator === 'undefined' ? undefined : navigator): KeyboardLock | null {
  const k = (nav as { keyboard?: Partial<KeyboardLock> } | undefined)?.keyboard;
  return k !== undefined && typeof k.lock === 'function' && typeof k.unlock === 'function' ? (k as KeyboardLock) : null;
}

/** macOS / iOS: browser shortcuts are on ⌘, so Ctrl+W is free, and ⌘W can't be captured. */
export function isMacLike(nav: unknown = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  const n = nav as { platform?: string; userAgent?: string } | undefined;
  return /Mac|iPhone|iPad|iPod/.test(`${n?.platform ?? ''} ${n?.userAgent ?? ''}`);
}

/** The one-line hint when fullscreen starts. */
export function fullscreenHint(keyboardLocked: boolean, mac: boolean, binds: KeyBinds, pointerLock: boolean): string {
  const esc = pointerLock ? 'Esc frees the mouse; hold Esc to leave fullscreen.' : 'Hold Esc to leave fullscreen.';
  const duck = keyLabel(binds.duck, mac);
  if (keyboardLocked) return `Keyboard locked: ${duck}+W crouches forward, browser shortcuts are off. ${esc}`;
  const leave = 'Esc leaves fullscreen.';
  if (mac) return `⌘W still closes the tab (while you play the browser asks first). ${leave}`;
  if (binds.duck !== 'Control') return `This browser can't lock the keyboard; duck is on ${duck}, so Ctrl shortcuts don't matter. ${leave}`;
  return `This browser can't lock the keyboard: Ctrl+W may close the tab (while you play it asks first). Move Duck to C or Alt under Keys. ${leave}`;
}

export interface PlayGuardOptions {
  /** The ⛶ Fullscreen button (hidden where fullscreen isn't available, e.g. iPhone Safari). */
  readonly button: HTMLButtonElement | null;
  /** The hint line (hidden when empty). */
  readonly hint: HTMLElement | null;
  /** True while the player controls a pawn (the leave-site guard is on). */
  readonly playing: () => boolean;
  readonly binds: () => KeyBinds;
  /** Whether the page uses pointer lock (3D: short Esc frees the mouse). */
  readonly pointerLock: boolean;
  /** A short Esc press while the keyboard is locked (the browser no longer handles it). */
  readonly onEscape?: () => void;
  /** Fullscreen started or ended. */
  readonly onChange?: () => void;
}

const HINT_MS = 9000;

export class PlayGuard {
  private guarding = false;
  private locked = false;
  private hintTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly kb = keyboardLockApi();
  readonly mac = isMacLike();

  constructor(private readonly o: PlayGuardOptions) {
    const b = o.button;
    if (b !== null) {
      b.hidden = !document.fullscreenEnabled;
      b.addEventListener('click', () => {
        void this.toggle();
        b.blur();
      });
    }
    document.addEventListener('fullscreenchange', () => this.onFullscreenChange());
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.locked && !e.repeat) o.onEscape?.();
    });
    this.update();
  }

  get fullscreen(): boolean {
    return document.fullscreenElement !== null;
  }

  /** Whether Keyboard Lock is on now (fullscreen in a Chromium browser). */
  get keyboardLocked(): boolean {
    return this.locked;
  }

  /** Whether this browser has Keyboard Lock at all. */
  get keyboardLockAvailable(): boolean {
    return this.kb !== null;
  }

  /** Enter fullscreen (and lock the keyboard where possible), or leave it. Needs a user gesture to enter. */
  async toggle(): Promise<void> {
    if (this.fullscreen) {
      await document.exitFullscreen().catch(() => undefined);
      return;
    }
    try {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    } catch {
      return;
    }
    if (this.kb !== null) {
      try {
        await this.kb.lock(KEYBOARD_LOCK_CODES);
        this.locked = this.fullscreen;
      } catch {
        this.locked = false;
      }
    }
    this.showHint();
    this.o.onChange?.();
  }

  /** Call every frame (cheap): the leave-site guard follows `playing()`; the button shows the state. */
  update(): void {
    const on = this.o.playing();
    if (on !== this.guarding) {
      this.guarding = on;
      if (on) window.addEventListener('beforeunload', onBeforeUnload);
      else window.removeEventListener('beforeunload', onBeforeUnload);
    }
    const b = this.o.button;
    if (b !== null) {
      const fs = this.fullscreen;
      if (b.getAttribute('aria-pressed') !== String(fs)) {
        b.setAttribute('aria-pressed', String(fs));
        b.title = fs
          ? 'Leave fullscreen (or hold Esc)'
          : this.kb !== null
            ? 'Play fullscreen with the keyboard locked: Ctrl+W crouches forward instead of closing the tab'
            : 'Play fullscreen (this browser can’t lock the keyboard; see Keys to move Duck off Ctrl)';
      }
    }
  }

  /** Whether the leave-site guard is on (tests / automation). */
  get guarded(): boolean {
    return this.guarding;
  }

  private onFullscreenChange(): void {
    if (!this.fullscreen) {
      if (this.locked) this.kb?.unlock();
      this.locked = false;
      this.hideHint();
    }
    this.update();
    this.o.onChange?.();
  }

  private showHint(): void {
    const h = this.o.hint;
    if (h === null) return;
    h.textContent = fullscreenHint(this.locked, this.mac, this.o.binds(), this.o.pointerLock);
    h.hidden = false;
    if (this.hintTimer !== null) clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => this.hideHint(), HINT_MS);
  }

  private hideHint(): void {
    if (this.hintTimer !== null) clearTimeout(this.hintTimer);
    this.hintTimer = null;
    if (this.o.hint !== null) this.o.hint.hidden = true;
  }
}

/** "Leave site?": preventDefault (current browsers) plus returnValue (older Chromium / Safari). */
function onBeforeUnload(e: BeforeUnloadEvent): string {
  e.preventDefault();
  (e as { returnValue: unknown }).returnValue = '';
  return '';
}
