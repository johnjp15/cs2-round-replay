import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseTuning } from '../src/contracts/tuning';
import { NavMesh, navOptionsFromTuning, type NavPoint } from '../src/sim2d/nav';

const navJson = JSON.parse(readFileSync(new URL('../data/mirage-nav.json', import.meta.url), 'utf8')) as unknown;
const tuningJson = JSON.parse(readFileSync(new URL('../data/tuning.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const tuning = parseTuning(tuningJson);
const nav = NavMesh.fromJson(navJson, navOptionsFromTuning(tuning));

const P = (x: number, y: number): NavPoint => ({ x, y });

const SPOTS: [string, number, number][] = [
  ['B plant spot', -1982, 311],
  ['top of T ramp', 240, -1500],
  ['Apartments window', -1764, 794],
  ['Truck', -2387, 815],
  ['Shop', -2364, -674],
  ['Catwalk', -726, 243],
  ['Tunnel stairs', -786, 391],
  ['Palace Alley', 785, -1144],
  ['Back Alley', -391, 909],
];

function expectWalkablePath(path: NavPoint[] | null): NavPoint[] {
  expect(path).not.toBeNull();
  const p = path as NavPoint[];
  expect(p.length).toBeGreaterThanOrEqual(2);
  for (let i = 1; i < p.length; i++) expect(nav.segmentWalkable(p[i - 1] as NavPoint, p[i] as NavPoint)).toBe(true);
  return p;
}

describe('mirage-nav.json', () => {
  it('has the 27 places and well-formed areas with ids 0..n-1', () => {
    expect(nav.places.length).toBe(27);
    expect(nav.places[0]).toBe('');
    expect(nav.areas.length).toBeGreaterThanOrEqual(903);
    nav.areas.forEach((a, i) => {
      expect(a.id).toBe(i);
      expect(a.x1).toBeLessThan(a.x2);
      expect(a.y1).toBeLessThan(a.y2);
    });
  });
});

describe('NavMesh point queries', () => {
  it.each(SPOTS)('%s is walkable', (_name, x, y) => {
    expect(nav.isWalkable(P(x, y))).toBe(true);
    expect(nav.areaAt(P(x, y))).not.toBeNull();
  });

  it('names places', () => {
    expect(nav.placeName(P(-1982, 311))).toBe('Bombsite B');
    expect(nav.placeName(P(240, -1500))).toBe('T Ramp');
    expect(nav.placeName(P(-786, 391))).toBe('Tunnel Stairs');
    expect(nav.placeName(P(785, -1144))).toBe('Palace Alley');
  });

  it('interpolates floor height', () => {
    expect(Math.abs(nav.zAt(P(-1982, 311)) - -160)).toBeLessThanOrEqual(10);
    expect(Math.abs(nav.zAt(P(-786, 391)) - -318)).toBeLessThanOrEqual(40);
  });

  it('nearestArea snaps an off-mesh point and areaAt returns null there', () => {
    const p = P(-3000, 2000);
    expect(nav.areaAt(p)).toBeNull();
    expect(nav.isWalkable(p)).toBe(false);
    expect(nav.nearestArea(p).id).toBeGreaterThanOrEqual(0);
  });
});

describe('NavMesh paths', () => {
  it('finds B plant spot -> top of T ramp with only walkable segments', () => {
    const p = expectWalkablePath(nav.path(P(-1982, 311), P(240, -1500)));
    const len = NavMesh.pathLength(p);
    // Shortest route in this mesh is B -> Shop (Market) -> CT Spawn -> Jungle -> Bombsite A -> T Ramp (~3,580 units);
    // see docs/nav.md for why this is not the 5,000-6,500 originally expected.
    expect(len).toBeGreaterThan(Math.hypot(240 - -1982, -1500 - 311));
    expect(len).toBeLessThan(4200);
    expect(p[0]).toMatchObject({ x: -1982, y: 311 });
    expect(p[p.length - 1]).toMatchObject({ x: 240, y: -1500 });
  });

  it("Sp4rtaN's flank route is connected leg by leg", () => {
    const route: [number, number][] = [
      [-463, -1675], // Bombsite A
      [240, -1500], // T Ramp
      [785, -1144], // Palace Alley
      [1245, -342], // T Spawn
      [1050, 495], // Side Alley
      [413, 800], // House
      [-311, 662], // Back Alley
      [-1068, 748], // Apartments
    ];
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1] as [number, number];
      const b = route[i] as [number, number];
      expectWalkablePath(nav.path(P(a[0], a[1]), P(b[0], b[1])));
    }
  });

  it('is deterministic', () => {
    const a = nav.path(P(-1982, 311), P(240, -1500));
    const b = nav.path(P(-1982, 311), P(240, -1500));
    expect(a).toEqual(b);
    const fresh = NavMesh.fromJson(navJson, navOptionsFromTuning(tuning));
    expect(fresh.path(P(-1982, 311), P(240, -1500))).toEqual(a);
  });

  it('returns a two-point path inside one area', () => {
    const p = nav.path(P(-2000, 350), P(-2050, 400));
    expect(p?.length).toBe(2);
  });
});

describe('NavMesh line of sight', () => {
  it("Truck sees down the Apartments corridor (Lokier's line)", () => {
    expect(nav.lineOfSight(P(-2387, 815), P(-1138, 783))).toBe(true);
  });

  it('Shop does not see B plant spot', () => {
    expect(nav.lineOfSight(P(-2364, -674), P(-1982, 311))).toBe(false);
  });

  it('is symmetric on the reference lines', () => {
    expect(nav.lineOfSight(P(-1138, 783), P(-2387, 815))).toBe(true);
    expect(nav.lineOfSight(P(-1982, 311), P(-2364, -674))).toBe(false);
  });

  it('runs 50 checks in well under 1 ms', () => {
    const pts: NavPoint[] = [];
    for (let i = 0; i < 100; i++) {
      const a = nav.areas[(i * 97) % nav.areas.length];
      if (a !== undefined) pts.push(P((a.x1 + a.x2) / 2, (a.y1 + a.y2) / 2));
    }
    const run = (): number => {
      const t0 = performance.now();
      for (let i = 0; i < 50; i++) nav.lineOfSight(pts[2 * i] as NavPoint, pts[2 * i + 1] as NavPoint);
      return performance.now() - t0;
    };
    run(); // warm up
    let best = Infinity;
    for (let r = 0; r < 5; r++) best = Math.min(best, run());
    expect(best).toBeLessThan(1);
  });
});

describe('NavMesh clampMove', () => {
  it('returns the target when the move is clear', () => {
    expect(nav.clampMove(P(-2000, 350), P(-2050, 400))).toMatchObject({ x: -2050, y: 400 });
  });

  it('slides along the wall from inside Shop toward a point deep in the wall', () => {
    const from = P(-2300, -662);
    const to = P(-2450, -800);
    expect(nav.isWalkable(from)).toBe(true);
    expect(nav.isWalkable(to)).toBe(false);
    const r = nav.clampMove(from, to);
    expect(nav.isWalkable(r)).toBe(true);
    expect(Math.hypot(r.x - from.x, r.y - from.y)).toBeGreaterThan(20);
    // Ends nearer the target than it started.
    expect(Math.hypot(r.x - to.x, r.y - to.y)).toBeLessThan(Math.hypot(from.x - to.x, from.y - to.y));
  });

  it('from the Shop reference spot also ends walkable after moving', () => {
    const from = P(-2364, -674);
    const r = nav.clampMove(from, P(-2600, -760));
    expect(nav.isWalkable(r)).toBe(true);
    expect(Math.hypot(r.x - from.x, r.y - from.y)).toBeGreaterThan(10);
  });
});

describe('navOptionsFromTuning', () => {
  it('reads data/tuning.json nav section', () => {
    expect(navOptionsFromTuning(tuning)).toEqual({ stepHeight: 18, edgeEpsilon: 1, losMargin: 8 });
  });

  it('rejects a missing key (validated by parseTuning)', () => {
    const broken = { ...tuningJson, nav: { stepHeight: 18, edgeEpsilon: 1 } };
    expect(() => navOptionsFromTuning(parseTuning(broken))).toThrow(/nav\.losMargin/);
  });
});
