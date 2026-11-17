/** K5: duel and spray series built from K2's tables on synthetic demos (tests/coach/combat-synth.ts). */
import { describe, expect, it } from 'vitest';
import { createContext } from '../../src/coach/analyze/index';
import { defaultWeaponTable } from '../../src/coach/analyze/context';
import { ingestMatch } from '../../src/coach/ingest/index';
import type { Evidence, EvidenceSeries } from '../../src/coach/model/report';
import { addEvidenceSeries, duelSeries, spraySeries } from '../../src/coach/report/evidence-series';
import { addBullet, aimAt, combatDemo, finish, kill, setPos, setVel, setView } from './combat-synth';

function demo(): ReturnType<typeof combatDemo> {
  const raw = combatDemo(2, 1);
  setPos(raw, 0, 0, 1100, 0, 0);
  setPos(raw, 1, 0, 1100, 0, 300);
  setPos(raw, 2, 0, 1100, 1000, 0);
  setPos(raw, 3, 0, 1100, 1000, 300);
  return raw;
}

const ev = (kind: Evidence['kind'], focus: number, tick0: number, tick1: number, players: number[]): Evidence =>
  ({ kind, round: 1, tick0, tick1, focus, players, annotations: [], caption: '' });
const ch = (s: EvidenceSeries[], name: string): EvidenceSeries | undefined => s.find((x) => x.name === name);

describe('duel series', () => {
  it('speed with the one-tick lag and the accurate-speed line, angle to the head, inaccuracy and shots', () => {
    const raw = demo();
    setVel(raw, 0, 381, 400, 0, 200); // the speed behind the shot at 400 is the velocity at 401
    setVel(raw, 0, 401, 401, 0, 150);
    const at = aimAt(raw, 0, 2, 400);
    setView(raw, 0, 300, 500, at.pitch, at.yaw);
    addBullet(raw, { tick: 400, p: 0, ...at, inaccuracy: 0.05 });
    addBullet(raw, { tick: 410, p: 0, ...at, hurt: { victim: 2, healthAfter: 70 } });
    kill(raw, 2, 0, 420);
    const ctx = createContext(finish(raw), ingestMatch(raw));
    const s = duelSeries(ctx, ev('duel', 400, 300, 460, [0, 2]));
    const speed = ch(s, 'speed');
    expect(speed?.axis).toBe('tick');
    expect(speed?.x[0]).toBe(300);
    expect(speed?.x.at(-1)).toBe(460);
    expect(speed?.values[speed.x.indexOf(400)]).toBe(150);
    expect(speed?.values[speed.x.indexOf(399)]).toBe(200);
    expect(speed?.ref?.value).toBeCloseTo(0.34 * 215, 0);
    const angle = ch(s, 'angle');
    // Aimed at the chest, 1,000 units away: the head is about 1° above.
    expect(angle?.values[angle.x.indexOf(400)]).toBeGreaterThan(0.5);
    expect(angle?.values[angle.x.indexOf(400)]).toBeLessThan(2);
    expect(Number.isNaN(angle?.values[angle.x.indexOf(430)])).toBe(true); // target dead
    expect(ch(s, 'inaccuracy')?.values).toEqual([50, 6.41]);
    expect(ch(s, 'shots')?.marks).toEqual(['miss', 'hit']);
    expect(ch(s, 'duck')).toBeUndefined(); // never crouched
  });
});

describe('spray series', () => {
  it('compensated aim, crosshair and the ideal path from the pattern, per bullet', () => {
    const raw = demo();
    const pattern = defaultWeaponTable().sprays['ak47'] ?? [];
    for (let k = 0; k < 8; k++) {
      const tick = 300 + 6 * k;
      const drift = k >= 3 ? 2 : 0;
      const bullet = aimAt(raw, 0, 2, tick, drift);
      // The crosshair sits at bullet − kick, with the kick of the pattern.
      const kick = pattern[k] ?? [0, 0];
      setView(raw, 0, tick - 1, tick - 1, bullet.pitch - kick[0], bullet.yaw - kick[1]);
      addBullet(raw, { tick, p: 0, ...bullet, recoilIndex: k, ...(k === 1 ? { hurt: { victim: 2, healthAfter: 80 } } : {}) });
    }
    const ctx = createContext(finish(raw), ingestMatch(raw));
    const s = spraySeries(ctx, ev('spray', 300, 236, 410, [0, 2]));
    expect(ch(s, 'aim_y')?.x).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(ch(s, 'aim_y')?.values.map((v) => Math.round(v))).toEqual([0, 0, 0, 2, 2, 2, 2, 2]);
    expect(ch(s, 'aim_x')?.marks?.[1]).toBe('hit');
    expect(ch(s, 'aim_x')?.marks?.[0]).toBe('on');
    expect(ch(s, 'aim_x')?.marks?.[5]).toBe('miss');
    expect(ch(s, 'ideal_y')?.values).toEqual(pattern.slice(0, 8).map((p) => Math.round(p[0] * 100) / 100));
    expect(ch(s, 'ideal_x')?.label).toContain('pattern');
    // The crosshair minus the ideal is the aim error.
    const vy = ch(s, 'view_y')?.values ?? [];
    const iy = ch(s, 'ideal_y')?.values ?? [];
    const ay = ch(s, 'aim_y')?.values ?? [];
    for (let k = 0; k < 8; k++) expect((vy[k] ?? 0) - (iy[k] ?? 0)).toBeCloseTo(ay[k] ?? 0, 1);
  });

  it('fills series only on duel and spray evidence, once', () => {
    const raw = demo();
    for (let k = 0; k < 4; k++) addBullet(raw, { tick: 300 + 6 * k, p: 0, ...aimAt(raw, 0, 2, 300 + 6 * k) });
    const ctx = createContext(finish(raw), ingestMatch(raw));
    const f = { evidence: [ev('replay', 300, 250, 350, [0]), ev('spray', 300, 250, 350, [0, 2]), ev('duel', 300, 250, 350, [0, 2])] } as Parameters<typeof addEvidenceSeries>[1];
    addEvidenceSeries(ctx, f);
    expect(f.evidence.map((e) => e.series === undefined)).toEqual([true, false, false]);
    const before = f.evidence[1]?.series;
    addEvidenceSeries(ctx, f);
    expect(f.evidence[1]?.series).toBe(before);
  });
});
