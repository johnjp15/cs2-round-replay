import { describe, expect, it } from 'vitest';
import * as contracts from '../src/contracts/index';
import {
  BUTTONS,
  JsonError,
  PLAYER_IDS,
  canonicalize,
  fnv1a32Hex,
  formatNumber,
  parseJsonLine,
  sortButtons,
  sortById,
  sortIds,
  stableStringify,
  type Act,
  type Action,
  type ActionType,
  type Control,
  type ControlType,
  type Observe,
  type ObsEvent,
} from '../src/contracts/index';

const v = (x: number, y: number, z: number) => ({ x, y, z });

/** One of every ObsEvent member (compile-time exhaustive via the mapped type). */
const EVENTS: { readonly [K in ObsEvent['type']]: Extract<ObsEvent, { type: K }> } = {
  damage: { type: 'damage', attacker: 'snarlbot', victim: 'incredibad', amount: 27, armor: 4, weapon: 'ak47', hitgroup: 'chest', scripted: true },
  shot: { type: 'shot', shooter: 'snarlbot', weapon: 'ak47' },
  death: { type: 'death', victim: 'incredibad', attacker: null, weapon: null, headshot: false },
  sound: { type: 'sound', source: 'donk', pos: v(1.5, -2.25, 0), kind: 'footstep' },
  bomb: { type: 'bomb', phase: 'planted', id: 'cart', pos: v(-1800, 300, -160) },
  round_end: { type: 'round_end', winner: 'CT', reason: 'bomb_defused' },
};

const ACTIONS: { readonly [K in ActionType]: Extract<Action, { type: K }> } = {
  damage: { type: 'damage', attacker: 'sp4rtan', victim: 'donk', amount: 100, armor: 0, hitgroup: 'head', weapon: 'ak47', lethal: true },
  block_damage: { type: 'block_damage', attacker: 'donk', victim: 'sp4rtan' },
  unblock_damage: { type: 'unblock_damage', attacker: 'donk', victim: 'sp4rtan' },
  set_mode: { type: 'set_mode', id: 'zwomp', mode: 'LIVE', goal: { route: [v(1, 2, 3), v(4, 5, 6)], role: 'hold', hold: v(4, 5, 6) } },
  set_weapon: { type: 'set_weapon', id: 'sp4rtan', weapon: 'deagle' },
  give: { type: 'give', id: 'sp4rtan', item: 'ak47', clip: 12, reserve: 60 },
  set_hp: { type: 'set_hp', id: 'lokier', hp: 42, armor: 0, helmet: false },
  teleport: { type: 'teleport', id: 'barely', pos: v(-473, 647, -82), yaw: 180 },
  plant: { type: 'plant', id: 'cart', pos: v(-1800, 300, -160) },
  defuse_start: { type: 'defuse_start', id: 'sp4rtan' },
  defuse_stop: { type: 'defuse_stop', id: 'sp4rtan' },
  end_round: { type: 'end_round', winner: 'T', reason: 'elimination' },
  log: { type: 'log', level: 'info', text: 'trigger "seen" fired → LIVE ☃' },
};

const CONTROLS: { readonly [K in ControlType]: Extract<Control, { type: K }> } = {
  start: { type: 'start' },
  restart: { type: 'restart' },
  seek: { type: 'seek', t: 12.5 },
  checkpoint: { type: 'checkpoint', id: 'cp1' },
  rewind: { type: 'rewind', id: 'cp1' },
  pause: { type: 'pause', paused: true },
  speed: { type: 'speed', x: 0.25 },
};

function fullObserve(): Observe {
  return {
    tick: 64,
    t: 1,
    human: 'sp4rtan',
    events: Object.values(EVENTS),
    round: {
      phase: 'over',
      score: { ct: 12, t: 15 },
      winner: 'CT',
      reason: 'bomb_defused',
      endTick: 4275,
      timeLeftSec: 0.71875,
      bomb: { state: 'defused', carrier: null, pos: v(-1982, 311, -160), plantTick: 1761, defuser: 'sp4rtan', defuseEndTick: 4275 },
    },
    pawns: sortById(
      PLAYER_IDS.map((id, i) => ({
        id,
        team: i < 5 ? 'T' : 'CT',
        pos: v(i * 10.5, 0 - i, -80),
        vel: v(0, 0, 0),
        yaw: 90,
        pitch: -1.25,
        hp: 100,
        armor: 100,
        alive: i !== 3,
        weapon: 'knife',
        ammo: { clip: 0, reserve: 0 },
        crouching: i % 2 === 0,
        sees: i === 0 ? ['cart', 'donk'] : [],
      })),
    ),
  } as const satisfies Observe;
}

function fullAct(): Act {
  return {
    inputs: [{ id: 'barely', forward: 1, side: -0.5, yaw: 359.999999, pitch: 0, buttons: [...BUTTONS] }],
    actions: Object.values(ACTIONS),
    status: [
      { id: 'barely', mode: 'REPLAY', trigger: null, sinceTick: 0 },
      { id: 'cart', mode: 'LIVE', trigger: 'heard', sinceTick: 12 },
      { id: 'donk', mode: 'DEAD', trigger: 'death', sinceTick: 40 },
    ],
  };
}

