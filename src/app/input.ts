/**
 * Keyboard and mouse → the human pawn's PawnInput. Pure mapping functions only; the DOM listeners
 * are a thin layer in input-dom.ts.
 *
 * - WASD (or the arrow keys) move relative to the **screen**: W = up = north, D = right = east,
 *   whatever way the pawn faces. moveDirection() gives that world direction and toPawnFrame()
 *   turns it into forward/side relative to the pawn's yaw, using the movement convention
 *   (docs/movement.md): forward = (cos yaw, sin yaw), +side = strafe right = yaw − 90° = (sin yaw, −cos yaw).
 * - The mouse sets yaw: the pawn faces the cursor in world coordinates (yawToward).
 * - Shift = WALK, Ctrl or C = DUCK, left button = ATTACK, right button = ATTACK2, R = RELOAD, E = USE.
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
  attack: false,
  attack2: false,
  use: false,
  reload: false,
};

/** CS2 weapon slots: 1 primary, 2 pistol, 3 knife, 4 grenades (repeat to cycle), 5 bomb. */
export type WeaponSlot = 1 | 2 | 3 | 4 | 5;

export type Binding = { readonly kind: 'hold'; readonly control: HeldControl } | { readonly kind: 'slot'; readonly slot: WeaponSlot };

/** Bindings by `KeyboardEvent.code` (physical key, so they do not depend on the keyboard layout). */
const KEY_BINDINGS: ReadonlyMap<string, Binding> = new Map<string, Binding>([
  ['KeyW', { kind: 'hold', control: 'up' }],
  ['ArrowUp', { kind: 'hold', control: 'up' }],
  ['KeyS', { kind: 'hold', control: 'down' }],
  ['ArrowDown', { kind: 'hold', control: 'down' }],
  ['KeyA', { kind: 'hold', control: 'left' }],
  ['ArrowLeft', { kind: 'hold', control: 'left' }],
  ['KeyD', { kind: 'hold', control: 'right' }],
  ['ArrowRight', { kind: 'hold', control: 'right' }],
  ['ShiftLeft', { kind: 'hold', control: 'walk' }],
  ['ShiftRight', { kind: 'hold', control: 'walk' }],
  ['ControlLeft', { kind: 'hold', control: 'duck' }],
  ['ControlRight', { kind: 'hold', control: 'duck' }],
  ['KeyC', { kind: 'hold', control: 'duck' }],
  ['KeyR', { kind: 'hold', control: 'reload' }],
  ['KeyE', { kind: 'hold', control: 'use' }],
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
]);

export function bindingForKey(code: string): Binding | null {
  return KEY_BINDINGS.get(code) ?? null;
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
