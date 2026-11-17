/** K6: the sight tables (sightings, duels, first sights, habits, death context) on the synthetic box map. */
import { describe, expect, it } from 'vitest';
import { blindRows, buildSightings, DEATH_CONTEXT, DUELS, FIRSTS, HABITS, SEE, SIGHTINGS, seeAt } from '../../src/coach/derive/sight/index';
import { FLAG } from '../../src/coach/model/raw';
import { addBullet } from './combat-synth';
import { blind, det, hurt, kill, setColumn, setFlag, setPos, setWeapon } from './k4-helpers';
import { A1, A_PEEK, B1, B2, B_COVER, B_PEEK, boxWorld, look, row, setView, sightCtx, sightDemo } from './sight-synth';

/** b1 steps out at 501; a1 faces the wall (yaw 0) until 540 and looks at b1 from 541 with the given offsets. */
function peekDemo(up = 0, right = 0) {
  const world = boxWorld();
  const raw = sightDemo();
  setPos(raw, B1, 501, Infinity, B_PEEK[0], B_PEEK[1]);
  look(raw, world, A1, 541, 1000, B1, up, right);
  return { raw, world };
}

const P = 10;

describe('sightings', () => {
  it('finds the row line of sight starts and the row the target enters the view', () => {
    const { raw, world } = peekDemo();
    const { ctx } = sightCtx(raw, world);
    const tab = ctx.table(SIGHTINGS);
    expect(tab.available).toBe(true);
    expect(seeAt(tab, row(raw, 500), A1, B1) & SEE.los).toBe(0);
    expect(seeAt(tab, row(raw, 501), A1, B1) & SEE.los).toBe(SEE.los);
    // b1 is 63° off a1's yaw 0: line of sight, not in view (the 16:9 frustum is ±53.1°).
    expect(seeAt(tab, row(raw, 520), A1, B1) & (SEE.inView | SEE.seen)).toBe(0);
    expect(seeAt(tab, row(raw, 541), A1, B1) & SEE.seen).toBe(SEE.seen);
    expect(seeAt(tab, row(raw, 541), A1, B1) & SEE.head).toBe(SEE.head);
    const mine = tab.sightings.filter((s) => s.obs === A1 && s.tgt === B1);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.tick0).toBe(541);
    expect(mine[0]?.tick1).toBe(1000);
    // b1 faces +x with a1 behind him: line of sight both ways, but he never sees a1.
    expect(seeAt(tab, row(raw, 600), B1, A1) & SEE.los).toBe(SEE.los);
    expect(tab.sightings.filter((s) => s.obs === B1)).toHaveLength(0);
    // Teammates and parked players are never live pairs.
    expect(seeAt(tab, row(raw, 600), A1, 1)).toBe(0);
    expect(seeAt(tab, row(raw, 600), A1, B2) & SEE.eval).toBe(0);
    expect(seeAt(tab, row(raw, 600), A1, B2) & SEE.far).toBe(SEE.far);
  });

  it('gives the same state at step 8 (with bisection) as at every row', () => {
    const { raw, world } = peekDemo();
    const { ctx } = sightCtx(raw, world);
    const a = buildSightings(ctx);
    const b = buildSightings(ctx, { step: 1 });
    expect(a.sightings).toEqual(b.sightings);
    expect(Buffer.from(a.state).equals(Buffer.from(b.state))).toBe(true);
    expect(a.stats.evaluated).toBeLessThan(b.stats.evaluated / 3);
  });

  it('can be limited to one player\'s pairs', () => {
    const { raw, world } = peekDemo();
    const { ctx } = sightCtx(raw, world);
    const u = buildSightings(ctx, { slots: [B2] });
    expect(u.sightings).toHaveLength(0);
    expect(u.stats.pairRows).toBeLessThan(buildSightings(ctx).stats.pairRows);
  });

  it('a smoke between them hides the target (smoked) until it expires', () => {
    const { raw, world } = peekDemo();
    det(raw, 600, 'smoke', 2, 77, 0, 600, 0);
    det(raw, 850, 'smoke_end', 2, 77, 0, 600, 0);
    const { ctx } = sightCtx(raw, world);
    const tab = ctx.table(SIGHTINGS);
    expect(seeAt(tab, row(raw, 590), A1, B1) & SEE.seen).toBe(SEE.seen);
    const mid = seeAt(tab, row(raw, 720), A1, B1);
    expect(mid & (SEE.seen | SEE.los)).toBe(0);
    expect(mid & SEE.smoked).toBe(SEE.smoked);
    expect(seeAt(tab, row(raw, 900), A1, B1) & SEE.seen).toBe(SEE.seen);
    expect(tab.sightings.filter((s) => s.obs === A1).length).toBe(2);
  });

  it('a blind observer sees nothing until less than blindRemainingSec of the flash is left', () => {
    const { raw, world } = peekDemo();
    setColumn(raw, 'flash', A1, 600, 1000, 3);
    blind(raw, 600, B1, A1, 3, 50);
    const { ctx } = sightCtx(raw, world);
    const b = blindRows(ctx, 1);
    expect(b[row(raw, 599) * P + A1]).toBe(0);
    expect(b[row(raw, 600) * P + A1]).toBe(1);
    expect(b[row(raw, 727) * P + A1]).toBe(1);
    expect(b[row(raw, 728) * P + A1]).toBe(0);
    const tab = ctx.table(SIGHTINGS);
    expect(seeAt(tab, row(raw, 650), A1, B1) & (SEE.seen | SEE.inView | SEE.blind)).toBe(SEE.inView | SEE.blind);
    const s = tab.sightings.filter((x) => x.obs === A1);
    expect(s.map((x) => [x.tick0, x.tick1])).toEqual([[541, 599], [728, 1000]]);
  });

  it('catches a short peek between samples when a shot anchors it, and can miss it without', () => {
    const make = (shot: boolean) => {
      const world = boxWorld();
      const raw = sightDemo();
      setPos(raw, B1, 601, 603, B_PEEK[0], B_PEEK[1]);
      look(raw, world, A1, 601, 603, B1);
      if (shot) addBullet(raw, { tick: 602, p: B1, pitch: 0, yaw: 180 });
      return sightCtx(raw, world).ctx;
    };
    const withShot = make(true).table(SIGHTINGS).sightings.filter((s) => s.obs === A1);
    expect(withShot.map((s) => [s.tick0, s.tick1])).toEqual([[601, 603]]);
    expect(make(false).table(SIGHTINGS).sightings).toHaveLength(0);
  });

  it('is empty without a sight mesh', () => {
    const { raw } = peekDemo();
    const { ctx } = sightCtx(raw, null);
    expect(ctx.table(SIGHTINGS).available).toBe(false);
    expect(ctx.table(DUELS).duels).toHaveLength(0);
    expect(ctx.table(FIRSTS).available).toBe(false);
    expect(ctx.table(HABITS).available).toBe(false);
    expect(ctx.table(DEATH_CONTEXT).available).toBe(false);
  });
});

