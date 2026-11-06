import { describe, expect, it } from 'vitest';
import { SessionLog, parseTuning, type Action, type Observe, type PlayerId, type Tuning, type Vec3 } from '../src/contracts/index';
import { flashSeconds, throwElevation, throwGrenade } from '../src/sim2d/grenades';
import type { Sim2DHost } from '../src/sim2d/host';
import { armorDamage } from '../src/sim2d/weapons';
import { act, eventsOf, input, newHost, openNav, pawn, run, setupActions, ticksWhere, tuning, wallNav } from './combat-fixtures';

const g = tuning.grenades;

function withTuning(patch: (raw: Record<string, Record<string, unknown>>) => void): Tuning {
  const raw = JSON.parse(JSON.stringify(tuning)) as Record<string, Record<string, unknown>>;
  patch(raw);
  return parseTuning(raw);
}

/** Give `id` a grenade (drawn and ready) at `pos`, facing `yaw`. */
function armGrenade(id: PlayerId, pos: { x: number; y: number }, yaw: number, kind: 'smoke' | 'flash' | 'he' | 'molotov'): Action[] {
  return setupActions(id, pos, yaw, kind);
}

/** ATTACK for one tick (pin), then release (throw). Returns the throw tick. */
function throwIt(host: Sim2DHost, id: PlayerId, yaw: number, pitch: number): number {
  host.apply(act([], [input(id, yaw, pitch, ['ATTACK'])]));
  host.tick();
  host.apply(act([], [input(id, yaw, pitch, [])]));
  const t = host.observe().tick;
  host.tick();
  host.apply(act([]));
  return t;
}

/** Where a level throw east from `from` lands (same pure function the host uses). */
function landing(from: { x: number; y: number }, pitch = 0, nav = openNav, t: Tuning = tuning): Vec3 {
  return throwGrenade('smoke', { id: 'barely', team: 'T', pos: { x: from.x, y: from.y, z: 0 }, yaw: 0, pitch, crouching: false }, 0, 0, nav, t.grenades, t.damage).to;
}

describe('throw', () => {
  it('level aim throws 10° up (Source remap); range from 2D ballistics, flight time ≈ 1.1 s', () => {
    expect(throwElevation(0, g)).toBe(10);
    expect(throwElevation(-90, g)).toBe(90);
    expect(throwElevation(90, g)).toBe(-90);
    const gr = throwGrenade('smoke', { id: 'barely', team: 'T', pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, crouching: false }, 0, 1, openNav, g, tuning.damage);
    expect(gr.to.x).toBeCloseTo(729.3, 1);
    expect(gr.to.y).toBeCloseTo(0, 6);
    expect(gr.landTick).toBe(70);
    expect(gr.popTick).toBe(96); // smoke: max(fuse 1.5 s, landing)
  });

  it('stops short of the first wall and never lands past throwRange', () => {
    const at = landing({ x: -400, y: 0 }, 0, wallNav);
    expect(at.x).toBeLessThan(-50 + 1e-9);
    expect(at.x).toBeGreaterThan(-100);
    const short = withTuning((r) => ((r['grenades'] as Record<string, unknown>)['throwRange'] = 500));
    expect(landing({ x: 0, y: 0 }, -35, openNav, short).x).toBeCloseTo(500, 6);
  });

  it('ATTACK press then release throws; the grenade leaves the inventory (two smokes = two throws), then the gun is drawn', () => {
    const host = newHost();
    host.apply(
      act([
        ...setupActions('cart', { x: 0, y: 0 }, 0, 'ak47'),
        { type: 'give', id: 'cart', item: 'smoke', clip: 0, reserve: 0 },
        { type: 'give', id: 'cart', item: 'smoke', clip: 0, reserve: 0 },
        { type: 'set_weapon', id: 'cart', weapon: 'smoke' },
      ]),
    );
    expect(host.pawnState('cart')?.inventory.map((q) => q.item)).toEqual(['ak47', 'knife', 'smoke', 'smoke']);
    // Holding ATTACK does not throw.
    host.apply(act([], [input('cart', 0, 0, ['ATTACK'])]));
    run(host, 30);
    expect(host.activeEffects()).toEqual([]);
    host.apply(act([], [input('cart', 0, 0, [])]));
    run(host, 1);
    expect(host.activeEffects().map((e) => [e.kind, e.phase])).toEqual([['smoke', 'flying']]);
    expect(host.pawnState('cart')?.inventory.map((q) => q.item)).toEqual(['ak47', 'knife', 'smoke']);
    expect(pawn(host.observe(), 'cart').weapon).toBe('smoke');
    // The second smoke deploys first (grenades.deploySec), then throws.
    run(host, 64);
    throwIt(host, 'cart', 0, 0);
    expect(pawn(host.observe(), 'cart').weapon).toBe('ak47');
    expect(host.pawnState('cart')?.inventory.map((q) => q.item)).toEqual(['ak47', 'knife']);
    expect(host.activeEffects().length).toBe(2);
  });
});

