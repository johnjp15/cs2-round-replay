/**
 * B1 (backlog #32): bots compensate recoil like a player pulling the mouse down. In CS2 the bullet leaves along
 * view + aim punch × recoilScale; a LIVE bot sets its view to (target − that punch offset) before the shot, so its
 * spray stays on the target instead of climbing over the head. Headless, in the 3D host on a flat floor: a LIVE AK
 * bot sprays a standing target (10 000 HP so every bullet of the burst can be scored) at 300 and 600 units; each
 * bullet is scored with the hitbox trace (`Shot3.victim`) and its height relative to the target's head. A puppet's
 * tracer (its drawn bullet; its outcome stays the tape's) goes along its scripted view, not above it.
 */
import { describe, expect, it } from 'vitest';
import type { Action, PlayerId, Tuning } from '../src/contracts/index';
import { MapGeometry } from '../src/sim2d/geometry';
import { Sim3DHost, type Shot3 } from '../src/sim3d/index';
import { act, openNav, setupActions, tuning } from './combat-fixtures';

const DEG = 180 / Math.PI;

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
const E = 4000;
const floor = meshOf([
  [-E, -E, 0, E, -E, 0, E, E, 0],
  [-E, -E, 0, E, E, 0, -E, E, 0],
]);
const roster = [
  { id: 'cart' as PlayerId, team: 'T' as const },
  { id: 'sp4rtan' as PlayerId, team: 'CT' as const },
];

interface Burst {
  /** Bullets fired by the bot, in order. */
  readonly shots: readonly Shot3[];
  /** Of the first `n`, how many entered one of the target's hitboxes. */
  hits(n: number): number;
  /** Height of bullet i where it passes the target (units above the floor). */
  heightAt(i: number): number;
}

/** The AI with no aim error (acquisition offset and per-shot residual 0): recoil control and CS2's spread alone. */
const perfectAim: Tuning = { ...tuning, ai: { ...tuning.ai, aimErrorDeg: 0, aimResidualDeg: 0 } };

/** cart (T, LIVE, AK-47) at the origin; sp4rtan (CT, puppet, 10 000 HP) standing `range` units east. */
function burst(seed: number, range: number, control: boolean, t: Tuning): Burst {
  const h = new Sim3DHost(openNav, t, roster, null, { mask: null, seed }, { movement: floor, world: floor });
  h.setHuman(null);
  h.setBotRecoilControl(control);
  const live: Action = { type: 'set_mode', id: 'cart', mode: 'LIVE', goal: { route: [], role: 'hold', hold: { x: 0, y: 0, z: 0 } } };
  h.apply(act([...setupActions('cart', { x: 0, y: 0 }, 0, 'ak47'), ...setupActions('sp4rtan', { x: range, y: 0 }, 180, 'ak47', { hp: 10000 }), live]));
  const shots: Shot3[] = [];
  for (let t = 0; t < 64 * 6 && shots.length < 30; t++) {
    h.tick();
    for (const s of h.shots()) if (s.shooter === 'cart') shots.push(s);
  }
  return {
    shots,
    hits: (n) => shots.slice(0, n).filter((s) => s.victim === 'sp4rtan').length,
    heightAt: (i) => {
      const s = shots[i] as Shot3;
      const f = (range - s.from.x) / (s.to.x - s.from.x);
      return s.from.z + (s.to.z - s.from.z) * f;
    },
  };
}

const SEEDS = Array.from({ length: 20 }, (_, k) => 100 + k);
const HEAD = tuning.damage.eyeHeight + 8; // above the top of the head hitbox

function report(range: number, control: boolean, t: Tuning = tuning): { rate: number; above: number; heights: number[] } {
  let hit = 0;
  let total = 0;
  let above = 0;
  const heights = Array.from({ length: 10 }, () => 0);
  for (const seed of SEEDS) {
    const b = burst(seed, range, control, t);
    expect(b.shots.length, `seed ${seed}: the bot fired`).toBeGreaterThanOrEqual(10);
    hit += b.hits(10);
    total += 10;
    for (let i = 0; i < 10; i++) {
      const z = b.heightAt(i);
      heights[i] = (heights[i] as number) + z / SEEDS.length;
      if (i >= 2 && z > HEAD) above++;
    }
  }
  const rate = hit / total;
  console.log(
    `[bot recoil] ${control ? 'compensated' : 'uncompensated'}${t === perfectAim ? ', no aim error,' : ''} AK burst at ${range} u: ${(rate * 100).toFixed(0)} % of 10 bullets hit; ` +
      `bullets 3–10 above the head: ${above}/${8 * SEEDS.length}; mean height per bullet ${heights.map((z) => z.toFixed(0)).join(' ')}`,
  );
  return { rate, above, heights };
}

