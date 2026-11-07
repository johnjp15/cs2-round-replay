import { describe, expect, it } from 'vitest';
import { JsonError, SessionLog, parseJsonLine, stableStringify } from '../src/contracts/index';
import { EchoCore, ScriptedHost, runSession } from './fakes';

/** Golden digest of runSession(100). If it changes, every recorded fixture changes too. */
const GOLDEN_DIGEST_100 = 'ffbcd3ec'; // G3: PawnObs gained `onGround` (C3: Observe gained `round`)

describe('SessionLog', () => {
  it('stores one canonical line per tick', () => {
    const log = runSession(100);
    expect(log.length).toBe(100);
    const lines = log.lines();
    expect(lines).toHaveLength(100);
    for (const line of lines) {
      expect(line).not.toContain('\n');
      expect(stableStringify(parseJsonLine(line))).toBe(line);
      expect(line.startsWith('{"act":')).toBe(true);
    }
    expect(log.toText().endsWith('\n')).toBe(true);
    expect(log.toText().split('\n')).toHaveLength(101);
    expect(new SessionLog().toText()).toBe('');
  });

  it('get(tick) returns the parsed entry', () => {
    const log = runSession(100);
    const e = log.get(57);
    expect(e?.observe.tick).toBe(57);
    expect(e?.observe.pawns).toHaveLength(10);
    expect(e?.act.actions[0]).toEqual({ type: 'log', level: 'info', text: 'tick 57 step 58 alive 10' });
    expect(log.get(100)).toBeNull();
    expect(log.at(0)?.observe.tick).toBe(0);
    expect(log.at(-1)).toBeNull();
  });

  it('fromText(toText()) round-trips, also with CRLF and blank lines', () => {
    const log = runSession(100);
    const back = SessionLog.fromText(log.toText());
    expect(back.lines()).toEqual(log.lines());
    expect(back.digest()).toBe(log.digest());
    const crlf = SessionLog.fromText('\n' + log.toText().replace(/\n/g, '\r\n') + '\n\n');
    expect(crlf.digest()).toBe(log.digest());
  });

  it('fromText rejects malformed lines', () => {
    expect(() => SessionLog.fromText('{"act":{}}\n')).toThrow(/line 1: missing observe/);
    expect(() => SessionLog.fromText('{"act":{},"observe":{"tick":1.5}}')).toThrow(JsonError);
    expect(() => SessionLog.fromText('[]')).toThrow(/not an object/);
  });

  it('digest() is stable across runs and sensitive to content', () => {
    const a = runSession(100);
    const b = runSession(100);
    expect(a.digest()).toMatch(/^[0-9a-f]{8}$/);
    expect(a.digest()).toBe(b.digest());
    expect(a.digest()).toBe(GOLDEN_DIGEST_100);
    expect(runSession(99).digest()).not.toBe(a.digest());
  });

  it('logs the controls sent before a tick', () => {
    const log = runSession(10, new ScriptedHost(), new EchoCore(), new Map([[3, [{ type: 'pause', paused: true } as const]]]));
    expect(log.get(3)?.controls).toEqual([{ type: 'pause', paused: true }]);
    expect(log.get(2)?.controls).toEqual([]);
    expect(log.get(4)?.act.actions[0]).toMatchObject({ text: expect.stringContaining('paused') });
  });
});
