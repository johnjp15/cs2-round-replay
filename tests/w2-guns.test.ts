/**
 * W2 (V1 audit finding 5): the 3D host's guns are CS2's (data/weapons.json via src/sim3d/guns.ts) for a mechanical
 * pawn (the human here): every gun of the table can be drawn, fired and reloaded with the table's clip, reserve,
 * cycle and reload numbers. Puppets keep the 2D table (the golden master: tests/sim3d-golden.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { canonicalize, type Action, type Button, type ObsEvent, type PawnInput } from '../src/contracts/index';
import { Session } from '../src/app/session';
import { parseWeaponTable } from '../src/engine/weapons/index';
import { sim3dHostFactory, type Sim3DHost } from '../src/sim3d/index';
import { gunFromDef, gunTable, tableId } from '../src/sim3d/guns';
import weaponsJson from '../data/weapons.json';
import { loadHarness3dData } from '../tools/harness3d';

const data = loadHarness3dData();
const table = parseWeaponTable(weaponsJson);
const guns = gunTable(table);

describe('W2 CS2 guns', () => {
  it('maps the table: AWP 5 / 10, USP-S 12 / 24, M4A1-S 20 / 80; aliases resolve; non-guns are null', () => {
    expect(guns.get('awp')).toMatchObject({ clip: 5, reserve: 10, automatic: false });
    expect(guns.get('usps')).toMatchObject({ clip: 12, reserve: 24, damage: 35 });
    expect(guns.get('m4a1s')?.clip).toBe(table.weapons['m4a1s']?.clip);
    expect(guns.get('ak47')?.armorPen).toBeCloseTo(0.775, 9);
    expect(guns.get('ak47')?.rpm).toBeCloseTo(600, 9);
    expect(tableId(table, 'm4a1')).toBe('m4a4');
    expect(tableId(table, 'nope')).toBeNull();
    expect(gunFromDef(table.weapons['knife'] as never)).toBeNull();
    expect(guns.has('smoke')).toBe(false);
    expect(guns.size).toBeGreaterThan(30);
  });

  it('every table gun is drawn, fired, cycled and reloaded by the human with the table numbers', { timeout: 600_000 }, () => {
    const s = new Session({ ...data, seed: 1, human: 'cart', host: sim3dHostFactory(data.world) });
    const h = s.host as unknown as Sim3DHost;
    const look = (buttons: Button[]): PawnInput => canonicalize({ id: 'cart', forward: 0, side: 0, yaw: 90, pitch: -60, buttons });
    for (let k = 0; k < 4; k++) {
      s.setHumanInput(look([]));
      s.step();
    }
    const base = s.snapshot();
    const problems: string[] = [];
    for (const [id, g] of guns) {
      const revolver = id === 'revolver';
      s.restore(base);
      const actions = [
        { type: 'give', id: 'cart', item: id, clip: g.clip, reserve: g.reserve },
        { type: 'set_weapon', id: 'cart', weapon: id },
      ] as unknown as Action[];
      h.apply({ tick: s.observe().tick, inputs: [], actions } as never);
      const step = (buttons: Button[]): readonly ObsEvent[] => {
        s.setHumanInput(look(buttons));
        s.step();
        return s.observe().events;
      };
      const ammo = () => h.pawnState('cart')?.inventory.find((q) => q.item === id);
      // Deploy.
      for (let k = 0; k < Math.ceil(g.deploySec * 64) + 2; k++) step([]);
      if (h.pawnState('cart')?.weapon !== id) {
        problems.push(`${id}: not drawn`);
        continue;
      }
      const shot = (ev: readonly ObsEvent[]) => ev.some((e) => e.type === 'shot' && e.shooter === 'cart');
      if (!shot(step(['ATTACK']))) {
        problems.push(`${id}: no shot`);
        continue;
      }
      const t0 = s.observe().tick;
      if (ammo()?.clip !== g.clip - 1) problems.push(`${id}: clip after a shot ${ammo()?.clip}, want ${g.clip - 1}`);
      // The next shot: held (automatic) or pressed on alternate ticks (semi-automatic).
      let t1: number | null = null;
      if (g.clip > 1) {
        for (let k = 0; k < Math.ceil((60 / g.rpm) * 64) + 70 && t1 === null; k++) {
          const press = g.automatic || k % 2 === 1;
          if (shot(step(press ? ['ATTACK'] : []))) t1 = s.observe().tick;
        }
        const want = (60 / g.rpm) * 64;
        if (t1 === null) problems.push(`${id}: no second shot`);
        else if (t1 - t0 < want - 1 || t1 - t0 > want + (g.automatic ? 1.5 : 2.5) + 64 * 0.5 * Number(revolver)) problems.push(`${id}: ${t1 - t0} ticks between shots, cycle ${want.toFixed(2)}`);
      }
      // Reload to a full magazine from the reserve in the table's reload time.
      if (g.reserve > 0) {
        for (let k = 0; k < 40; k++) step([]);
        const before = ammo();
        step(['RELOAD']);
        const r0 = s.observe().tick;
        let done: number | null = null;
        for (let k = 0; k < Math.ceil(g.reloadSec * 64) + 10 && done === null; k++) {
          step([]);
          if (ammo()?.clip === g.clip) done = s.observe().tick;
        }
        // CS2 discards the rest of the magazine: a full one comes out of the reserve.
        const used = Math.min(g.clip, before?.reserve ?? 0);
        if (done === null) problems.push(`${id}: not reloaded (${JSON.stringify(ammo())})`);
        else {
          if (Math.abs(done - r0 - g.reloadSec * 64) > 2) problems.push(`${id}: reload ${done - r0} ticks, table ${(g.reloadSec * 64).toFixed(1)}`);
          if (ammo()?.reserve !== (before?.reserve ?? 0) - used) problems.push(`${id}: reserve ${ammo()?.reserve}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('the human\'s AWP from the kit (10 / 30, the 2020 recording) becomes CS2\'s 5 / 10 when he holds it', () => {
    const s = new Session({ ...data, seed: 1, human: 'cart', host: sim3dHostFactory(data.world) });
    const h = s.host as unknown as Sim3DHost;
    s.step();
    h.apply({ tick: s.observe().tick, inputs: [], actions: [{ type: 'give', id: 'cart', item: 'awp', clip: 10, reserve: 30 }, { type: 'set_weapon', id: 'cart', weapon: 'awp' }] } as never);
    s.setHumanInput(canonicalize({ id: 'cart', forward: 0, side: 0, yaw: 0, pitch: 0, buttons: [] }));
    s.step();
    s.step();
    expect(s.observe().pawns.find((p) => p.id === 'cart')?.ammo).toEqual({ clip: 5, reserve: 10 });
  });
});