describe('duels and first sights', () => {
  /** a1 sees b1 at 541 with the head 3° above and 2° right of the crosshair; b1 turns to a1 at 562; a1 hits at 570 and kills. */
  function duelDemo() {
    const { raw, world } = peekDemo(3, 2);
    look(raw, world, B1, 562, 1000, A1);
    look(raw, world, A1, 569, 570, B1);
    const P0 = raw.players.length;
    const r = row(raw, 569);
    addBullet(raw, { tick: 570, p: A1, pitch: raw.ticks.pitch[r * P0 + A1] ?? 0, yaw: raw.ticks.yaw[r * P0 + A1] ?? 0, hurt: { victim: B1, healthAfter: 0 } });
    kill(raw, 570, A1, B1);
    return sightCtx(raw, world).ctx;
  }

  it('builds one duel with both sides\' first sight, first shot, damage and the winner', () => {
    const ctx = duelDemo();
    const { duels } = ctx.table(DUELS);
    expect(duels).toHaveLength(1);
    const d = duels[0];
    expect(d?.a.p).toBe(A1);
    expect(d?.a.sightTick).toBe(541);
    expect(d?.b.sightTick).toBe(562);
    expect(d?.a.shotTick).toBe(570);
    expect(d?.a.damageTick).toBe(570);
    expect(d?.a.damage).toBe(100);
    expect(d?.b.shotTick).toBeNull();
    expect(d?.outcome).toBe('kill');
    expect(d?.winner).toBe(A1);
    expect(d?.a.holding).toBe(true);
    expect(d?.distance).toBeGreaterThan(1300);
  });

  it('measures where the head was against the crosshair and the times to shot and damage', () => {
    const ctx = duelDemo();
    const f = ctx.table(FIRSTS).bySlot[A1] ?? [];
    expect(f).toHaveLength(1);
    const x = f[0];
    expect(x?.up).toBeCloseTo(3, 2);
    expect(x?.right).toBeCloseTo(2, 2);
    expect(x?.angle).toBeGreaterThan(3.5);
    expect(x?.angle).toBeLessThan(3.7);
    expect(x?.moved).toBeCloseTo(x?.angle ?? 0, 1);
    expect(x?.damageMs).toBe(Math.round(29 * 15.625));
    expect(x?.shotMs).toBe(x?.damageMs);
    expect(x?.sawFirst).toBe(true);
    expect(x?.outcome).toBe('won');
    const b = ctx.table(FIRSTS).bySlot[B1] ?? [];
    expect(b[0]?.sawFirst).toBe(false);
    expect(b[0]?.outcome).toBe('lost');
  });

  it('merges sightings split by a short gap into one duel and keeps longer gaps apart', () => {
    const world = boxWorld();
    const raw = sightDemo();
    // b1 out 300–400, back in cover 401–440 (0.6 s), out 441–500, in cover again until 700, out 701–800.
    setPos(raw, B1, 300, 400, B_PEEK[0], B_PEEK[1]);
    setPos(raw, B1, 441, 500, B_PEEK[0], B_PEEK[1]);
    setPos(raw, B1, 701, 800, B_PEEK[0], B_PEEK[1]);
    look(raw, world, A1, 200, 1000, B1);
    setPos(raw, B1, 0, 299, B_COVER[0], B_COVER[1]);
    look(raw, world, A1, 300, 1000, B1);
    const ctx = sightCtx(raw, world).ctx;
    const d = ctx.table(DUELS).duels;
    expect(d.map((x) => [x.tick0, x.tick1, x.outcome])).toEqual([[300, 500, 'disengaged'], [701, 800, 'disengaged']]);
  });
});

