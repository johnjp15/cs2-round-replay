/** K2: combat tables and the aim / movement detectors on synthetic demos (tests/coach/combat-synth.ts). */
import { describe, expect, it } from 'vitest';
import { analyze, createContext } from '../../src/coach/analyze/index';
import { SHOTS, SPRAYS, TARGETS } from '../../src/coach/derive/aim/index';
import { DEATHS_IN_HAND, RELOADS, speedAt } from '../../src/coach/derive/movement/index';
import { AIM_DETECTORS } from '../../src/coach/detect/aim/index';
import { MOVEMENT_DETECTORS } from '../../src/coach/detect/movement/index';
import { describe as describeSpray, segments, sprayProfile } from '../../src/coach/detect/aim/spray';
import { ingestMatch } from '../../src/coach/ingest/index';
import { AIM_METRICS } from '../../src/coach/metrics/aim/index';
import { MOVEMENT_METRICS } from '../../src/coach/metrics/movement/index';
import { BUTTON, FLAG, rowAtOrAfter } from '../../src/coach/model/raw';
import type { RawDemo } from '../../src/coach/model/raw';
import type { Finding } from '../../src/coach/model/report';
import { addBullet, aimAt, combatDemo, finish, kill, setButtons, setFlag, setPos, setVel, setWeapon } from './combat-synth';

const R1 = 200; // round 1's freeze end; live play runs to tick 1000.

function run(raw: RawDemo, user = 0): { findings: Finding[]; topFixes: string[] } {
  const match = ingestMatch(finish(raw));
  return analyze(raw, match, { user, metrics: [...AIM_METRICS, ...MOVEMENT_METRICS], detectors: [...AIM_DETECTORS, ...MOVEMENT_DETECTORS] });
}

/** Four players: A1 (0) at the origin, A2 (1) at y = 300, B1 (2) and B2 (3) 1,000 units east, facing west. */
function duelDemo(rounds = 1): RawDemo {
  const raw = combatDemo(2, rounds);
  const end = 100 + rounds * 1000;
  setPos(raw, 0, 0, end, 0, 0);
  setPos(raw, 1, 0, end, 0, 300);
  setPos(raw, 2, 0, end, 1000, 0);
  setPos(raw, 3, 0, end, 1000, 300);
  return raw;
}

describe('combat tables', () => {
  it('joins bullets to shots and hits, counts damage from health, groups bursts', () => {
    const raw = duelDemo();
    for (let k = 0; k < 5; k++) addBullet(raw, { tick: 300 + 6 * k, p: 0, ...aimAt(raw, 0, 2, 300), recoilIndex: k, ...(k === 1 ? { hurt: { victim: 2, healthAfter: 73, dmg: 120 } } : {}) });
    addBullet(raw, { tick: 360, p: 0, ...aimAt(raw, 0, 2, 360) });
    raw.events.shots.push({ tick: 400, p: 0, weapon: 'knife', silenced: false });
    const ctx = createContext(finish(raw), ingestMatch(raw));
    const t = ctx.table(SHOTS);
    expect(t.shots.length).toBe(6);
    expect(t.nonBulletShots).toBe(1);
    expect(t.bursts.map((b) => b.shots.length)).toEqual([5, 1]);
    expect(t.bursts[0]?.spray).toBe(true);
    expect(t.shots.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 1]);
    expect(t.shots[1]?.hitEnemy).toBe(true);
    expect(t.shots[1]?.damage).toBe(27);
    const tg = ctx.table(TARGETS);
    expect(tg.rows.map((r) => r.how)).toEqual(['aim', 'hit', 'aim', 'aim', 'aim', 'aim']);
    expect(tg.rows.every((r) => r.target === 2)).toBe(true);
    expect(tg.rows[0]?.onTarget).toBe(true);
    expect(Math.abs(tg.rows[0]?.up ?? 1)).toBeLessThan(1e-6);
    expect(ctx.table(SPRAYS).length).toBe(1);
  });

  it('reads the speed behind a tick from the next row (the velocity column lags a tick)', () => {
    const raw = duelDemo();
    setVel(raw, 0, 301, 301, 200);
    const t = rowAtOrAfter(raw.ticks, 300);
    expect(speedAt(raw, t, 0)).toBe(200);
    expect(speedAt(raw, t + 1, 0)).toBe(0);
  });

  it('leaves bullets aimed at nobody and ambiguous ones without a target', () => {
    const raw = duelDemo();
    setPos(raw, 3, 0, 1100, 1000, 5); // B2 right next to B1: ambiguous
    addBullet(raw, { tick: 300, p: 0, pitch: 0, yaw: 90 }); // 90° off everyone
    addBullet(raw, { tick: 320, p: 0, ...aimAt(raw, 0, 2, 320, 0, -0.14) }); // between B1 and B2
    const ctx = createContext(finish(raw), ingestMatch(raw));
    expect(ctx.table(TARGETS).rows.map((r) => r.how)).toEqual(['none', 'ambiguous']);
  });

  it('a death counts as while reloading only before the magazine is refilled', () => {
    const raw = duelDemo();
    raw.events.reloads.push({ tick: 400, p: 0 });
    setWeapon(raw, 0, 380, 1000, 'ak47', 10);
    setFlag(raw, 0, 400, 1000, FLAG.reloading, true);
    kill(raw, 0, 2, 450);
    raw.events.reloads.push({ tick: 500, p: 1 });
    setFlag(raw, 1, 500, 1000, FLAG.reloading, true);
    setWeapon(raw, 1, 520, 1000, 'ak47', 30); // refilled at 520
    kill(raw, 1, 2, 560);
    const ctx = createContext(finish(raw), ingestMatch(raw));
    expect(ctx.table(DEATHS_IN_HAND).map((d) => [d.victim, d.reloading])).toEqual([[0, true], [1, false]]);
    const r = ctx.table(RELOADS);
    expect(r.map((x) => [x.p, x.enemyNear, x.diedReloading])).toEqual([[0, true, true], [1, true, false]]);
  });
});