describe('smoke', () => {
  it('pops at 1.5 s with a grenade sound; smokeBlocks between two pawns is true for 18 s, then false', () => {
    const host = newHost();
    host.apply(act(armGrenade('cart', { x: 0, y: 0 }, 0, 'smoke')));
    const t0 = throwIt(host, 'cart', 0, 0);
    const land = landing({ x: 0, y: 0 });
    const a = { x: land.x, y: -400 };
    const b = { x: land.x, y: 400 };
    const obs = run(host, 200);
    const popAt = t0 + 96;
    expect(ticksWhere(obs, (e) => e.type === 'sound' && e.kind === 'grenade')).toEqual([popAt]);
    expect(eventsOf(obs[popAt - t0 - 1] as Observe, 'sound')[0]).toMatchObject({ source: 'cart', kind: 'grenade' });
    expect(host.smokeBlocks(a, b)).toBe(true);
    expect(host.smokeBlocks(a, { x: land.x + 500, y: -400 })).toBe(false);
    // Active from the pop until pop + 18 s.
    run(host, popAt + 1152 - 1 - host.observe().tick);
    expect(host.observe().tick).toBe(popAt + 1151);
    expect(host.smokeBlocks(a, b)).toBe(true);
    expect(host.activeEffects()).toMatchObject([{ kind: 'smoke', phase: 'smoke', radius: 144, untilTick: popAt + 1152 }]);
    run(host, 1);
    expect(host.smokeBlocks(a, b)).toBe(false);
    expect(host.activeEffects()).toEqual([]);
  });

  it('bullets pass through smoke', () => {
    const host = newHost();
    host.apply(act([...armGrenade('cart', { x: 0, y: 0 }, 0, 'smoke'), ...setupActions('barely', { x: 0, y: 100 }, 0, 'ak47'), ...setupActions('sp4rtan', { x: 1200, y: 0 }, 180, 'ak47')]));
    throwIt(host, 'cart', 0, 0);
    run(host, 120);
    expect(host.smokeBlocks({ x: 0, y: 0 }, { x: 1200, y: 0 })).toBe(true);
    // barely moves onto the line and shoots through the smoke.
    host.apply(act([{ type: 'teleport', id: 'barely', pos: { x: 0, y: 0, z: 0 }, yaw: 0 }], [input('barely', 0, 0, ['ATTACK'])]));
    host.tick();
    expect(eventsOf(host.observe(), 'damage')[0]).toMatchObject({ attacker: 'barely', victim: 'sp4rtan', hitgroup: 'head' });
  });
});

