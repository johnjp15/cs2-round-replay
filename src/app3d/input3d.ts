/**
 * H1: first-person controls (pure part, tested in Node; the DOM listeners are in controls-dom.ts). docs/app3d.md
 * "Controls".
 *
 * - The mouse turns the view (pointer lock) exactly as CS2 does: view-cs2.ts `applyMouse` (yaw −= m_yaw × dx ×
 *   sensitivity, pitch += m_pitch × dy × sensitivity, ±89°, no acceleration or smoothing; default sensitivity 1.25).
 * - WASD move relative to the view, as in CS2: W forward, S back, A strafe left, D strafe right (PawnInput forward /
 *   side are relative to the yaw: side positive = right); a diagonal is normalized.
 * - Buttons as the 2D app (src/app/input.ts): Shift WALK, Ctrl / C DUCK, Space JUMP, mouse 1 ATTACK (fire, throw),
 *   mouse 2 ATTACK2, R RELOAD, E USE (plant, defuse; while watching E takes control), 1–5 weapon slots.
 */
import { roundNumber, type PawnInput, type PlayerId } from '../contracts/index';
import { SLOT_WEAPONS, buttonsFor, weaponForSlot, type HeldControls, type WeaponSlot } from '../app/input';

import { DEFAULT_SENSITIVITY, applyMouse } from './view-cs2';

export { DEFAULT_SENSITIVITY } from './view-cs2';

export interface Look {
  readonly yaw: number;
  readonly pitch: number;
}

/** Yaw in (−180, 180]. */
export function wrapYaw(a: number): number {
  const r = (((a % 360) + 540) % 360) - 180;
  return r === -180 ? 180 : r;
}

/** The view after a mouse move of (dx, dy) counts (pointer-lock movementX / movementY). */
export function turnView(look: Look, dx: number, dy: number, sensitivity = DEFAULT_SENSITIVITY): Look {
  return applyMouse(look, dx, dy, sensitivity);
}

/** forward / side (−1..1, view-relative, side positive = right) for the held WASD keys. */
export function viewMove(c: HeldControls): { readonly forward: number; readonly side: number } {
  const f = (c.up ? 1 : 0) - (c.down ? 1 : 0);
  const s = (c.right ? 1 : 0) - (c.left ? 1 : 0);
  if (f !== 0 && s !== 0) return { forward: roundNumber(f * Math.SQRT1_2), side: roundNumber(s * Math.SQRT1_2) };
  return { forward: f, side: s };
}

/** The human pawn's input: view-relative WASD, the view angles (rounded to the log's 6 decimals), held buttons. */
export function fpsInput(id: PlayerId, c: HeldControls, look: Look): PawnInput {
  const m = viewMove(c);
  return { id, forward: m.forward, side: m.side, yaw: roundNumber(look.yaw), pitch: roundNumber(look.pitch), buttons: buttonsFor(c) };
}

/** Free-fly spectator camera: one step of `dt` seconds at `speed` units/s along the view (WASD), Space up, Ctrl down. */
export function flyStep(pos: { x: number; y: number; z: number }, look: Look, c: HeldControls, dt: number, speed: number): { x: number; y: number; z: number } {
  const m = viewMove(c);
  const y = (look.yaw * Math.PI) / 180;
  const p = (look.pitch * Math.PI) / 180;
  const fx = Math.cos(p) * Math.cos(y);
  const fy = Math.cos(p) * Math.sin(y);
  const fz = -Math.sin(p);
  // right = (sin yaw, −cos yaw, 0)
  const rx = Math.sin(y);
  const ry = -Math.cos(y);
  const up = (c.jump ? 1 : 0) - (c.duck ? 1 : 0);
  const k = speed * dt * (c.walk ? 3 : 1);
  return { x: pos.x + (fx * m.forward + rx * m.side) * k, y: pos.y + (fy * m.forward + ry * m.side) * k, z: pos.z + (fz * m.forward + up) * k };
}

// ---- W1: crosshair, wheel jump, lastinv ---------------------------------------------------------------------------

