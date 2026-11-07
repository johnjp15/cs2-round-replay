import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SessionLog, canonicalize, parseRound, parseTuning, type Act, type Action, type ICore, type Observe, type PawnInput, type PlayerId } from '../src/contracts/index';
import { aimPitch, traceShot, type ScanPawn } from '../src/sim2d/hitscan';
import { Sim2DHost } from '../src/sim2d/host';
import { armorDamage, bulletDamage, cycleTicks, rawDamage, stepWeapon, freshWeaponState } from '../src/sim2d/weapons';
import { act, eventsOf, input, newHost, openNav, pawn, run, setupActions, ticksWhere, tuning, wallNav } from './combat-fixtures';
import { nav as mirage, round, roster } from './sim2d-fixtures';

const d = tuning.damage;
const gun = (id: string) => {
  const w = tuning.weapons[id];
  if (w === undefined) throw new Error(`no gun ${id}`);
  return w;
};
const body = (x: number, y: number, z = 0, crouching = false) => ({ pos: { x, y, z }, crouching });

/** cart (T, shooter) at the origin facing east; sp4rtan (CT) `dist` units east. */
function duel(weapon: string, dist: number, victim: { hp?: number; armor?: number; helmet?: boolean } = {}): Sim2DHost {
  const host = newHost();
  host.apply(act([...setupActions('cart', { x: 0, y: 0 }, 0, weapon), ...setupActions('sp4rtan', { x: dist, y: 0 }, 180, 'ak47', victim)]));
  return host;
}

/** Hold ATTACK for one tick at `band` of sp4rtan and return the observe after it. */
function fireAt(host: Sim2DHost, band: 'head' | 'chest' | 'stomach' | 'leg', buttons: PawnInput['buttons'] = ['ATTACK']): Observe {
  const o = host.observe();
  const pitch = aimPitch(pawn(o, 'cart'), pawn(o, 'sp4rtan'), band, d);
  host.apply(act([], [input('cart', 0, pitch, buttons)]));
  host.tick();
  return host.observe();
}

