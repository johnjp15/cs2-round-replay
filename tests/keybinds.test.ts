import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_KEY_BINDS,
  DEFAULT_KEY_MAP,
  bindKeyOf,
  blocksShortcut,
  bindingForKey,
  canBindKey,
  keyLabel,
  keyMapFor,
  parseKeyBinds,
  rebind,
  type KeyBinds,
} from '../src/app/input';
import { KEY_BINDS_STORAGE_KEY, KeyBindsStore, type KeyValueStorage } from '../src/app/keybinds';
import { InputDom } from '../src/app/input-dom';
import { ControlsDom } from '../src/app3d/controls-dom';
import { KEYBOARD_LOCK_CODES, fullscreenHint, isMacLike, keyboardLockApi } from '../src/app/play-guard';

class MemoryStorage implements KeyValueStorage {
  readonly m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

describe('key map and rebinding', () => {
  it('defaults: Ctrl (either side) and C duck, Shift walk, Space jump, E use', () => {
    expect(bindingForKey('ControlLeft')).toEqual({ kind: 'hold', control: 'duck' });
    expect(bindingForKey('ControlRight')).toEqual({ kind: 'hold', control: 'duck' });
    expect(bindingForKey('KeyC')).toEqual({ kind: 'hold', control: 'duck' });
    expect(bindingForKey('ShiftRight')).toEqual({ kind: 'hold', control: 'walk' });
    expect(bindingForKey('Space')).toEqual({ kind: 'hold', control: 'jump' });
    expect(bindingForKey('KeyE')).toEqual({ kind: 'hold', control: 'use' });
    expect(bindingForKey('AltLeft')).toBeNull();
    expect(keyMapFor(DEFAULT_KEY_BINDS)).toEqual(DEFAULT_KEY_MAP);
  });

  it('duck on Alt: both Alt keys duck, C still ducks, Ctrl is free', () => {
    const b = rebind(DEFAULT_KEY_BINDS, 'duck', 'AltRight') as KeyBinds;
    expect(b.duck).toBe('Alt');
    const m = keyMapFor(b);
    expect(bindingForKey('AltLeft', m)).toEqual({ kind: 'hold', control: 'duck' });
    expect(bindingForKey('AltRight', m)).toEqual({ kind: 'hold', control: 'duck' });
    expect(bindingForKey('KeyC', m)).toEqual({ kind: 'hold', control: 'duck' });
    expect(bindingForKey('ControlLeft', m)).toBeNull();
    expect(bindingForKey('KeyW', m)).toEqual({ kind: 'hold', control: 'up' });
  });

  it('C taken by another control stops ducking; a key in use swaps', () => {
    const b = rebind(DEFAULT_KEY_BINDS, 'jump', 'KeyC') as KeyBinds;
    expect(bindingForKey('KeyC', keyMapFor(b))).toEqual({ kind: 'hold', control: 'jump' });
    expect(bindingForKey('Space', keyMapFor(b))).toBeNull();
    const s = rebind(DEFAULT_KEY_BINDS, 'walk', 'ControlLeft') as KeyBinds;
    expect(s).toEqual({ duck: 'Shift', walk: 'Control', jump: 'Space', use: 'KeyE' });
  });

  it('refuses the fixed keys, Escape, ⌘ and the pages’ own keys', () => {
    for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'KeyR', 'Digit1', 'Escape', 'MetaLeft', 'Tab', 'KeyV', 'KeyF', 'BracketLeft', 'KeyP']) {
      expect(rebind(DEFAULT_KEY_BINDS, 'duck', code), code).toBeNull();
    }
    expect(canBindKey('KeyQ')).toBe(true);
    expect(canBindKey('Alt')).toBe(true);
    expect(bindKeyOf('ShiftLeft')).toBe('Shift');
    expect(bindKeyOf('KeyQ')).toBe('KeyQ');
  });

  it('labels', () => {
    expect(keyLabel('Control')).toBe('Ctrl');
    expect(keyLabel('Alt')).toBe('Alt');
    expect(keyLabel('Alt', true)).toBe('Option');
    expect(keyLabel('KeyC')).toBe('C');
    expect(keyLabel('Space')).toBe('Space');
    expect(keyLabel('Backquote')).toBe('`');
  });

  it('parses stored binds, dropping bad and reserved keys', () => {
    expect(parseKeyBinds(null)).toEqual(DEFAULT_KEY_BINDS);
    expect(parseKeyBinds({ duck: 'KeyW', walk: 7, jump: 'KeyQ' })).toEqual({ ...DEFAULT_KEY_BINDS, jump: 'KeyQ' });
    expect(parseKeyBinds({ duck: 'AltLeft', use: 'KeyQ' })).toEqual({ ...DEFAULT_KEY_BINDS, duck: 'Alt', use: 'KeyQ' });
    expect(parseKeyBinds({ duck: 'Alt', walk: 'Alt' })).toEqual(DEFAULT_KEY_BINDS);
    expect(parseKeyBinds({ walk: 'Control' })).toEqual(DEFAULT_KEY_BINDS);
  });
});

