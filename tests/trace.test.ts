import { describe, expect, it } from 'vitest';
import { DISPLAY_IDS, PLAYER_IDS, stableStringify, toReplayTrace, type ObsEvent } from '../src/contracts/index';
import { EchoCore, ScriptedHost, runSession } from './fakes';

describe('toReplayTrace', () => {
  it('has ten tracks of 10 Hz samples for a 100-tick log', () => {
    const trace = toReplayTrace(runSession(100));
    const ids = Object.keys(trace.tracks).sort();
    expect(ids).toEqual(PLAYER_IDS.map((id) => DISPLAY_IDS[id]).sort());
    expect(ids).toContain('Sp4rtaN');
    expect(ids).toContain('barely');
    // ticks 0, 6, 13, 19, 26, 32, 38, 45, 51, 58, 64, 70, 77, 83, 90, 96 -> 16 samples
    for (const id of ids) {
      const tr = trace.tracks[id] ?? [];
      expect(tr).toHaveLength(16);
      expect(tr.map((s) => s[0])).toEqual([0, 6, 13, 19, 26, 32, 38, 45, 51, 58, 64, 70, 77, 83, 90, 96].map((k) => Math.round((k / 64) * 1000) / 1000));
      for (const s of tr) {
        expect(s).toHaveLength(5);
        expect(s.slice(1, 4).every(Number.isInteger)).toBe(true);
        expect(s[4]).toBe(0);
      }
    }
    expect(trace.players).toHaveLength(10);
    expect(trace.kills).toEqual([]);
    expect(trace.events).toHaveLength(100); // one Core log per tick
    expect(stableStringify(toReplayTrace(runSession(100)))).toBe(stableStringify(trace));
  });

  it('turns deaths into kills and ends the victim track', () => {
    const script = new Map<number, readonly ObsEvent[]>([
      [30, [{ type: 'death', victim: 'incredibad', attacker: 'snarlbot', weapon: 'ak47', headshot: true }]],
      [90, [{ type: 'round_end', winner: 'T', reason: 'elimination' }]],
    ]);
    const trace = toReplayTrace(runSession(100, new ScriptedHost(script), new EchoCore()));
    expect(trace.kills).toHaveLength(1);
    expect(trace.kills[0]).toMatchObject({ t: 0.469, killer: 'snarlbot', victim: 'Incredibad', weapon: 'ak47', hs: true, assist: null });
    // samples up to tick 26 alive, tick 32 is the first dead sample (kept), then stop.
    expect(trace.tracks['Incredibad']).toHaveLength(6);
    expect(trace.tracks['snarlbot']).toHaveLength(16);
    expect(trace.players.find((p) => p.id === 'Incredibad')).toEqual({ id: 'Incredibad', team: 'CT', death: 0.469 });
    expect(trace.events.filter((e) => e.kind !== 'info').map((e) => e.kind)).toEqual(['kill', 'state']);
  });
});
