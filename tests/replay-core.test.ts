import { describe, expect, it } from 'vitest';
import { PLAYER_IDS, SessionLog, replay, stableStringify, type Action, type Control, type ObsEvent, type PlayerId } from '../src/contracts/index';
import { EventSchedule, ReplayCore, RoundModel, startActions } from '../src/core/index';
import { ScriptedHost, runSession } from './fakes';
import { loadRound, loadTuning } from './round-fixture';

const round = loadRound();
const tuning = loadTuning();
const model = new RoundModel(round);
const schedule = new EventSchedule(round);
const SEED = 12;

// ScriptedHost is no world (every pawn sees every other, at fixed positions off their tracks, and sp4rtan is the
// human), so B4's triggers would switch everyone LIVE: these B1 tests run the Core without divergence.
const newCore = (): ReplayCore => new ReplayCore(model, schedule, tuning, SEED, null, { divergence: false });
const START = new Map<number, readonly Control[]>([[0, [{ type: 'start' }]]]);
const DEATH = new Map<number, readonly ObsEvent[]>([[21, [{ type: 'death', victim: 'incredibad', attacker: 'snarlbot', weapon: 'ak47', headshot: false }]]]);

/** The setup Act's actions: startActions, then (B3) block_damage for the enemy pairs and self pairs of the puppets. */
function setup(human: PlayerId | null): Action[] {
  const blocks: Action[] = [];
  for (const a of PLAYER_IDS) {
    for (const b of PLAYER_IDS) {
      if (a === human || b === human || (a !== b && model.player(a).team === model.player(b).team)) continue;
      blocks.push({ type: 'block_damage', attacker: a, victim: b });
    }
  }
  return [...startActions(model, tuning), ...blocks];
}

function run(ticks: number, controls = START): SessionLog {
  return runSession(ticks, new ScriptedHost(DEATH), newCore(), controls);
}