describe('KeyBindsStore', () => {
  it('saves, reloads, resets, and survives broken JSON or no storage', () => {
    const st = new MemoryStorage();
    const a = new KeyBindsStore(st);
    expect(a.binds).toEqual(DEFAULT_KEY_BINDS);
    const seen: KeyBinds[] = [];
    a.onChange((b) => seen.push(b));
    expect(a.set('duck', 'KeyC')).toBe(true);
    expect(a.set('duck', 'KeyW')).toBe(false);
    expect(seen).toHaveLength(1);
    expect(JSON.parse(st.getItem(KEY_BINDS_STORAGE_KEY) ?? '{}')).toEqual({ ...DEFAULT_KEY_BINDS, duck: 'KeyC' });
    expect(new KeyBindsStore(st).binds.duck).toBe('KeyC');
    a.reset();
    expect(st.getItem(KEY_BINDS_STORAGE_KEY)).toBeNull();
    expect(new KeyBindsStore(st).binds).toEqual(DEFAULT_KEY_BINDS);
    st.setItem(KEY_BINDS_STORAGE_KEY, '{not json');
    expect(new KeyBindsStore(st).binds).toEqual(DEFAULT_KEY_BINDS);
    const none = new KeyBindsStore(null);
    expect(none.set('jump', 'KeyQ')).toBe(true);
    expect(none.binds.jump).toBe('KeyQ');
  });
});

describe('shortcut guard', () => {
  const k = (code: string, mods: { ctrl?: boolean; meta?: boolean; alt?: boolean } = {}): { code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean } => ({
    code,
    ctrlKey: mods.ctrl ?? false,
    metaKey: mods.meta ?? false,
    altKey: mods.alt ?? false,
  });
  it('while playing blocks bound keys and every Ctrl combination, never ⌘', () => {
    expect(blocksShortcut(k('KeyW', { ctrl: true }), true, true)).toBe(true);
    expect(blocksShortcut(k('KeyT', { ctrl: true }), false, true)).toBe(true);
    expect(blocksShortcut(k('KeyN', { ctrl: true }), false, true)).toBe(true);
    expect(blocksShortcut(k('Space'), true, true)).toBe(true);
    expect(blocksShortcut(k('KeyQ'), false, true)).toBe(false);
    expect(blocksShortcut(k('KeyW', { meta: true }), true, true)).toBe(false);
    expect(blocksShortcut(k('KeyW', { ctrl: true }), true, false)).toBe(false);
  });

  it('fullscreen hint per browser', () => {
    expect(fullscreenHint(true, false, DEFAULT_KEY_BINDS, true)).toBe('Keyboard locked: Ctrl+W crouches forward, browser shortcuts are off. Esc frees the mouse; hold Esc to leave fullscreen.');
    expect(fullscreenHint(true, false, DEFAULT_KEY_BINDS, false)).toContain('Hold Esc to leave fullscreen.');
    expect(fullscreenHint(false, false, DEFAULT_KEY_BINDS, true)).toContain('Move Duck to C or Alt under Keys');
    expect(fullscreenHint(false, false, { ...DEFAULT_KEY_BINDS, duck: 'KeyC' }, true)).toContain('duck is on C');
    expect(fullscreenHint(false, true, DEFAULT_KEY_BINDS, true)).toContain('⌘W still closes the tab');
  });

  it('feature detection', () => {
    expect(keyboardLockApi({})).toBeNull();
    expect(keyboardLockApi({ keyboard: { getLayoutMap: () => null } })).toBeNull();
    const kb = { lock: () => Promise.resolve(), unlock: () => undefined };
    expect(keyboardLockApi({ keyboard: kb })).toBe(kb);
    expect(isMacLike({ platform: 'MacIntel' })).toBe(true);
    expect(isMacLike({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0)' })).toBe(false);
    for (const c of ['KeyW', 'KeyT', 'KeyN', 'ControlLeft', 'ControlRight', 'Escape', 'Space', 'AltLeft']) expect(KEYBOARD_LOCK_CODES).toContain(c);
    expect(KEYBOARD_LOCK_CODES).not.toContain('MetaLeft');
  });
});

/** A keyboard event good enough for the listeners (Node has Event but no KeyboardEvent). */
function key(type: 'keydown' | 'keyup', code: string, mods: { ctrl?: boolean; meta?: boolean; alt?: boolean; repeat?: boolean } = {}): Event {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, { code, ctrlKey: mods.ctrl ?? false, metaKey: mods.meta ?? false, altKey: mods.alt ?? false, shiftKey: false, repeat: mods.repeat ?? false });
  return e;
}

function fakeDom(): { win: EventTarget } {
  const win = new EventTarget();
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', Object.assign(new EventTarget(), { pointerLockElement: null, hidden: false }));
  return { win };
}

describe('keydown handling (2D InputDom)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('Ctrl+W while playing: default prevented, duck and forward held', () => {
    const { win } = fakeDom();
    let playing = true;
    const dom = new InputDom(new EventTarget() as unknown as HTMLElement, { active: () => playing, onSlot: () => undefined });
    const ctrl = key('keydown', 'ControlLeft', { ctrl: true });
    win.dispatchEvent(ctrl);
    const w = key('keydown', 'KeyW', { ctrl: true });
    win.dispatchEvent(w);
    expect(ctrl.defaultPrevented).toBe(true);
    expect(w.defaultPrevented).toBe(true);
    const c = dom.controls();
    expect(c.duck).toBe(true);
    expect(c.up).toBe(true);
    // Ctrl+T / Ctrl+N aren't bound, but they are moves too while playing.
    const t = key('keydown', 'KeyT', { ctrl: true });
    win.dispatchEvent(t);
    expect(t.defaultPrevented).toBe(true);
    // ⌘W is never blocked (and lets go of the keys: macOS sends no keyups while ⌘ is down).
    const cmd = key('keydown', 'KeyW', { meta: true });
    win.dispatchEvent(cmd);
    expect(cmd.defaultPrevented).toBe(false);
    expect(dom.controls().duck).toBe(false);
    // Watching: the page's shortcuts are the browser's.
    playing = false;
    const idle = key('keydown', 'KeyW', { ctrl: true });
    win.dispatchEvent(idle);
    expect(idle.defaultPrevented).toBe(false);
    dom.dispose();
  });

  it('a rebound duck: Alt ducks, Ctrl no longer does (but Ctrl+W is still blocked while playing)', () => {
    const { win } = fakeDom();
    const dom = new InputDom(new EventTarget() as unknown as HTMLElement, { active: () => true, onSlot: () => undefined });
    dom.keyMap = keyMapFor({ ...DEFAULT_KEY_BINDS, duck: 'Alt' });
    win.dispatchEvent(key('keydown', 'AltLeft', { alt: true }));
    expect(dom.controls().duck).toBe(true);
    win.dispatchEvent(key('keyup', 'AltLeft'));
    win.dispatchEvent(key('keydown', 'ControlLeft', { ctrl: true }));
    expect(dom.controls().duck).toBe(false);
    const w = key('keydown', 'KeyW', { ctrl: true });
    win.dispatchEvent(w);
    expect(w.defaultPrevented).toBe(true);
    expect(dom.controls().up).toBe(true);
    dom.dispose();
  });
});