describe('damage formula (CS2)', () => {
  it('AK-47 chest at 10 units on 100/100 helmeted: 27 HP, armor 100 → 95', () => {
    const o = fireAt(duel('ak47', 10), 'chest');
    expect(eventsOf(o, 'damage')).toEqual([
      { type: 'damage', attacker: 'cart', victim: 'sp4rtan', amount: 27, armor: 5, weapon: 'ak47', hitgroup: 'chest', scripted: false },
    ]);
    expect(pawn(o, 'sp4rtan')).toMatchObject({ hp: 73, armor: 95, alive: true });
    // Same numbers from the pure formula: 36 × 0.98^(18.87 / 500) = 35.97; × 0.775 = 27.88 → 27; (35.97 − 27.88) / 2 = 4.05 → 5.
    expect(bulletDamage(gun('ak47'), Math.hypot(10, 16), 'chest', 100, true, d)).toEqual({ health: 27, armor: 5 });
  });

  it('AK-47 headshot on 100/100 helmeted kills, death carries headshot', () => {
    const o = fireAt(duel('ak47', 500), 'head');
    expect(eventsOf(o, 'damage')[0]).toMatchObject({ amount: 100, hitgroup: 'head', scripted: false });
    expect(eventsOf(o, 'death')).toEqual([{ type: 'death', victim: 'sp4rtan', attacker: 'cart', weapon: 'ak47', headshot: true }]);
    expect(pawn(o, 'sp4rtan')).toMatchObject({ hp: 0, alive: false });
    // 36 × 4 × 0.98 = 141.1; × 0.775 = 109.4 → 109 (more than 100 HP).
    expect(bulletDamage(gun('ak47'), 500, 'head', 100, true, d).health).toBe(109);
  });

  it('range falloff: AK-47 chest at 2,000 units does 33 unarmored (36 × 0.98^4) and 25 through armor', () => {
    expect(rawDamage(36, 0.98, 2000, 1, d)).toBeCloseTo(33.2053, 4);
    const bare = fireAt(duel('ak47', 2000, { armor: 0, helmet: false }), 'chest');
    expect(eventsOf(bare, 'damage')[0]).toMatchObject({ amount: 33, armor: 0, hitgroup: 'chest' });
    const armored = fireAt(duel('ak47', 2000), 'chest');
    expect(eventsOf(armored, 'damage')[0]).toMatchObject({ amount: 25, armor: 4 });
  });

  it('AWP chest through armor kills: 115 × 0.99 × 0.975 = 111 HP at 500 units', () => {
    expect(bulletDamage(gun('awp'), 500, 'chest', 100, true, d)).toEqual({ health: 111, armor: 2 });
    const o = fireAt(duel('awp', 500), 'chest');
    expect(eventsOf(o, 'death')).toEqual([{ type: 'death', victim: 'sp4rtan', attacker: 'cart', weapon: 'awp', headshot: false }]);
  });

  it('hitgroup multipliers and armored areas: stomach ×1.25 armored, legs ×0.75 never armored, head armored only with a helmet', () => {
    expect(bulletDamage(gun('ak47'), 0, 'stomach', 100, true, d)).toEqual({ health: 34, armor: 6 }); // 45 × 0.775 = 34.875
    expect(bulletDamage(gun('ak47'), 0, 'leg', 100, true, d)).toEqual({ health: 27, armor: 0 }); // 27
    expect(bulletDamage(gun('ak47'), 0, 'head', 100, false, d)).toEqual({ health: 144, armor: 0 });
    expect(bulletDamage(gun('deagle'), 0, 'head', 0, false, d).health).toBe(206); // 53 × 3.9 = 206.7
  });

  it('armor cap: when armor runs out, the rest goes to health (toHealth = damage − armor / 0.5)', () => {
    // 100 damage, pen 0.5: toArmor = 25 > 10 armor → toHealth = 100 − 20 = 80, armor 10 → 0.
    expect(armorDamage(100, 0.5, 10, true, d)).toEqual({ health: 80, armor: 10 });
    expect(armorDamage(27.9, 0.775, 0, true, d)).toEqual({ health: 27, armor: 0 });
  });

  it('reproduces the four recorded hits of the round (positions from round.json)', () => {
    const hits = parseRound(readFileSync(new URL('../data/round.json', import.meta.url), 'utf8')).damage;
    expect(hits.length).toBeGreaterThanOrEqual(4);
    const dist = (i: number) => {
      const h = hits[i];
      if (h === undefined || h.apos === null || h.vpos === null) throw new Error('missing positions');
      return Math.hypot(h.apos.x - h.vpos.x, h.apos.y - h.vpos.y, h.apos.z - h.vpos.z);
    };
    // lokier → cart, SSG 08, 73 HP / 7 armor: chest through armor (the 7 needs CS's int armor subtraction).
    expect(bulletDamage(gun('ssg08'), dist(0), 'chest', 100, true, d)).toEqual({ health: 73, armor: 7 });
    // sp4rtan → donk, AK-47, 27 / 34 / 26: chest, stomach (armored), leg.
    expect(bulletDamage(gun('ak47'), dist(1), 'chest', 100, true, d).health).toBe(27);
    expect(bulletDamage(gun('ak47'), dist(2), 'stomach', 95, true, d).health).toBe(34);
    expect(bulletDamage(gun('ak47'), dist(3), 'leg', 89, true, d).health).toBe(26);
  });
});

