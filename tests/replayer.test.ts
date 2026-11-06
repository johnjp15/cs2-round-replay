import { describe, expect, it } from 'vitest';
import { MAX_REPLAY_DIFFS, SessionLog, replay, type ObsEvent } from '../src/contracts/index';
import { EchoCore, MutatedCore, ScriptedHost, runSession } from './fakes';

describe('replay', () => {
  it('a 100-tick EchoCore session replays identically', () => {
    const log = runSession(100);
    const r = replay(log, new EchoCore());
    expect(r).toEqual({ identical: true, firstMismatchTick: null, diffs: [], mismatchCount: 0, ticks: 100 });
  });

  it('replays identically after a text round trip, with events and controls', () => {
    const script = new Map<number, readonly ObsEvent[]>([
      [20, [{ type: 'shot', shooter: 'snarlbot', weapon: 'ak47' }]],
      [21, [{ type: 'death', victim: 'incredibad', attacker: 'snarlbot', weapon: 'ak47', headshot: false }]],
    ]);
    const controls = new Map([[30, [{ type: 'pause', paused: true } as const]], [40, [{ type: 'pause', paused: false } as const]]]);
    const log = runSession(100, new ScriptedHost(script), new EchoCore(), controls);
    const r = replay(SessionLog.fromText(log.toText()), new EchoCore());
    expect(r.identical).toBe(true);
  });

  it('reports the first mismatching tick of a mutated core', () => {
    const log = runSession(100);
    const r = replay(log, new MutatedCore(57));
    expect(r.identical).toBe(false);
    expect(r.firstMismatchTick).toBe(57);
    expect(r.mismatchCount).toBe(1);
    expect(r.diffs).toHaveLength(1);
    expect(r.diffs[0]?.tick).toBe(57);
    expect(r.diffs[0]?.actual.actions).toEqual([{ type: 'log', level: 'info', text: 'mutated' }]);
    expect(r.diffs[0]?.expected.actions[0]).toMatchObject({ text: 'tick 57 step 58 alive 10' });
  });

  it('caps diffs at 20 but counts every mismatch', () => {
    const log = runSession(100);
    const core = new EchoCore();
    core.steps = 1; // off by one from the start: every line differs
    const r = replay(log, core);
    expect(r.firstMismatchTick).toBe(0);
    expect(r.mismatchCount).toBe(100);
    expect(r.diffs).toHaveLength(MAX_REPLAY_DIFFS);
    expect(r.diffs.map((d) => d.tick)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('core snapshot/restore resumes an identical stream', () => {
    const log = runSession(100);
    const a = new EchoCore();
    for (let i = 0; i < 50; i++) {
      const e = log.at(i);
      if (e) a.step(e.observe);
    }
    const b = new EchoCore();
    b.restore(JSON.parse(JSON.stringify(a.snapshot())));
    const e = log.at(50);
    expect(e && b.step(e.observe)).toEqual(e?.act);
  });
});
