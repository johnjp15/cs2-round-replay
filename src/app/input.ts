/**
 * Keyboard and mouse → the human pawn's PawnInput. Pure mapping functions only; the DOM listeners
 * are a thin layer in input-dom.ts.
 *
 * - WASD (or the arrow keys) move relative to the **screen**: W = up = north, D = right = east,
 *   whatever way the pawn faces. moveDirection() gives that world direction and toPawnFrame()
 *   turns it into forward/side relative to the pawn's yaw, using the movement convention
 *   (docs/movement.md): forward = (cos yaw, sin yaw), +side = strafe right = yaw − 90° = (sin yaw, −cos yaw).
 * - The mouse sets yaw: the pawn faces the cursor in world coordinates (yawToward).
 * - Shift = WALK, Ctrl or C = DUCK, Space = JUMP (G3; held, it jumps once: the movement wants a fresh press, as CS2
 *   with sv_autobunnyhopping 0), left button = ATTACK, right button = ATTACK2, R = RELOAD, E = USE. Duck, walk, jump and use can
 *   move to other keys (keyMapFor; the setting is keybinds.ts).
 * - 1–5 select a weapon slot. That is not a PawnInput button: the app turns the request into a
 *   `set_weapon` action for the human pawn through the Session's small action queue
 *   (Session.requestWeaponSlot). In CS2 the human switches weapons natively, so these never go
 *   through Core and are not in the logged Act; the next observe shows the new weapon.
 */
import { roundNumber, sortButtons, type Button, type PawnInput, type PlayerId, type WeaponId } from '../contracts/index';
import type { Point2 } from './radar';

/** What the human is holding down right now. */
export interface HeldControls {
  readonly up: boolean;
  readonly down: boolean;
  readonly left: boolean;
  readonly right: boolean;
  readonly walk: boolean;
  readonly duck: boolean;
  readonly jump: boolean;
  readonly attack: boolean;
  readonly attack2: boolean;
  readonly use: boolean;
  readonly reload: boolean;
}

export type HeldControl = keyof HeldControls;

export const NO_CONTROLS: HeldControls = {
  up: false,
  down: false,
  left: false,
  right: false,
  walk: false,
  duck: false,
  jump: false,
  attack: false,
  attack2: false,
  use: false,
  reload: false,
};

/** CS2 weapon slots: 1 primary, 2 pistol, 3 knife, 4 grenades (repeat to cycle), 5 bomb. */
export type WeaponSlot = 1 | 2 | 3 | 4 | 5;

export type Binding = { readonly kind: 'hold'; readonly control: HeldControl } | { readonly kind: 'slot'; readonly slot: WeaponSlot };

/** The fixed bindings by `KeyboardEvent.code` (physical key, so they do not depend on the keyboard layout). */
const FIXED_KEYS: readonly (readonly [string, Binding])[] = [
  ['KeyW', { kind: 'hold', control: 'up' }],
  ['ArrowUp', { kind: 'hold', control: 'up' }],
  ['KeyS', { kind: 'hold', control: 'down' }],
  ['ArrowDown', { kind: 'hold', control: 'down' }],
  ['KeyA', { kind: 'hold', control: 'left' }],
  ['ArrowLeft', { kind: 'hold', control: 'left' }],
  ['KeyD', { kind: 'hold', control: 'right' }],
  ['ArrowRight', { kind: 'hold', control: 'right' }],
  ['KeyR', { kind: 'hold', control: 'reload' }],
  ['Digit1', { kind: 'slot', slot: 1 }],
  ['Digit2', { kind: 'slot', slot: 2 }],
  ['Digit3', { kind: 'slot', slot: 3 }],
  ['Digit4', { kind: 'slot', slot: 4 }],
  ['Digit5', { kind: 'slot', slot: 5 }],
  ['Numpad1', { kind: 'slot', slot: 1 }],
  ['Numpad2', { kind: 'slot', slot: 2 }],
  ['Numpad3', { kind: 'slot', slot: 3 }],
  ['Numpad4', { kind: 'slot', slot: 4 }],
  ['Numpad5', { kind: 'slot', slot: 5 }],
];

/** The held controls the player can move to another key (the key-binding setting, keybinds.ts). */
export type RebindableControl = 'duck' | 'walk' | 'jump' | 'use';
export const REBINDABLE: readonly RebindableControl[] = ['duck', 'walk', 'jump', 'use'];

/**
 * A key per rebindable control: a `KeyboardEvent.code`, or `Control` / `Shift` / `Alt` for either side of that
 * modifier.
 */
export type KeyBinds = { readonly [C in RebindableControl]: string };

/** CS2's defaults: Ctrl duck, Shift walk, Space jump, E use. C also ducks while no other control has it. */
export const DEFAULT_KEY_BINDS: KeyBinds = { duck: 'Control', walk: 'Shift', jump: 'Space', use: 'KeyE' };