describe('flash', () => {
  it('blinds a pawn facing it (scaled by distance), not one facing away; teammates too', () => {
    const land = landing({ x: 0, y: 0 });
    const host = newHost();
    host.apply(
      act([
        ...armGrenade('barely', { x: 0, y: 0 }, 0, 'flash'),
        { type: 'teleport', id: 'sp4rtan', pos: { x: land.x + 300, y: 0, z: 0 }, yaw: 180 }, // facing the flash
        { type: 'teleport', id: 'zwomp', pos: { x: land.x + 300, y: 100, z: 0 }, yaw: 0 }, // facing away
        { type: 'teleport', id: 'cart', pos: { x: land.x - 300, y: 0, z: 0 }, yaw: 0 }, // teammate, facing it
      ]),
    );
    const t0 = throwIt(host, 'barely', 0, 0);
    run(host, 100);
    const pop = t0 + 96;
    const expected = pop + Math.round(flashSeconds(300, 0, g, tuning.ai) * 64);
    expect(flashSeconds(300, 0, g, tuning.ai)).toBeCloseTo(2.4, 9); // 3 s × (1 − 300 / 1500)
    expect(host.blindUntilTick('sp4rtan')).toBe(expected);
    expect(host.blindUntilTick('cart')).toBe(expected);
    expect(host.blindUntilTick('zwomp')).toBe(0);
    // The thrower faces his own flash too: 729 units away, inside flashRange.
    expect(host.blindUntilTick('barely')).toBe(pop + Math.round(flashSeconds(land.x, 0, g, tuning.ai) * 64));
  });

  it('angle and distance scaling; nothing beyond the FOV or flashRange; a smoke in between protects', () => {
    expect(flashSeconds(0, 0, g, tuning.ai)).toBe(3);
    expect(flashSeconds(0, 53, g, tuning.ai)).toBeCloseTo(1.5, 9); // FOV edge: × flashEdgeFactor
    expect(flashSeconds(0, 54, g, tuning.ai)).toBe(0);
    expect(flashSeconds(1500, 0, g, tuning.ai)).toBe(0);

    // cart's smoke lands halfway between barely's flash (land.x) and sp4rtan (land.x + 400), and is up first.
    const land = landing({ x: 0, y: 0 });
    const host = newHost();
    host.apply(
      act([
        ...armGrenade('barely', { x: 0, y: 0 }, 0, 'flash'),
        ...armGrenade('cart', { x: 200, y: 0 }, 0, 'smoke'),
        { type: 'teleport', id: 'sp4rtan', pos: { x: land.x + 400, y: 0, z: 0 }, yaw: 180 },
      ]),
    );
    throwIt(host, 'cart', 0, 0);
    run(host, 30);
    throwIt(host, 'barely', 0, 0);
    run(host, 120);
    expect(host.smokeBlocks({ x: land.x, y: 0 }, { x: land.x + 400, y: 0 })).toBe(true);
    expect(host.blindUntilTick('sp4rtan')).toBe(0);
  });
});

describe('HE', () => {
  it('radial damage up to 98 falling linearly to 0 at 350, with armor (heArmorPen); generic hitgroup; teammates spared', () => {
    const land = landing({ x: 0, y: 0 });
    const host = newHost();
    host.apply(
      act([
        ...armGrenade('barely', { x: 0, y: 0 }, 0, 'he'),
        ...setupActions('sp4rtan', { x: land.x + 50, y: 0 }, 180, 'ak47'), // 100/100
        ...setupActions('zwomp', { x: land.x, y: 100 }, 180, 'ak47', { armor: 0, helmet: false }),
        ...setupActions('cart', { x: land.x, y: -60 }, 180, 'ak47'), // teammate
      ]),
    );
    const t0 = throwIt(host, 'barely', 0, 0);
    const obs = run(host, 100);
    const popObs = obs[t0 + 96 - t0 - 1] as Observe;
    const hits = eventsOf(popObs, 'damage');
    const raw = (dx: number, dy: number) => g.heDamage * (1 - Math.hypot(dx, dy, tuning.damage.bandHeights['stomach'] ?? 0) / g.heRadius);
    const sp = armorDamage(raw(land.x + 50 - land.x, 0), g.heArmorPen, 100, true, tuning.damage);
    expect(sp).toEqual({ health: 46, armor: 18 });
    expect(hits).toEqual([
      { type: 'damage', attacker: 'barely', victim: 'sp4rtan', amount: sp.health, armor: sp.armor, weapon: 'he', hitgroup: 'generic', scripted: false },
      { type: 'damage', attacker: 'barely', victim: 'zwomp', amount: Math.trunc(raw(0, 100)), armor: 0, weapon: 'he', hitgroup: 'generic', scripted: false },
    ]);
    expect(pawn(popObs, 'cart').hp).toBe(100);
    expect(armorDamage(98, g.heArmorPen, 100, true, tuning.damage)).toEqual({ health: 56, armor: 21 }); // point blank, armored
  });

  it('a blocked pair takes no HE damage', () => {
    const land = landing({ x: 0, y: 0 });
    const host = newHost();
    host.apply(act([...armGrenade('barely', { x: 0, y: 0 }, 0, 'he'), ...setupActions('sp4rtan', { x: land.x, y: 0 }, 180, 'ak47'), { type: 'block_damage', attacker: 'barely', victim: 'sp4rtan' }]));
    throwIt(host, 'barely', 0, 0);
    const obs = run(host, 100);
    expect(obs.flatMap((o) => eventsOf(o, 'damage'))).toEqual([]);
    expect(host.combatLog().length).toBe(1);
  });
});

