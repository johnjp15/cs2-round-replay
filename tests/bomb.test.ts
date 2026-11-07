/** C3: the bomb in Sim2DHost (plant, timer and beeps, explosion, defuse, drop and pickup, snapshots). */
import { describe, expect, it } from 'vitest';
import { SessionLog, canonicalize, replay, type Act, type Action, type Control, type CoreSnapshot, type ICore, type Observe, type PawnInput } from '../src/contracts/index';
import { explosionDamage, nextBeep } from '../src/sim2d/bomb';
import { Sim2DHost } from '../src/sim2d/host';
import { armorDamage, isArmored } from '../src/sim2d/weapons';
import {
  BOMB_POS,
  DEFUSE_START_TICK,
  DEFUSE_TICK,
  EXPLODE_TICK,
  PLANT_TICK,
  bombTicks,
  hold,
  inputs,
  mirageHost,
  place,
  runTo,
  tuning,
} from './bomb-fixtures';
import { act, eventsOf, openNav, pawn, roster4 } from './combat-fixtures';

const bt = tuning.bomb;
/** 3.2 s × 64 = 204.8 ticks: the plant is due on the first whole tick after it. */
const PLANT_TICKS = 205;

/** barely in B site with the c4 drawn, holding USE from tick `s` (the input is applied at observe tick s). */
function planting(s = 10, forward = 0): Sim2DHost {
  const host = mirageHost();
  host.apply(act(place('barely', BOMB_POS, 'c4')));
  runTo(host, s);
  host.apply(inputs(hold('barely', ['USE'], forward)));
  return host;
}

/** The recorded round's bomb: planted by the `plant` action at 27.517 s; `defuser` 30 units east of it at the defuse start. */
function plantedAtRecordedTick(): Sim2DHost {
  const host = mirageHost();
  runTo(host, PLANT_TICK);
  host.apply(act([{ type: 'plant', id: 'barely', pos: BOMB_POS }]));
  return host;
}

function defuseFrom(host: Sim2DHost, id: 'sp4rtan' | 'zwomp', tick: number): void {
  runTo(host, tick - 1);
  host.apply(act(place(id, { x: BOMB_POS.x + 30, y: BOMB_POS.y, z: BOMB_POS.z }, 'knife')));
  host.tick();
  host.apply(inputs(hold(id, ['USE'])));
}

