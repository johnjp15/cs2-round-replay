import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildRound, parseCsv } from '../tools/extract-round';
import type { PlayerId, RoundData } from '../src/contracts/index';
import { validateRound } from '../tools/validate-round';

const roundText = readFileSync(new URL('../data/round.json', import.meta.url), 'utf8');
const round = JSON.parse(roundText) as RoundData;
const csvUrl = new URL('../data/source/mirage-round-sp4rtan-1v3-shots.csv', import.meta.url);
const csvText = readFileSync(csvUrl, 'utf8');
const csvRows = parseCsv(csvText).length - 1;

// Expected facts about the round (from the project docs), copied here on purpose.
const KILLS: { t: number; killer: PlayerId; victim: PlayerId; weapon: string; hs: boolean }[] = [
  { t: 0.5, killer: 'snarlbot', victim: 'incredibad', weapon: 'ak47', hs: false },
  { t: 12.4, killer: 'snarlbot', victim: 'snakelore', weapon: 'ak47', hs: false },
  { t: 12.75, killer: 'lokier', victim: 'eradicate', weapon: 'ssg08', hs: true },
  { t: 17.85, killer: 'sp4rtan', victim: 'snarlbot', weapon: 'deagle', hs: false },
  { t: 18.8, killer: 'cart', victim: 'lokier', weapon: 'ak47', hs: true },
  { t: 44.2, killer: 'barely', victim: 'zwomp', weapon: 'ak47', hs: false },
  { t: 50.35, killer: 'sp4rtan', victim: 'donk', weapon: 'ak47', hs: false },
  { t: 58.85, killer: 'sp4rtan', victim: 'barely', weapon: 'ak47', hs: true },
  { t: 69.4, killer: 'sp4rtan', victim: 'cart', weapon: 'ak47', hs: false }, // post-round
];

const DAMAGE: { t: number; attacker: PlayerId; victim: PlayerId; amount: number; armor?: number }[] = [
  { t: 18.5, attacker: 'lokier', victim: 'cart', amount: 73, armor: 7 },
  { t: 49.9, attacker: 'sp4rtan', victim: 'donk', amount: 27 },
  { t: 50.0, attacker: 'sp4rtan', victim: 'donk', amount: 34 },
  { t: 50.1, attacker: 'sp4rtan', victim: 'donk', amount: 26 },
];

const START: Record<PlayerId, [number, number]> = {
  barely: [-473, 647],
  cart: [-391, 909],
  eradicate: [-731, 567],
  donk: [-177, 544],
  snarlbot: [800, -1120],
  lokier: [-2387, 815],
  sp4rtan: [-505, -1460],
  zwomp: [-1180, -500],
  incredibad: [905, -1290],
  snakelore: [133, -1710],
};

const close = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

