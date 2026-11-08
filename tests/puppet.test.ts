import { describe, expect, it } from 'vitest';
import { PLAYER_IDS, type Observe, type PawnObs, type PlayerId, type TrackSample, type Tuning, type ViewSample, type WalkQuery, type YawSample } from '../src/contracts/index';
import {
  EventSchedule,
  PuppetController,
  PuppetTrack,
  ReplayCore,
  RoundModel,
  movementButtons,
  recordedWeapons,
  startYaw,
  stickToward,
  turnToward,
  weaponAt,
  withLook,
} from '../src/core/index';
import { NavWalkQuery } from '../src/sim2d/walk-query';
import { Sim2DHost } from '../src/sim2d/host';
import { ScriptedHost, liveRound, runSession } from './fakes';
import { loadRound, loadTuning } from './round-fixture';
import { nav, roster } from './sim2d-fixtures';

const tuning = loadTuning();
const r = tuning.replay;
const OPEN: WalkQuery = { isWalkableLine: () => true, pathLength: (a, b) => Math.hypot(b.x - a.x, b.y - a.y) };
/** AK run speed for every sample. */
const AK = 215;

function sample(t: number, x: number, y: number, z = 0): TrackSample {
  return { t, tick: Math.round(t * 64), x, y, z, confidence: 'observed' };
}

/** n samples at 10 Hz from (x0, y0) moving (vx, vy) units/s. */
function line(n: number, x0: number, y0: number, vx: number, vy: number): TrackSample[] {
  const out: TrackSample[] = [];
  for (let i = 0; i < n; i++) {
    const t = Math.round(i) / 10;
    out.push(sample(t, x0 + vx * t, y0 + vy * t));
  }
  return out;
}

function track(samples: readonly TrackSample[], yaw: readonly YawSample[] = [], t: Tuning = tuning): PuppetTrack {
  return new PuppetTrack('cart', samples, samples.map(() => AK), yaw, t.replay);
}