describe('B1: a LIVE bot sprays an AK-47 at a standing target (20 seeds)', () => {
  it('perfect compensation (no AI aim error: recoil control + CS2 spread): ≥ 80 % of a 10-round burst at 300 u hits', () => {
    const r = report(300, true, perfectAim);
    expect(r.rate).toBeGreaterThanOrEqual(0.8);
    expect(r.above).toBe(0);
    report(600, true, perfectAim);
  });

  it('regression guard: the same bot without compensation climbs over the head (fewer than 80 % hit)', () => {
    const r = report(300, false, perfectAim);
    expect(r.rate).toBeLessThan(0.8);
    expect(r.above).toBeGreaterThan(0.5 * 8 * SEEDS.length);
  });

  it("with the AI's skill model (its aim error kept, centred on the target): bullets 3+ stay at the target, ≥ 70 % hit at 300 u", () => {
    const r = report(300, true);
    expect(r.rate).toBeGreaterThanOrEqual(0.7);
    expect(r.above).toBeLessThan(0.1 * 8 * SEEDS.length);
    // The mean height of every bullet stays within 8 u of the first's (no climb).
    for (const z of r.heights) expect(Math.abs(z - (r.heights[0] as number))).toBeLessThan(8);
    report(600, true);
  });

  it('regression guard with the skill model: uncompensated, the spray climbs (mean height of bullet 10 ≥ 30 u over bullet 1)', () => {
    const r = report(300, false);
    expect(r.rate).toBeLessThan(0.5);
    expect((r.heights[9] as number) - (r.heights[0] as number)).toBeGreaterThan(30);
    report(600, false);
  });
});

describe("B1: a puppet's tracer goes where it aims (its outcome stays the tape's)", () => {
  /** sp4rtan (puppet, AK-47) sprays a scripted view at cart 300 u away; the drawn bullets' angle to that view. */
  function puppetSpray(control: boolean): number[] {
    const h = new Sim3DHost(openNav, tuning, roster, null, { mask: null, seed: 7 }, { movement: floor, world: floor });
    h.setHuman(null);
    h.setBotRecoilControl(control);
    h.apply(act([...setupActions('sp4rtan', { x: 0, y: 0 }, 0, 'ak47'), ...setupActions('cart', { x: 3000, y: 0 }, 180, 'ak47', { hp: 10000 })]));
    const out: number[] = [];
    for (let t = 0; t < 64 * 2 && out.length < 15; t++) {
      h.apply(act([], [{ id: 'sp4rtan', forward: 0, side: 0, yaw: 0, pitch: 0, buttons: ['ATTACK'] }]));
      h.tick();
      for (const s of h.shots()) {
        if (s.shooter !== 'sp4rtan') continue;
        const dx = s.to.x - s.from.x;
        const dz = s.to.z - s.from.z;
        out.push(Math.atan2(dz, Math.hypot(dx, s.to.y - s.from.y)) * DEG);
      }
    }
    return out;
  }

  it('compensated, every drawn bullet of a 15-bullet spray leaves within the standing cone of the view (no climb)', () => {
    const up = puppetSpray(true);
    expect(up.length).toBe(15);
    console.log(`[bot recoil] puppet tracer elevation (deg), compensated: ${up.map((a) => a.toFixed(2)).join(' ')}`);
    for (const a of up) expect(Math.abs(a)).toBeLessThan(1.2);
  });

  it('uncompensated (the old behaviour) the drawn spray climbs several degrees', () => {
    const up = puppetSpray(false);
    console.log(`[bot recoil] puppet tracer elevation (deg), uncompensated: ${up.map((a) => a.toFixed(2)).join(' ')}`);
    expect(Math.max(...up)).toBeGreaterThan(3);
  });
});