describe('contract types', () => {
  it('round-trips Observe, Act and every Control through stableStringify', () => {
    for (const value of [fullObserve(), fullAct(), Object.values(CONTROLS)]) {
      const text = stableStringify(value);
      expect(parseJsonLine(text)).toEqual(value);
      expect(stableStringify(parseJsonLine(text))).toBe(text);
    }
    expect(Object.keys(EVENTS)).toHaveLength(6);
    expect(Object.keys(ACTIONS)).toHaveLength(13);
    expect(Object.keys(CONTROLS)).toHaveLength(7);
  });

  it('exports the ten player ids sorted and runtime helpers from the barrel', () => {
    expect(PLAYER_IDS).toHaveLength(10);
    expect([...PLAYER_IDS]).toEqual([...PLAYER_IDS].sort());
    expect(typeof contracts.replay).toBe('function');
    expect(typeof contracts.SessionLog).toBe('function');
    expect(typeof contracts.toReplayTrace).toBe('function');
    expect(contracts.isPlayerId('sp4rtan')).toBe(true);
    expect(contracts.isPlayerId('Sp4rtaN')).toBe(false);
  });

  it('sorts by id ordinally without touching the input', () => {
    const xs = [{ id: 'zwomp' }, { id: 'Zed' }, { id: 'barely' }, { id: 'b' }];
    const sorted = sortById(xs);
    expect(sorted.map((x) => x.id)).toEqual(['Zed', 'b', 'barely', 'zwomp']);
    expect(xs[0]?.id).toBe('zwomp');
    expect(sortIds(['donk', 'cart', 'donk'])).toEqual(['cart', 'donk']);
    expect(sortButtons(['WALK', 'ATTACK', 'WALK'])).toEqual(['ATTACK', 'WALK']);
  });
});

describe('stableStringify', () => {
  it('sorts object keys at every depth and writes no whitespace', () => {
    expect(stableStringify({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
    expect(stableStringify({ B: 1, a: 2, _: 3 })).toBe('{"B":1,"_":3,"a":2}');
  });

  it('normalizes numbers', () => {
    expect(stableStringify(-0)).toBe('0');
    expect(stableStringify([-0, 0])).toBe('[0,0]');
    expect(stableStringify(1e21)).toBe('1000000000000000000000');
    expect(stableStringify(-1e21)).toBe('-1000000000000000000000');
    expect(stableStringify(0.1 + 0.2)).toBe('0.3');
    expect(stableStringify(1 / 3)).toBe('0.333333');
    expect(stableStringify(-0.0000001)).toBe('0');
    expect(stableStringify(-0.0000006)).toBe('-0.000001');
    expect(stableStringify(1e-7)).toBe('0');
    expect(stableStringify(123456789.1234567)).toBe('123456789.123457');
    expect(stableStringify(100)).toBe('100');
    expect(stableStringify(2.5)).toBe('2.5');
    expect(stableStringify(1 / 128)).toBe('0.007813'); // exact tie rounds away from zero
    expect(stableStringify(-1 / 128)).toBe('-0.007813');
    expect(formatNumber(2 ** 53 + 2)).toBe('9007199254740994');
  });

  it('rejects values JSON cannot represent', () => {
    expect(() => stableStringify(Number.NaN)).toThrow(JsonError);
    expect(() => stableStringify({ a: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
    expect(() => stableStringify({ a: undefined })).toThrow(/undefined at \$\.a/);
    expect(() => stableStringify(() => 1)).toThrow(JsonError);
  });

  it('escapes strings like JSON.stringify', () => {
    const s = 'q"\\\n\t\u0001é😀\ud800';
    expect(stableStringify(s)).toBe(JSON.stringify(s));
    expect(parseJsonLine(stableStringify(s))).toBe(s);
  });

  it('canonicalize equals a log round trip', () => {
    expect(canonicalize({ x: 0.1 + 0.2, y: -0 })).toEqual({ x: 0.3, y: 0 });
  });

  it('parseJsonLine rejects empty and bad lines and tolerates CRLF', () => {
    expect(parseJsonLine('{"a":1}\r')).toEqual({ a: 1 });
    expect(() => parseJsonLine('')).toThrow(JsonError);
    expect(() => parseJsonLine('{nope')).toThrow(JsonError);
  });
});

describe('fnv1a32Hex', () => {
  it('matches the published FNV-1a 32-bit vectors (UTF-8)', () => {
    expect(fnv1a32Hex('')).toBe('811c9dc5');
    expect(fnv1a32Hex('a')).toBe('e40c292c');
    expect(fnv1a32Hex('foobar')).toBe('bf9cf968');
  });

  it('hashes UTF-8 bytes', () => {
    const s = 'é😀→';
    const bytes = new TextEncoder().encode(s);
    let h = 0x811c9dc5;
    for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
    expect(fnv1a32Hex(s)).toBe(h.toString(16).padStart(8, '0'));
  });
});
