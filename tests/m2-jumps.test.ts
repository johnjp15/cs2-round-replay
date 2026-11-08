/**
 * M2 (#83, docs/movement.md "M2"): jumps in the 3D host (Sim3DHost, 64 tick) against CS2's numbers, CS2's stamina
 * rules on hops, and the 3D camera through a jump: the human's predicted view (the landing shows when the sim lands)
 * and the eye through an in-air duck (no 9-unit pop).
 */
import { describe, expect, it } from 'vitest';
import type { Button, PlayerId } from '../src/contracts/index';
import { MapGeometry } from '../src/sim2d/geometry';
import { TICK_DT, type MoveState } from '../src/sim2d/movement';
import { Sim3DHost } from '../src/sim3d/index';
import { ViewEye } from '../src/app3d/view-cs2';
import { act, openNav, setupActions, tuning } from './combat-fixtures';

const m = tuning.movement;
const E = 3000;
const roster = [
  { id: 'cart' as PlayerId, team: 'T' as const },
  { id: 'barely' as PlayerId, team: 'T' as const },
  { id: 'sp4rtan' as PlayerId, team: 'CT' as const },
];

function meshOf(tris: number[][]): MapGeometry {
  const verts: number[] = [];
  const idx: number[] = [];
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      idx.push(verts.length / 3);
      verts.push(Math.round((t[k * 3] as number) * 8), Math.round((t[k * 3 + 1] as number) * 8), Math.round((t[k * 3 + 2] as number) * 8));
    }
  }
  return new MapGeometry({ quant: 8, verts: Int32Array.from(verts), tris: Int32Array.from(idx) });
}

const flat = meshOf([
  [-E, -E, 0, E, -E, 0, E, E, 0],
  [-E, -E, 0, E, E, 0, -E, E, 0],
]);

/** cart (knife) standing at the origin as the human, settled for 40 ticks. */
function host(): Sim3DHost {
  const h = new Sim3DHost(openNav, tuning, roster, null, { mask: null, seed: 1 }, { movement: flat, world: flat });
  h.apply(act([...setupActions('cart', { x: 0, y: 0 }, 0, 'knife'), ...setupActions('barely', { x: -2000, y: -2000 }, 0, 'ak47'), ...setupActions('sp4rtan', { x: -2000, y: 2000 }, 180, 'ak47')]));
  h.tick();
  h.setHuman('cart');
  for (let i = 0; i < 40; i++) tickWith(h, 0, []);
  return h;
}

function tickWith(h: Sim3DHost, forward: number, buttons: Button[]): MoveState {
  h.setHumanInput({ id: 'cart', forward, side: 0, yaw: 0, pitch: 0, buttons });
  h.tick();
  return (h.pawnState('cart') as { move: MoveState }).move;
}

/** Where the feet rest on the floor (the hull stays the 1/32 trace skin above it). */
const REST_Z = (host().pawnState('cart') as { move: MoveState }).move.pos.z;

/** States after each tick of one jump from rest (JUMP on the first tick only; DUCK from `duckFrom`), z above REST_Z. */
function jump(duckFrom = -1, ticks = 60): MoveState[] {
  const h = host();
  const out: MoveState[] = [];
  for (let k = 0; k < ticks; k++) {
    const st = tickWith(h, 0, [...(duckFrom >= 0 && k >= duckFrom ? (['DUCK'] as Button[]) : []), ...(k === 0 ? (['JUMP'] as Button[]) : [])]);
    out.push({ ...st, pos: { ...st.pos, z: st.pos.z - REST_Z } });
  }
  return out;
}