describe('hitscan', () => {
  const shooter: ScanPawn = { id: 'cart', team: 'T', pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, crouching: false, alive: true };
  const at = (id: PlayerId, team: 'T' | 'CT', x: number, y: number, crouching = false): ScanPawn => ({ id, team, pos: { x, y, z: 0 }, yaw: 180, pitch: 0, crouching, alive: true });

  it('aim pitch is Source pitch (positive = down) to each band', () => {
    expect(aimPitch(body(0, 0), body(100, 0), 'head', d)).toBe(0);
    expect(aimPitch(body(0, 0), body(100, 0), 'chest', d)).toBeCloseTo((Math.atan2(16, 100) * 180) / Math.PI, 5);
    expect(aimPitch(body(0, 0, -100), body(100, 0), 'head', d)).toBeLessThan(0); // target above: look up
  });

  it('picks the closest band within the tolerance; outside it the bullet misses', () => {
    const target = at('sp4rtan', 'CT', 300, 0);
    const pitch = (band: 'head' | 'chest' | 'stomach' | 'leg') => aimPitch(shooter, target, band, d);
    for (const band of ['head', 'chest', 'stomach', 'leg'] as const) {
      expect(traceShot({ ...shooter, pitch: pitch(band) }, [shooter, target], openNav, d)?.hitgroup).toBe(band);
    }
    expect(traceShot({ ...shooter, pitch: -3.5 }, [shooter, target], openNav, d)).toBeNull();
    expect(traceShot({ ...shooter, pitch: -2.9 }, [shooter, target], openNav, d)?.hitgroup).toBe('head');
  });

  it('misses a pawn the ray does not cross (16-unit circle) and pawns behind the shooter', () => {
    expect(traceShot(shooter, [shooter, at('sp4rtan', 'CT', 300, 17)], openNav, d)).toBeNull();
    expect(traceShot(shooter, [shooter, at('sp4rtan', 'CT', 300, 15)], openNav, d)?.victim).toBe('sp4rtan');
    expect(traceShot(shooter, [shooter, at('sp4rtan', 'CT', -300, 0)], openNav, d)).toBeNull();
  });

  it('friendly fire off: shots pass through teammates', () => {
    const hit = traceShot(shooter, [shooter, at('barely', 'T', 100, 0), at('sp4rtan', 'CT', 300, 0)], openNav, d);
    expect(hit?.victim).toBe('sp4rtan');
  });

  it('a bullet that passes over a crouched pawn hits the standing one behind it', () => {
    const near = at('zwomp', 'CT', 20, 0, true);
    const far = at('sp4rtan', 'CT', 500, 0);
    expect(traceShot(shooter, [shooter, near, far], openNav, d)).toMatchObject({ victim: 'sp4rtan', hitgroup: 'head' });
  });

  it('walls stop bullets (nav line of sight to the impact point)', () => {
    const west: ScanPawn = { ...shooter, pos: { x: -200, y: 0, z: 0 } };
    expect(traceShot(west, [west, at('sp4rtan', 'CT', 200, 0)], wallNav, d)).toBeNull();
    expect(traceShot(west, [west, at('sp4rtan', 'CT', -100, 0)], wallNav, d)?.victim).toBe('sp4rtan');
  });
});

