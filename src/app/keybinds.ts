/**
 * The key-binding setting (both pages): which keys duck, walk, jump and use (input.ts keyMapFor). Kept in
 * localStorage under one key shared by the 2D and 3D pages, read and written the way the 3D page keeps its settings
 * (JSON, a missing or broken entry = the defaults, no storage = the defaults for this visit).
 *
 * Why: Ctrl is CS2's duck, and Ctrl+W (crouch forward) is a browser shortcut on Windows and Linux. Chromium-based
 * browsers in fullscreen get Keyboard Lock (play-guard.ts) and keep Ctrl; elsewhere a player can move duck to C or
 * Alt here. docs/app.md "Keys".
 */
import { DEFAULT_KEY_BINDS, bindKeyOf, canBindKey, parseKeyBinds, rebind, type KeyBinds, type RebindableControl } from './input';

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

// ---- U2: page keys (not pawn controls): the key that always takes control of cart -----------------------------------

/** U2: the page's own rebindable keys, kept apart from the pawn controls (they only act while watching). */
export interface PageKeys {
  /** Takes control of cart while watching, whoever is spectated (default C; while playing C stays the extra duck key). */
  readonly takeCart: string;
}

export const DEFAULT_PAGE_KEYS: PageKeys = { takeCart: 'KeyC' };
export const PAGE_KEYS_STORAGE_KEY = 'cs2-sim-pagekeys';

/**
 * Whether `code` can be the take-cart key given the pawn binds: a key a pawn control could take (input.ts canBindKey:
 * not a fixed or page key), not a modifier, and not the Use or Jump key (E takes the spectated player, Space cycles
 * players while watching). The duck key may share it: duck only acts while playing, take-cart only while watching.
 */
export function canBindPageKey(code: string, binds: KeyBinds): boolean {
  const key = bindKeyOf(code);
  return key === code && canBindKey(key) && key !== binds.use && key !== binds.jump && key !== 'Space';
}

/** Stored page keys (JSON, maybe old or hand-edited) → valid ones: an unbindable key keeps its default. */
export function parsePageKeys(raw: unknown, binds: KeyBinds = DEFAULT_KEY_BINDS): PageKeys {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_PAGE_KEYS;
  const v = (raw as { readonly [k: string]: unknown })['takeCart'];
  return typeof v === 'string' && canBindPageKey(v, binds) ? { takeCart: v } : DEFAULT_PAGE_KEYS;
}

/** The page keys in localStorage (same rules as KeyBindsStore). */
export class PageKeysStore {
  private current: PageKeys;
  private readonly listeners: ((k: PageKeys) => void)[] = [];

  constructor(
    private readonly storage: KeyValueStorage | null,
    private readonly binds: () => KeyBinds = () => DEFAULT_KEY_BINDS,
  ) {
    let k = DEFAULT_PAGE_KEYS;
    try {
      const raw = storage?.getItem(PAGE_KEYS_STORAGE_KEY) ?? null;
      if (raw !== null) k = parsePageKeys(JSON.parse(raw), binds());
    } catch {
      k = DEFAULT_PAGE_KEYS;
    }
    this.current = k;
  }

  get keys(): PageKeys {
    return this.current;
  }

  /** The take-cart key on `code`; false when it can't be bound. */
  setTakeCart(code: string): boolean {
    if (!canBindPageKey(code, this.binds())) return false;
    this.apply({ takeCart: code });
    return true;
  }

  reset(): void {
    this.apply(DEFAULT_PAGE_KEYS);
  }

  onChange(f: (k: PageKeys) => void): void {
    this.listeners.push(f);
  }

  private apply(k: PageKeys): void {
    this.current = k;
    try {
      if (k.takeCart === DEFAULT_PAGE_KEYS.takeCart) this.storage?.removeItem(PAGE_KEYS_STORAGE_KEY);
      else this.storage?.setItem(PAGE_KEYS_STORAGE_KEY, JSON.stringify(k));
    } catch {
      // Storage full or blocked: the key holds for this visit.
    }
    for (const f of this.listeners) f(k);
  }
}