/**
 * W1 (#32, #77): the crosshair's offset from the screen centre in pixels. CS2's default `cl_crosshair_recoil 0`: the
 * crosshair stays at the centre while the view kicks (by `view_recoil_tracking`); the bullet still leaves along
 * view + aim punch × weapon_recoil_scale, so the crosshair shows the view, not the bullet. `follow` (the "Crosshair
 * follows recoil" setting, cl_crosshair_recoil 1) puts it where the next bullet goes (`offset` computes that).
 */
export function crosshairOffsetPx(follow: boolean, camera: Look, aim: Look, offset: (camera: Look, aim: Look) => { x: number; y: number }): { x: number; y: number } {
  if (!follow || (camera.yaw === aim.yaw && camera.pitch === aim.pitch)) return { x: 0, y: 0 };
  return offset(camera, aim);
}

/**
 * W1 (#40): `+jump` on the mouse wheel. In CS2 a wheel notch bound to +jump is a press and a release in the same
 * frame; the server sees it as JUMP down on the next usercmd. The page samples the input once per frame and runs the
 * 64 Hz ticks that frame owes (often none at high fps), so a notch is latched until a tick has run with JUMP held
 * ('press'), then JUMP is let go for at least one tick ('release') so the next notch is a fresh press (the movement
 * jumps on a new press only, sv_autobunnyhopping 0). Notches while a press is pending don't queue up (at most one
 * waits).
 */
export class WheelJump {
  private state: 'idle' | 'press' | 'release' = 'idle';
  private pending = false;

  /** A wheel notch the jump is bound to. */
  notch(): void {
    if (this.state === 'idle') this.state = 'press';
    else this.pending = true;
  }

  /** Whether this frame's input holds JUMP for the wheel. */
  held(): boolean {
    return this.state === 'press';
  }

  /** After the frame's ticks: `ticks` ran with the input of held(). */
  ticksRan(ticks: number): void {
    if (ticks <= 0) return;
    if (this.state === 'press') this.state = 'release';
    else if (this.state === 'release') {
      this.state = this.pending ? 'press' : 'idle';
      this.pending = false;
    }
  }

  reset(): void {
    this.state = 'idle';
    this.pending = false;
  }
}

/** Which wheel directions jump (the Keys group's checkboxes; CS2 players bind `+jump` to mwheeldown or mwheelup). */
export interface WheelJumpBinds {
  readonly down: boolean;
  readonly up: boolean;
}

/** Whether a wheel event of `deltaY` jumps (deltaY > 0 = wheel down / towards the user). */
export function wheelJumps(binds: WheelJumpBinds, deltaY: number): boolean {
  return (deltaY > 0 && binds.down) || (deltaY < 0 && binds.up);
}

/**
 * W1 (#41): CS2's `lastinv` (Q): the slot presses (input.ts weaponForSlot, the Session's taped slot requests) that
 * take the pawn from `current` to `previous`, or [] when it can't (no previous item, not carried any more, already
 * out). A slot whose weapons cycle (grenades) takes as many presses as it needs to reach the item.
 */
export function lastInvSlots(previous: string | null, current: string, carried: readonly string[]): WeaponSlot[] {
  if (previous === null || previous === current || !carried.includes(previous)) return [];
  const slot = slotOfWeapon(previous);
  if (slot === null) return [];
  const presses: WeaponSlot[] = [];
  let w = current;
  for (let i = 0; i < 6; i++) {
    const next = weaponForSlot(slot, carried, w);
    if (next === null) return [];
    presses.push(slot);
    if (next === previous) return presses;
    w = next;
  }
  return [];
}

/** The CS2 slot of a weapon (input.ts SLOT_WEAPONS), or null. */
export function slotOfWeapon(w: string): WeaponSlot | null {
  for (const s of [1, 2, 3, 4, 5] as const) if ((SLOT_WEAPONS[s] as readonly string[]).includes(w)) return s;
  return null;
}

/**
 * The previous item for lastinv: follows the human's held weapon tick by tick; a change makes the old one the
 * previous (CS2 keeps the last weapon on every switch, including the automatic one after a grenade throw).
 */
export class LastInv {
  private current: string | null = null;
  previous: string | null = null;

  observe(weapon: string | null): void {
    if (weapon === null) return;
    if (this.current !== null && weapon !== this.current) this.previous = this.current;
    this.current = weapon;
  }

  reset(): void {
    this.current = null;
    this.previous = null;
  }
}