describe('ReplayCore', () => {
  it('gives the same 100-tick log digest on every run, and replays identically', () => {
    const a = run(100);
    const b = run(100);
    expect(a.length).toBe(100);
    expect(a.digest()).toMatch(/^[0-9a-f]{8}$/);
    expect(b.digest()).toBe(a.digest());
    expect(b.toText()).toBe(a.toText());
    expect(replay(SessionLog.fromText(a.toText()), newCore())).toMatchObject({ identical: true, mismatchCount: 0, ticks: 100 });
  });

  it('sets the round up on the first tick after start, then holds the puppets still', () => {
    const log = run(30);
    const first = log.at(0);
    expect(first?.act.actions).toEqual(setup('sp4rtan'));
    expect(log.at(1)?.act.actions).toEqual([]);

    // ScriptedHost's human is sp4rtan: nine inputs, all neutral, except that snarlbot (F1) already pre-aims the angle
    // incredibad appears from (his kill at 0.50 s): no stick or buttons, the view eased from where it was.
    const inputs = log.at(5)?.act.inputs ?? [];
    expect(inputs.map((i) => i.id)).toEqual(PLAYER_IDS.filter((id) => id !== 'sp4rtan'));
    const obs = log.at(5)?.observe;
    for (const input of inputs) {
      const pawn = obs?.pawns.find((p) => p.id === input.id);
      if (input.id === 'snarlbot') {
        expect(input).toMatchObject({ forward: 0, side: 0, buttons: [] });
        expect(Math.abs(((((input.yaw - (pawn?.yaw ?? NaN)) % 360) + 540) % 360) - 180)).toBeLessThanOrEqual(tuning.replay.aimTurnRateDegPerTick);
        continue;
      }
      expect(input).toEqual({ id: input.id, forward: 0, side: 0, yaw: pawn?.yaw, pitch: pawn?.pitch, buttons: [] });
    }
  });

  it('reports REPLAY / DEAD / HUMAN status for all ten pawns with sinceTick', () => {
    const log = run(30);
    const before = log.at(20)?.act.status ?? [];
    expect(before.map((s) => s.id)).toEqual([...PLAYER_IDS]);
    // B4: the human's living pawn is HUMAN (ScriptedHost's human is sp4rtan).
    expect(before.filter((s) => s.id !== 'sp4rtan').every((s) => s.mode === 'REPLAY' && s.trigger === null && s.sinceTick === 0)).toBe(true);
    expect(before.find((s) => s.id === 'sp4rtan')).toEqual({ id: 'sp4rtan', mode: 'HUMAN', trigger: null, sinceTick: 0 });
    const after = log.at(25)?.act;
    expect(after?.status.find((s) => s.id === 'incredibad')).toEqual({ id: 'incredibad', mode: 'DEAD', trigger: null, sinceTick: 21 });
    expect(after?.inputs.some((i) => i.id === 'incredibad')).toBe(false);
    expect(after?.inputs).toHaveLength(8);
  });

  it('emits no setup before start, and sets up again after restart', () => {
    const none = run(5, new Map());
    expect(none.at(0)?.act.actions).toEqual([]);

    const log = run(60, new Map<number, readonly Control[]>([[0, [{ type: 'start' }]], [40, [{ type: 'restart' }]]]));
    expect(log.at(39)?.act.actions).toEqual([]);
    expect(log.at(40)?.act.actions).toEqual(setup('sp4rtan'));
    expect(log.at(41)?.act.actions).toEqual([]);
    // ScriptedHost doesn't revive incredibad, so he is DEAD again from the restart tick.
    expect(log.at(45)?.act.status.find((s) => s.id === 'incredibad')).toMatchObject({ mode: 'DEAD', sinceTick: 40 });
    expect(log.at(45)?.act.status.find((s) => s.id === 'barely')).toMatchObject({ mode: 'REPLAY', sinceTick: 40 });
  });

  it('handles pause and speed, and checks seek / checkpoint / rewind (B5)', () => {
    const core = newCore();
    core.control({ type: 'pause', paused: true });
    core.control({ type: 'speed', x: 0.25 });
    expect([core.paused, core.speed]).toEqual([true, 0.25]);
    core.control({ type: 'pause', paused: false });
    expect(core.paused).toBe(false);
    expect(() => core.control({ type: 'speed', x: 0 })).toThrow(RangeError);
    // Checkpoints and seeks are the driver's: the Core only checks them.
    const before = stableStringify(core.snapshot());
    core.control({ type: 'seek', t: 12.5 });
    core.control({ type: 'checkpoint', id: 'cp' });
    expect(stableStringify(core.snapshot())).toBe(before);
    expect(() => core.control({ type: 'seek', t: -1 })).toThrow(RangeError);
    expect(() => core.control({ type: 'seek', t: Number.NaN })).toThrow(RangeError);
    expect(() => core.control({ type: 'checkpoint', id: '' })).toThrow(/checkpoint id/);
    expect(() => core.control({ type: 'rewind', id: '' })).toThrow(/checkpoint id/);
    // rewind arms a resync of the engine on the next step (the driver restored the Core first).
    core.control({ type: 'rewind', id: 'cp' });
    expect(stableStringify(core.snapshot())).not.toBe(before);
  });

  it('snapshot / restore continues exactly where it left off', () => {
    const host = new ScriptedHost(DEATH);
    const core = newCore();
    core.control({ type: 'start' });
    for (let i = 0; i < 25; i++) host.apply(core.step(host.observe()));
    const snap = core.snapshot();
    const hostSnap = host.snapshot();
    const tail = (c: ReplayCore, h: ScriptedHost): string[] => {
      const out: string[] = [];
      for (let i = 0; i < 10; i++) {
        const a = c.step(h.observe());
        out.push(JSON.stringify(a));
        h.apply(a);
      }
      return out;
    };
    const expected = tail(core, host);

    const core2 = newCore();
    core2.restore(snap);
    host.restore(hostSnap);
    expect(tail(core2, host)).toEqual(expected);
    expect(core2.snapshot()).toEqual(core.snapshot());
    expect(() => new ReplayCore(model, schedule, tuning, SEED + 1).restore(snap)).toThrow(/seed/);
  });
});