describe('aim.counter_strafe', () => {
  it('flags first bullets fired while moving, with the ms to stop and the technique', () => {
    const raw = duelDemo();
    for (let k = 0; k < 10; k++) {
      const tick = R1 + 20 + 60 * k;
      const moving = k < 6;
      if (moving) {
        setVel(raw, 0, tick - 20, tick + 3, 0, 200); // strafing north at 200 u/s (93 % of the AK's 215) until 3 ticks after
        setButtons(raw, 0, tick - 20, tick, BUTTON.left); // yaw 0 (east): left = north, along the velocity
      }
      addBullet(raw, { tick, p: 0, ...aimAt(raw, 0, 2, tick), inaccuracy: moving ? 0.17 : 0.00641, ...(moving ? {} : { hurt: { victim: 2, healthAfter: 99 } }) });
      // The others shoot standing.
      for (const p of [1, 2, 3]) addBullet(raw, { tick: tick + 1, p, ...aimAt(raw, p, p < 2 ? 2 : 0, tick + 1) });
    }
    const rep = run(raw);
    const f = rep.findings.find((x) => x.id === 'aim.counter_strafe.early');
    expect(f).toBeDefined();
    expect(f?.summary).toContain('60 % of your first rifle bullets while still moving');
    expect(f?.summary).toContain('a median of 47 ms before you had stopped; those shots carried 26.5× the standing inaccuracy');
    expect(f?.why).toContain('were still holding the key 6 times');
    expect(f?.metrics[0]).toMatchObject({ id: 'aim.counter_strafe.early_share', value: 0.6, lobbyRank: 4, n: 10 });
    expect(f?.evidence.length).toBe(3);
    for (const e of f?.evidence ?? []) {
      expect(e.kind).toBe('duel');
      expect(e.tick0).toBeLessThan(e.focus);
      expect(raw.events.bullets.some((b) => b.p === 0 && b.tick === e.focus && b.inaccuracy === 0.17)).toBe(true);
      expect(e.annotations.map((a) => a.kind)).toEqual(['path', 'line', 'label']);
    }
    expect(rep.topFixes).toContain('aim.counter_strafe.early');
  });
});

describe('aim.spray', () => {
  it('finds where the spray leaves the target', () => {
    const raw = duelDemo(2);
    for (const [r, base] of [[0, R1 + 50], [0, R1 + 300], [1, 1200 + 50], [1, 1200 + 300]] as const) {
      void r;
      for (let k = 0; k < 10; k++) {
        const tick = base + 6 * k;
        // A1 drifts 2.5° high from bullet 4 (1,000 units: the head top is ~1.3° above the chest); the others stay on.
        addBullet(raw, { tick, p: 0, ...aimAt(raw, 0, 2, tick, k >= 3 ? 2.5 : 0), recoilIndex: k });
        for (const p of [1, 2, 3]) addBullet(raw, { tick: tick + 1, p, ...aimAt(raw, p, p < 2 ? 3 : 1, tick + 1), recoilIndex: k });
      }
    }
    const rep = run(raw);
    const f = rep.findings.find((x) => x.id === 'aim.spray.drift');
    expect(f).toBeDefined();
    expect(f?.summary).toContain('on target for bullets 1–3, 2.5° high over bullets 4–10');
    expect(f?.title).toBe('Pull down through the spray');
    expect(f?.evidence.length).toBeGreaterThanOrEqual(2);
    expect(f?.evidence.every((e) => e.kind === 'spray' && e.annotations.some((a) => a.kind === 'path'))).toBe(true);
  });

  it('describes profiles in segments', () => {
    const segs = segments([
      { n: 1, count: 5, up: 0, right: 0, dist: 1000, verdict: 'on' },
      { n: 2, count: 5, up: 0, right: 0, dist: 1000, verdict: 'on' },
      { n: 3, count: 5, up: 1.8, right: 0, dist: 1000, verdict: 'high' },
      { n: 4, count: 5, up: 1.8, right: 0, dist: 1000, verdict: 'high' },
      { n: 5, count: 5, up: 0, right: 1.2, dist: 1000, verdict: 'right' },
    ]);
    expect(describeSpray(segs)).toBe('on target for bullets 1–2, 1.8° high over bullets 3–4, 1.2° right over bullet 5');
    expect(sprayProfile([])).toEqual([]);
  });
});

