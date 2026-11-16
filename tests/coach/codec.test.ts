import { describe, expect, it } from 'vitest';
import { decodeRawDemo, encodeRawDemo } from '../../src/coach/model/raw-codec';
import { BUTTON, PLAYER_COLUMNS } from '../../src/coach/model/raw';
import { canonicalItem, itemFromDefIndex } from '../../src/coach/model/items';
import { fourPlayers, roundsFrom, synthDemo } from './synth';

describe('coach RawDemo codec', () => {
  it('round-trips every column and record, deterministically', () => {
    const raw = synthDemo({ ...fourPlayers(), matchStart: 100, rounds: roundsFrom(100, 2) });
    raw.ticks.vx[3] = Number.NaN;
    raw.ticks.buttons[5] = 0xffffffff;
    raw.projectiles.push({ type: 'smoke', thrower: 1, entity: 7, t0: 10, t1: 18, path: new Int16Array([1, 2, 3, -32768, -32768, -32768, 7, 8, 9]) });
    const a = encodeRawDemo(raw);
    const b = encodeRawDemo(raw);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const back = decodeRawDemo(a);
    expect(back.players).toEqual(raw.players);
    expect(back.events).toEqual(raw.events);
    expect(back.inventories).toEqual(raw.inventories);
    for (const k of Object.keys(PLAYER_COLUMNS) as (keyof typeof PLAYER_COLUMNS)[]) {
      expect(back.ticks[k].constructor).toBe(raw.ticks[k].constructor);
      expect(Array.from(back.ticks[k])).toEqual(Array.from(raw.ticks[k]));
    }
    expect(Array.from(back.ticks.tick)).toEqual(Array.from(raw.ticks.tick));
    expect(Array.from(back.projectiles[0]?.path ?? [])).toEqual([1, 2, 3, -32768, -32768, -32768, 7, 8, 9]);
    expect(encodeRawDemo(back).length).toBe(a.length);
  });

  it('rejects foreign bytes', () => {
    expect(() => decodeRawDemo(new Uint8Array(16))).toThrow(/not a coach/);
  });
});

describe('coach model helpers', () => {
  it('maps every spelling of an item to one canonical name', () => {
    expect(canonicalItem('weapon_ak47')).toBe('ak47');
    expect(canonicalItem('AK-47')).toBe('ak47');
    expect(canonicalItem('M4A4')).toBe('m4a1');
    expect(canonicalItem('M4A1-S')).toBe('m4a1_silencer');
    expect(canonicalItem('Bowie Knife')).toBe('knife');
    expect(canonicalItem('knife_t')).toBe('knife');
    expect(canonicalItem('weapon_knife_t')).toBe('knife');
    expect(canonicalItem('item_kevlar')).toBe('vest');
    expect(canonicalItem('vesthelm')).toBe('vesthelm');
    expect(canonicalItem('inferno')).toBe('inferno');
    expect(itemFromDefIndex(61)).toBe('usp_silencer');
    expect(itemFromDefIndex(515)).toBe('knife');
  });

  it('decodes the sample button mask from the plan', () => {
    const mask = Number(BigInt.asUintN(32, BigInt('65552')));
    expect(mask).toBe(BUTTON.walk | BUTTON.back);
  });
});