describe('data/round.json', () => {
  it('passes the structural validator', () => {
    expect(validateRound(round, csvRows)).toEqual([]);
  });

  it('has every expected kill with tick within ±1', () => {
    expect(round.kills).toHaveLength(KILLS.length);
    for (const k of KILLS) {
      const found = round.kills.find((r) => close(r.t, k.t, 0.01) && r.killer === k.killer && r.victim === k.victim);
      expect(found, `kill ${k.t} ${k.killer}→${k.victim}`).toBeDefined();
      if (!found) continue;
      expect({ weapon: found.weapon, hs: found.hs }).toEqual({ weapon: k.weapon, hs: k.hs });
      expect(Math.abs(found.tick - Math.round(k.t * 64))).toBeLessThanOrEqual(1);
    }
    expect(round.kills.find((k) => k.t === 69.4)?.postRound).toBe(true);
  });

  it('has the expected damage events', () => {
    for (const d of DAMAGE) {
      const found = round.damage.find((r) => close(r.t, d.t, 0.01) && r.attacker === d.attacker && r.victim === d.victim);
      expect(found, `damage ${d.t} ${d.attacker}→${d.victim}`).toBeDefined();
      expect(found?.amount).toBe(d.amount);
      if (d.armor !== undefined) expect(found?.armor).toBe(d.armor);
    }
  });

  it('has the bomb plant and defuse', () => {
    const b = round.bomb;
    expect(b.carrier).toBe('barely');
    expect(b.plantT).toBe(27.517);
    expect(b.plantTick).toBe(Math.round(27.517 * 64));
    expect(b.pos).toEqual({ x: -1982, y: 311, z: -160 });
    expect(b.defuseStartT).toBe(61.8);
    expect(b.defuseT).toBe(66.8);
  });

  it('starts every player at the expected t = 0 position (±1 unit, and matching the track)', () => {
    for (const p of round.players) {
      const [x, y] = START[p.id];
      expect(Math.abs(p.start.pos.x - x), `${p.id} x`).toBeLessThanOrEqual(1);
      expect(Math.abs(p.start.pos.y - y), `${p.id} y`).toBeLessThanOrEqual(1);
      const s0 = round.tracks[p.id]?.samples[0];
      expect(s0?.t).toBe(0);
      expect(Math.abs((s0?.x ?? NaN) - x)).toBeLessThanOrEqual(1);
      expect(Math.abs((s0?.y ?? NaN) - y)).toBeLessThanOrEqual(1);
    }
  });

  it('has 0.1 s strictly increasing samples for every player', () => {
    for (const p of round.players) {
      const s = round.tracks[p.id]?.samples ?? [];
      expect(s.length, p.id).toBeGreaterThan(0);
      for (let i = 1; i < s.length; i++) {
        const a = s[i - 1];
        const b = s[i];
        if (!a || !b) continue;
        expect(b.t > a.t).toBe(true);
        expect(close(b.t - a.t, 0.1, 1e-9), `${p.id} at ${b.t}`).toBe(true);
      }
    }
  });

  it('marks track confidence as the source says', () => {
    const conf = (id: PlayerId, t: number): string | undefined => round.tracks[id]?.samples[Math.round(t * 10)]?.confidence;
    expect(conf('barely', 10)).toBe('observed');
    expect(conf('snarlbot', 5)).toBe('estimated');
    expect(conf('snarlbot', 15)).toBe('observed');
    expect(conf('sp4rtan', 30)).toBe('inferred');
    expect(round.tracks['sp4rtan']?.samples[300]?.uncertainty).toBeGreaterThan(0);
    expect(conf('lokier', 18)).toBe('observed'); // sighted by cart 17.45–18.8
  });

  it('has one shot per CSV row and ticks equal round(t*64)', () => {
    expect(round.shots).toHaveLength(csvRows);
    for (const s of round.shots) {
      if (s.t === null) expect(s.window).not.toBeNull();
      else expect(s.tick).toBe(Math.round(s.t * 64));
    }
  });

  it('has the kit and roles from the movement doc', () => {
    const p = (id: PlayerId) => round.players.find((x) => x.id === id);
    expect(p('barely')?.kit).toMatchObject({ primary: 'ak47', c4: true, grenades: ['he', 'smoke'], clip: 30, reserve: 90 });
    expect(p('cart')).toMatchObject({ startHp: 100, startArmor: 100, isHumanDefault: true });
    expect(p('cart')?.kit.grenades).toEqual(['smoke', 'smoke']);
    expect(p('snarlbot')?.startHp).toBe(44);
    expect(p('donk')?.kit).toMatchObject({ primary: 'awp', clip: 10, reserve: 30, grenades: ['flash', 'molotov'] });
    expect(p('lokier')?.kit.primary).toBe('ssg08');
    expect(p('sp4rtan')?.kit).toMatchObject({ primary: null, secondary: 'deagle', kit: true });
    expect(p('sp4rtan')?.pickups).toEqual([{ t: 19.6, tick: 1254, weapon: 'ak47' }]);
    for (const id of ['incredibad', 'snakelore', 'zwomp'] as const) expect(p(id)?.kit).toMatchObject({ primary: 'm4a4', assumed: true });
    expect(p('sp4rtan')?.role).toBe('flank_then_retake');
    expect(p('zwomp')?.role).toBe('rotate_b');
    expect(p('lokier')?.role).toBe('hold_b');
    expect(p('barely')?.roles).toEqual(['take_b', 'planter']);
    expect(round.players.filter((x) => x.isHumanDefault).map((x) => x.id)).toEqual(['cart']);
  });

  it('never gives Lokier an AWP', () => {
    expect(roundText).not.toMatch(/"lokier"[^}]*"awp"/);
    expect(round.timelines.weapon['lokier']?.[0]?.weapon).toBe('ssg08');
  });
});

// The web-apps clone is usually a sibling of this repo (or of the worktree folder); ROUND_SOURCE_HTML overrides.
const SOURCE = 'web-apps/cs2/mirage-round-replay/index.html';
const htmlPath =
  [process.env['ROUND_SOURCE_HTML'], new URL(`../../${SOURCE}`, import.meta.url).pathname, new URL(`../../../${SOURCE}`, import.meta.url).pathname].find(
    (p): p is string => p !== undefined && existsSync(p),
  ) ?? '';

describe.skipIf(htmlPath === '')('tools/extract-round.ts (needs the web-apps source)', () => {
  it('is deterministic and matches the committed data/round.json', () => {
    const html = readFileSync(htmlPath, 'utf8');
    const tuning = JSON.parse(readFileSync(new URL('../data/tuning.json', import.meta.url), 'utf8')) as {
      weapons: Record<string, { clip: number; reserve: number }>;
    };
    const inp = {
      html,
      csv: csvText,
      tuningWeapons: tuning.weapons,
      htmlName: 'web-apps/cs2/mirage-round-replay/index.html',
      csvName: 'web-apps/cs2/mirage-round-replay/source/shots/mirage-round-sp4rtan-1v3-shots.csv',
    };
    const a = buildRound(inp);
    const b = buildRound(inp);
    expect(a.json).toBe(b.json);
    expect(a.radar.equals(b.radar)).toBe(true);
    expect(a.json).toBe(roundText);
    expect(a.radar.equals(readFileSync(new URL('../data/mirage-radar.jpg', import.meta.url)))).toBe(true);
  });
});