describe('molotov', () => {
  it('bursts on landing; 8 HP every 0.2 s (40/s) to anyone inside, armor untouched, until dead', () => {
    const land = landing({ x: 0, y: 0 });
    const host = newHost();
    host.apply(act([...armGrenade('barely', { x: 0, y: 0 }, 0, 'molotov'), ...setupActions('sp4rtan', { x: land.x + 30, y: 0 }, 180, 'ak47')]));
    const t0 = throwIt(host, 'barely', 0, 0);
    const obs = run(host, 300);
    const burst = t0 + 70;
    expect(ticksWhere(obs, (e) => e.type === 'sound' && e.kind === 'grenade')).toEqual([burst]);
    const hurt = ticksWhere(obs, (e) => e.type === 'damage');
    expect(hurt.map((t) => t - burst)).toEqual([0, 13, 26, 39, 52, 64, 77, 90, 103, 116, 128, 141, 154]); // ⌈k × 12.8⌉
    const amounts = obs.flatMap((o) => eventsOf(o, 'damage')).map((e) => [e.amount, e.armor, e.weapon, e.hitgroup]);
    expect(amounts.slice(0, 12)).toEqual(Array.from({ length: 12 }, () => [8, 0, 'molotov', 'generic']));
    expect(amounts[12]).toEqual([4, 0, 'molotov', 'generic']);
    expect(obs.flatMap((o) => eventsOf(o, 'death'))).toEqual([{ type: 'death', victim: 'sp4rtan', attacker: 'barely', weapon: 'molotov', headshot: false }]);
  });

  it('burns for 7 s (35 steps), then is gone; a molotov still flying after 2 s bursts where it is', () => {
    const land = landing({ x: 0, y: 0 });
    const host = newHost();
    host.apply(act([...armGrenade('barely', { x: 0, y: 0 }, 0, 'molotov'), ...setupActions('sp4rtan', { x: land.x, y: 0 }, 180, 'ak47', { hp: 1000, armor: 0 })]));
    const t0 = throwIt(host, 'barely', 0, 0);
    const obs = run(host, 600);
    const hits = obs.flatMap((o) => eventsOf(o, 'damage'));
    expect(hits.length).toBe(35);
    expect(pawn(host.observe(), 'sp4rtan').hp).toBe(1000 - 280);
    expect(host.activeEffects()).toEqual([]);
    const last = ticksWhere(obs, (e) => e.type === 'damage').at(-1);
    expect(last).toBe(t0 + 70 + 436); // step 34 at ⌈34 × 12.8⌉; the fire ends at 448 (7 s)

    // Looking up 60°: the flight lasts ~3.9 s, so it bursts mid-air at 2 s, short of the landing point.
    const lob = newHost();
    lob.apply(act(armGrenade('barely', { x: 0, y: 0 }, 0, 'molotov')));
    const t1 = throwIt(lob, 'barely', 0, -60);
    const lobObs = run(lob, 200);
    expect(ticksWhere(lobObs, (e) => e.type === 'sound' && e.kind === 'grenade')).toEqual([t1 + 128]);
    const fire = lob.activeEffects()[0];
    expect(fire).toMatchObject({ kind: 'molotov', phase: 'fire' });
    expect(fire?.pos.x).toBeLessThan(landing({ x: 0, y: 0 }, -60).x);
  });

  it('a smoke puts out a fire it covers, and a molotov bursting inside a smoke fizzles', () => {
    const host = newHost();
    host.apply(act([...armGrenade('barely', { x: 0, y: 0 }, 0, 'molotov'), ...armGrenade('cart', { x: 0, y: 40 }, 0, 'smoke')]));
    throwIt(host, 'barely', 0, 0);
    run(host, 75);
    expect(host.activeEffects().map((e) => e.phase)).toEqual(['fire']);
    throwIt(host, 'cart', 0, 0);
    run(host, 100);
    expect(host.activeEffects().map((e) => e.phase)).toEqual(['smoke']);

    host.apply(act(armGrenade('sp4rtan', { x: 0, y: -40 }, 0, 'molotov')));
    throwIt(host, 'sp4rtan', 0, 0);
    const obs = run(host, 100);
    expect(ticksWhere(obs, (e) => e.type === 'sound' && e.kind === 'grenade').length).toBe(1); // it still bursts (sound)
    expect(host.activeEffects().map((e) => e.phase)).toEqual(['smoke']);
  });
});