describe('fire rules', () => {
  it('holding ATTACK for 1.0 s with an AK-47 fires exactly 10 rounds at 600 rpm, on the fractional 6.4-tick cadence', () => {
    expect(cycleTicks(gun('ak47'))).toBeCloseTo(6.4, 12);
    const host = newHost();
    host.apply(act(setupActions('cart', { x: 0, y: 0 }, 90, 'ak47'), [input('cart', 90, 0, ['ATTACK'])]));
    const obs = run(host, 64);
    const shots = ticksWhere(obs, (e) => e.type === 'shot');
    expect(shots).toEqual([0, 7, 13, 20, 26, 32, 39, 45, 52, 58]); // ⌈k × 6.4⌉
    expect(pawn(host.observe(), 'cart').ammo).toEqual({ clip: 20, reserve: 90 });
    // The 11th is due at 64.0, i.e. 1.0 s after the first.
    expect(ticksWhere(run(host, 1), (e) => e.type === 'shot')).toEqual([64]);
  });

  it('every shot emits shot then sound {kind: shot} at the shooter', () => {
    const host = newHost();
    host.apply(act(setupActions('cart', { x: 10, y: 20 }, 90, 'ak47'), [input('cart', 90, 0, ['ATTACK'])]));
    host.tick();
    expect(host.observe().events).toEqual([
      { type: 'shot', shooter: 'cart', weapon: 'ak47' },
      { type: 'sound', source: 'cart', pos: { x: 10, y: 20, z: 0 }, kind: 'shot' },
    ]);
  });

  it('the deagle is semi-automatic: one shot per ATTACK press', () => {
    const host = newHost();
    host.apply(act(setupActions('cart', { x: 0, y: 0 }, 90, 'deagle'), [input('cart', 90, 0, ['ATTACK'])]));
    expect(ticksWhere(run(host, 64), (e) => e.type === 'shot')).toEqual([0]);

    // Press for 2 ticks, release for 18: one shot per press (cycle 14.4 ticks).
    const tapper = newHost();
    tapper.apply(act(setupActions('cart', { x: 0, y: 0 }, 90, 'deagle')));
    const obs: Observe[] = [];
    for (let i = 0; i < 80; i++) {
      tapper.apply(act([], [input('cart', 90, 0, i % 20 < 2 ? ['ATTACK'] : [])]));
      tapper.tick();
      obs.push(tapper.observe());
    }
    expect(ticksWhere(obs, (e) => e.type === 'shot')).toEqual([0, 20, 40, 60]);
  });

  it('snipers are semi-automatic too and wait for their bolt cycle (AWP 41 rpm)', () => {
    const host = newHost();
    host.apply(act(setupActions('cart', { x: 0, y: 0 }, 90, 'awp')));
    const obs: Observe[] = [];
    for (let i = 0; i < 200; i++) {
      host.apply(act([], [input('cart', 90, 0, i % 4 < 2 ? ['ATTACK'] : [])]));
      host.tick();
      obs.push(host.observe());
    }
    // Presses every 4 ticks (held 2): the bolt is ready at 93.66, the next press is at 96; then 96 + 93.66 = 189.66 → press at 192.
    expect(ticksWhere(obs, (e) => e.type === 'shot')).toEqual([0, 96, 192]);
  });

  it('an empty magazine reloads by itself once the cycle is ready; no shots during the reload', () => {
    const host = newHost();
    host.apply(act(setupActions('cart', { x: 0, y: 0 }, 90, 'ak47'), [input('cart', 90, 0, ['ATTACK'])]));
    const obs = run(host, 360);
    const shots = ticksWhere(obs, (e) => e.type === 'shot');
    expect(shots.length).toBe(32);
    expect(shots[29]).toBe(186); // 30th round at ⌈29 × 6.4⌉
    expect(ticksWhere(obs, (e) => e.type === 'sound' && e.kind === 'reload')).toEqual([192]); // due 192.0
    expect(shots.slice(30)).toEqual([352, 359]); // reload 2.5 s = 160 ticks, then the cadence restarts
    expect(pawn(obs[351] as Observe, 'cart').ammo).toEqual({ clip: 0, reserve: 90 });
    expect(pawn(obs[352] as Observe, 'cart').ammo).toEqual({ clip: 29, reserve: 60 });
  });

  it('RELOAD tops up from reserve after reloadSec; ATTACK is ignored meanwhile; a full magazine does not reload', () => {
    const host = newHost();
    host.apply(act(setupActions('cart', { x: 0, y: 0 }, 90, 'ak47', { clip: 25, reserve: 90 }), [input('cart', 90, 0, ['RELOAD'])]));
    const first = run(host, 1);
    expect(eventsOf(first[0] as Observe, 'sound').map((e) => e.kind)).toEqual(['reload']);
    host.apply(act([], [input('cart', 90, 0, ['ATTACK'])]));
    const during = run(host, 159);
    expect(ticksWhere(during, (e) => e.type === 'shot')).toEqual([]);
    expect(pawn(during[158] as Observe, 'cart').ammo).toEqual({ clip: 25, reserve: 90 });
    host.apply(act([], []));
    run(host, 1); // tick 160: reload done
    expect(pawn(host.observe(), 'cart').ammo).toEqual({ clip: 30, reserve: 85 });

    host.apply(act([], [input('cart', 90, 0, ['RELOAD'])]));
    expect(ticksWhere(run(host, 10), (e) => e.type === 'sound' && e.kind === 'reload')).toEqual([]);
  });

  it('with reloadDiscardsMagazine (CS2 since March 2026) the rounds left in the magazine are lost', () => {
    const raw = JSON.parse(JSON.stringify(tuning)) as Record<string, Record<string, unknown>>;
    (raw['damage'] as Record<string, unknown>)['reloadDiscardsMagazine'] = true;
    const t2 = parseTuning(raw);
    const host = newHost(openNav, t2);
    host.apply(act(setupActions('cart', { x: 0, y: 0 }, 90, 'ak47', { clip: 25, reserve: 90 }), [input('cart', 90, 0, ['RELOAD'])]));
    run(host, 161);
    expect(pawn(host.observe(), 'cart').ammo).toEqual({ clip: 30, reserve: 60 });
  });

  it('set_weapon deploys for deploySec before the gun can fire; with a teleport in the same act it is ready at once', () => {
    const host = newHost();
    host.apply(act(setupActions('cart', { x: 0, y: 0 }, 90, 'ak47')));
    host.apply(act([{ type: 'give', id: 'cart', item: 'deagle', clip: 7, reserve: 35 }, { type: 'set_weapon', id: 'cart', weapon: 'deagle' }], [input('cart', 90, 0, ['ATTACK'])]));
    expect(ticksWhere(run(host, 80), (e) => e.type === 'shot')).toEqual([64]); // deagle deploySec 1
    expect(host.pawnState('cart')?.wpn.deployEndTick).toBe(64);
  });

  it('switching weapons cancels a reload; the knife and c4 never shoot', () => {
    const host = newHost();
    host.apply(act(setupActions('cart', { x: 0, y: 0 }, 90, 'ak47', { clip: 3, reserve: 90 }), [input('cart', 90, 0, ['RELOAD'])]));
    run(host, 10);
    expect(host.pawnState('cart')?.wpn.reloadEndTick).toBe(160);
    host.apply(act([{ type: 'set_weapon', id: 'cart', weapon: 'knife' }], [input('cart', 90, 0, ['ATTACK'])]));
    expect(host.pawnState('cart')?.wpn.reloadEndTick).toBeNull();
    expect(ticksWhere(run(host, 100), (e) => e.type === 'shot')).toEqual([]);
    expect(host.pawnState('cart')?.inventory.find((q) => q.item === 'ak47')).toEqual({ item: 'ak47', clip: 3, reserve: 90 });
  });

  it('stepWeapon is pure', () => {
    const s = freshWeaponState();
    const inp = { tick: 0, item: 'ak47', ammo: { clip: 1, reserve: 0 }, gun: gun('ak47'), attack: true, reload: false, discardMagazine: false };
    const a = stepWeapon(s, inp);
    expect(stepWeapon(s, inp)).toEqual(a);
    expect(s).toEqual(freshWeaponState());
    expect(a).toMatchObject({ fired: true, ammo: { clip: 0, reserve: 0 }, reloadStarted: false });
  });
});

