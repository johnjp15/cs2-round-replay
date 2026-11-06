import { describe, expect, it } from 'vitest';
import {
  SessionLog,
  canonicalize,
  type Act,
  type Action,
  type ICore,
  type Observe,
  type PawnInput,
  type PawnObs,
  type PlayerId,
} from '../src/contracts/index';
import { Sim2DHost, UNSUPPORTED_V0, type RosterEntry } from '../src/sim2d/host';
import { EchoCore } from './fakes';
import { nav, round, roster, tuning } from './sim2d-fixtures';

const EMPTY_STATUS: Act['status'] = [];

function newHost(): Sim2DHost {
  return new Sim2DHost(nav, tuning, roster);
}

function pawn(o: Observe, id: PlayerId): PawnObs {
  const p = o.pawns.find((q) => q.id === id);
  if (p === undefined) throw new Error(`no pawn ${id}`);
  return p;
}

/** An action with fields the current contracts may not have yet (B1 adds glock, defuser, set_hp.helmet). */
function loose(a: object): Action {
  return a as unknown as Action;
}

function act(actions: readonly Action[], inputs: readonly PawnInput[] = []): Act {
  return { inputs, actions, status: EMPTY_STATUS };
}

function input(id: PlayerId, forward: number, side: number, yaw: number): PawnInput {
  return { id, forward, side, yaw, pitch: 0, buttons: [] };
}

/** Round start from round.json: teleport, HP/armor, kit, weapon drawn. */
function setupActions(): Action[] {
  const out: Action[] = [];
  for (const p of round.players) {
    out.push({ type: 'teleport', id: p.id, pos: p.start.pos, yaw: 0 });
    out.push({ type: 'set_hp', id: p.id, hp: p.startHp, armor: p.startArmor });
    const drawn = p.kit.primary ?? p.kit.secondary;
    if (drawn !== null) {
      out.push(loose({ type: 'give', id: p.id, item: drawn, clip: p.kit.clip, reserve: p.kit.reserve }));
      out.push(loose({ type: 'set_weapon', id: p.id, weapon: drawn }));
    }
  }
  return out;
}

/** EchoCore plus the round setup on the first step. */
class SetupCore extends EchoCore {
  override step(o: Observe): Act {
    const a = super.step(o);
    return o.tick === 0 ? { ...a, actions: [...setupActions(), ...a.actions] } : a;
  }
}

/** Driver loop: observe (canonical) -> step -> log -> apply -> tick. */
function drive(host: Sim2DHost, core: ICore, ticks: number, log: SessionLog = new SessionLog()): SessionLog {
  for (let i = 0; i < ticks; i++) {
    const o = canonicalize(host.observe());
    const a = core.step(o);
    log.append(o, a);
    host.apply(a);
    host.tick();
  }
  return log;
}

describe('Sim2DHost observe', () => {
  it('reports all ten pawns sorted by id, no sees/events, human = cart by default', () => {
    const o = newHost().observe();
    expect(o.tick).toBe(0);
    expect(o.t).toBe(0);
    expect(o.human).toBe('cart');
    expect(o.events).toEqual([]);
    expect(o.pawns.map((p) => p.id)).toEqual(['barely', 'cart', 'donk', 'eradicate', 'incredibad', 'lokier', 'snakelore', 'snarlbot', 'sp4rtan', 'zwomp']);
    expect(pawn(o, 'sp4rtan').team).toBe('CT');
    expect(pawn(o, 'cart').team).toBe('T');
    for (const p of o.pawns) expect(p.sees).toEqual([]);
  });

  it('rejects a bad roster', () => {
    expect(() => new Sim2DHost(nav, tuning, [])).toThrow(/empty/);
    const one = roster[0] as RosterEntry;
    expect(() => new Sim2DHost(nav, tuning, [one, one])).toThrow(/duplicate/);
  });
});

