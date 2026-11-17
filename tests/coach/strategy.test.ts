/** K8: map knowledge, strategy tables and the strat.* detectors on synthetic Mirage matches (both halves). */
import { describe, expect, it } from 'vitest';
import places from '../../data/coach/maps/de_mirage/places.json';
import mirageJson from '../../data/coach/knowledge/de_mirage.json';
import { analyze } from '../../src/coach/analyze/index';
import { createContext } from '../../src/coach/analyze/context';
import { STRAT_GRID, Z_UNKNOWN } from '../../src/coach/derive/strategy/grid';
import { STRAT_HITS } from '../../src/coach/derive/strategy/hits';
import { checkPlaces, KNOWLEDGE, knowledgeFor, loadKnowledge, type MapKnowledge } from '../../src/coach/derive/strategy/knowledge';
import { STRAT_LANES } from '../../src/coach/derive/strategy/lanes';
import { halvesOf, STRAT_REPEATS } from '../../src/coach/derive/strategy/repeats';
import { STRAT_ROTATIONS } from '../../src/coach/derive/strategy/rotations';
import { setupLabel, STRAT_SETUPS } from '../../src/coach/derive/strategy/setups';
import { STRATEGY_DETECTORS } from '../../src/coach/detect/strategy/index';
import { STRATEGY_METRICS } from '../../src/coach/metrics/strategy/index';
import type { RawDemo } from '../../src/coach/model/raw';
import type { Finding, MatchReport } from '../../src/coach/model/report';
import { at, finish, mirage, plant, put, putUnknown, R, tRound, type MirageSpec } from './strategy-synth';

function report(raw: RawDemo, user: number): MatchReport {
  const { match } = finish(raw);
  return analyze(raw, match, { user, metrics: STRATEGY_METRICS, detectors: STRATEGY_DETECTORS });
}
function ctx(raw: RawDemo): ReturnType<typeof createContext> {
  const { match } = finish(raw);
  return createContext(raw, match);
}
const find = (rep: MatchReport, prefix: string): Finding | undefined => rep.findings.find((f) => f.id.startsWith(prefix));

function checkEvidence(f: Finding | undefined): void {
  expect(f).toBeDefined();
  expect(f?.evidence.length).toBeGreaterThanOrEqual(1);
  expect(f?.evidence.length).toBeLessThanOrEqual(3);
  for (const e of f?.evidence ?? []) {
    expect(e.kind).toBe('replay');
    expect(e.tick0).toBeLessThanOrEqual(e.focus);
    expect(e.tick1).toBeGreaterThanOrEqual(e.focus);
    expect(e.annotations.some((a) => a.kind === 'zone')).toBe(true);
    expect(e.annotations.some((a) => a.kind === 'circle' && a.role === 'user')).toBe(true);
  }
  expect(f?.confidence).toBeGreaterThan(0);
  expect(f?.confidence).toBeLessThan(1);
  expect(f?.scope).toBe('macro');
  expect(f?.area).toBe('strategy');
}

