/**
 * W1 (#38, #43): the knife in the 3D host (Sim3DHost), headless, on a flat floor. CS:GO / CS2 numbers
 * (src/engine/weapons/knife.ts, CKnife::SwingOrStab): mouse 1 slashes (48 u, 40 then 25, 90 from behind; 0.4 s
 * after a miss, 0.5 s after a hit), mouse 2 stabs (32 u, 65, 180 from behind; 1.0 / 1.1 s); 85 % through armor; a
 * wall stops it; and the human runs at 250 u/s with the knife, 215 with the AK-47 (weapons.json m_flMaxSpeed).
 */
import { describe, expect, it } from 'vitest';
import type { Button, PlayerId, Vec3 } from '../src/contracts/index';
import { KNIFE_DAMAGE, isBackstab, knifeDamage, knifeDelays, maxSpeedOf, armsContext, freshArms, parseWeaponTable } from '../src/engine/weapons/index';
import { MapGeometry } from '../src/sim2d/geometry';
import { Sim3DHost } from '../src/sim3d/index';
import weaponsJson from '../data/weapons.json';
import { act, openNav, setupActions, tuning } from './combat-fixtures';

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

const E = 3000;
const floor = [
  [-E, -E, 0, E, -E, 0, E, E, 0],
  [-E, -E, 0, E, E, 0, -E, E, 0],
];
const roster = [
  { id: 'cart' as PlayerId, team: 'T' as const },
  { id: 'sp4rtan' as PlayerId, team: 'CT' as const },
];

/** cart (human, knife drawn) at the origin facing +x; Sp4rtaN at (x, y) facing `yaw`, with `armor`. */
function host(x: number, yaw: number, opts: { armor?: number; wallAt?: number; weapon?: string } = {}): Sim3DHost {
  const tris = [...floor];
  const w = opts.wallAt;
  if (w !== undefined) tris.push([w, -E, -E, w, E, -E, w, E, E], [w, -E, -E, w, E, E, w, -E, E]);
  const g = meshOf(tris);
  const h = new Sim3DHost(openNav, tuning, roster, null, { mask: null, seed: 1 }, { movement: g, world: g });
  h.apply(act([...setupActions('cart', { x: 0, y: 0 }, 0, opts.weapon ?? 'knife'), ...setupActions('sp4rtan', { x, y: 0 }, yaw, 'ak47', { armor: opts.armor ?? 0, helmet: false })]));
  h.tick();
  h.setHuman('cart');
  return h;
}

interface Hit {
  readonly tick: number;
  readonly attack: string;
  readonly victim: PlayerId | null;
  readonly wall: boolean;
  readonly amount: number;
  readonly armor: number;
}

/** Hold `buttons` for `ticks` ticks (cart still, looking along +x level); every swing with its damage event. */
function hold(h: Sim3DHost, ticks: number, buttons: Button[]): Hit[] {
  const out: Hit[] = [];
  for (let i = 0; i < ticks; i++) {
    h.setHumanInput({ id: 'cart', forward: 0, side: 0, yaw: 0, pitch: 0, buttons });
    h.tick();
    const tick = h.observe().tick - 1;
    const dmg = h.observe().events.find((e) => e.type === 'damage' && e.victim === 'sp4rtan');
    for (const s of h.swings()) {
      out.push({ tick, attack: s.attack, victim: s.victim, wall: s.wall, amount: dmg?.type === 'damage' ? dmg.amount : 0, armor: dmg?.type === 'damage' ? dmg.armor : 0 });
    }
  }
  return out;
}

const hp = (h: Sim3DHost): number => h.observe().pawns.find((p) => p.id === 'sp4rtan')?.hp ?? -1;

describe('knife rules (engine)', () => {
  it('CS:GO / CS2 damage, delays and the backstab cone', () => {
    expect(KNIFE_DAMAGE).toEqual({ slash: { first: 40, next: 25, back: 90 }, stab: { front: 65, back: 180 } });
    expect(knifeDamage('stab', true, false)).toBe(180);
    expect(knifeDelays('slash', false)).toEqual({ slash: 0.4, stab: 0.5 });
    expect(knifeDelays('slash', true)).toEqual({ slash: 0.5, stab: 0.5 });
    expect(knifeDelays('stab', false)).toEqual({ slash: 1, stab: 1 });
    expect(knifeDelays('stab', true)).toEqual({ slash: 1.1, stab: 1.1 });
    // Victim at +x facing +x (away): from behind; facing the attacker: not; 61° off behind still is, 62° isn't.
    expect(isBackstab({ x: 0, y: 0 }, { x: 40, y: 0 }, 0)).toBe(true);
    expect(isBackstab({ x: 0, y: 0 }, { x: 40, y: 0 }, 180)).toBe(false);
    expect(isBackstab({ x: 0, y: 0 }, { x: 40, y: 0 }, 61)).toBe(true);
    expect(isBackstab({ x: 0, y: 0 }, { x: 40, y: 0 }, 62)).toBe(false);
  });
});

