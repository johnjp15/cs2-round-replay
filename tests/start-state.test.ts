import { describe, expect, it } from 'vitest';
import { PLAYER_IDS, type Action, type PlayerId, type Tuning } from '../src/contracts/index';
import { RoundModel, startActions, startYaw } from '../src/core/index';
import { loadRound, loadTuning } from './round-fixture';

const model = new RoundModel(loadRound());
const tuning = loadTuning();
const actions = startActions(model, tuning);

type Give = [item: string, clip: number, reserve: number];
interface Expected {
  hp: number;
  /** V4: eradicate's HUD reads 89 armor from 0 s (a kept vest); everyone else 100. */
  armor?: number;
  gives: Give[];
  weapon: string;
}

// Round start facts (project movement doc), copied here on purpose. W2: every pawn also gets a pistol, the recorded one
// (donk's Glock-18, Sp4rtaN's Desert Eagle) or the team default (T Glock-18, CT USP-S), drawn weapons unchanged.
const EXPECTED: Record<PlayerId, Expected> = {
  barely: { hp: 100, gives: [['ak47', 30, 90], ['glock', 20, 120], ['he', 0, 0], ['smoke', 0, 0], ['c4', 0, 0]], weapon: 'ak47' },
  cart: { hp: 100, gives: [['ak47', 30, 90], ['glock', 20, 120], ['smoke', 0, 0], ['smoke', 0, 0]], weapon: 'ak47' },
  donk: { hp: 100, gives: [['awp', 10, 30], ['glock', 20, 120], ['flash', 0, 0], ['molotov', 0, 0]], weapon: 'awp' },
  eradicate: { hp: 100, armor: 89, gives: [['ak47', 30, 90], ['glock', 20, 120]], weapon: 'ak47' },
  incredibad: { hp: 100, gives: [['m4a4', 30, 90], ['usps', 12, 24]], weapon: 'm4a4' },
  lokier: { hp: 100, gives: [['ssg08', 10, 90], ['usps', 12, 24]], weapon: 'ssg08' },
  snakelore: { hp: 100, gives: [['m4a4', 30, 90], ['usps', 12, 24]], weapon: 'm4a4' },
  snarlbot: { hp: 44, gives: [['ak47', 30, 90], ['glock', 20, 120], ['smoke', 0, 0], ['flash', 0, 0]], weapon: 'ak47' },
  sp4rtan: { hp: 100, gives: [['deagle', 7, 35], ['defuser', 0, 0]], weapon: 'deagle' },
  zwomp: { hp: 100, gives: [['m4a4', 30, 90], ['usps', 12, 24]], weapon: 'm4a4' },
};

function forPlayer(id: PlayerId): Action[] {
  return actions.filter((a) => 'id' in a && a.id === id);
}

describe('startActions', () => {
  it('emits teleport, set_hp, gives, set_weapon per player, in id order', () => {
    const order: string[] = [];
    for (const a of actions) if ('id' in a && order.at(-1) !== a.id) order.push(a.id);
    expect(order).toEqual([...PLAYER_IDS]);
    for (const id of PLAYER_IDS) {
      const types = forPlayer(id).map((a) => a.type);
      expect(types, id).toEqual(['teleport', 'set_hp', ...EXPECTED[id].gives.map(() => 'give'), 'set_weapon']);
    }
  });

  it('matches the round start facts for all ten players', () => {
    for (const id of PLAYER_IDS) {
      const e = EXPECTED[id];
      const acts = forPlayer(id);
      expect(acts[1], id).toEqual({ type: 'set_hp', id, hp: e.hp, armor: e.armor ?? 100, helmet: true });
      const gives = acts.filter((a) => a.type === 'give').map((a) => [a.item, a.clip, a.reserve]);
      expect(gives, id).toEqual(e.gives);
      expect(acts.at(-1), id).toEqual({ type: 'set_weapon', id, weapon: e.weapon });
      const tp = acts[0];
      expect(tp?.type === 'teleport' && tp.pos, id).toEqual(model.player(id).startPos);
    }
    expect(forPlayer('snarlbot')[1]).toMatchObject({ hp: 44 });
    expect(forPlayer('lokier').find((a) => a.type === 'give')).toMatchObject({ item: 'ssg08' });
  });

  it('resolves start yaws by the documented rules', () => {
    expect(startYaw(model, 'eradicate')).toEqual({ yaw: 167.2, source: 'recorded' });

    const s = model.player('snarlbot').startPos;
    const i = model.player('incredibad').startPos;
    const toward = (Math.atan2(i.y - s.y, i.x - s.x) * 180) / Math.PI;
    const snarl = startYaw(model, 'snarlbot');
    const incred = startYaw(model, 'incredibad');
    expect(snarl.source).toBe('facing');
    expect(incred.source).toBe('facing');
    expect(snarl.yaw).toBeCloseTo(toward, 3);
    expect(incred.yaw - snarl.yaw).toBeCloseTo(180, 2);

    // barely's first sample > 8 units from the start within 1 s is at 0.2 s: (-490, 643).
    const b = startYaw(model, 'barely');
    expect(b.source).toBe('motion');
    expect(b.yaw).toBeCloseTo((Math.atan2(643 - 647, -490 - -473) * 180) / Math.PI, 3);
    for (const id of ['cart', 'donk'] as const) expect(startYaw(model, id).source, id).toBe('motion');
    // These CTs' inferred tracks hold still for the first second.
    for (const id of ['lokier', 'snakelore', 'sp4rtan', 'zwomp'] as const) expect(startYaw(model, id), id).toEqual({ yaw: 0, source: 'default' });

    for (const a of actions) if (a.type === 'teleport') expect(a.yaw).toBe(startYaw(model, a.id).yaw);
  });

  it('is deterministic and needs tuning for guns not drawn at t = 0', () => {
    expect(startActions(model, tuning)).toEqual(actions);
    const noGlock: Tuning = { ...tuning, weapons: { ...tuning.weapons } };
    delete (noGlock.weapons as Record<string, unknown>)['glock'];
    expect(() => startActions(model, noGlock)).toThrow(/tuning\.weapons\.glock/);
  });
});
