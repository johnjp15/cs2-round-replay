/** K4: the utility, positioning and economy tables on small synthetic demos (tests/coach/k4-helpers.ts). */
import { describe, expect, it } from 'vitest';
import { BUYS, purchasesOf } from '../../src/coach/derive/economy/buys';
import { itemPrice } from '../../src/coach/derive/economy/prices';
import { DEATHS } from '../../src/coach/derive/positioning/deaths';
import { OPENING, pushProgress } from '../../src/coach/derive/positioning/opening';
import { TRADES } from '../../src/coach/derive/positioning/trades';
import { THROWS, joinProjectiles } from '../../src/coach/derive/utility/throws';
import { UTILITY_TUNING } from '../../src/coach/derive/utility/tuning';
import { FLAG, TEAM_CT } from '../../src/coach/model/raw';
import {
  armAll, blind, ctxOf, det, hurt, kill, projectile, purchase, setColumn, setFlag, setPos, tenPlayers,
} from './k4-helpers';

describe('utility.throws', () => {
  const raw = tenPlayers(1);
  // Two flashes by slot 0 with the same (reused) entity id.
  projectile(raw, 'flashbang', 0, 50, 300, 404, [0, 0, 0], [500, 500, 0]);
  det(raw, 405, 'flash', 0, 50, 500, 500);
  projectile(raw, 'flashbang', 0, 50, 600, 704, [0, 0, 0], [800, 800, 0]);
  det(raw, 705, 'flash', 0, 50, 800, 800);
  kill(raw, 350, 2, 7); // slot 7 dead before the first flash
  blind(raw, 405, 0, 5, 2.5, 50); // enemy, counts
  blind(raw, 405, 0, 6, 0.8, 50); // enemy, too short
  blind(raw, 405, 0, 1, 1.5, 50); // teammate, counts
  blind(raw, 405, 0, 0, 0.5, 50); // self, too short
  blind(raw, 405, 0, 7, 3.0, 50); // dead enemy: never counted
  kill(raw, 469, 2, 5); // the blinded enemy dies to the thrower's team one second later
  hurt(raw, 437, 8, 1, 70); // the blinded teammate takes damage half a second later
  blind(raw, 705, 0, 9, 1.2, 50); // second flash: one enemy
  // HE by slot 3: the projectile lingers after the detonation; the damage is the health removed, not dmg_health.
  projectile(raw, 'he_grenade', 3, 60, 500, 900, [3000, 0, 0], [1000, 1000, 0]);
  det(raw, 600, 'he', 3, 60, 1000, 1000);
  hurt(raw, 600, 3, 6, 60, 'hegrenade', { dmgHealth: 40 });
  hurt(raw, 550, 4, 9, 30);
  hurt(raw, 600, 3, 9, 0, 'hegrenade', { dmgHealth: 57 });
  hurt(raw, 600, 3, 4, 90, 'hegrenade', { dmgHealth: 10 });
  // A molotov whose fire carries another entity id; an enemy stands in it for two seconds.
  projectile(raw, 'molotov', 4, 70, 300, 360, [4000, 0, 0], [2000, 2000, 0]);
  det(raw, 361, 'fire', 4, 99, 2000, 2000);
  det(raw, 361 + 448, 'fire_end', 4, 99, 2000, 2000);
  setPos(raw, 8, 380, 380 + 127, 2050, 2000);
  hurt(raw, 400, 4, 8, 92, 'inferno', { dmgHealth: 8 });
  // A smoke and its expiry; an HE with no projectile.
  projectile(raw, 'smoke', 1, 80, 300, 400, [1000, 0, 0], [3000, 0, 0]);
  det(raw, 400, 'smoke', 1, 80, 3000, 0);
  det(raw, 400 + 1408, 'smoke_end', 1, 80, 3000, 0);
  det(raw, 700, 'he', 2, 61, 0, 3000);
  const ctx = ctxOf(raw);
  const throws = ctx.table(THROWS);

  it('joins each projectile to its own detonation despite the reused entity id', () => {
    expect(throws.map((t) => `${t.type}:${t.thrower}:${t.detTick}`)).toEqual([
      'fire:4:361', 'smoke:1:400', 'flash:0:405', 'he:3:600', 'flash:0:705', 'he:2:700',
    ]);
    const [, , f1, , f2, bare] = throws;
    expect(f1?.throwTick).toBe(300);
    expect(f1?.throwPos).toEqual([0, 0, 0]);
    expect(f2?.detPos).toEqual([800, 800, 0]);
    expect(bare?.throwTick).toBeNull();
  });

  it('labels blinds and finds the kill and the teammate fight inside the window', () => {
    const f = throws[2];
    expect(f?.blinds.map((b) => `${b.victim}:${b.rel}:${b.alive}:${b.counts}`)).toEqual([
      '0:self:true:false', '1:team:true:true', '5:enemy:true:true', '6:enemy:true:false', '7:enemy:false:false',
    ]);
    expect(f?.enemiesBlinded).toBe(1);
    expect(f?.teammatesBlinded).toBe(1);
    expect(f?.selfBlinded).toBe(false);
    expect(f?.ledToKill).toBe(true);
    expect(f?.blinds.find((b) => b.victim === 5)?.killedBy).toBe(2);
    expect(f?.blinds.find((b) => b.victim === 1)?.fightTick).toBe(437);
    expect(throws[4]?.blinds.map((b) => b.victim)).toEqual([9]);
  });

  it('counts HE damage from health deltas, to enemies and teammates', () => {
    const he = throws[3];
    expect(he?.enemyDamage).toBe(40 + 30);
    expect(he?.teamDamage).toBe(10);
  });

  it('counts fire damage and the seconds an enemy stood in it', () => {
    const fire = throws[0];
    expect(fire?.enemyDamage).toBe(8);
    expect(fire?.lifetimeSec).toBe(7);
    expect(fire?.fireEnemySec).toBeCloseTo(2, 1);
    expect(fire?.fireNearSec).toBeGreaterThanOrEqual(fire?.fireEnemySec ?? 0);
  });

  it('reads the smoke lifetime from its expiry', () => {
    expect(throws[1]?.lifetimeSec).toBe(22);
  });

  it('never joins a detonation beyond the match radius', () => {
    const tune = { ...UTILITY_TUNING.throws, matchRadius: 10 };
    const j = joinProjectiles([raw.projectiles[0] as (typeof raw.projectiles)[number]], [{ tick: 405, kind: 'flash', p: 0, entity: 50, x: 900, y: 900, z: 0 }], tune);
    expect(j[0]?.det).toBeNull();
  });
});