describe('plant (USE with the c4 drawn inside a bombsite)', () => {
  it('USE held 3.2 s inside site B plants on tick start + 205, at the pawn, and removes the c4', () => {
    const s = 10;
    const host = planting(s);
    const before = runTo(host, s + 100);
    expect(host.bombState().plant).toEqual({ id: 'barely', startTick: s, endTick: s + PLANT_TICKS });
    expect(before.at(-1)?.round.phase).toBe('live');
    expect(before.at(-1)?.round.bomb).toMatchObject({ state: 'carried', carrier: 'barely' });
    const obs = runTo(host, s + 300);
    expect(bombTicks([...before, ...obs], 'planted')).toEqual([s + PLANT_TICKS]);
    const at = obs.find((o) => o.tick === s + PLANT_TICKS + 1) as Observe;
    expect(eventsOf(at, 'bomb')).toEqual([{ type: 'bomb', phase: 'planted', id: 'barely', pos: pawn(at, 'barely').pos }]);
    expect(pawn(at, 'barely').pos).toMatchObject({ x: BOMB_POS.x, y: BOMB_POS.y });
    expect(at.round).toMatchObject({ phase: 'planted', timeLeftSec: 39.984375 });
    expect(at.round.bomb).toEqual({ state: 'planted', carrier: null, pos: pawn(at, 'barely').pos, plantTick: s + PLANT_TICKS, defuser: null, defuseEndTick: null });
    expect(host.pawnState('barely')?.inventory.map((q) => q.item)).not.toContain('c4');
    expect(pawn(at, 'barely').weapon).toBe('ak47');
    expect(host.bombState()).toMatchObject({ explodeTick: s + PLANT_TICKS + 2560, plant: null, planter: 'barely' });
  });

  it('USE outside a bombsite does not plant', () => {
    const host = mirageHost();
    host.apply(act(place('barely', { x: -473, y: 647, z: -82 }, 'c4'))); // Back Alley
    host.apply(inputs(hold('barely', ['USE'])));
    const obs = runTo(host, 400);
    expect(bombTicks(obs, 'planted')).toEqual([]);
    expect(host.bombState()).toMatchObject({ state: 'carried', plant: null });
  });

  it('releasing USE at 3.1 s cancels; holding it again starts over', () => {
    const s = 10;
    const host = planting(s);
    let obs = runTo(host, s + 199); // USE held on ticks s .. s + 198 (3.11 s)
    host.apply(inputs(hold('barely', [])));
    obs = [...obs, ...runTo(host, s + 260)];
    expect(bombTicks(obs, 'planted')).toEqual([]);
    expect(host.bombState().plant).toBeNull();
    host.apply(inputs(hold('barely', ['USE'])));
    obs = runTo(host, s + 260 + 300);
    expect(bombTicks(obs, 'planted')).toEqual([s + 260 + PLANT_TICKS]);
  });

  it('switching weapon or dying cancels the plant; a dead planter drops the c4', () => {
    const s = 10;
    const a = planting(s);
    runTo(a, s + 100);
    a.apply({ inputs: [hold('barely', ['USE'])], actions: [{ type: 'set_weapon', id: 'barely', weapon: 'ak47' }], status: [] });
    expect(bombTicks(runTo(a, s + 400), 'planted')).toEqual([]);
    expect(a.bombState()).toMatchObject({ state: 'carried', plant: null });

    const b = planting(s);
    runTo(b, s + 100);
    b.apply({ inputs: [hold('barely', ['USE'])], actions: [{ type: 'damage', attacker: 'sp4rtan', victim: 'barely', amount: 100, armor: 0, hitgroup: 'head', weapon: 'deagle', lethal: true }], status: [] });
    const obs = runTo(b, s + 400);
    expect(bombTicks(obs, 'planted')).toEqual([]);
    expect(b.bombState()).toMatchObject({ state: 'dropped', plant: null, pos: pawn(obs[0] as Observe, 'barely').pos });
    expect(obs.at(-1)?.round.bomb).toMatchObject({ state: 'dropped', carrier: null, pos: pawn(obs[0] as Observe, 'barely').pos });
  });

  it('movement is locked while planting: a running pawn stops dead, still turns, and moves again after the plant', () => {
    const host = mirageHost();
    host.apply(act(place('barely', BOMB_POS, 'c4')));
    host.apply(inputs(hold('barely', [], 1, 0)));
    runTo(host, 30); // running east across the site
    const start = host.observe();
    expect(Math.hypot(pawn(start, 'barely').vel.x, pawn(start, 'barely').vel.y)).toBeGreaterThan(200);
    host.apply(inputs(hold('barely', ['USE'], 1, 45)));
    const obs = runTo(host, 30 + PLANT_TICKS + 1);
    for (const o of obs) {
      expect(pawn(o, 'barely').pos, `tick ${o.tick}`).toEqual(pawn(start, 'barely').pos);
      expect(pawn(o, 'barely').vel).toEqual({ x: 0, y: 0, z: 0 });
      expect(pawn(o, 'barely').yaw).toBe(45);
    }
    expect(bombTicks(obs, 'planted')).toEqual([30 + PLANT_TICKS]);
    const after = runTo(host, 30 + PLANT_TICKS + 20);
    expect(pawn(after.at(-1) as Observe, 'barely').pos).not.toEqual(pawn(start, 'barely').pos);
  });
});