/** The extra duck key (the 2D app's alternative to Ctrl), kept while C isn't bound to another control. */
export const ALT_DUCK_KEY = 'KeyC';

/**
 * Keys a rebindable control can't take: the fixed bindings, Escape (frees the mouse, leaves fullscreen), ⌘ / the OS
 * key, Tab, and the pages' own keys (2D: E take control, F G T H overlays, [ ] seek; 3D: V camera, Z / X player, P
 * pause).
 */
const RESERVED_KEYS: ReadonlySet<string> = new Set([
  ...FIXED_KEYS.map(([code]) => code),
  'Escape',
  'MetaLeft',
  'MetaRight',
  'OSLeft',
  'OSRight',
  'ContextMenu',
  'Tab',
  'CapsLock',
  'KeyF',
  'KeyG',
  'KeyT',
  'KeyH',
  'BracketLeft',
  'BracketRight',
  'KeyV',
  'KeyZ',
  'KeyX',
  'KeyP',
  'F11',
  'F12',
]);

const MODIFIER_SIDES: { readonly [k: string]: readonly string[] } = {
  Control: ['ControlLeft', 'ControlRight'],
  Shift: ['ShiftLeft', 'ShiftRight'],
  Alt: ['AltLeft', 'AltRight'],
};

/** The key a `KeyboardEvent.code` binds as: either side of a modifier is the modifier (`ControlLeft` → `Control`). */
export function bindKeyOf(code: string): string {
  for (const [k, sides] of Object.entries(MODIFIER_SIDES)) if (sides.includes(code)) return k;
  return code;
}

/** The `KeyboardEvent.code`s a bound key stands for. */
export function codesOfKey(key: string): readonly string[] {
  return MODIFIER_SIDES[key] ?? [key];
}

/** Whether a key (as bindKeyOf gives it) can be bound to a rebindable control. */
export function canBindKey(key: string): boolean {
  if (key === '' || key === 'Unidentified') return false;
  return codesOfKey(key).every((c) => !RESERVED_KEYS.has(c));
}