describe('Sim2DHost actions', () => {
  it('teleport / set_hp / give / set_weapon show up in observe()', () => {
    const host = newHost();
    host.apply(
      act([
        { type: 'teleport', id: 'cart', pos: { x: -391, y: 909, z: -84 }, yaw: 45 },
        { type: 'set_hp', id: 'cart', hp: 61, armor: 37 },
        { type: 'give', id: 'cart', item: 'ak47', clip: 30, reserve: 90 },
        { type: 'set_weapon', id: 'cart', weapon: 'ak47' },
      ]),
    );
    const p = pawn(host.observe(), 'cart');
    expect(p.pos).toEqual({ x: -391, y: 909, z: -84 });
    expect(p.vel).toEqual({ x: 0, y: 0, z: 0 });
    expect(p.yaw).toBe(45);
    expect(p.hp).toBe(61);
    expect(p.armor).toBe(37);
    expect(p.alive).toBe(true);
    expect(p.weapon).toBe('ak47');
    expect(p.ammo).toEqual({ clip: 30, reserve: 90 });
    expect(host.unhandled()).toEqual([]);

    // A tick snaps z to the nav floor and keeps the pawn put without input.
    host.tick();
    const q = pawn(host.observe(), 'cart');
    expect(q.pos.x).toBe(-391);
    expect(q.pos.z).toBeCloseTo(nav.zAt({ x: -391, y: 909, z: -84 }), 6);
  });

  it('teleport zeroes velocity; set_hp 0 kills and set_hp > 0 revives', () => {
    const host = newHost();
    host.apply(act([{ type: 'teleport', id: 'cart', pos: { x: -391, y: 909, z: -84 }, yaw: 0 }], [input('cart', 1, 0, 0)]));
    for (let i = 0; i < 10; i++) host.tick();
    expect(Math.hypot(pawn(host.observe(), 'cart').vel.x, pawn(host.observe(), 'cart').vel.y)).toBeGreaterThan(50);
    host.apply(act([{ type: 'teleport', id: 'cart', pos: { x: -391, y: 909, z: -84 }, yaw: 90 }]));
    expect(pawn(host.observe(), 'cart').vel).toEqual({ x: 0, y: 0, z: 0 });

    host.apply(act([{ type: 'set_hp', id: 'donk', hp: 0, armor: 0 }]));
    expect(pawn(host.observe(), 'donk').alive).toBe(false);
    host.apply(act([{ type: 'set_hp', id: 'donk', hp: 100, armor: 100 }]));
    expect(pawn(host.observe(), 'donk').alive).toBe(true);
  });

  it('dead pawns do not move', () => {
    const host = newHost();
    host.apply(act([{ type: 'teleport', id: 'cart', pos: { x: -391, y: 909, z: -84 }, yaw: 0 }, { type: 'set_hp', id: 'cart', hp: 0, armor: 0 }], [input('cart', 1, 0, 0)]));
    for (let i = 0; i < 10; i++) host.tick();
    expect(pawn(host.observe(), 'cart').pos.x).toBe(-391);
  });

  it('set_weapon needs the item; give replaces an entry; set_mode is recorded', () => {
    const host = newHost();
    host.apply(
      act([
        { type: 'set_weapon', id: 'donk', weapon: 'awp' },
        { type: 'give', id: 'donk', item: 'awp', clip: 10, reserve: 30 },
        { type: 'give', id: 'donk', item: 'awp', clip: 4, reserve: 20 },
        { type: 'set_weapon', id: 'donk', weapon: 'awp' },
        { type: 'set_mode', id: 'donk', mode: 'LIVE', goal: { route: [{ x: 1, y: 2, z: 3 }], role: 'hold', hold: null } },
      ]),
    );
    expect(pawn(host.observe(), 'donk').weapon).toBe('awp');
    expect(pawn(host.observe(), 'donk').ammo).toEqual({ clip: 4, reserve: 20 });
    expect(host.pawnState('donk')?.inventory).toEqual([
      { item: 'awp', clip: 4, reserve: 20 },
      { item: 'knife', clip: 0, reserve: 0 },
    ]);
    expect(host.pawnState('donk')?.mode).toBe('LIVE');
    expect(host.pawnState('donk')?.goal?.role).toBe('hold');
    expect(host.unhandled().map((n) => [n.type, n.reason])).toEqual([['set_weapon', 'not in inventory']]);
  });

  it('records combat, bomb and round actions and controls as unsupported in v0 (nothing vanishes)', () => {
    const host = newHost();
    const actions: Action[] = [
      { type: 'damage', attacker: 'cart', victim: 'lokier', amount: 27, armor: 5, hitgroup: 'chest', weapon: 'ak47', lethal: false },
      { type: 'block_damage', attacker: 'sp4rtan', victim: 'cart' },
      { type: 'unblock_damage', attacker: 'sp4rtan', victim: 'cart' },
      { type: 'plant', id: 'barely', pos: { x: -1982, y: 311, z: -160 } },
      { type: 'defuse_start', id: 'sp4rtan' },
      { type: 'defuse_stop', id: 'sp4rtan' },
      { type: 'end_round', winner: 'CT', reason: 'bomb_defused' },
      { type: 'log', level: 'info', text: 'for the status panel' },
      loose({ type: 'future_action', id: 'cart' }),
    ];
    host.apply(act(actions));
    host.control({ type: 'pause', paused: true });
    const notes = host.unhandled();
    expect(notes.map((n) => n.type)).toEqual(['damage', 'block_damage', 'unblock_damage', 'plant', 'defuse_start', 'defuse_stop', 'end_round', 'future_action', 'pause']);
    for (const n of notes) expect(n.reason).toBe(UNSUPPORTED_V0);
    expect(notes[0]?.data).toEqual(actions[0]);
    expect(notes.at(-1)?.kind).toBe('control');
    // Unsupported damage does not touch HP.
    expect(pawn(host.observe(), 'lokier').hp).toBe(100);
  });

  it('tolerates B1 fields: glock, defuser item, set_hp.helmet', () => {
    const host = newHost();
    host.apply(
      act([
        loose({ type: 'give', id: 'donk', item: 'glock', clip: 20, reserve: 120 }),
        loose({ type: 'set_weapon', id: 'donk', weapon: 'glock' }),
        loose({ type: 'give', id: 'sp4rtan', item: 'defuser', clip: 0, reserve: 0 }),
        loose({ type: 'set_weapon', id: 'sp4rtan', weapon: 'defuser' }),
        loose({ type: 'set_hp', id: 'sp4rtan', hp: 100, armor: 100, helmet: true }),
      ]),
    );
    const o = host.observe();
    expect(pawn(o, 'donk').weapon).toBe('glock');
    expect(pawn(o, 'donk').ammo).toEqual({ clip: 20, reserve: 120 });
    expect(host.pawnState('sp4rtan')?.inventory.map((q) => q.item)).toEqual(['defuser', 'knife']);
    expect(host.pawnState('sp4rtan')?.helmet).toBe(true);
    expect(pawn(o, 'sp4rtan').weapon).toBe('knife');
    expect(host.unhandled().map((n) => [n.type, n.reason])).toEqual([['set_weapon', 'item cannot be held']]);
    // The glock's run speed comes from tuning.
    host.apply(act([{ type: 'teleport', id: 'donk', pos: { x: -1700, y: 400, z: -160 }, yaw: 0 }], [input('donk', 1, 0, 0)]));
    for (let i = 0; i < 128; i++) host.tick();
    expect(Math.hypot(pawn(host.observe(), 'donk').vel.x, pawn(host.observe(), 'donk').vel.y)).toBeCloseTo(tuning.movement.runSpeedByWeapon['glock'] ?? NaN, 6);
  });

  it('flags inputs for unknown or duplicate pawns', () => {
    const host = newHost();
    host.apply(act([], [input('cart', 1, 0, 0), input('cart', 0, 1, 0)]));
    expect(host.unhandled().map((n) => n.reason)).toEqual(['duplicate input for pawn; first one kept']);
  });
});