describe('timer, beeps and explosion', () => {
  it('a scripted plant at 27.517 s explodes exactly at tick round(67.517 × 64), damages through armor and wins it for T', () => {
    const host = plantedAtRecordedTick();
    const obs = runTo(host, EXPLODE_TICK + 100);
    expect(PLANT_TICK).toBe(1761);
    expect(EXPLODE_TICK).toBe(4321);
    expect(bombTicks(obs, 'planted')).toEqual([PLANT_TICK]);
    expect(bombTicks(obs, 'exploded')).toEqual([EXPLODE_TICK]);
    const before = obs.find((o) => o.tick === EXPLODE_TICK) as Observe;
    const at = obs.find((o) => o.tick === EXPLODE_TICK + 1) as Observe;
    // Order: exploded, then the damage (and deaths), then round_end.
    expect(at.events[0]).toEqual({ type: 'bomb', phase: 'exploded', id: null, pos: BOMB_POS });
    expect(at.events.at(-1)).toEqual({ type: 'round_end', winner: 'T', reason: 'bomb_exploded' });
    // Every alive pawn within 1,750 units (3D, to stomach height, through walls) takes linear damage through armor.
    const hit = eventsOf(at, 'damage');
    expect(hit.length).toBeGreaterThan(0);
    for (const p of before.pawns) {
      const d = Math.hypot(p.pos.x - BOMB_POS.x, p.pos.y - BOMB_POS.y, p.pos.z + 36 - BOMB_POS.z);
      const ev = hit.find((e) => e.victim === p.id);
      if (!p.alive || d >= bt.radius) {
        expect(ev, p.id).toBeUndefined();
        continue;
      }
      const helmet = host.pawnState(p.id)?.helmet ?? false;
      const want = armorDamage(explosionDamage(d, bt), bt.armorPen, p.armor, isArmored('generic', helmet), tuning.damage);
      expect(ev, p.id).toEqual({ type: 'damage', attacker: null, victim: p.id, amount: Math.min(p.hp, want.health), armor: Math.min(p.armor, want.armor), weapon: null, hitgroup: 'generic', scripted: false });
    }
    expect(at.round).toMatchObject({ phase: 'over', winner: 'T', reason: 'bomb_exploded', endTick: EXPLODE_TICK, score: { ct: 11, t: 16 }, timeLeftSec: 0 });
    expect(at.round.bomb).toMatchObject({ state: 'exploded', pos: BOMB_POS, plantTick: PLANT_TICK });
    // Once.
    expect(obs.flatMap((o) => eventsOf(o, 'round_end'))).toHaveLength(1);
  });

  it('explosion damage: 500 at the bomb, linear to 0 at 1,750; armor halves it (pen 0.5) until it runs out', () => {
    expect(explosionDamage(0, bt)).toBe(500);
    expect(explosionDamage(875, bt)).toBe(250);
    expect(explosionDamage(1749, bt)).toBe(0.285714);
    expect(explosionDamage(1750, bt)).toBe(0);
    // 100 armor absorbs at most 200: 500 → 300 HP; 250 → 125 HP and 63 armor; 71.3 → 35 HP and 18 armor.
    expect(armorDamage(500, bt.armorPen, 100, true, tuning.damage)).toEqual({ health: 300, armor: 100 });
    expect(armorDamage(250, bt.armorPen, 100, true, tuning.damage)).toEqual({ health: 125, armor: 63 });
    expect(armorDamage(explosionDamage(Math.hypot(1500, 36), bt), bt.armorPen, 100, true, tuning.damage)).toEqual({ health: 35, armor: 18 });
    // On the open test map: a CT 1,500 units away keeps 29 HP, one at 100 units dies; a T 1,800 away is untouched.
    const host = new Sim2DHost(openNav, tuning, roster4);
    host.apply(
      act([
        ...place('barely', { x: 0, y: 1800, z: 0 }),
        ...place('cart', { x: 0, y: -100, z: 0 }),
        ...place('sp4rtan', { x: 1500, y: 0, z: 0 }),
        ...place('zwomp', { x: -100, y: 0, z: 0 }),
        { type: 'set_hp', id: 'sp4rtan', hp: 100, armor: 0, helmet: false },
        { type: 'set_hp', id: 'cart', hp: 100, armor: 100, helmet: true },
        { type: 'plant', id: 'barely', pos: { x: 0, y: 0, z: 0 } },
      ]),
    );
    const obs = runTo(host, 2562);
    const at = obs.find((o) => o.events.some((e) => e.type === 'bomb' && e.phase === 'exploded')) as Observe;
    expect(at.tick - 1).toBe(2560);
    expect(eventsOf(at, 'damage').map((e) => [e.victim, e.amount, e.armor])).toEqual([
      ['cart', 100, 100],
      ['sp4rtan', 71, 0],
      ['zwomp', 100, 0],
    ]);
    expect(eventsOf(at, 'death').map((e) => [e.victim, e.attacker, e.weapon])).toEqual([
      ['cart', null, null],
      ['zwomp', null, null],
    ]);
    expect(pawn(at, 'barely').hp).toBe(100);
  });

  it('beeps (sound, source null, kind bomb) every 1 s, every 0.5 s in the last 10 s, never at the explosion', () => {
    const host = plantedAtRecordedTick();
    const obs = runTo(host, EXPLODE_TICK + 64);
    const beeps = obs.flatMap((o) => eventsOf(o, 'sound').filter((e) => e.kind === 'bomb').map(() => o.tick - 1));
    const want: number[] = [];
    for (let k = 1; k <= 30; k++) want.push(PLANT_TICK + 64 * k);
    for (let j = 1; j <= 19; j++) want.push(PLANT_TICK + 1920 + 32 * j);
    expect(beeps).toEqual(want);
    expect(beeps).toHaveLength(49);
    const one = obs.find((o) => o.tick === PLANT_TICK + 65) as Observe;
    expect(eventsOf(one, 'sound')).toContainEqual({ type: 'sound', source: null, pos: BOMB_POS, kind: 'bomb' });
    expect(nextBeep(0, 2560, bt)).toBe(64);
    expect(nextBeep(1920, 2560, bt)).toBe(1952);
  });
});