describe('positioning.trades, deaths, opening', () => {
  const raw = tenPlayers(1);
  armAll(raw);
  setPos(raw, 0, 0, Infinity, 0, 0);
  setPos(raw, 1, 0, Infinity, 300, 400);
  setPos(raw, 2, 0, Infinity, 0, 1200);
  setPos(raw, 5, 0, Infinity, 0, 1000);
  setFlag(raw, 0, 250, 299, FLAG.reloading);
  setFlag(raw, 0, 250, 299, FLAG.scoped);
  setColumn(raw, 'flash', 0, 250, 299, 1.5);
  blind(raw, 250, 6, 0, 2, 1);
  raw.inventories.push({ tick: 299, p: 0, at: 'death', items: ['flashbang', 'hegrenade', 'knife', 'smokegrenade'] });
  kill(raw, 300, 5, 0);
  hurt(raw, 450, 1, 5, 50);
  kill(raw, 500, 1, 5);
  kill(raw, 600, 6, 2);
  raw.events.bomb.push({ tick: 650, kind: 'planted', p: 1, site: 5, hasKit: false });
  raw.events.bomb.push({ tick: 690, kind: 'begin_plant', p: 3, site: 5, hasKit: false });
  kill(raw, 700, 7, 3);
  kill(raw, 720, 7, 4);
  kill(raw, 800, 1, 7);
  kill(raw, 984, 1, 6);
  const ctx = ctxOf(raw);

  it('flags trades inside the window, each death once, one kill trading two', () => {
    const t = ctx.table(TRADES);
    expect(t.map((r) => `${r.k}:${r.isTrade ? 'T' : '-'}:${r.traded ? r.tradedBy : '-'}`)).toEqual([
      '0:-:1', '1:T:-', '2:-:-', '3:-:5', '4:-:5', '5:T:-', '6:-:-',
    ]);
    expect(t[5]?.trades).toEqual([3, 4]);
  });

  it('records the death context', () => {
    const d = ctx.table(DEATHS)[0];
    expect(d).toMatchObject({
      victim: 0, killer: 5, side: 'T', reloading: true, scoped: true, flashedSec: 1.5, flashedBy: 6, grenadeValue: 800,
      aliveOwn: 5, aliveEnemy: 5, firstDeath: true, traded: true, tradedBy: 1, bomb: 'none', roundWon: true,
    });
    expect(d?.grenades).toEqual(['flashbang', 'hegrenade', 'smokegrenade']);
    expect(d?.distance).toBe(1000);
    expect(d?.nearest).toEqual({ p: 1, dist: 500 });
    expect(d?.clockSec).toBeCloseTo(100 / 64, 6);
    const mate = d?.teammates.find((m) => m.p === 1);
    expect(mate).toMatchObject({ damageToKiller: 50, killedKiller: true, hadGun: true, sawKiller: null });
    expect(d?.teammateSawKiller).toBeNull();
    const planting = ctx.table(DEATHS).find((x) => x.victim === 3);
    expect(planting).toMatchObject({ planting: true, bomb: 'planted', firstDeath: false, aliveOwn: 3 });
    expect(planting?.bombSec).toBeCloseTo(50 / 64, 6);
  });

  it('takes the first enemy kill of each round as the opening duel', () => {
    const o = ctx.table(OPENING);
    expect(o.length).toBe(1);
    expect(o[0]).toMatchObject({ attacker: 5, victim: 0, attackerSide: 'CT', victimSide: 'T', attackerWon: false, winnerSide: 'T' });
    expect(pushProgress([0, 0, 0], [0, 0, 0], [0, 100, 0])).toBe(0);
    expect(pushProgress([0, 75, 0], [0, 0, 0], [0, 100, 0])).toBe(0.75);
  });
});