describe('blocked pairs and scripted damage', () => {
  it('block_damage: the shot still fires, no damage applies and no damage event is emitted; unblock restores it', () => {
    const host = duel('ak47', 300);
    host.apply(act([{ type: 'block_damage', attacker: 'cart', victim: 'sp4rtan' }]));
    expect(host.blockedPairs()).toEqual([{ attacker: 'cart', victim: 'sp4rtan' }]);
    const o = fireAt(host, 'head');
    expect(eventsOf(o, 'shot')).toEqual([{ type: 'shot', shooter: 'cart', weapon: 'ak47' }]);
    expect(eventsOf(o, 'damage')).toEqual([]);
    expect(eventsOf(o, 'death')).toEqual([]);
    expect(pawn(o, 'sp4rtan')).toMatchObject({ hp: 100, armor: 100, alive: true });
    const would = bulletDamage(gun('ak47'), Math.hypot(300, 0), 'head', 100, true, d);
    expect(host.combatLog().map((l) => l.text)).toEqual([`blocked cart -> sp4rtan ak47 head: ${would.health} hp / ${would.armor} armor not applied`]);

    // Only that ordered pair is blocked.
    host.apply(act([{ type: 'unblock_damage', attacker: 'cart', victim: 'sp4rtan' }, { type: 'block_damage', attacker: 'sp4rtan', victim: 'cart' }]));
    run(host, 20);
    const again = fireAt(host, 'chest');
    expect(eventsOf(again, 'damage')[0]).toMatchObject({ attacker: 'cart', victim: 'sp4rtan', amount: 27 });
    expect(eventsOf(again, 'blocked_hit')).toEqual([]);
  });

  it('G5: a blocked bullet of the human is reported (blocked_hit: victim, hitgroup) after its shot and sound; nobody else’s is', () => {
    // The host's human is cart (Sim2DHost's default).
    const host = duel('ak47', 300);
    host.apply(act([{ type: 'block_damage', attacker: 'cart', victim: 'sp4rtan' }]));
    const o = fireAt(host, 'head');
    expect(o.events.map((e) => e.type)).toEqual(['shot', 'sound', 'blocked_hit']);
    expect(eventsOf(o, 'blocked_hit')).toEqual([{ type: 'blocked_hit', attacker: 'cart', victim: 'sp4rtan', weapon: 'ak47', hitgroup: 'head' }]);
    expect(pawn(o, 'sp4rtan')).toMatchObject({ hp: 100, armor: 100 });
    host.apply(act([]));
    run(host, 20);
    expect(eventsOf(fireAt(host, 'leg'), 'blocked_hit')).toEqual([{ type: 'blocked_hit', attacker: 'cart', victim: 'sp4rtan', weapon: 'ak47', hitgroup: 'leg' }]);
    // A miss is not reported.
    host.apply(act([]));
    run(host, 20);
    const o2 = host.observe();
    host.apply(act([], [input('cart', 30, aimPitch(pawn(o2, 'cart'), pawn(o2, 'sp4rtan'), 'head', d), ['ATTACK'])]));
    host.tick();
    expect(host.observe().events.map((e) => e.type)).toEqual(['shot', 'sound']);

    // The same blocked hit with nobody playing (cart a puppet, as under B3's round-start blocks) is not reported.
    const bots = duel('ak47', 300);
    bots.setHuman(null);
    bots.apply(act([{ type: 'block_damage', attacker: 'cart', victim: 'sp4rtan' }]));
    const ob = fireAt(bots, 'head');
    expect(ob.events.map((e) => e.type)).toEqual(['shot', 'sound']);
    expect(bots.combatLog()).toHaveLength(1);
  });

  it('scripted damage applies exactly, flagged scripted; lethal forces HP to 0 and death carries the headshot', () => {
    const host = duel('ak47', 300);
    host.apply(act([{ type: 'damage', attacker: 'cart', victim: 'sp4rtan', amount: 27, armor: 5, hitgroup: 'chest', weapon: 'ak47', lethal: false }]));
    host.tick();
    let o = host.observe();
    expect(o.events).toEqual([{ type: 'damage', attacker: 'cart', victim: 'sp4rtan', amount: 27, armor: 5, weapon: 'ak47', hitgroup: 'chest', scripted: true }]);
    expect(pawn(o, 'sp4rtan')).toMatchObject({ hp: 73, armor: 95, alive: true });

    host.apply(act([{ type: 'damage', attacker: 'cart', victim: 'sp4rtan', amount: 10, armor: 0, hitgroup: 'head', weapon: 'ak47', lethal: true }]));
    host.tick();
    o = host.observe();
    expect(o.events).toEqual([
      { type: 'damage', attacker: 'cart', victim: 'sp4rtan', amount: 73, armor: 0, weapon: 'ak47', hitgroup: 'head', scripted: true },
      { type: 'death', victim: 'sp4rtan', attacker: 'cart', weapon: 'ak47', headshot: true },
    ]);
    expect(pawn(o, 'sp4rtan')).toMatchObject({ hp: 0, alive: false });

    // Damage to a dead pawn is noted, not applied.
    host.apply(act([{ type: 'damage', attacker: 'cart', victim: 'sp4rtan', amount: 10, armor: 0, hitgroup: 'chest', weapon: 'ak47', lethal: false }]));
    host.tick();
    expect(host.observe().events).toEqual([]);
    expect(host.unhandled().map((n) => n.reason)).toEqual(['victim is dead']);
  });

  it('scripted damage ignores blocks, and a non-lethal hit that empties HP still kills (amount = HP removed)', () => {
    const host = duel('ak47', 300, { hp: 13 });
    host.apply(act([{ type: 'block_damage', attacker: 'sp4rtan', victim: 'cart' }]));
    host.apply(act([{ type: 'damage', attacker: 'cart', victim: 'sp4rtan', amount: 27, armor: 4, hitgroup: 'chest', weapon: 'ak47', lethal: false }]));
    host.tick();
    expect(host.observe().events).toEqual([
      { type: 'damage', attacker: 'cart', victim: 'sp4rtan', amount: 13, armor: 4, weapon: 'ak47', hitgroup: 'chest', scripted: true },
      { type: 'death', victim: 'sp4rtan', attacker: 'cart', weapon: 'ak47', headshot: false },
    ]);
  });

  it('shots resolve in id order within a tick: a pawn killed earlier in the tick does not fire', () => {
    const host = duel('awp', 400);
    const o0 = host.observe();
    host.apply(
      act([], [
        input('cart', 0, aimPitch(pawn(o0, 'cart'), pawn(o0, 'sp4rtan'), 'chest', d), ['ATTACK']),
        input('sp4rtan', 180, aimPitch(pawn(o0, 'sp4rtan'), pawn(o0, 'cart'), 'chest', d), ['ATTACK']),
      ]),
    );
    host.tick();
    const o = host.observe();
    expect(eventsOf(o, 'shot').map((e) => e.shooter)).toEqual(['cart']);
    expect(eventsOf(o, 'death').map((e) => e.victim)).toEqual(['sp4rtan']);
  });
});