describe('defuse (a CT within 62 units holding USE)', () => {
  it('a kit defuse started at 61.8 s ends at 66.8 s with a CT win by bomb_defused, 0.72 s before the explosion', () => {
    const host = plantedAtRecordedTick();
    defuseFrom(host, 'sp4rtan', DEFUSE_START_TICK);
    const mid = runTo(host, DEFUSE_START_TICK + 100);
    expect(mid.at(-1)?.round).toMatchObject({ phase: 'planted', bomb: { state: 'planted', defuser: 'sp4rtan', defuseEndTick: DEFUSE_TICK } });
    const obs = [...mid, ...runTo(host, EXPLODE_TICK + 200)];
    expect([DEFUSE_START_TICK, DEFUSE_TICK]).toEqual([3955, 4275]);
    expect(bombTicks(obs, 'defuse_start')).toEqual([DEFUSE_START_TICK]);
    expect(bombTicks(obs, 'defused')).toEqual([DEFUSE_TICK]);
    expect(bombTicks(obs, 'exploded')).toEqual([]);
    expect(bombTicks(obs, 'defuse_stop')).toEqual([]);
    const at = obs.find((o) => o.tick === DEFUSE_TICK + 1) as Observe;
    expect(at.events).toEqual([
      { type: 'bomb', phase: 'defused', id: 'sp4rtan', pos: BOMB_POS },
      { type: 'round_end', winner: 'CT', reason: 'bomb_defused' },
    ]);
    expect(at.round).toEqual({
      phase: 'over',
      score: { ct: 12, t: 15 },
      winner: 'CT',
      reason: 'bomb_defused',
      endTick: DEFUSE_TICK,
      timeLeftSec: 0.71875,
      bomb: { state: 'defused', carrier: null, pos: BOMB_POS, plantTick: PLANT_TICK, defuser: 'sp4rtan', defuseEndTick: DEFUSE_TICK },
    });
    expect(obs.at(-1)?.round.timeLeftSec).toBe(0.71875); // frozen
    // Beeps stop at the defuse: the last is the one due before it (0.5 s spacing in the last 10 s).
    const beeps = obs.flatMap((o) => (eventsOf(o, 'sound').some((e) => e.kind === 'bomb') ? [o.tick - 1] : []));
    expect(beeps.at(-1)).toBe(PLANT_TICK + 1920 + 32 * 18);
    expect(beeps.at(-1)).toBeLessThan(DEFUSE_TICK);
  });

  it('a no-kit defuse started at 61.8 s fails: defuse_stop and the explosion come first', () => {
    const host = plantedAtRecordedTick();
    defuseFrom(host, 'zwomp', DEFUSE_START_TICK);
    const obs = runTo(host, EXPLODE_TICK + 100);
    expect(bombTicks(obs, 'defuse_start')).toEqual([DEFUSE_START_TICK]);
    expect(obs.find((o) => o.tick === DEFUSE_START_TICK + 1)?.round.bomb.defuseEndTick).toBe(DEFUSE_START_TICK + 640);
    expect(bombTicks(obs, 'defused')).toEqual([]);
    const at = obs.find((o) => o.tick === EXPLODE_TICK + 1) as Observe;
    expect(eventsOf(at, 'bomb').map((e) => e.phase)).toEqual(['defuse_stop', 'exploded']);
    expect(eventsOf(at, 'round_end')).toEqual([{ type: 'round_end', winner: 'T', reason: 'bomb_exploded' }]);
  });

  it('a defuse that would end on the explosion tick fails', () => {
    const host = plantedAtRecordedTick();
    defuseFrom(host, 'sp4rtan', EXPLODE_TICK - 320);
    const obs = runTo(host, EXPLODE_TICK + 10);
    expect(bombTicks(obs, 'defused')).toEqual([]);
    expect(bombTicks(obs, 'exploded')).toEqual([EXPLODE_TICK]);
  });

  it('leaving range or releasing USE cancels with defuse_stop; holding again starts over', () => {
    const host = plantedAtRecordedTick();
    defuseFrom(host, 'sp4rtan', DEFUSE_START_TICK);
    let obs = runTo(host, 4000);
    host.apply({ inputs: [hold('sp4rtan', ['USE'])], actions: place('sp4rtan', { x: BOMB_POS.x + 70, y: BOMB_POS.y, z: BOMB_POS.z }), status: [] });
    obs = [...obs, ...runTo(host, 4010)];
    expect(bombTicks(obs, 'defuse_stop')).toEqual([4000]);
    expect(obs.at(-1)?.round.bomb).toMatchObject({ defuser: null, defuseEndTick: null });
    // Back in range (still holding USE): starts again from zero, then a release cancels.
    host.apply({ inputs: [hold('sp4rtan', ['USE'])], actions: place('sp4rtan', { x: BOMB_POS.x + 61, y: BOMB_POS.y, z: BOMB_POS.z }), status: [] });
    obs = runTo(host, 4050);
    expect(bombTicks(obs, 'defuse_start')).toEqual([4010]);
    host.apply(inputs(hold('sp4rtan', [])));
    obs = runTo(host, EXPLODE_TICK + 1);
    expect(bombTicks(obs, 'defuse_stop')).toEqual([4050]);
    expect(bombTicks(obs, 'defused')).toEqual([]);
    expect(bombTicks(obs, 'exploded')).toEqual([EXPLODE_TICK]);
  });

  it('movement is locked while defusing; dying cancels; Ts and dead CTs never start one', () => {
    const host = plantedAtRecordedTick();
    defuseFrom(host, 'sp4rtan', DEFUSE_START_TICK);
    host.apply(inputs(hold('sp4rtan', ['USE'], 1, 90), hold('cart', ['USE'])));
    const p0 = pawn(host.observe(), 'sp4rtan').pos;
    let obs = runTo(host, DEFUSE_START_TICK + 50);
    for (const o of obs) expect(pawn(o, 'sp4rtan').pos).toEqual(p0);
    host.apply({
      inputs: [hold('sp4rtan', ['USE']), hold('cart', ['USE'])],
      actions: [
        ...place('cart', { x: BOMB_POS.x - 20, y: BOMB_POS.y, z: BOMB_POS.z }),
        { type: 'damage', attacker: 'cart', victim: 'sp4rtan', amount: 0, armor: 0, hitgroup: 'head', weapon: 'ak47', lethal: true },
      ],
      status: [],
    });
    obs = runTo(host, DEFUSE_START_TICK + 100);
    expect(bombTicks(obs, 'defuse_stop')).toEqual([DEFUSE_START_TICK + 50]);
    expect(bombTicks(obs, 'defuse_start')).toEqual([]);
  });

  it('defuse_start / defuse_stop actions force it: no USE, no range; the kit still counts', () => {
    const host = plantedAtRecordedTick();
    runTo(host, DEFUSE_START_TICK);
    host.apply(act([{ type: 'defuse_start', id: 'sp4rtan' }])); // sp4rtan is at his start, 2,000 units away
    let obs = runTo(host, DEFUSE_START_TICK + 10);
    expect(bombTicks(obs, 'defuse_start')).toEqual([DEFUSE_START_TICK]);
    expect(obs.at(-1)?.round.bomb).toMatchObject({ defuser: 'sp4rtan', defuseEndTick: DEFUSE_TICK });
    host.apply(act([{ type: 'defuse_start', id: 'zwomp' }, { type: 'defuse_stop', id: 'zwomp' }, { type: 'plant', id: 'cart', pos: BOMB_POS }]));
    runTo(host, DEFUSE_START_TICK + 11);
    expect(host.unhandled().map((n) => [n.type, n.reason])).toEqual([
      ['defuse_start', 'sp4rtan is defusing'],
      ['defuse_stop', 'not defusing'],
      ['plant', 'bomb is planted'],
    ]);
    obs = runTo(host, DEFUSE_TICK + 5);
    expect(bombTicks(obs, 'defused')).toEqual([DEFUSE_TICK]);

    const stop = plantedAtRecordedTick();
    runTo(stop, DEFUSE_START_TICK);
    stop.apply(act([{ type: 'defuse_start', id: 'sp4rtan' }]));
    runTo(stop, DEFUSE_START_TICK + 100);
    stop.apply(act([{ type: 'defuse_stop', id: 'sp4rtan' }]));
    const after = runTo(stop, EXPLODE_TICK + 1);
    expect(bombTicks(after, 'defuse_stop')).toEqual([DEFUSE_START_TICK + 100]);
    expect(bombTicks(after, 'exploded')).toEqual([EXPLODE_TICK]);
  });
});

