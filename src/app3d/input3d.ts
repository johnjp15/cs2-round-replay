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
import { buttonsFor, type HeldControls } from '../app/input';

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