describe('sounds', () => {
  it('footsteps above footstepSpeed at most every 0.3 s; walking (knife 130 u/s) is silent', () => {
    const host = newHost();
    host.apply(act([{ type: 'teleport', id: 'cart', pos: { x: 0, y: 0, z: 0 }, yaw: 0 }], [input('cart', 0, 0, [], 1)]));
    const obs = run(host, 128);
    const steps = ticksWhere(obs, (e) => e.type === 'sound' && e.kind === 'footstep');
    expect(steps.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < steps.length; i++) expect((steps[i] as number) - (steps[i - 1] as number)).toBeGreaterThanOrEqual(19.2);
    const first = steps[0] as number;
    expect(Math.hypot(pawn(obs[first] as Observe, 'cart').vel.x, pawn(obs[first] as Observe, 'cart').vel.y)).toBeGreaterThan(tuning.sound.footstepSpeed);

    const walker = newHost();
    walker.apply(act([{ type: 'teleport', id: 'cart', pos: { x: 0, y: 0, z: 0 }, yaw: 0 }], [input('cart', 0, 0, ['WALK'], 1)]));
    expect(ticksWhere(run(walker, 128), (e) => e.type === 'sound' && e.kind === 'footstep')).toEqual([]);
  });
});

// ---- determinism on Mirage -------------------------------------------------------------------