describe('bomb drop and pickup', () => {
  it("the carrier's death drops the c4 where he died; only an alive T within 32 units picks it up", () => {
    const host = mirageHost();
    const spot = { x: -473, y: 647, z: -82 };
    host.apply(
      act([
        ...place('barely', spot),
        ...place('cart', { x: spot.x + 40, y: spot.y, z: spot.z }),
        ...place('sp4rtan', { x: spot.x - 10, y: spot.y - 10, z: spot.z }),
        { type: 'damage', attacker: 'sp4rtan', victim: 'barely', amount: 0, armor: 0, hitgroup: 'head', weapon: 'deagle', lethal: true },
      ]),
    );
    let obs = runTo(host, 20);
    const dropPos = pawn(obs[0] as Observe, 'barely').pos;
    expect(obs[0]?.round.bomb).toEqual({ state: 'dropped', carrier: null, pos: dropPos, plantTick: null, defuser: null, defuseEndTick: null });
    expect(host.pawnState('barely')?.inventory.map((q) => q.item)).not.toContain('c4');
    expect(obs.at(-1)?.round.bomb.state).toBe('dropped'); // cart at 40 units, sp4rtan is a CT
    // cart walks in and picks it up as soon as he is within 32 units; his gun stays drawn.
    host.apply(inputs(hold('cart', ['WALK'], 1, 180)));
    obs = runTo(host, 60);
    const picked = obs.find((o) => o.round.bomb.state === 'carried') as Observe;
    expect(picked.round.bomb).toMatchObject({ carrier: 'cart', pos: pawn(picked, 'cart').pos });
    const before = obs[obs.indexOf(picked) - 1] as Observe;
    expect(Math.hypot(pawn(before, 'cart').pos.x - dropPos.x, pawn(before, 'cart').pos.y - dropPos.y)).toBeGreaterThan(32);
    expect(Math.hypot(pawn(picked, 'cart').pos.x - dropPos.x, pawn(picked, 'cart').pos.y - dropPos.y)).toBeLessThanOrEqual(32);
    expect(pawn(picked, 'cart').weapon).toBe('ak47');
    expect(host.pawnState('cart')?.inventory.map((q) => q.item)).toContain('c4');
  });
});

