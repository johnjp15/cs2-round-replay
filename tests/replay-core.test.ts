import { describe, expect, it } from 'vitest';
import { PLAYER_IDS, SessionLog, replay, type Control, type ObsEvent } from '../src/contracts/index';
import { EventSchedule, ReplayCore, RoundModel, startActions } from '../src/core/index';
import { ScriptedHost, runSession } from './fakes';
import { loadRound, loadTuning } from './round-fixture';

const round = loadRound();
const tuning = loadTuning();
const model = new RoundModel(round);
const schedule = new EventSchedule(round);
const SEED = 12;

const newCore = (): ReplayCore => new ReplayCore(model, schedule, tuning, SEED);
const START = new Map<number, readonly Control[]>([[0, [{ type: 'start' }]]]);
const DEATH = new Map<number, readonly ObsEvent[]>([[21, [{ type: 'death', victim: 'incredibad', attacker: 'snarlbot', weapon: 'ak47', headshot: false }]]]);

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
    expect(first?.act.actions).toEqual(startActions(model, tuning));
    expect(log.at(1)?.act.actions).toEqual([]);

    // ScriptedHost's human is sp4rtan: nine inputs, all neutral.
    const inputs = log.at(5)?.act.inputs ?? [];
    expect(inputs.map((i) => i.id)).toEqual(PLAYER_IDS.filter((id) => id !== 'sp4rtan'));
    const obs = log.at(5)?.observe;
    for (const input of inputs) {
      const pawn = obs?.pawns.find((p) => p.id === input.id);
      expect(input).toEqual({ id: input.id, forward: 0, side: 0, yaw: pawn?.yaw, pitch: pawn?.pitch, buttons: [] });
    }
  });

  it('reports REPLAY / DEAD status for all ten pawns with sinceTick', () => {
    const log = run(30);
    const before = log.at(20)?.act.status ?? [];
    expect(before.map((s) => s.id)).toEqual([...PLAYER_IDS]);
    expect(before.every((s) => s.mode === 'REPLAY' && s.trigger === null && s.sinceTick === 0)).toBe(true);
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
    expect(log.at(40)?.act.actions).toEqual(startActions(model, tuning));
    expect(log.at(41)?.act.actions).toEqual([]);
    // ScriptedHost doesn't revive incredibad, so he is DEAD again from the restart tick.
    expect(log.at(45)?.act.status.find((s) => s.id === 'incredibad')).toMatchObject({ mode: 'DEAD', sinceTick: 40 });
    expect(log.at(45)?.act.status.find((s) => s.id === 'barely')).toMatchObject({ mode: 'REPLAY', sinceTick: 40 });
  });

  it('handles pause and speed, and refuses seek / checkpoint / rewind until B5', () => {
    const core = newCore();
    core.control({ type: 'pause', paused: true });
    core.control({ type: 'speed', x: 0.25 });
    expect([core.paused, core.speed]).toEqual([true, 0.25]);
    core.control({ type: 'pause', paused: false });
    expect(core.paused).toBe(false);
    expect(() => core.control({ type: 'speed', x: 0 })).toThrow(RangeError);
    expect(() => core.control({ type: 'seek', t: 12.5 })).toThrow(/not implemented until B5/);
    expect(() => core.control({ type: 'checkpoint', id: 'cp' })).toThrow(/not implemented until B5/);
    expect(() => core.control({ type: 'rewind', id: 'cp' })).toThrow(/not implemented until B5/);
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