describe('keydown handling (3D ControlsDom)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('Ctrl+W: default prevented, duck and forward held; Ctrl+T blocked only while playing', () => {
    const { win } = fakeDom();
    let playing = true;
    const keys: string[] = [];
    const dom = new ControlsDom(new EventTarget() as unknown as HTMLElement, {
      onSlot: () => undefined,
      onKey: (code) => {
        keys.push(code);
        return false;
      },
      onFire: () => undefined,
      onAttack2: () => undefined,
      playing: () => playing,
    });
    const ctrl = key('keydown', 'ControlLeft', { ctrl: true });
    const w = key('keydown', 'KeyW', { ctrl: true });
    win.dispatchEvent(ctrl);
    win.dispatchEvent(w);
    expect(ctrl.defaultPrevented && w.defaultPrevented).toBe(true);
    expect(dom.controls().duck).toBe(true);
    expect(dom.controls().up).toBe(true);
    const t = key('keydown', 'KeyT', { ctrl: true });
    win.dispatchEvent(t);
    expect(t.defaultPrevented).toBe(true);
    win.dispatchEvent(key('keyup', 'ControlLeft'));
    expect(dom.controls().duck).toBe(false);
    expect(dom.controls().up).toBe(true);
    playing = false;
    const t2 = key('keydown', 'KeyT', { ctrl: true });
    win.dispatchEvent(t2);
    expect(t2.defaultPrevented).toBe(false);
    // Bound keys never do their default (free-fly uses them while watching).
    const sp = key('keydown', 'Space');
    win.dispatchEvent(sp);
    expect(sp.defaultPrevented).toBe(true);
    // Alt duck after rebinding (Alt no longer silences the listener).
    dom.keyMap = keyMapFor({ ...DEFAULT_KEY_BINDS, duck: 'Alt' });
    win.dispatchEvent(key('keydown', 'AltRight', { alt: true }));
    expect(dom.controls().duck).toBe(true);
    expect(keys).toContain('KeyW');
  });
});
