/** Pure parts of the coach page: the library's storage codec and the hash routes. */
import { describe, expect, it } from 'vitest';
import { packBytes, packGzip, unpackBytes, unpackGzip } from '../../src/coach-app/pack';
import { matchHref, parseRoute } from '../../src/coach-app/router';

describe('coach page storage codec', () => {
  const value = {
    a: 1, s: 'x', list: [{ xy: new Int16Array([1, -2, -32768]), f: new Uint8Array([7]) }],
    deep: { y: new Float32Array([0.5, NaN]), i: new Int32Array([2 ** 30]) },
  };
  it('round-trips typed arrays anywhere in the object', () => {
    const back = unpackBytes<typeof value>(packBytes(value));
    expect(back.a).toBe(1);
    expect(back.list[0]?.xy).toBeInstanceOf(Int16Array);
    expect([...(back.list[0]?.xy ?? [])]).toEqual([1, -2, -32768]);
    expect([...(back.list[0]?.f ?? [])]).toEqual([7]);
    expect(back.deep.y[0]).toBe(0.5);
    expect(Number.isNaN(back.deep.y[1])).toBe(true);
    expect(back.deep.i[0]).toBe(2 ** 30);
  });
  it('gzips', async () => {
    const big = { z: new Int16Array(100_000) };
    const gz = await packGzip(big);
    expect(gz.byteLength).toBeLessThan(2_000);
    const back = await unpackGzip<typeof big>(gz);
    expect(back.z.length).toBe(100_000);
  });
});

describe('coach page routes', () => {
  it('parses and builds match, round, tick and evidence routes', () => {
    expect(parseRoute('')).toEqual({ page: 'home' });
    expect(parseRoute('#/')).toEqual({ page: 'home' });
    expect(parseRoute('#/m/abc')).toEqual({ page: 'match', id: 'abc', round: null, tick: null, evidence: null });
    const h = matchHref('abc', 4, 24410.4, [0, 2]);
    expect(h).toBe('#/m/abc/r/4?t=24410&ev=0.2');
    expect(parseRoute(h)).toEqual({ page: 'match', id: 'abc', round: 4, tick: 24410, evidence: [0, 2] });
    expect(parseRoute('#/m/abc/r/x?ev=1')).toEqual({ page: 'match', id: 'abc', round: null, tick: null, evidence: null });
  });
});