describe('grenade determinism', () => {
  /** Three throws at once, then 400 ticks; returns the observes plus effects and blind ticks each tick. */
  function scenario(host: Sim2DHost, ticks: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < ticks; i++) {
      host.tick();
      out.push(JSON.stringify({ o: host.observe(), fx: host.activeEffects(), blind: ['barely', 'cart', 'sp4rtan', 'zwomp'].map((id) => host.blindUntilTick(id as PlayerId)), smoke: host.smokeBlocks({ x: 700, y: -300 }, { x: 700, y: 300 }) }));
    }
    return out;
  }

  function setup(): Sim2DHost {
    const host = newHost();
    host.apply(
      act([
        ...armGrenade('barely', { x: 0, y: 0 }, 0, 'molotov'),
        ...armGrenade('cart', { x: 0, y: 50 }, 0, 'smoke'),
        ...armGrenade('sp4rtan', { x: 1500, y: 0 }, 180, 'flash'),
        ...setupActions('zwomp', { x: 760, y: 0 }, 180, 'ak47'),
      ]),
    );
    host.apply(act([], [input('barely', 0, -20, ['ATTACK']), input('cart', 0, 0, ['ATTACK']), input('sp4rtan', 180, 0, ['ATTACK'])]));
    host.tick();
    host.apply(act([], [input('barely', 0, -20), input('cart', 0, 0), input('sp4rtan', 180, 0)]));
    return host;
  }

  it('snapshot / restore mid-flight reproduces every following tick, also in a fresh host', () => {
    const host = setup();
    run(host, 40);
    expect(host.activeEffects().every((e) => e.phase === 'flying')).toBe(true);
    const snap = host.snapshot();
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
    const first = scenario(host, 400);
    host.restore(snap);
    expect(host.snapshot()).toEqual(snap);
    expect(scenario(host, 400)).toEqual(first);
    const fresh = newHost();
    fresh.restore(JSON.parse(JSON.stringify(snap)) as typeof snap);
    expect(scenario(fresh, 400)).toEqual(first);
    expect(first.some((l) => l.includes('"kind":"grenade"'))).toBe(true);
  });

  it('two identical runs give identical SessionLog digests', () => {
    const digest = () => {
      const host = setup();
      const log = new SessionLog();
      for (let i = 0; i < 500; i++) {
        const a = act([]);
        log.append(host.observe(), a);
        host.tick();
      }
      return log.digest();
    };
    expect(digest()).toBe(digest());
  });
});