describe('M2: the jump in the 3D host is CS2\'s (sv_gravity 800, sv_jump_impulse 301.99338, precise take-off)', () => {
  const v = m.jumpImpulse;
  const g = m.gravity;
  const s = jump();
  const landed = s.findIndex((q, k) => k > 0 && q.onGround);

  it('every air tick lies on the continuous parabola v·t − g·t²/2 (half-step gravity, not explicit Euler)', () => {
    expect(v).toBe(301.99338);
    expect(g).toBe(800);
    for (let k = 0; k < landed; k++) {
      const t = (k + 1) * TICK_DT;
      expect(Math.abs((s[k] as MoveState).pos.z - (v * t - (g * t * t) / 2))).toBeLessThan(1e-5); // the host rounds to 6 decimals each tick
    }
    // Explicit Euler (velocity first, then position) would put the first tick at v·dt − g·dt² = 4.5233, not 4.6210.
    expect((s[0] as MoveState).pos.z).toBeCloseTo(4.620991, 5);
  });

  it('apex 56.9975 on the 24th tick (CS2: v²/2g = 57.000 at v/g = 0.3775 s), landing after 48 ticks (2v/g = 0.755 s)', () => {
    const zs = s.map((q) => q.pos.z);
    const apex = Math.max(...zs);
    expect((v * v) / (2 * g)).toBeCloseTo(57, 4);
    expect(apex).toBeCloseTo(56.99752, 4);
    expect(zs.indexOf(apex) + 1).toBe(24);
    expect(landed + 1).toBe(48);
    expect((landed + 1) * TICK_DT).toBe(0.75);
    expect((2 * v) / g).toBeCloseTo(0.754983, 5);
  });

  it('crouch jumps: DUCK held from the ground 56.9975; DUCK pressed in the air lifts the feet 9 → 65.9975 (66-unit boxes)', () => {
    expect(Math.max(...jump(0).map((q) => q.pos.z))).toBeCloseTo(56.99752, 4);
    expect(Math.max(...jump(10).map((q) => q.pos.z))).toBeCloseTo(65.99752, 4);
  });
});

describe('M2: CS2 stamina on hops (sv_legacy_jump 0: no jump cost; the landing penalty recovers at 60/s)', () => {
  /** Knife, W held: take-off speeds of 6 hops, each pressed `late` ground ticks after landing; the stamina at each landing. */
  function chain(late: number): { takeoff: number[]; landStamina: number[] } {
    const h = host();
    for (let i = 0; i < 64; i++) tickWith(h, 1, []);
    const takeoff: number[] = [];
    const landStamina: number[] = [];
    let wait = -1;
    let before = (h.pawnState('cart') as { move: MoveState }).move;
    for (let k = 0; k < 64 * 6 && takeoff.length < 6; k++) {
      let press = k === 0;
      if (wait >= 0) press = wait-- === 0;
      const st = tickWith(h, 1, press ? ['JUMP'] : []);
      if (before.onGround && !st.onGround) takeoff.push(Math.round(Math.hypot(st.vel.x, st.vel.y) * 10) / 10);
      if (!before.onGround && st.onGround) {
        landStamina.push(st.stamina);
        wait = late;
      }
      before = st;
    }
    return { takeoff, landStamina };
  }

  it('a perfect hop (first ground tick) keeps 250 hop after hop; the landing adds 0.05 × 285.5 = 14.28 and a take-off nothing', () => {
    const c = chain(0);
    expect(c.takeoff).toEqual([250, 250, 250, 250, 250, 250]);
    for (const st of c.landStamina) expect(st).toBeCloseTo(m.staminaLandCost * (m.gravity * (47 / 64) - m.jumpImpulse), 3);
    expect(m.staminaLandCost * (m.gravity * (47 / 64) - m.jumpImpulse)).toBeCloseTo(14.275, 3);
  });

  it('a tick late loses a tick of friction and the landing penalty: 250 → 220.5 → 197.1 → 178.4 → 163.5 → 151.7', () => {
    expect(chain(1).takeoff).toEqual([250, 220.5, 197.1, 178.4, 163.5, 151.7]);
    expect(chain(2).takeoff).toEqual([250, 199, 166.3, 145.3, 131.9, 123.3]);
  });
});