/** An ICore that replays a fixed script: inputs and actions by tick. */
class ScriptCore implements ICore {
  constructor(private readonly script: (tick: number) => Act) {}
  step(o: Observe): Act {
    return this.script(o.tick);
  }
  control(c: Control): void {
    void c;
  }
  snapshot(): CoreSnapshot {
    return { kind: 'core', data: null };
  }
  restore(s: CoreSnapshot): void {
    void s;
  }
}

/** The recorded bomb story with engine rules: barely plants with USE, sp4rtan defuses with USE and the kit. */
function bombStory(tick: number): Act {
  const ins: PawnInput[] = [];
  if (tick >= PLANT_TICK - PLANT_TICKS && tick <= PLANT_TICK) ins.push(hold('barely', ['USE']));
  if (tick >= DEFUSE_START_TICK) ins.push(hold('sp4rtan', ['USE']));
  const actions: Action[] = [];
  if (tick === PLANT_TICK - PLANT_TICKS - 1) actions.push(...place('barely', BOMB_POS, 'c4'));
  if (tick === DEFUSE_START_TICK - 1) actions.push(...place('sp4rtan', { x: BOMB_POS.x + 40, y: BOMB_POS.y - 20, z: BOMB_POS.z }, 'deagle'));
  return { inputs: ins, actions, status: [] };
}

