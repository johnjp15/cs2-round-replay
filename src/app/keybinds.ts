/**
 * The key-binding setting (both pages): which keys duck, walk, jump and use (input.ts keyMapFor). Kept in
 * localStorage under one key shared by the 2D and 3D pages, read and written the way the 3D page keeps its settings
 * (JSON, a missing or broken entry = the defaults, no storage = the defaults for this visit).
 *
 * Why: Ctrl is CS2's duck, and Ctrl+W (crouch forward) is a browser shortcut on Windows and Linux. Chromium-based
 * browsers in fullscreen get Keyboard Lock (play-guard.ts) and keep Ctrl; elsewhere a player can move duck to C or
 * Alt here. docs/app.md "Keys".
 */
import { DEFAULT_KEY_BINDS, parseKeyBinds, rebind, type KeyBinds, type RebindableControl } from './input';

export const KEY_BINDS_STORAGE_KEY = 'cs2-sim-keybinds';

/** The part of `Storage` the store needs (tests pass a Map-backed fake). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The page's storage, or null when there is none (private mode, blocked cookies). */
export function pageStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export class KeyBindsStore {
  private current: KeyBinds;
  private readonly listeners: ((b: KeyBinds) => void)[] = [];

  constructor(private readonly storage: KeyValueStorage | null) {
    this.current = KeyBindsStore.load(storage);
  }

  static load(storage: KeyValueStorage | null): KeyBinds {
    try {
      const raw = storage?.getItem(KEY_BINDS_STORAGE_KEY) ?? null;
      return raw === null ? DEFAULT_KEY_BINDS : parseKeyBinds(JSON.parse(raw));
    } catch {
      return DEFAULT_KEY_BINDS;
    }
  }

  get binds(): KeyBinds {
    return this.current;
  }

  /** Put `control` on the key of `code` (a swap if another control had it); false when the key can't be bound. */
  set(control: RebindableControl, code: string): boolean {
    const next = rebind(this.current, control, code);
    if (next === null) return false;
    this.apply(next);
    return true;
  }

  reset(): void {
    this.apply(DEFAULT_KEY_BINDS);
  }

  onChange(f: (b: KeyBinds) => void): void {
    this.listeners.push(f);
  }

  private apply(b: KeyBinds): void {
    this.current = b;
    try {
      if (b === DEFAULT_KEY_BINDS) this.storage?.removeItem(KEY_BINDS_STORAGE_KEY);
      else this.storage?.setItem(KEY_BINDS_STORAGE_KEY, JSON.stringify(b));
    } catch {
      // Storage full or blocked: the binds hold for this visit.
    }
    for (const f of this.listeners) f(b);
  }
}