describe('map knowledge', () => {
  it('loads the committed files; Mirage classifies every place of its places.json, Dust II is a draft', () => {
    expect(Object.keys(KNOWLEDGE).sort()).toEqual(['de_dust2', 'de_mirage']);
    const m = KNOWLEDGE['de_mirage'] as MapKnowledge;
    expect(m.verified).toBe(true);
    expect(knowledgeFor('de_dust2')?.verified).toBe(false);
    expect(knowledgeFor('de_inferno')).toBeNull();
    const res = checkPlaces(m, places.places.map((p) => p.name));
    expect(res).toEqual({ unknown: [], unused: [], classified: 23 });
    expect(m.checkedAgainst[0]?.siteIds).toEqual({ 184: 'A', 185: 'B' });
    for (const l of m.lanes) expect(l.counters.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects broken files', () => {
    const base = JSON.parse(JSON.stringify(mirageJson)) as { zones: { places: string[] }[]; lanes: { places: string[] }[]; verified: boolean; checkedAgainst: unknown[] };
    const dup = JSON.parse(JSON.stringify(base)) as typeof base;
    dup.zones[1]?.places.push('TSpawn');
    expect(() => loadKnowledge(dup)).toThrow(/TSpawn is in zones/);
    const lane = JSON.parse(JSON.stringify(base)) as typeof base;
    lane.lanes[0]?.places.push('Fountain');
    expect(() => loadKnowledge(lane)).toThrow(/Fountain is in no zone/);
    const twoLanes = JSON.parse(JSON.stringify(base)) as typeof base;
    twoLanes.lanes[1]?.places.push('TRamp');
    expect(() => loadKnowledge(twoLanes)).toThrow(/TRamp is in lanes/);
    const unverified = JSON.parse(JSON.stringify(base)) as typeof base;
    unverified.checkedAgainst = [];
    expect(() => loadKnowledge(unverified)).toThrow(/verified needs/);
  });

  it('reports unknown and unused names', () => {
    const res = checkPlaces(KNOWLEDGE['de_mirage'] as MapKnowledge, ['TSpawn', 'Fountain', '']);
    expect(res.unknown).toEqual(['Fountain']);
    expect(res.unused.length).toBe(22);
  });
});

/** Six rounds, team A always T: Ts walk Palace alley → Palace → A, plant, win. CTs 5..9 set up A, A, CT spawn, B, B. */
function palaceMatch(contested: boolean): { raw: RawDemo; spec: MirageSpec } {
  const spec: MirageSpec = { rounds: 6 };
  const raw = mirage(spec);
  for (let k = 0; k < 6; k++) {
    tRound(raw, spec, k, { lane: ['PalaceAlley', 'PalaceInterior'], site: 'A', hitSec: 30, ct: ['BombsiteA', 'BombsiteA', 'CTSpawn', 'BombsiteB', 'BombsiteB'] });
    if (contested) put(raw, 6, R(k).fe, R(k).end, 'PalaceInterior');
  }
  return { raw, spec };
}

describe('lane control', () => {
  it('an uncontested lane taken every round: tables and strat.lane', () => {
    const { raw } = palaceMatch(false);
    const c = ctx(raw);
    const palace = c.table(STRAT_LANES).filter((l) => l.laneId === 'palace');
    expect(palace.length).toBe(6);
    for (const l of palace) {
      expect(l.taken).toBe(true);
      expect(l.contested).toBe(false);
      expect(l.firstTSec).toBeCloseTo(18, 0);
      expect(l.enteredBy).toEqual([0, 3, 3]);
      expect(l.hitSite).toBe('A');
      expect(l.plantSite).toBe('A');
    }
    const hits = c.table(STRAT_HITS);
    expect(hits.map((h) => h.site)).toEqual(['A', 'A', 'A', 'A', 'A', 'A']);
    expect(hits[0]?.lanes).toEqual(['palace']);
    expect(hits[0]?.committed).toEqual([0, 1, 2]);
    expect(hits[0]?.roles).toMatchObject({ 0: 'entry', 1: 'second', 2: 'support' });
    expect(hits[0]?.timing).toBe('fast');
    const rep = report(raw, 5);
    const f = find(rep, 'strat.lane.open');
    checkEvidence(f);
    expect(f?.polarity).toBe('fix');
    expect(f?.summary).toContain('They took Palace in 6 of your 6 CT rounds, 6 times with nobody contesting it; those 6 rounds ended in 6 A plants and 6 lost.');
    expect(f?.summary).toContain('You were the A player in 6 of them and stood in A site each time');
    expect(f?.advice.map((a) => a.text)).toEqual(knowledgeFor('de_mirage')?.lanes.find((l) => l.id === 'palace')?.counters);
    const chart = rep.charts?.['strat.lane'];
    expect(chart?.kind).toBe('boards');
    if (chart?.kind === 'boards') {
      expect(chart.boards.length).toBe(6);
      expect(chart.boards[0]?.zones[0]?.role).toBe('t');
      expect(chart.boards[0]?.dots.some((d) => d.role === 'user')).toBe(true);
      expect(chart.boards.filter((b) => b.link !== undefined).length).toBe(f?.evidence.length);
    }
    // The setup had three on A (CT spawn defends A): no light-site fix, an observation instead.
    expect(find(rep, 'strat.setup')?.id).toBe('strat.setup.pattern');
    expect(c.table(STRAT_SETUPS)[0]?.label).toBe('2 A, 2 B, 1 CT');
    expect(c.table(STRAT_SETUPS)[0]?.onHitSiteAtSetup).toBe(3);
  });

  it('a lane with a CT in it is contested and not flagged', () => {
    const { raw } = palaceMatch(true);
    const c = ctx(raw);
    const palace = c.table(STRAT_LANES).filter((l) => l.laneId === 'palace');
    for (const l of palace) {
      expect(l.contested).toBe(true);
      expect(l.contests[0]).toMatchObject({ slot: 6, how: 'body' });
      expect(l.ctGaveUp).toBe('held');
    }
    expect(find(report(raw, 5), 'strat.lane')).toBeUndefined();
  });

  it('a CT grenade landing in the lane before the Ts are through contests it', () => {
    const { raw } = palaceMatch(false);
    // A smoke by CT slot 7 into Palace in every round, landing at 12 s.
    for (let k = 0; k < 6; k++) {
      const c = places.places.find((p) => p.name === 'PalaceInterior')?.centroid ?? { x: 0, y: 0, z: 0 };
      raw.events.detonations.push({ tick: at(k, 12), kind: 'smoke', p: 7, entity: 900 + k, x: c.x, y: c.y, z: c.z });
      raw.events.detonations.push({ tick: at(k, 30), kind: 'smoke_end', p: 7, entity: 900 + k, x: c.x, y: c.y, z: c.z });
    }
    const lanes = ctx(raw).table(STRAT_LANES).filter((l) => l.laneId === 'palace');
    for (const l of lanes) expect(l.contests.map((x) => `${x.slot}:${x.how}`)).toEqual(['7:grenade']);
  });
});

describe('rotations', () => {
  it('leaving B before any information when they then hit B is an early, punished rotation', () => {
    const spec: MirageSpec = { rounds: 4 };
    const raw = mirage(spec);
    for (let k = 0; k < 4; k++) {
      tRound(raw, spec, k, { lane: ['House', 'BackAlley', 'Apartments'], site: 'B', hitSec: 36, ct: ['BombsiteA', 'BombsiteA', 'CTSpawn', 'BombsiteB', 'Shop'] });
      // Slot 8 starts on B, leaves at 20 s through CT spawn to A.
      put(raw, 8, at(k, 20), at(k, 23) - 1, 'CTSpawn');
      put(raw, 8, at(k, 23), R(k).end, 'BombsiteA');
    }
    const c = ctx(raw);
    const rot = c.table(STRAT_ROTATIONS).filter((r) => r.slot === 8);
    expect(rot.length).toBe(4);
    for (const r of rot) {
      expect(r).toMatchObject({ home: 'B', other: 'A', rotated: true, early: true, punished: true, stayed: false, hitSite: 'B' });
      expect(r.info.A).toBeNull();
      expect(r.info.B?.kind).toBe('plant');
    }
    // Slot 9 (Market) never moved: home B, not rotated, not stayed (the information was on his own site).
    expect(c.table(STRAT_ROTATIONS).find((r) => r.slot === 9)).toMatchObject({ home: 'B', rotated: false, stayed: false });
    const f = find(report(raw, 8), 'strat.rotate');
    checkEvidence(f);
    expect(f?.summary).toContain('4 times you left your site before any information on the other one and they hit yours within 30 s');
    expect(find(report(raw, 9), 'strat.rotate')).toBeUndefined();
  });

  it('staying on A after a plant on B, with nobody on A, is a stay', () => {
    const spec: MirageSpec = { rounds: 3 };
    const raw = mirage(spec);
    for (let k = 0; k < 3; k++) tRound(raw, spec, k, { lane: ['House', 'Apartments'], site: 'B', hitSec: 30, ct: ['BombsiteA', 'BombsiteA', 'CTSpawn', 'BombsiteB', 'Shop'] });
    const rot = ctx(raw).table(STRAT_ROTATIONS).filter((r) => r.slot === 5);
    for (const r of rot) expect(r).toMatchObject({ home: 'A', rotated: false, stayed: true });
    expect(find(report(raw, 5), 'strat.rotate')?.summary).toContain('3 times the information on the other site was there (a plant, a plant, a plant)');
  });
});

describe('both halves, T side and repeats', () => {
  /** Eight rounds, sides swap at round index 4. First half: team A rushes B dry and loses; second: team B hits A via Palace. */
  function twoHalves(): RawDemo {
    const spec: MirageSpec = { rounds: 8, swapAt: 4, winner: (k) => (k < 4 ? 'B' : 'A') };
    const raw = mirage(spec);
    for (let k = 0; k < 8; k++) {
      if (k < 4) tRound(raw, spec, k, { lane: ['House', 'Apartments'], site: 'B', hitSec: 20, plantIt: false, ct: ['BombsiteA', 'CTSpawn', 'Middle', 'BombsiteB', 'BombsiteB'] });
      else tRound(raw, spec, k, { lane: ['PalaceAlley', 'PalaceInterior'], site: 'A', hitSec: 40, ct: ['BombsiteA', 'BombsiteA', 'CTSpawn', 'BombsiteB', 'Shop'] });
    }
    return raw;
  }

  it('splits the halves and reads each side per team', () => {
    const raw = twoHalves();
    const c = ctx(raw);
    expect(halvesOf(c).map((h) => [h.T, h.rounds])).toEqual([['A', [1, 2, 3, 4]], ['B', [5, 6, 7, 8]]]);
    const reps = c.table(STRAT_REPEATS);
    expect(reps.map((r) => `${r.half}${r.side}${r.team}`)).toEqual(['1TA', '1CTB', '2TB', '2CTA']);
    const t1 = reps[0]?.choices.find((x) => x.key === 'site:B');
    expect(t1).toMatchObject({ count: 4, streak: 4, repeats: true });
    expect(reps[0]?.choices.find((x) => x.key === 'dry')?.count).toBe(4);
    expect(reps[2]?.choices.find((x) => x.key === 'via:palace')).toMatchObject({ count: 4, repeats: true });
    const hits = c.table(STRAT_HITS);
    expect(hits.map((h) => `${h.round}${h.site}${h.timing}`)).toEqual(['1Bfast', '2Bfast', '3Bfast', '4Bfast', '5Adefault', '6Adefault', '7Adefault', '8Adefault']);
  });

  it('strat.t_side: dry hits that lose are a fix, with the user named as the entry', () => {
    const rep = report(twoHalves(), 0);
    const f = find(rep, 'strat.t_side');
    checkEvidence(f);
    expect(f?.id).toBe('strat.t_side.dry');
    expect(f?.summary).toContain('Your team hit a site in 4 of 4 T rounds (B 4 times; 4 fast (by 30 s)): 4 hits without a smoke or flash before the entry, 0 won; 0 hits behind utility, 0 won. You entered first 4 times.');
    // Metrics exist for both teams on both sides.
    const entry = rep.metrics.find((m) => m.id === 'strat.t_side.entry_share');
    expect(entry?.value).toBe(1);
    expect(entry?.lobby.filter((v) => Number.isFinite(v)).length).toBe(10);
    expect(rep.charts?.['strat.t_side']?.kind).toBe('boards');
  });

  it('strat.opponent: on CT in the second half, team A sees the Palace habit', () => {
    const rep = report(twoHalves(), 5);
    // Slot 5 is team B: CT in the first half, where team A hit B four times.
    const f = find(rep, 'strat.opponent');
    expect(f).toBeDefined();
    expect(f?.summary).toMatch(/^They (hit B|came through Apartments) in 4 of the 4 rounds of the half/);
  });
});

describe('unknown places and site ids', () => {
  it('an unknown place name is unclassified, counted, never guessed', () => {
    const spec: MirageSpec = { rounds: 1 };
    const raw = mirage(spec);
    tRound(raw, spec, 0, { lane: ['PalaceInterior'], site: 'A', hitSec: 30, ct: ['BombsiteA', 'CTSpawn', 'CTSpawn', 'BombsiteB', 'BombsiteB'] });
    putUnknown(raw, 6, R(0).fe, R(0).end, 'Fountain');
    const c = ctx(raw);
    const g = c.table(STRAT_GRID);
    expect(g.unknown.map((u) => u.name)).toEqual(['Fountain']);
    expect(g.rounds[0]?.zone[6]).toBe(Z_UNKNOWN);
    const s = c.table(STRAT_SETUPS)[0];
    expect(s?.setup.find((x) => x.slot === 6)?.group).toBe('unknown');
    expect(s?.label).toBe('1 A, 2 B, 1 CT, 1 ?');
    expect(setupLabel([])).toBe('');
  });

  it('the plant site comes from the planter\'s place, else from the file\'s site ids', () => {
    const spec: MirageSpec = { rounds: 2 };
    const raw = mirage(spec);
    tRound(raw, spec, 0, { lane: ['House'], site: 'B', hitSec: 20, plantIt: false, ct: [] });
    plant(raw, at(0, 25), 0, 999); // planter on B site, an id the file does not know
    tRound(raw, spec, 1, { lane: ['House'], site: 'B', hitSec: 20, plantIt: false, ct: [] });
    putUnknown(raw, 0, at(1, 24), at(1, 26), 'Fountain');
    plant(raw, at(1, 25), 0, 184); // planter on an unknown place: the id says A
    const g = ctx(raw).table(STRAT_GRID);
    expect(g.rounds.map((r) => r.plantSite)).toEqual(['B', 'A']);
  });

  it('analyze() skips strategy on a map without knowledge', () => {
    const spec: MirageSpec = { rounds: 1 };
    const raw = mirage(spec);
    raw.header.map = 'de_synth';
    const rep = report(raw, 0);
    expect(rep.findings).toEqual([]);
    expect(rep.charts).toBeUndefined();
    expect(rep.metrics.every((m) => !Number.isFinite(m.value))).toBe(true);
  });
});