describe('the knife in the 3D host', () => {
  it('mouse 1 held: 40, then 25 per slash every 0.5 s on a hit (front, no armor)', () => {
    const h = host(40, 180);
    // bFirstSwing needs 0.4 s past the slash timer, which the deploy set (DefaultDeploy: m_flNextPrimaryAttack).
    hold(h, 27, []);
    const hits = hold(h, 40, ['ATTACK']);
    expect(hits.length).toBe(2);
    expect(hits.map((x) => [x.attack, x.victim, x.amount])).toEqual([
      ['slash', 'sp4rtan', 40],
      ['slash', 'sp4rtan', 25],
    ]);
    expect((hits[1] as Hit).tick - (hits[0] as Hit).tick).toBe(32); // 0.5 s
    expect(hp(h)).toBe(35);
  });

  it('a slash right after the deploy is not a first swing (25), as in CS', () => {
    expect(hold(host(40, 180), 1, ['ATTACK'])[0]?.amount).toBe(25);
  });

  it('a slash that misses: next one 0.4 s later (25.6 ticks → tick 26)', () => {
    const h = host(300, 180);
    const hits = hold(h, 30, ['ATTACK']);
    expect(hits.map((x) => x.victim)).toEqual([null, null]);
    expect((hits[1] as Hit).tick - (hits[0] as Hit).tick).toBe(26);
  });

  it('slash from behind: 90; through armor 85 % (90 → 76 HP)', () => {
    expect(hold(host(40, 0), 1, ['ATTACK'])[0]?.amount).toBe(90);
    const ha = host(40, 0, { armor: 100 });
    hold(ha, 27, []);
    const armored = hold(ha, 1, ['ATTACK'])[0];
    expect(armored?.amount).toBe(76);
    expect(armored?.armor).toBeGreaterThan(0);
  });

  it('mouse 2: stab 65 in front; 180 from behind kills through armor; reach 32 u (not 48)', () => {
    const front = hold(host(40, 180), 1, ['ATTACK2']);
    expect(front[0]).toMatchObject({ attack: 'stab', amount: 65 });
    const back = host(40, 0, { armor: 100 });
    hold(back, 1, ['ATTACK2']);
    expect(hp(back)).toBe(0);
    expect(back.observe().events.some((e) => e.type === 'death' && e.victim === 'sp4rtan' && e.weapon === 'knife')).toBe(true);
    // The line, then the ±16 hull sweep: a box face within reach + 16 is hit. Sp4rtaN at 75 (face 59): a slash
    // (48 + 16 = 64) reaches him, a stab (32 + 16 = 48) doesn't; at 60 (face 44) the stab does.
    expect(hold(host(75, 180), 1, ['ATTACK2'])[0]?.victim).toBeNull();
    expect(hold(host(75, 180), 1, ['ATTACK'])[0]?.victim).toBe('sp4rtan');
    expect(hold(host(60, 180), 1, ['ATTACK2'])[0]?.victim).toBe('sp4rtan');
    expect(hold(host(85, 180), 1, ['ATTACK'])[0]?.victim).toBeNull();
  });

  it('stabs every 1.1 s while held on a hit; mouse 1 wins when both are held', () => {
    const h = host(40, 180, { armor: 0 });
    h.apply(act([{ type: 'set_hp', id: 'sp4rtan', hp: 1000, armor: 0, helmet: false }]));
    const stabs = hold(h, 80, ['ATTACK2']);
    expect(stabs.length).toBe(2);
    expect((stabs[1] as Hit).tick - (stabs[0] as Hit).tick).toBe(71); // 70.4 ticks
    expect(hold(host(40, 180), 1, ['ATTACK', 'ATTACK2'])[0]?.attack).toBe('slash');
  });

  it('a wall between them stops the knife (a wall hit, no damage)', () => {
    const h = host(44, 180, { wallAt: 20 });
    const hits = hold(h, 1, ['ATTACK']);
    expect(hits[0]).toMatchObject({ victim: null, wall: true });
    expect(hp(h)).toBe(100);
  });

  it('waits for the deploy: no swing until the knife is out (1.0 s)', () => {
    const h = host(40, 180, { weapon: 'ak47' });
    h.apply(act([{ type: 'give', id: 'cart', item: 'knife', clip: 0, reserve: 0 }, { type: 'set_weapon', id: 'cart', weapon: 'knife' }]));
    const hits = hold(h, 70, ['ATTACK']);
    expect(hits.length).toBeGreaterThan(0);
    expect((hits[0] as Hit).tick).toBeGreaterThanOrEqual(63);
  });
});

describe('knife speed (#43)', () => {
  it('maxSpeedOf: knife 250, AK-47 215 (weapons.json m_flMaxSpeed)', () => {
    const ctx = armsContext(parseWeaponTable(weaponsJson), tuning, 64);
    expect(maxSpeedOf(ctx, freshArms(ctx, 'knife', 0), false)).toBe(250);
    expect(maxSpeedOf(ctx, freshArms(ctx, 'ak47', 0), false)).toBe(215);
  });

  it('the human walks (runs) at 250 u/s with the knife and 215 with the AK-47 in the 3D host', () => {
    const run = (weapon: string): number => {
      const h = host(-2000, 0, { weapon });
      let v: Vec3 = { x: 0, y: 0, z: 0 };
      for (let i = 0; i < 128; i++) {
        h.setHumanInput({ id: 'cart', forward: 1, side: 0, yaw: 0, pitch: 0, buttons: [] });
        h.tick();
        v = h.observe().pawns.find((p) => p.id === 'cart')?.vel ?? v;
      }
      return Math.hypot(v.x, v.y);
    };
    expect(run('knife')).toBeCloseTo(250, 3);
    expect(run('ak47')).toBeCloseTo(215, 3);
  });
});
