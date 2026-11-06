import { describe, expect, it } from 'vitest';
import { RoundDataError, parseRound, toTick } from '../src/contracts/index';
import { ROUND_TEXT, roundJson } from './round-fixture';

type Json = Record<string, unknown>;
const at = (o: Json, key: string): Json => o[key] as Json;
const item = (o: Json, key: string, i: number): Json => (o[key] as Json[])[i] as Json;

describe('parseRound', () => {
  it('accepts data/round.json as an object or as text', () => {
    const json = roundJson();
    const r = parseRound(json);
    expect(r).toBe(json);
    expect(r.players.map((p) => p.id)).toEqual(['barely', 'cart', 'donk', 'eradicate', 'incredibad', 'lokier', 'snakelore', 'snarlbot', 'sp4rtan', 'zwomp']);
    expect(parseRound(ROUND_TEXT)).toEqual(json);
    expect(r.meta.clock0).toBe(98.25);
  });

  it('rejects bad JSON and non-objects', () => {
    expect(() => parseRound('{nope')).toThrow(/invalid JSON/);
    expect(() => parseRound(null)).toThrow(RoundDataError);
    expect(() => parseRound([])).toThrow(/round: expected an object/);
  });

  it('names the first bad field', () => {
    const missing = roundJson();
    delete missing['bomb'];
    expect(() => parseRound(missing)).toThrow(/^bomb: expected an object/);

    const unsorted = roundJson();
    (unsorted['players'] as Json[]).reverse();
    expect(() => parseRound(unsorted)).toThrow(/players\[0\]\.id: expected barely/);

    const weapon = roundJson();
    item(weapon, 'kills', 0)['weapon'] = 'AK-47';
    expect(() => parseRound(weapon)).toThrow(/kills\[0\]\.weapon: expected one of/);

    const tick = roundJson();
    item(tick, 'damage', 1)['tick'] = 3195;
    expect(() => parseRound(tick)).toThrow(`damage[1].tick: expected ${toTick(49.9)}`);

    const track = roundJson();
    const samples = at(at(track, 'tracks'), 'donk')['samples'] as Json[];
    Object.assign(samples[3] as Json, { t: 0.1, tick: toTick(0.1) });
    expect(() => parseRound(track)).toThrow(/tracks\.donk\.samples\[3\]\.t: samples not strictly increasing/);

    const yaw = roundJson();
    at(item(yaw, 'players', 2), 'start')['yaw'] = 'east';
    expect(() => parseRound(yaw)).toThrow(/players\[2\]\.start\.yaw: expected a finite number/);

    const grenade = roundJson();
    (at(item(grenade, 'players', 1), 'kit')['grenades'] as unknown[]).push('decoy');
    expect(() => parseRound(grenade)).toThrow(/players\[1\]\.kit\.grenades\[2\]: expected one of smoke\|flash\|he\|molotov/);

    const ticks = roundJson();
    at(ticks, 'meta')['ticksPerSec'] = 128;
    expect(() => parseRound(ticks)).toThrow(/meta\.ticksPerSec: expected 64/);
  });
});