/**
 * Round-start setup from round.json, then snarlbot sprays at incredibad's chest. Their start spots have no 2D
 * line of sight on the nav mesh (different levels), so incredibad is placed 250 units from snarlbot in the
 * first direction (15° steps) that is walkable and in sight.
 */
function duelSpot(): { x: number; y: number; z: number } {
  const s = round.players.find((p) => p.id === 'snarlbot')?.start.pos ?? { x: 0, y: 0, z: 0 };
  for (let deg = 0; deg < 360; deg += 15) {
    const q = { x: s.x + 250 * Math.cos((deg * Math.PI) / 180), y: s.y + 250 * Math.sin((deg * Math.PI) / 180) };
    if (mirage.isWalkable(q) && mirage.lineOfSight(s, q)) return { x: Math.round(q.x), y: Math.round(q.y), z: mirage.zAt({ ...q, z: s.z }) };
  }
  throw new Error('no duel spot');
}

class DuelCore implements ICore {
  private started = false;
  step(o: Observe): Act {
    const actions: Action[] = [];
    if (!this.started) {
      this.started = true;
      for (const p of round.players) {
        actions.push({ type: 'teleport', id: p.id, pos: p.id === 'incredibad' ? duelSpot() : p.start.pos, yaw: 0 });
        actions.push({ type: 'set_hp', id: p.id, hp: p.startHp, armor: p.startArmor, helmet: true });
        const drawn = p.kit.primary ?? p.kit.secondary;
        if (drawn !== null) {
          actions.push({ type: 'give', id: p.id, item: drawn as 'ak47', clip: p.kit.clip, reserve: p.kit.reserve });
          actions.push({ type: 'set_weapon', id: p.id, weapon: drawn as 'ak47' });
        }
      }
      return { inputs: [], actions, status: [] };
    }
    const s = pawn(o, 'snarlbot');
    const v = pawn(o, 'incredibad');
    const yaw = (Math.atan2(v.pos.y - s.pos.y, v.pos.x - s.pos.x) * 180) / Math.PI;
    const inputs: PawnInput[] = [{ id: 'snarlbot', forward: 0, side: 0, yaw, pitch: aimPitch(s, v, 'chest', d), buttons: o.tick < 40 ? ['ATTACK'] : [] }];
    return { inputs, actions, status: [] };
  }
  control(): void {}
  snapshot() {
    return { kind: 'core' as const, data: this.started };
  }
  restore(s: { data: unknown }): void {
    this.started = s.data === true;
  }
}

