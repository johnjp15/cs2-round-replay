/**
 * W1 (#49): the 3D page's round hotkeys (pure part; tested in Node; the buttons are hotkeys-dom.ts). John: "add
 * hotkeys to start, pause, and restart the round. Ideally these should not be accidentally pressable so pick keys
 * wisely."
 *
 * - Start = Enter, Pause / Resume = P (the page's pause key since H1; CS2 binds nothing to P), Restart = Backspace
 *   pressed **twice within 1 s** (one accidental tap does nothing). All three are far from a hand on WASD and the
 *   mouse, and none is a CS2 default bind (CS2: WASD, E, Q, F, G, R, B, C, 1–5, Space, Ctrl, Shift, Tab, …).
 * - Rebindable under Keys (click, press a key). A key a control of the game has (the movement and weapon keys, the
 *   rebindable duck / walk / jump / use, the spectator's V / Z / X) or a key the browser needs (Esc, Tab, ⌘, F11,
 *   F12) can't be taken; two hotkeys can't share a key (the other one moves to the old key: a swap).
 * - They work while the pointer is locked (key events still reach the page; in fullscreen Keyboard Lock keeps them
 *   from the browser, play-guard.ts).
 */

export type PageHotkey = 'start' | 'pause' | 'restart';
export const PAGE_HOTKEYS: readonly PageHotkey[] = ['start', 'pause', 'restart'];

/** A `KeyboardEvent.code` per hotkey. */
export type Hotkeys = { readonly [K in PageHotkey]: string };

export const DEFAULT_HOTKEYS: Hotkeys = { start: 'Enter', pause: 'KeyP', restart: 'Backspace' };

/** Restart needs a second press of its key within this long (ms). */
export const RESTART_DOUBLE_MS = 1000;

export const HOTKEY_NAMES: { readonly [K in PageHotkey]: string } = { start: 'Start', pause: 'Pause', restart: 'Restart' };

/**
 * Keys a hotkey can never take: everything a hand on WASD reaches and CS2's default binds (W A S D Q E R F G B C T Z
 * X V, 1–5, Space, Ctrl, Shift, Alt, Tab, Caps Lock, the backquote console key), the arrows (movement here), Esc, ⌘ /
 * the OS key and the browser's F11 / F12.
 */
const NEVER: ReadonlySet<string> = new Set([
  ...'WASDQERFGBCTZXV'.split('').map((c) => `Key${c}`),
  ...[1, 2, 3, 4, 5].map((n) => `Digit${n}`),
  'Space',
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'OSLeft',
  'OSRight',
  'Tab',
  'CapsLock',
  'Backquote',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ContextMenu',
  'F11',
  'F12',
]);

/** Whether `code` can be a hotkey, given the game's key map (`bound`: codes a control of the game has). */
export function canBindHotkey(code: string, bound: (code: string) => boolean = () => false): boolean {
  if (code === '' || code === 'Unidentified' || NEVER.has(code)) return false;
  return !bound(code);
}

/** The hotkeys with `k` on `code` (a swap if another hotkey had it), or null when the key can't be one. */
export function rebindHotkey(h: Hotkeys, k: PageHotkey, code: string, bound?: (code: string) => boolean): Hotkeys | null {
  if (!canBindHotkey(code, bound)) return null;
  const next: { [K in PageHotkey]: string } = { ...h };
  const other = PAGE_HOTKEYS.find((o) => o !== k && h[o] === code);
  if (other !== undefined) next[other] = h[k];
  next[k] = code;
  return next;
}

/** Stored hotkeys (settings JSON) → valid ones: a bad entry keeps its default; a clash → all defaults. */
export function parseHotkeys(raw: unknown): Hotkeys {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_HOTKEYS;
  const r = raw as { readonly [k: string]: unknown };
  const h: { [K in PageHotkey]: string } = { ...DEFAULT_HOTKEYS };
  for (const k of PAGE_HOTKEYS) {
    const v = r[k];
    if (typeof v === 'string' && canBindHotkey(v)) h[k] = v;
  }
  return new Set(PAGE_HOTKEYS.map((k) => h[k])).size === PAGE_HOTKEYS.length ? h : DEFAULT_HOTKEYS;
}

/** A short label: Enter, P, Backspace, F5, Num 0… */
export function hotkeyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}

/** The tooltip text of a hotkey: "Enter", "P", "Backspace twice (within 1 s)". */
export function hotkeyHint(k: PageHotkey, code: string): string {
  return k === 'restart' ? `${hotkeyLabel(code)} twice (within ${RESTART_DOUBLE_MS / 1000} s)` : hotkeyLabel(code);
}

/** Key presses → hotkeys: Start and Pause on one press, Restart on the second press within RESTART_DOUBLE_MS. */
export class HotkeyMatcher {
  private restartAt: number | null = null;

  constructor(public keys: Hotkeys = DEFAULT_HOTKEYS) {}

  /** A key press (not a repeat) at `nowMs`: the hotkey it triggers, or null. `armed` is set while Restart waits. */
  press(code: string, nowMs: number): PageHotkey | null {
    const k = PAGE_HOTKEYS.find((h) => this.keys[h] === code) ?? null;
    if (k !== 'restart') {
      if (k !== null) this.restartAt = null;
      return k;
    }
    if (this.restartAt !== null && nowMs - this.restartAt <= RESTART_DOUBLE_MS && nowMs >= this.restartAt) {
      this.restartAt = null;
      return 'restart';
    }
    this.restartAt = nowMs;
    return null;
  }

  /** True while one Restart press waits for its second. */
  armed(nowMs: number): boolean {
    return this.restartAt !== null && nowMs - this.restartAt <= RESTART_DOUBLE_MS;
  }
}