describe('habits', () => {
  it('counts airborne shots at a target, shots while blind, scoped movement in sight and sniper re-peeks', () => {
    const world = boxWorld();
    const raw = sightDemo();
    setPos(raw, B1, 201, 1000, B_PEEK[0], B_PEEK[1]);
    look(raw, world, A1, 201, 1000, B1);
    look(raw, world, B1, 201, 1000, A1);
    const P0 = raw.players.length;
    const aim = (t: number) => ({ pitch: raw.ticks.pitch[(row(raw, t) - 1) * P0 + A1] ?? 0, yaw: raw.ticks.yaw[(row(raw, t) - 1) * P0 + A1] ?? 0 });
    for (const t of [300, 330, 360, 390]) {
      setFlag(raw, A1, t - 2, t + 2, FLAG.airborne);
      addBullet(raw, { tick: t, p: A1, ...aim(t) });
    }
    setColumn(raw, 'flash', A1, 420, 1000, 3);
    blind(raw, 420, B1, A1, 3, 51);
    addBullet(raw, { tick: 430, p: A1, ...aim(430) });
    // Scoped AWP moving at 150 u/s for 20 ticks while b1 is in sight.
    setWeapon(raw, A1, 600, 700, 'awp');
    setFlag(raw, A1, 600, 700, FLAG.scoped);
    for (let r = row(raw, 640); r <= row(raw, 660); r++) raw.ticks.vx[r * P0 + A1] = 150;
    const { ctx } = sightCtx(raw, world);
    const h = ctx.table(HABITS);
    expect(h.airborne[A1]?.map((s) => s.tick)).toEqual([300, 330, 360, 390]);
    expect(h.flashed[A1]?.map((s) => s.tick)).toEqual([430]);
    expect(h.scopedMoving[A1]).toHaveLength(1);
    expect(h.scopedMoving[A1]?.[0]?.enemy).toBe(B1);
    expect(h.scopedMoving[A1]?.[0]?.tick0).toBe(639);
    expect(h.repeeks[A1]).toHaveLength(0);
  });

  it('finds a re-peek after a missed sniper shot', () => {
    const world = boxWorld();
    const raw = sightDemo();
    setPos(raw, A1, 201, 610, A_PEEK[0], A_PEEK[1]);
    setPos(raw, A1, 680, 1000, A_PEEK[0], A_PEEK[1]);
    setWeapon(raw, A1, 0, Infinity, 'awp');
    look(raw, world, A1, 201, 1000, B1);
    look(raw, world, B1, 201, 1000, A1);
    const P0 = raw.players.length;
    const r = row(raw, 600) - 1;
    addBullet(raw, { tick: 600, p: A1, weapon: 'awp', pitch: raw.ticks.pitch[r * P0 + A1] ?? 0, yaw: raw.ticks.yaw[r * P0 + A1] ?? 0 });
    kill(raw, 700, B1, A1);
    const { ctx } = sightCtx(raw, world);
    const rp = ctx.table(HABITS).repeeks[A1] ?? [];
    expect(rp).toHaveLength(1);
    expect(rp[0]?.hideTick).toBe(611);
    expect(rp[0]?.backTick).toBe(680);
    expect(rp[0]?.died).toBe(true);
  });
});