/** A short label for a bound key: Ctrl, Shift, Alt (⌥ on the Mac), C, Space, Mouse-less keys by their code. */
export function keyLabel(key: string, mac = false): string {
  if (key === 'Control') return 'Ctrl';
  if (key === 'Alt') return mac ? 'Option' : 'Alt';
  if (key.startsWith('Key')) return key.slice(3);
  if (key.startsWith('Digit')) return key.slice(5);
  if (key.startsWith('Numpad')) return `Num ${key.slice(6)}`;
  const named: { readonly [k: string]: string } = { Backquote: '`', Minus: '-', Equal: '=', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\' };
  return named[key] ?? key;
}

/**
 * The binds with `control` on `key`, or null when the key can't be bound. A key another rebindable control has moves
 * over: that control takes `control`'s old key (a swap), so every control keeps a key.
 */
export function rebind(binds: KeyBinds, control: RebindableControl, code: string): KeyBinds | null {
  const key = bindKeyOf(code);
  if (!canBindKey(key)) return null;
  const next: { [C in RebindableControl]: string } = { ...binds };
  const other = REBINDABLE.find((c) => c !== control && binds[c] === key);
  if (other !== undefined) next[other] = binds[control];
  next[control] = key;
  return next;
}

/** Stored binds (JSON from localStorage, possibly old or hand-edited) → valid binds: bad or duplicate keys reset. */
export function parseKeyBinds(raw: unknown): KeyBinds {
  let b: KeyBinds = DEFAULT_KEY_BINDS;
  if (typeof raw !== 'object' || raw === null) return b;
  const r = raw as { readonly [k: string]: unknown };
  for (const c of REBINDABLE) {
    const v = r[c];
    if (typeof v !== 'string') continue;
    const n = rebind(b, c, v);
    if (n !== null) b = n;
  }
  return b;
}

/** The whole key map for a set of binds (the fixed keys, the rebindable four, then C as the extra duck key). */
export function keyMapFor(binds: KeyBinds): ReadonlyMap<string, Binding> {
  const m = new Map<string, Binding>(FIXED_KEYS);
  for (const c of REBINDABLE) for (const code of codesOfKey(binds[c])) m.set(code, { kind: 'hold', control: c });
  if (!m.has(ALT_DUCK_KEY)) m.set(ALT_DUCK_KEY, { kind: 'hold', control: 'duck' });
  return m;
}

/** The default key map (DEFAULT_KEY_BINDS). */
export const DEFAULT_KEY_MAP: ReadonlyMap<string, Binding> = keyMapFor(DEFAULT_KEY_BINDS);

export function bindingForKey(code: string, map: ReadonlyMap<string, Binding> = DEFAULT_KEY_MAP): Binding | null {
  return map.get(code) ?? null;
}

/** A keydown as far as the shortcut guard cares. */
export interface KeyLike {
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}

/**
 * Whether a keydown's browser default must be blocked. While playing: every bound key (Space mustn't scroll, ' / '
 * mustn't search) and every Ctrl combination, bound or not: Ctrl is duck, so Ctrl+W (crouch forward), Ctrl+S, Ctrl+D,
 * Ctrl+T, Ctrl+N, Ctrl+R… are moves, not shortcuts. With ⌘ held nothing is blocked (Mac shortcuts keep working; the
 * browser wouldn't let a page block ⌘W anyway). The browser itself may still act on some of these (Chromium and
 * Firefox reserve Ctrl+W / Ctrl+T / Ctrl+N outside Keyboard Lock); see play-guard.ts.
 */
export function blocksShortcut(k: KeyLike, bound: boolean, playing: boolean): boolean {
  if (k.metaKey || !playing) return false;
  return bound || k.ctrlKey;
}

/** `MouseEvent.button`: 0 = left = ATTACK, 2 = right = ATTACK2. */
export function bindingForMouseButton(button: number): Binding | null {
  if (button === 0) return { kind: 'hold', control: 'attack' };
  if (button === 2) return { kind: 'hold', control: 'attack2' };
  return null;
}

/**
 * Screen-relative move direction in world axes (x east, y north) from the held keys: W = (0, 1),
 * D = (1, 0). Opposite keys cancel; a diagonal is normalized to length 1; nothing held = (0, 0).
 */
export function moveDirection(c: HeldControls): Point2 {
  const x = (c.right ? 1 : 0) - (c.left ? 1 : 0);
  const y = (c.up ? 1 : 0) - (c.down ? 1 : 0);
  if (x !== 0 && y !== 0) return { x: x * Math.SQRT1_2, y: y * Math.SQRT1_2 };
  return { x, y };
}

/**
 * A world direction as forward/side relative to `yawDeg`: forward = d · (cos yaw, sin yaw),
 * side = d · (sin yaw, −cos yaw) (positive = strafe right). Rounded to the log's 6 decimals.
 */
export function toPawnFrame(dir: Point2, yawDeg: number): { forward: number; side: number } {
  const r = (yawDeg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { forward: roundNumber(dir.x * c + dir.y * s), side: roundNumber(dir.x * s - dir.y * c) };
}

/**
 * Yaw in degrees ((−180, 180], CCW from +x, map y north) from `from` toward `to`; `fallback` when
 * the two points are closer than `minDist` (the cursor is on the pawn). Rounded to 6 decimals.
 */
export function yawToward(from: Point2, to: Point2, fallback: number, minDist = 1): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx * dx + dy * dy < minDist * minDist) return fallback;
  return roundNumber((Math.atan2(dy, dx) * 180) / Math.PI);
}

/** Held buttons in BUTTONS order. */
export function buttonsFor(c: HeldControls): Button[] {
  const b: Button[] = [];
  if (c.attack) b.push('ATTACK');
  if (c.attack2) b.push('ATTACK2');
  if (c.use) b.push('USE');
  if (c.duck) b.push('DUCK');
  if (c.walk) b.push('WALK');
  if (c.jump) b.push('JUMP');
  if (c.reload) b.push('RELOAD');
  return sortButtons(b);
}

/** The human pawn's input for this frame: screen-relative WASD at `yawDeg`, plus held buttons. */
export function humanInput(id: PlayerId, c: HeldControls, yawDeg: number, pitchDeg = 0): PawnInput {
  const { forward, side } = toPawnFrame(moveDirection(c), yawDeg);
  return { id, forward, side, yaw: yawDeg, pitch: pitchDeg, buttons: buttonsFor(c) };
}

/** Weapons per slot, in the order a repeated press cycles through them (slot 4 order not checked against CS2). */
export const SLOT_WEAPONS: { readonly [S in WeaponSlot]: readonly WeaponId[] } = {
  1: ['ak47', 'm4a4', 'awp', 'ssg08'],
  2: ['deagle', 'glock'],
  3: ['knife'],
  4: ['he', 'flash', 'smoke', 'molotov'],
  5: ['c4'],
};

/**
 * The weapon a slot press selects, given the carried items and the active weapon, or null when it
 * changes nothing (empty slot, or the slot's only weapon is already out). Pressing the slot of the
 * active weapon moves to the next carried weapon of that slot (grenades cycle).
 */
export function weaponForSlot(slot: WeaponSlot, carried: readonly string[], current: string): WeaponId | null {
  const options = SLOT_WEAPONS[slot].filter((w) => carried.includes(w));
  if (options.length === 0) return null;
  const at = options.indexOf(current as WeaponId);
  const next = at < 0 ? options[0] : options[(at + 1) % options.length];
  return next === undefined || next === current ? null : next;
}