describe('Sim2DHost inputs', () => {
  it('Core inputs persist until the next apply; pawns without input coast to a stop', () => {
    const host = newHost();
    host.apply(act([{ type: 'teleport', id: 'cart', pos: { x: -1700, y: 400, z: -160 }, yaw: 0 }], [input('cart', 1, 0, 0)]));
    for (let i = 0; i < 32; i++) host.tick();
    const moving = pawn(host.observe(), 'cart');
    expect(moving.pos.x).toBeGreaterThan(-1700 + 50);
    host.apply(act([]));
    for (let i = 0; i < 64; i++) host.tick();
    expect(pawn(host.observe(), 'cart').vel).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('human input overrides Core input for the human pawn only', () => {
    const host = newHost();
    const start = { x: -1700, y: 400, z: -160 };
    host.apply(
      act(
        [
          { type: 'teleport', id: 'cart', pos: start, yaw: 0 },
          { type: 'teleport', id: 'barely', pos: start, yaw: 0 },
        ],
        // Core says: both run east.
        [input('barely', 1, 0, 0), input('cart', 1, 0, 0)],
      ),
    );
    // Human (cart) says: run north.
    host.setHumanInput(input('cart', 1, 0, 90));
    for (let i = 0; i < 32; i++) host.tick();
    const o = host.observe();
    expect(pawn(o, 'cart').pos.y - start.y).toBeGreaterThan(50);
    expect(Math.abs(pawn(o, 'cart').pos.x - start.x)).toBeLessThan(1e-6);
    expect(pawn(o, 'cart').yaw).toBe(90);
    expect(pawn(o, 'barely').pos.x - start.x).toBeGreaterThan(50);

    // Clearing the human input hands cart back to Core.
    host.setHumanInput(null);
    const before = pawn(host.observe(), 'cart').pos.x;
    for (let i = 0; i < 32; i++) host.tick();
    expect(pawn(host.observe(), 'cart').pos.x).toBeGreaterThan(before + 20);

    expect(() => host.setHumanInput(input('barely', 1, 0, 0))).toThrow(/human pawn is cart/);
    host.setHuman('sp4rtan');
    expect(host.observe().human).toBe('sp4rtan');
    host.setHuman(null);
    expect(host.observe().human).toBeNull();
    expect(() => host.setHumanInput(input('cart', 1, 0, 0))).toThrow();
  });
});

describe('Sim2DHost determinism', () => {
  it('observe() is already canonical (6-decimal numbers)', () => {
    const host = newHost();
    drive(host, new SetupCore(), 50);
    const o = host.observe();
    expect(canonicalize(o)).toEqual(o);
  });

  it('snapshot -> restore -> identical observes for 200 ticks', () => {
    const host = newHost();
    const core = new SetupCore();
    drive(host, core, 40);
    host.setHumanInput(input('cart', 0.7, -0.4, 200));
    const snap = host.snapshot();
    const coreSnap = core.snapshot();
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);

    const first = drive(host, core, 200);
    host.restore(snap);
    core.restore(coreSnap);
    expect(host.snapshot()).toEqual(snap);
    const second = drive(host, core, 200);
    expect(second.lines()).toEqual(first.lines());
    expect(first.length).toBe(200);

    // A snapshot also restores into a fresh host.
    const fresh = newHost();
    fresh.restore(JSON.parse(JSON.stringify(snap)) as typeof snap);
    expect(fresh.observe()).toEqual((first.at(0) as { observe: Observe }).observe);
  });

  it('restore rejects foreign snapshots', () => {
    const host = newHost();
    expect(() => host.restore({ kind: 'host', data: { version: 99 } })).toThrow(/version/);
    const small = new Sim2DHost(nav, tuning, roster.slice(0, 3));
    expect(() => host.restore(small.snapshot())).toThrow(/roster/);
  });

  it('two identical runs give identical SessionLog digests, and pawns actually move', () => {
    const a = drive(newHost(), new SetupCore(), 300);
    const b = drive(newHost(), new SetupCore(), 300);
    expect(a.digest()).toMatch(/^[0-9a-f]{8}$/);
    expect(a.digest()).toBe(b.digest());
    expect(a.toText()).toBe(b.toText());
    const o0 = (a.get(1) as { observe: Observe }).observe;
    const o1 = (a.get(299) as { observe: Observe }).observe;
    const moved = o0.pawns.filter((p, i) => Math.hypot(p.pos.x - (o1.pawns[i] as PawnObs).pos.x, p.pos.y - (o1.pawns[i] as PawnObs).pos.y) > 50);
    expect(moved.length).toBeGreaterThanOrEqual(5);
    for (const p of o1.pawns) expect(nav.isWalkable(p.pos)).toBe(true);
  });

  it('the logged acts alone reproduce the logged observes', () => {
    const log = drive(newHost(), new SetupCore(), 150);
    const host = newHost();
    for (let i = 0; i < log.length; i++) {
      const e = log.at(i) as { observe: Observe; act: Act };
      expect(host.observe()).toEqual(e.observe);
      host.apply(e.act);
      host.tick();
    }
  });
});