describe('economy.buys', () => {
  const raw = tenPlayers(3);
  for (let p = 0; p < 10; p++) setColumn(raw, 'money', p, 0, Infinity, 4000);
  // Round 2 (ticks 1100–2000, freeze end 1200): slot 0 buys a helmet, an AK and a flash, the event re-sends the list,
  // he sells the flash back (the record repeats the list, the money rises by 200).
  purchase(raw, 1150, 0, 'vesthelm', 1000);
  purchase(raw, 1160, 0, 'ak47', 2700);
  purchase(raw, 1170, 0, 'flashbang', 200);
  for (const item of ['vesthelm', 'ak47', 'flashbang']) purchase(raw, 1220, 0, item, item === 'ak47' ? 2700 : item === 'vesthelm' ? 1000 : 200, false);
  setColumn(raw, 'money', 0, 1240, Infinity, 300);
  for (const item of ['vesthelm', 'ak47']) purchase(raw, 1240, 0, item, item === 'ak47' ? 2700 : 1000, false);
  purchase(raw, 1900, 0, 'ak47', 2700, false); // mid-round record: not a purchase
  setColumn(raw, 'armor', 0, 1150, Infinity, 100);
  setFlag(raw, 0, 1150, Infinity, FLAG.helmet);
  // A CT with a kit and a smoke bought after the freeze end.
  purchase(raw, 1150, 5, 'defuser', 400);
  purchase(raw, 1250, 5, 'smokegrenade', 300);
  setFlag(raw, 5, 1150, Infinity, FLAG.kit);
  const ctx = ctxOf(raw);
  const buys = ctx.table(BUYS);

  it('keeps only the records the money pays for, minus sales', () => {
    expect(purchasesOf(ctx, 0, 1100, 2000).map((b) => b.item)).toEqual(['vesthelm', 'ak47']);
    const b = buys.find((x) => x.round === 2 && x.p === 0);
    expect(b).toMatchObject({ side: 'T', team: 'A', moneyStart: 4000, spent: 3700, moneyLeft: 300, armor: 100, helmet: true, kit: false, primary: 'ak47', teamBuy: 'full', buyClass: 'full' });
    expect(b?.bought).toEqual(['vesthelm', 'ak47']);
  });

  it('adds grenades bought after the freeze end to the freeze-end loadout', () => {
    const b = buys.find((x) => x.round === 2 && x.p === 5);
    expect(b).toMatchObject({ side: 'CT', kit: true, spent: 700 });
    expect(b?.grenades).toEqual(['smokegrenade']);
    expect(raw.ticks.team[5]).toBe(TEAM_CT);
  });

  it('classes pistol rounds as pistol and prices items from data/weapons.json', () => {
    expect(buys.filter((x) => x.round === 1).every((x) => x.buyClass === 'pistol')).toBe(true);
    expect(buys.length).toBe(30);
    expect([itemPrice('flashbang'), itemPrice('smokegrenade'), itemPrice('defuser'), itemPrice('vesthelm'), itemPrice('m4a1')]).toEqual([200, 300, 400, 1000, 2900]);
  });
});