function driveStory(host: Sim2DHost, ticks: number, core: ICore = new ScriptCore(bombStory)): SessionLog {
  const log = new SessionLog();
  for (let i = 0; i < ticks; i++) {
    const o = canonicalize(host.observe());
    const a = core.step(o);
    log.append(o, a, []);
    host.apply(a);
    host.tick();
  }
  return log;
}

/** The same driver without the log (faster); returns the observes after each tick. */
function advanceStory(host: Sim2DHost, ticks: number): Observe[] {
  const core = new ScriptCore(bombStory);
  const out: Observe[] = [];
  for (let i = 0; i < ticks; i++) {
    host.apply(core.step(host.observe()));
    host.tick();
    out.push(host.observe());
  }
  return out;
}

describe('bomb snapshots and determinism', () => {
  it('the USE story plants at 27.517 s and defuses at 66.8 s', () => {
    const obs = advanceStory(mirageHost(), DEFUSE_TICK + 10);
    expect(obs.flatMap((o) => eventsOf(o, 'bomb').map((e) => [o.tick - 1, e.phase, e.id]))).toEqual([
      [PLANT_TICK, 'planted', 'barely'],
      [DEFUSE_START_TICK, 'defuse_start', 'sp4rtan'],
      [DEFUSE_TICK, 'defused', 'sp4rtan'],
    ]);
  });

  it('snapshot / restore mid-plant and mid-defuse reproduce every following tick, also in a fresh host', () => {
    for (const [at, until, phase] of [
      [PLANT_TICK - 100, PLANT_TICK + 50, 'planted'],
      [DEFUSE_START_TICK + 100, DEFUSE_TICK + 50, 'defused'],
    ] as const) {
      const host = mirageHost();
      advanceStory(host, at);
      const snap = host.snapshot();
      expect((snap.data as { version: number }).version).toBe(5);
      const state = host.bombState();
      if (at < PLANT_TICK) expect(state.plant).toMatchObject({ id: 'barely', endTick: PLANT_TICK });
      else expect(state.defuse).toMatchObject({ id: 'sp4rtan', endTick: DEFUSE_TICK, forced: false });
      const first = driveStory(host, until - at).toText();
      host.restore(snap);
      expect(host.snapshot()).toEqual(snap);
      expect(driveStory(host, until - at).toText()).toBe(first);
      const fresh = mirageHost();
      fresh.restore(snap);
      expect(driveStory(fresh, until - at).toText()).toBe(first);
      expect(first).toContain(`"phase":"${phase}"`);
    }
  });

  it('is deterministic: two runs give the same digest, and the log replays identically', () => {
    const a = driveStory(mirageHost(), DEFUSE_TICK + 20);
    const b = driveStory(mirageHost(), DEFUSE_TICK + 20);
    expect(a.digest()).toBe(b.digest());
    expect(replay(SessionLog.fromText(a.toText()), new ScriptCore(bombStory))).toMatchObject({ identical: true, mismatchCount: 0 });
  });
});