describe('aim.range_discipline and aim.first_bullet', () => {
  it('flags long sprays that hit nothing after bullet 4', () => {
    const raw = duelDemo(2);
    setPos(raw, 2, 0, 2100, 1600, 0);
    for (const base of [R1 + 50, 1200 + 50]) {
      for (let k = 0; k < 8; k++) addBullet(raw, { tick: base + 6 * k, p: 0, ...aimAt(raw, 0, 2, base + 6 * k), recoilIndex: k, ...(k < 2 ? { hurt: { victim: 2, healthAfter: 90 - 10 * k } } : {}) });
    }
    const rep = run(raw);
    const f = rep.findings.find((x) => x.id === 'aim.range_discipline.long_sprays');
    expect(f?.summary).toContain('2 of your 2 sprays of 6+ bullets beyond 1,200 units hit nothing after bullet 4');
    expect(f?.evidence.length).toBe(2);
    expect(f?.stats.rounds).toEqual([1, 2]);
  });

  it('flags a first-bullet hit rate well under the lobby', () => {
    const raw = duelDemo(2);
    for (let k = 0; k < 12; k++) {
      const tick = (k < 6 ? R1 : 1200) + 20 + 60 * (k % 6);
      addBullet(raw, { tick, p: 0, ...aimAt(raw, 0, 2, tick, 0, 2) }); // 2° right: a miss, still meant for B1
      for (const p of [1, 2, 3]) addBullet(raw, { tick: tick + 1, p, ...aimAt(raw, p, p < 2 ? 2 : 0, tick + 1), hurt: { victim: p < 2 ? 2 : 0, healthAfter: 99 } });
    }
    const rep = run(raw);
    const f = rep.findings.find((x) => x.id === 'aim.first_bullet.low');
    expect(f?.summary).toContain('Your first bullets hit 0 % (12 first bullets, lobby median 100 %)');
    expect(f?.evidence.every((e) => e.kind === 'duel')).toBe(true);
  });
});

describe('move.reload and move.caught_out', () => {
  it('flags exposed reloads and a death while reloading', () => {
    const raw = duelDemo();
    for (const tick of [R1 + 20, R1 + 150, R1 + 300]) {
      raw.events.reloads.push({ tick, p: 0 });
      setWeapon(raw, 0, tick - 5, tick + 50, 'ak47', 25);
    }
    setFlag(raw, 0, R1 + 300, 1000, FLAG.reloading, true);
    kill(raw, 0, 2, R1 + 340);
    const rep = run(raw);
    const f = rep.findings.find((x) => x.id === 'move.reload.exposed');
    expect(f?.summary).toBe('You started 3 of 3 reloads with an enemy within 1,200 units (3) or more than half a magazine left (3), and died once while reloading.');
    expect(f?.evidence.some((e) => e.focus === R1 + 340 && e.caption.includes('died reloading'))).toBe(true);
  });

  it('flags knife and grenade deaths, not a grenade thrown at the killer', () => {
    const raw = duelDemo(3);
    setWeapon(raw, 0, R1 + 380, R1 + 400, 'knife');
    kill(raw, 0, 2, R1 + 400);
    setWeapon(raw, 0, 1200 + 380, 1200 + 400, 'hegrenade');
    kill(raw, 0, 2, 1200 + 400);
    // Round 3: a grenade thrown at the killer 0.5 s before dying (A1 faces east, B1 is east).
    setWeapon(raw, 0, 2200 + 340, 2200 + 400, 'hegrenade');
    raw.events.shots.push({ tick: 2200 + 368, p: 0, weapon: 'hegrenade', silenced: false });
    kill(raw, 0, 2, 2200 + 400);
    const rep = run(raw);
    const f = rep.findings.find((x) => x.id === 'move.caught_out.deaths');
    expect(f?.summary).toContain('2 of your 3 deaths came with the knife (1) or a grenade (1) in hand');
    expect(f?.evidence.map((e) => e.focus)).toEqual([R1 + 400, 1200 + 400]);
  });
});