describe('death context', () => {
  it('labels a death from behind, seen by two enemies, while planting', () => {
    const world = boxWorld();
    const raw = sightDemo();
    setPos(raw, A1, 0, Infinity, A_PEEK[0], A_PEEK[1]);
    setPos(raw, B2, 0, Infinity, 600, 100);
    setView(raw, A1, 0, 1000, 0, 90);
    look(raw, world, B1, 200, 1000, A1);
    look(raw, world, B2, 200, 1000, A1);
    raw.events.bomb.push({ tick: 580, kind: 'begin_plant', p: A1, site: 1, hasKit: false });
    kill(raw, 600, B1, A1);
    const { ctx } = sightCtx(raw, world);
    const rows = ctx.table(DEATH_CONTEXT).rows;
    expect(rows).toHaveLength(1);
    const d = rows[0];
    expect(d?.labels).toEqual(['unseen', 'crossfire', 'objective']);
    expect(d?.behind).toBe(true);
    expect(d?.direction).toBe('behind');
    expect(d?.through).toBeNull();
    expect(d?.seenBy).toEqual([B1, B2]);
  });

  it('labels a death after re-peeking the angle he was just hit from', () => {
    const world = boxWorld();
    const raw = sightDemo();
    setPos(raw, A1, 300, 400, A_PEEK[0], A_PEEK[1]);
    setPos(raw, A1, 501, 1000, A_PEEK[0], A_PEEK[1]);
    look(raw, world, B1, 300, 1000, A1);
    look(raw, world, A1, 300, 1000, B1);
    hurt(raw, 380, B1, A1, 70);
    kill(raw, 540, B1, A1);
    const { ctx } = sightCtx(raw, world);
    const d = ctx.table(DEATH_CONTEXT).rows[0];
    expect(d?.labels).toEqual(['repeek']);
    expect(d?.repeekFrom).toBe(380);
    expect(d?.repeekBack).toBe(501);
  });

  it('labels a death in the open: seen for the whole approach while moving', () => {
    const world = boxWorld();
    const raw = sightDemo();
    for (let t = 400; t <= 600; t++) setPos(raw, A1, t, t, -300, 1200 + (t - 400) * 1.5);
    look(raw, world, B1, 300, 1000, A1);
    setView(raw, A1, 0, 1000, 0, 90);
    look(raw, world, A1, 590, 600, B1);
    kill(raw, 600, B1, A1);
    const { ctx } = sightCtx(raw, world);
    const d = ctx.table(DEATH_CONTEXT).rows[0];
    expect(d?.labels).toEqual(['open']);
    expect(d?.sawKillerTick).toBe(590);
    expect(d?.direction).toBe('front');
  });
});