describe('M2: the human\'s camera is predicted one tick ahead (Sim3DHost.predictHumanMove)', () => {
  it('equals the state the next tick produces, tick by tick through a run-up, a jump and a perfect hop, and changes nothing', () => {
    const h = host();
    let wasGround = true;
    for (let k = 0; k < 120; k++) {
      const buttons: Button[] = k === 30 ? ['JUMP'] : [];
      h.setHumanInput({ id: 'cart', forward: 1, side: 0, yaw: 0, pitch: 0, buttons: wasGround && k > 31 && k < 90 ? ['JUMP'] : buttons });
      const o0 = JSON.stringify(h.observe());
      const p = h.predictHumanMove();
      expect(JSON.stringify(h.observe())).toBe(o0);
      h.tick();
      const st = (h.pawnState('cart') as { move: MoveState }).move;
      expect(p).toEqual(st);
      wasGround = st.onGround;
    }
    h.setHumanInput(null);
    expect(h.predictHumanMove()).toBeNull();
  });

  it('after the landing tick has run, the predicted camera is on the floor; the plain interpolation is 6 units up until the next tick, the one a perfect hop must already be pressed for', () => {
    const h = host();
    const zs: number[] = [];
    let pred: MoveState | null = null;
    for (let k = 0; k < 60; k++) {
      h.setHumanInput({ id: 'cart', forward: 0, side: 0, yaw: 0, pitch: 0, buttons: k === 0 ? ['JUMP'] : [] });
      h.tick();
      const st = (h.pawnState('cart') as { move: MoveState }).move;
      zs.push(st.pos.z - REST_Z);
      if (st.onGround && k > 0) {
        pred = h.predictHumanMove();
        break;
      }
    }
    const L = zs.length - 1;
    // Drawn at alpha 0 right after tick L ran: predicted = cur (landed); interpolated = prev (still in the air).
    expect(REST_Z).toBe(1 / 32);
    expect(zs[L]).toBe(0);
    expect(pred?.pos.z).toBe(REST_Z);
    expect(zs[L - 1]).toBeCloseTo(6.054, 3);
  });
});

describe('M2: the eye through an in-air duck (view-cs2.ts ViewEye)', () => {
  /** Eye heights per frame at `fps`, drawn between consecutive ticks as the 3D app draws a pawn. */
  function eyes(s: MoveState[], fps: number): number[] {
    const e = new ViewEye();
    const tickMs = 1000 / 64;
    const out: number[] = [];
    for (let f = 0; (f * 1000) / fps < (s.length - 1) * tickMs; f++) {
      const t = (f * 1000) / fps;
      const n = Math.floor(t / tickMs) + 1;
      const alpha = (t - (n - 1) * tickMs) / tickMs;
      const a = s[n - 1] as MoveState;
      const b = s[n] as MoveState;
      const z = a.pos.z + (b.pos.z - a.pos.z) * alpha;
      out.push(z + e.step({ tick: n - 1, crouching: a.crouching, onGround: a.onGround }, { tick: n, crouching: b.crouching, onGround: b.onGround }, alpha, 1 / fps, m.airDuckLift));
    }
    return out;
  }

  it('ducking at air tick 10: the eye never rises above the plain jump\'s, sinks 9 in total and moves < 1 unit per frame relative to it', () => {
    const plain = eyes(jump(-1, 46), 240);
    const ducked = eyes(jump(10, 46), 240);
    const diff = ducked.map((z, i) => z - (plain[i] as number));
    expect(Math.max(...diff)).toBeLessThan(1e-6);
    expect(diff[diff.length - 1] as number).toBeCloseTo(-m.airDuckLift, 6);
    for (let i = 1; i < diff.length; i++) expect(Math.abs((diff[i] as number) - (diff[i - 1] as number))).toBeLessThan(1);
  });

  it('on the ground a duck keeps the feet and eases the eye 64 → 46 in 11 ticks', () => {
    const e = new ViewEye();
    const end = (tick: number, crouching: boolean): { tick: number; crouching: boolean; onGround: boolean } => ({ tick, crouching, onGround: true });
    let eye = e.step(end(0, false), end(1, true), 0, 0, 9);
    expect(eye).toBe(64);
    for (let k = 1; k <= 11; k++) eye = e.step(end(k, true), end(k + 1, true), 0, 1 / 64, 9);
    expect(eye).toBe(46);
  });
});