function pawn(id: PlayerId, x: number, y: number, yaw = 0): PawnObs {
  return {
    id,
    team: 'T',
    pos: { x, y, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    yaw,
    pitch: 0,
    hp: 100,
    armor: 100,
    alive: true,
    weapon: 'ak47',
    ammo: { clip: 30, reserve: 90 },
    crouching: false,
    onGround: true,
    sees: [],
  };
}

function observe(tick: number, pawns: PawnObs[], human: PlayerId | null): Observe {
  return { tick, t: tick / 64, pawns, events: [], human, round: liveRound(tick) };
}

describe('stick conversion (forward / side in the pawn yaw frame)', () => {
  it('facing north (yaw 90) with the target to the east: side = +1 (strafe right)', () => {
    const s = stickToward(100, 0, 90, 1);
    expect(s.side).toBeCloseTo(1, 6);
    expect(s.forward).toBeCloseTo(0, 6);
  });

  it('facing east: target north is strafe left, target east is forward, target west is back', () => {
    expect(stickToward(0, 50, 0, 1)).toEqual({ forward: 0, side: -1 });
    expect(stickToward(50, 0, 0, 0.5)).toEqual({ forward: 0.5, side: 0 });
    expect(stickToward(-50, 0, 0, 1)).toEqual({ forward: -1, side: 0 });
    expect(stickToward(0, 0, 0, 1)).toEqual({ forward: 0, side: 0 });
  });

  it('withLook keeps the world direction when the look changes (for B3 aiming)', () => {
    const east = { id: 'cart' as const, forward: 1, side: 0, yaw: 0, pitch: 0, buttons: [] };
    expect(withLook(east, 90, -5)).toMatchObject({ forward: 0, side: 1, yaw: 90, pitch: -5 });
    expect(withLook(east, 180, 0)).toMatchObject({ forward: -1, side: 0 });
    const diag = withLook({ ...east, forward: 0.6, side: 0.3, yaw: 37 }, -120, 0);
    const back = withLook(diag, 37, 0);
    expect(back.forward).toBeCloseTo(0.6, 5);
    expect(back.side).toBeCloseTo(0.3, 5);
  });

  it('the controller strafes right when it looks north (recorded yaw) and the track runs east', () => {
    const tr = track(line(30, 0, 0, 200, 0), [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3].map((t) => ({ t, tick: Math.round(t * 64), deg: 90 })));
    const c = new PuppetController(tr, tuning, OPEN);
    c.reset(90);
    const step = c.input(pawn('cart', 0, 0, 90), observe(6, [pawn('cart', 0, 0, 90)], null), 6);
    expect(step.input.yaw).toBe(90);
    expect(step.input.side).toBeGreaterThan(0.99);
    expect(Math.abs(step.input.forward)).toBeLessThan(0.05);
    expect(step.input.pitch).toBe(0);
  });
});

describe('WALK / DUCK', () => {
  it('parses the B2 replay tuning keys', () => {
    expect(r).toMatchObject({
      spikeSpeedFactor: 1.6,
      spikeMaxSec: 0.5,
      teleportWindowSec: 1,
      holdLastPositionSec: 0.25,
      standSpeedThreshold: 20,
      buttonMinSec: 0.25,
      steerFallbackSec: 2,
    });
  });

  it('thresholds: DUCK below crouchSpeedThreshold, WALK below walkSpeedThreshold, nothing standing', () => {
    expect([r.standSpeedThreshold, r.crouchSpeedThreshold, r.walkSpeedThreshold]).toEqual([20, 60, 120]);
    expect(movementButtons(0, 0, r)).toEqual([]);
    expect(movementButtons(19.9, 0, r)).toEqual([]);
    expect(movementButtons(20, 0, r)).toEqual(['DUCK']);
    expect(movementButtons(59.9, 0, r)).toEqual(['DUCK']);
    expect(movementButtons(60, 0, r)).toEqual(['WALK']);
    expect(movementButtons(119.9, 0, r)).toEqual(['WALK']);
    expect(movementButtons(120, 0, r)).toEqual([]);
    expect(movementButtons(250, 0, r)).toEqual([]);
  });

  it('never WALK or DUCK while behind by more than driftNudgeUnits', () => {
    expect(movementButtons(40, r.driftNudgeUnits, r)).toEqual(['DUCK']);
    expect(movementButtons(40, r.driftNudgeUnits + 0.1, r)).toEqual([]);
    expect(movementButtons(100, 30, r)).toEqual([]);

    // A walking track (80 u/s) the pawn trails by 40 units: run, no WALK.
    const tr = track(line(40, 0, 0, 80, 0));
    const c = new PuppetController(tr, tuning, OPEN);
    c.reset(0);
    const k = 128; // t = 2.0 s, track at x = 160
    expect(tr.plannedButton(k)).toBe('WALK');
    expect(c.input(pawn('cart', 120, 0), observe(k, [pawn('cart', 120, 0)], null), k).input.buttons).toEqual([]);
    expect(c.input(pawn('cart', 158, 0), observe(k, [pawn('cart', 158, 0)], null), k).input.buttons).toEqual(['WALK']);
  });

  it('the button plan drops WALK / DUCK stretches shorter than buttonMinSec', () => {
    // 2 s walking at 80 u/s, then 0.1 s at 40 u/s, then walking again: the short DUCK stretch is dropped.
    const s: TrackSample[] = [];
    let x = 0;
    for (let i = 0; i < 50; i++) {
      s.push(sample(i / 10, x, 0));
      x += i === 20 ? 4 : 8;
    }
    const tr = track(s);
    const ticks: (string | null)[] = [];
    for (let k = tr.startTick; k <= tr.endTick; k++) ticks.push(tr.plannedButton(k));
    expect(ticks.includes('DUCK')).toBe(false);
    expect(tr.plannedButton(64)).toBe('WALK');

    // A long slow stretch (1 s at 40 u/s) keeps its DUCK.
    const slow = track(line(30, 0, 0, 40, 0));
    expect(slow.plannedButton(64)).toBe('DUCK');
  });
});

describe('yaw', () => {
  it('turnToward limits the turn per tick and wraps through ±180', () => {
    expect(r.maxTurnRateDegPerTick).toBe(12);
    expect(turnToward(0, 90, 12)).toBe(12);
    expect(turnToward(0, -90, 12)).toBe(-12);
    expect(turnToward(0, 5, 12)).toBe(5);
    expect(turnToward(170, -170, 12)).toBe(-178);
    expect(turnToward(-175, 175, 12)).toBe(175);
    expect(turnToward(0, 180, 12)).toBe(12);
  });

  it('the controller turns toward the heading of motion at most 12° per tick and holds it when standing', () => {
    // East for 1 s, then west for 1 s, then standing.
    const s: TrackSample[] = [];
    for (let i = 0; i <= 40; i++) {
      const t = i / 10;
      const x = i <= 10 ? 200 * t : i <= 20 ? 200 - 200 * (t - 1) : 0;
      s.push(sample(t, x, 0));
    }
    const tr = track(s);
    const c = new PuppetController(tr, tuning, OPEN);
    c.reset(0);
    let prev = 0;
    let maxStep = 0;
    const yaws: number[] = [];
    for (let k = 0; k <= 200; k++) {
      const p = tr.targetAt(k);
      const step = c.input(pawn('cart', p.x, p.y, prev), observe(k, [pawn('cart', p.x, p.y, prev)], null), k);
      maxStep = Math.max(maxStep, Math.abs(((step.input.yaw - prev + 540) % 360) - 180));
      prev = step.input.yaw;
      yaws.push(prev);
    }
    expect(maxStep).toBeLessThanOrEqual(12 + 1e-9);
    expect(yaws[40]).toBe(0); // running east
    expect(Math.abs(yaws[110] as number)).toBe(180); // running west, turn completed
    expect(yaws[200]).toBe(yaws[150]); // standing since 2 s: yaw held
  });
});

describe('PuppetTrack preprocessing', () => {
  it('repairs a 2-sample spike by interpolating between its neighbours and keeps the raw track', () => {
    const s = line(30, 0, 0, 100, 0);
    const spiked = s.map((q, i) => (i === 10 || i === 11 ? { ...q, y: 150 } : q));
    const tr = track(spiked);
    const sum = tr.summary();
    expect(sum.spikes).toHaveLength(1);
    expect(sum.discontinuities).toHaveLength(0);
    expect(sum.spikes[0]).toMatchObject({ kind: 'spike', i0: 9, i1: 12, replaced: 2 });
    expect(tr.ref[10]).toEqual({ x: 100, y: 0, z: 0 });
    expect(tr.ref[11]?.x).toBeCloseTo(110, 9);
    expect(tr.ref[11]?.y).toBe(0);
    expect(tr.raw[10]?.y).toBe(150);
    expect(tr.rawAt(1.0).y).toBe(150);
    expect(tr.positionAt(1.05).y).toBe(0);
    // A teleport window follows the spike (snaps are allowed "after a spike").
    expect(tr.isTeleportPoint(tr.events[0]?.tick1 as number)).toBe(true);
  });

  it('classifies a jump that does not come back as a discontinuity / teleport point', () => {
    // 100 u/s, then a 150-unit jump forward between 1.0 and 1.1 s, then 100 u/s again.
    const s = line(40, 0, 0, 100, 0).map((q, i) => (i > 10 ? { ...q, x: q.x + 150 } : q));
    const tr = track(s);
    const sum = tr.summary();
    expect(sum.spikes).toHaveLength(0);
    expect(sum.discontinuities).toHaveLength(1);
    const e = sum.discontinuities[0];
    expect(e).toMatchObject({ kind: 'discontinuity', i0: 10, i1: 11, t0: 1, t1: 1.1, tick0: 64, tick1: 70 });
    expect(e?.dist).toBeCloseTo(160, 9);
    expect(tr.ref).toEqual(tr.raw.map((q) => ({ x: q.x, y: q.y, z: q.z })));
    const p = sum.teleportPoints[0];
    expect(p).toEqual({ event: 0, kind: 'discontinuity', openTick: 64, closeTick: 70 + Math.round(r.teleportWindowSec * 64) });
    expect(tr.isTeleportPoint(63)).toBe(false);
    expect(tr.isTeleportPoint(64)).toBe(true);
    expect(tr.isTeleportPoint(134)).toBe(true);
    expect(tr.isTeleportPoint(135)).toBe(false);
  });

  it('a long infeasible stretch is one discontinuity whose window opens at its last over-speed step', () => {
    const s = line(40, 0, 0, 100, 0).map((q, i) => (i > 10 ? { ...q, x: q.x + 50 * Math.min(i - 10, 5) } : q));
    const tr = track(s);
    expect(tr.summary().discontinuities).toHaveLength(1);
    expect(tr.events[0]).toMatchObject({ i0: 10, i1: 15 });
    expect(tr.teleportPoints[0]?.openTick).toBe(tr.raw[14]?.tick);
  });

  it('uses the recorded weapon for the speed limit', () => {
    const round = loadRound();
    const model = new RoundModel(round);
    const schedule = new EventSchedule(round);
    const w = recordedWeapons(model, schedule, 'sp4rtan');
    expect(weaponAt(w, 0)).toBe('deagle');
    expect(weaponAt(w, 1254)).toBe('ak47');
    expect(weaponAt(recordedWeapons(model, schedule, 'donk'), 100)).toBe('awp');
    const barely = PuppetTrack.fromModel(model, schedule, tuning, 'barely');
    const level = barely.events.find((e) => e.t0 === 44.7);
    expect(level).toMatchObject({ kind: 'discontinuity', t1: 44.8, limit: 1.6 * 215 });
    expect(level?.dz).toBe(154);
  });

  it('interpolates recorded yaw across ±180 and reports it unknown in gaps', () => {
    const yaw: YawSample[] = [
      { t: 1, tick: 64, deg: 170 },
      { t: 1.05, tick: 67, deg: -170 },
      { t: 2, tick: 128, deg: 0 },
    ];
    const tr = track(line(30, 0, 0, 0, 0), yaw);
    expect(tr.recordedYawAt(1)).toBe(170);
    expect(tr.recordedYawAt(1.025)).toBe(180);
    expect(tr.recordedYawAt(1.5)).toBeNull();
    expect(tr.recordedYawAt(2)).toBe(0);
    expect(tr.recordedYawAt(0.5)).toBeNull();
  });
});

describe('V2: recorded views (yaw and pitch fitted to the video)', () => {
  const v = (t: number, yaw: number, pitch: number | null, source: 'video' | 'radar' = 'video'): ViewSample => ({ t, tick: Math.round(t * 64), yaw, pitch, source, confidence: 'observed' });

  it('interpolates the fitted view (yaw across ±180, pitch linearly) and falls back to the radar yaw', () => {
    const views = [v(1, 170, -60), v(1.1, -170, -80), v(1.2, -160, null, 'radar'), v(1.3, -150, 10), v(1.5, -140, 20)];
    const yaw: YawSample[] = [
      { t: 1.2, tick: 77, deg: -161 },
      { t: 1.25, tick: 80, deg: -159 },
    ];
    const tr = new PuppetTrack('cart', line(30, 0, 0, 0, 0), line(30, 0, 0, 0, 0).map(() => AK), yaw, tuning.replay, views);
    expect(tr.recordedViewAt(1)).toEqual({ yaw: 170, pitch: -60 });
    expect(tr.recordedViewAt(1.05)).toEqual({ yaw: 180, pitch: -70 });
    // A radar sample (the fit failed) and its neighbours: the radar yaw, no pitch.
    expect(tr.recordedViewAt(1.2)).toEqual({ yaw: -161, pitch: null });
    expect(tr.recordedViewAt(1.225)).toEqual({ yaw: -160, pitch: null });
    // A gap longer than RECORDED_VIEW_MAX_GAP_SEC, no radar yaw: unknown.
    expect(tr.recordedViewAt(1.4)).toBeNull();
    expect(tr.recordedViewAt(0.5)).toBeNull();
  });

  it('the controller follows the fitted pitch at most 12° per tick, then levels off; scoped rifles hold their angle', () => {
    const s = line(40, 0, 0, 100, 0); // walking east at 100 u/s
    const views = [v(1, 90, -70), v(1.1, 90, -70), v(1.2, 90, -70)];
    const tr = new PuppetTrack('donk', s, s.map(() => 200), [], tuning.replay, views, s.map(() => true));
    const c = new PuppetController(tr, tuning, OPEN);
    c.reset(0);
    let yaw = 0;
    let pitch = 0;
    const out: { yaw: number; pitch: number }[] = [];
    for (let k = 0; k <= 160; k++) {
      const p = tr.targetAt(k);
      const pw = { ...pawn('donk', p.x, p.y, yaw), pitch };
      const step = c.input(pw, observe(k, [pw], null), k);
      expect(Math.abs(step.input.pitch - pitch)).toBeLessThanOrEqual(12 + 1e-9);
      yaw = step.input.yaw;
      pitch = step.input.pitch;
      out.push({ yaw, pitch });
    }
    expect(out[40]).toEqual({ yaw: 0, pitch: 0 }); // before the views: a scoped rifle walking holds its angle (0)
    expect(out[76]).toEqual({ yaw: 90, pitch: -70 }); // 1.19 s: the fitted view, reached within 8 ticks of 1 s
    expect(out[100]?.pitch).toBe(0); // 1.56 s: levelled off again
    expect(out[100]?.yaw).toBe(90); // and the scoped rifle keeps the last angle
  });
});

describe('snaps', () => {
  // A 150-unit jump forward at 1.0 → 1.1 s; the pawn is still where the track was before it.
  const s = line(40, 0, 0, 100, 0).map((q, i) => (i > 10 ? { ...q, x: q.x + 150 } : q));
  const k = 72; // inside the window; track at x = 262.5
  const stuck = (): PawnObs => pawn('cart', 100, 0);

  it('snaps an unseen pawn that is too far behind at a teleport point: teleport + info log, yaw kept', () => {
    const c = new PuppetController(track(s), tuning, OPEN);
    c.reset(30);
    const out = c.input(stuck(), observe(k, [stuck(), pawn('sp4rtan', 0, 500)], 'sp4rtan'), k);
    expect(out.actions[0]).toMatchObject({ type: 'teleport', id: 'cart', yaw: 30 });
    expect(out.actions[1]).toMatchObject({ type: 'log', level: 'info' });
    expect(out.actions[1]?.type === 'log' && out.actions[1].text).toMatch(/^puppet cart: snap to track at tick 72, 163 u behind/);
    expect(c.state.snaps).toBe(1);
    // One snap per teleport point.
    expect(c.input(stuck(), observe(k + 1, [stuck()], null), k + 1).actions).toEqual([]);
  });

  it('never teleports a pawn the human sees', () => {
    const c = new PuppetController(track(s), tuning, OPEN);
    c.reset(0);
    const watcher: PawnObs = { ...pawn('sp4rtan', 0, 500), sees: ['cart'] };
    for (let tick = 60; tick < 160; tick++) {
      const out = c.input(stuck(), observe(tick, [stuck(), watcher], 'sp4rtan'), tick);
      expect(out.actions).toEqual([]);
    }
    expect(c.state.snaps).toBe(0);
    // With no human at all, the same situation snaps.
    expect(c.input(stuck(), observe(k, [stuck()], null), k).actions[0]?.type).toBe('teleport');
  });

  it('does not snap outside teleport windows, however far behind', () => {
    const c = new PuppetController(track(line(60, 0, 0, 100, 0)), tuning, OPEN);
    c.reset(0);
    expect(c.input(stuck(), observe(300, [stuck()], null), 300).actions).toEqual([]);
    expect(c.state.behind).toBeGreaterThan(300);
  });
});

describe('end of track', () => {
  it('holds the last position for holdLastPositionSec, then gives no move input', () => {
    const tr = track(line(11, 0, 0, 100, 0)); // ends at t = 1.0 (tick 64), x = 100
    const c = new PuppetController(tr, tuning, OPEN);
    c.reset(0);
    const hold = Math.round(r.holdLastPositionSec * 64);
    const during = c.input(pawn('cart', 90, 0), observe(64 + hold, [pawn('cart', 90, 0)], null), 64 + hold).input;
    expect(during.forward).toBeGreaterThan(0);
    const after = c.input(pawn('cart', 90, 0), observe(65 + hold, [pawn('cart', 90, 0)], null), 65 + hold).input;
    expect(after).toEqual({ id: 'cart', forward: 0, side: 0, yaw: 0, pitch: 0, buttons: [] });
  });
});

describe('ReplayCore with puppets', () => {
  const round = loadRound();
  const model = new RoundModel(round);
  const schedule = new EventSchedule(round);
  const START = new Map([[0, [{ type: 'start' as const }]]]);

  it('holds every puppet still at its start yaw on the setup tick, then drives them', () => {
    // ScriptedHost is no world (everyone sees everyone off their tracks, sp4rtan human): B2 alone, without B4's triggers.
    const log = runSession(10, new ScriptedHost(), new ReplayCore(model, schedule, tuning, 1, OPEN, { divergence: false }), START);
    const first = log.at(0)?.act.inputs ?? [];
    expect(first.map((i) => i.id)).toEqual(PLAYER_IDS.filter((id) => id !== 'sp4rtan'));
    for (const i of first) expect(i).toEqual({ id: i.id, forward: 0, side: 0, yaw: startYaw(model, i.id).yaw, pitch: 0, buttons: [] });
    // ScriptedHost ignores the setup, so its pawns are far off their tracks and steer back (everyone is seen: no snaps).
    const later = log.at(5)?.act;
    expect(later?.inputs.some((i) => i.forward !== 0 || i.side !== 0)).toBe(true);
    expect(later?.actions).toEqual([]);
  });

  it('keeps every start yaw through the setup tick (Sim2DHost applies input yaw after the teleport)', () => {
    const cores: [string, ReplayCore][] = [
      ['puppets off', new ReplayCore(model, schedule, tuning, 1)],
      ['puppets on', new ReplayCore(model, schedule, tuning, 1, new NavWalkQuery(nav))],
    ];
    for (const human of ['cart', null] as const) {
      for (const [label, core] of cores) {
        const host = new Sim2DHost(nav, tuning, roster);
        host.setHuman(human);
        core.control({ type: 'start' });
        const act = core.step(host.observe());
        host.apply(act);
        host.tick();
        const o = host.observe();
        expect(o.tick).toBe(1);
        for (const a of act.actions) {
          if (a.type !== 'teleport') continue;
          expect(o.pawns.find((q) => q.id === a.id)?.yaw, `${label}, human ${String(human)}: ${a.id}`).toBe(a.yaw);
        }
        expect(o.pawns.find((q) => q.id === 'eradicate')?.yaw).toBe(167.2);
      }
    }
  });

  it('snapshot / restore carries the puppet state', () => {
    const host = new ScriptedHost();
    const core = new ReplayCore(model, schedule, tuning, 1, OPEN);
    core.control({ type: 'start' });
    for (let i = 0; i < 20; i++) host.apply(core.step(host.observe()));
    const snap = core.snapshot();
    const hostSnap = host.snapshot();
    const tail = (c: ReplayCore): string[] => {
      const out: string[] = [];
      for (let i = 0; i < 10; i++) {
        const a = c.step(host.observe());
        out.push(JSON.stringify(a));
        host.apply(a);
      }
      return out;
    };
    const expected = tail(core);
    const core2 = new ReplayCore(model, schedule, tuning, 1, OPEN);
    core2.restore(snap);
    host.restore(hostSnap);
    expect(tail(core2)).toEqual(expected);
    expect(core2.puppet('cart')?.state).toEqual(core.puppet('cart')?.state);
  });

  it('without a WalkQuery the puppets are off (B1 behaviour)', () => {
    const core = new ReplayCore(model, schedule, tuning, 1);
    expect(core.puppet('cart')).toBeNull();
    expect(core.snapCount).toBe(0);
  });
});

describe('G3: JUMP from a take-off sample (TrackSample.jump)', () => {
  // East at 200 u/s; the sample at 1.0 s (x 200) takes off for the one at 1.1 s (x 220, 20 u up: a box top).
  const jumpTrack = (kind: 'plain' | 'crouch'): PuppetTrack => {
    const s = line(30, 0, 0, 200, 0).map((q) => (q.t >= 1.1 - 1e-9 ? { ...q, z: 20 } : q));
    s[10] = { ...(s[10] as TrackSample), jump: kind };
    return track(s);
  };
  const running = (x: number, vx = 200): PawnObs => ({ ...pawn('cart', x, 0, 0), vel: { x: vx, y: 0, z: 0 } });

  it('the track lists its take-offs; none on a track without jump flags', () => {
    expect(jumpTrack('plain').takeoffs).toEqual([10]);
    expect(track(line(30, 0, 0, 200, 0)).takeoffs).toEqual([]);
  });

  it('presses JUMP once, near the take-off spot, in its window, running toward the landing; then steers at the landing', () => {
    const c = new PuppetController(jumpTrack('plain'), tuning, OPEN);
    // Too far from the take-off spot (x 200): no jump yet.
    expect(c.input(running(150), observe(60, [running(150)], null), 60).input.buttons).not.toContain('JUMP');
    // Within jumpReachUnits, on the ground, lined up: JUMP.
    const at = 200 - r.jumpReachUnits + 2;
    const first = c.input(running(at), observe(62, [running(at)], null), 62).input;
    expect(first.buttons).toContain('JUMP');
    expect(c.state.usedJumps).toEqual([10]);
    // In the air: no second press (fresh press only once), steering at the landing sample (straight east here).
    const air = { ...running(at + 6), onGround: false, pos: { x: at + 6, y: 0, z: 30 } };
    const next = c.input(air, observe(63, [air], null), 63).input;
    expect(next.buttons).not.toContain('JUMP');
    expect(next.forward).toBeGreaterThan(0);
    // The take-off is used: back on the ground near it later, no jump.
    const again = c.input(running(at), observe(70, [running(at)], null), 70).input;
    expect(again.buttons).not.toContain('JUMP');
  });

  it('not lined up (running away from the landing): eases to the take-off spot and jumps from nearly standing', () => {
    const c = new PuppetController(jumpTrack('plain'), tuning, OPEN);
    const away = running(190, -200);
    expect(c.input(away, observe(62, [away], null), 62).input.buttons).not.toContain('JUMP');
    const still = { ...pawn('cart', 199, 0, 0), vel: { x: 10, y: 0, z: 0 } };
    expect(c.input(still, observe(63, [still], null), 63).input.buttons).toContain('JUMP');
  });

  it('a crouch jump holds DUCK in the air', () => {
    const c = new PuppetController(jumpTrack('crouch'), tuning, OPEN);
    const at = 195;
    expect(c.input(running(at), observe(62, [running(at)], null), 62).input.buttons).toEqual(expect.arrayContaining(['JUMP', 'DUCK']));
    const air = { ...running(at + 6), onGround: false, pos: { x: at + 6, y: 0, z: 30 } };
    expect(c.input(air, observe(63, [air], null), 63).input.buttons).toContain('DUCK');
  });

  it('outside the window (the track is long past the take-off), no jump', () => {
    const c = new PuppetController(jumpTrack('plain'), tuning, OPEN);
    const k = 64 * 2 + Math.round(r.jumpWindowSec * 64) + 4;
    expect(c.input(running(198), observe(k, [running(198)], null), k).input.buttons).not.toContain('JUMP');
  });
});