function drive(host: Sim2DHost, core: ICore, ticks: number): SessionLog {
  const log = new SessionLog();
  for (let i = 0; i < ticks; i++) {
    const o = canonicalize(host.observe());
    const a = core.step(o);
    log.append(o, a);
    host.apply(a);
    host.tick();
  }
  return log;
}

describe('combat determinism (Mirage)', () => {
  it('two identical runs give identical digests, and the duel happens', () => {
    const a = drive(new Sim2DHost(mirage, tuning, roster), new DuelCore(), 120);
    const b = drive(new Sim2DHost(mirage, tuning, roster), new DuelCore(), 120);
    expect(a.digest()).toBe(b.digest());
    const events = a.lines().join('\n');
    expect(events).toContain('"type":"shot"');
    expect(events).toContain('"victim":"incredibad"');
    expect(events).toContain('"type":"death"');
  });

  it('snapshot mid-spray → restore → identical observes; observe() stays canonical', () => {
    const host = new Sim2DHost(mirage, tuning, roster);
    const core = new DuelCore();
    drive(host, core, 9);
    const snap = host.snapshot();
    const coreSnap = core.snapshot();
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
    const first = drive(host, core, 60);
    host.restore(snap);
    core.restore(coreSnap);
    expect(host.snapshot()).toEqual(snap);
    const second = drive(host, core, 60);
    expect(second.lines()).toEqual(first.lines());
    expect(canonicalize(host.observe())).toEqual(host.observe());
  });
});
