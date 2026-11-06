/**
 * Vision (C4 / A5): the sight mask built from the radar, its line of sight, the level check, and the key
 * acceptance — the labelled set (tests/fixtures/vision-labels.json; tools/vision-labels.ts): every trusted recorded
 * engagement and sighting visible, every hand-picked blocked pair blocked. Also `sees` (contract F5) and its cost.
 * Run with --reporter=verbose to see the report table.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PLAYER_IDS, type Action, type PlayerId, type Vec3 } from '../src/contracts/index';
import { Sim2DHost } from '../src/sim2d/host';
import { NavMesh, navOptionsFromTuning } from '../src/sim2d/nav';
import { Sight, VisMask, computeSees, decodeVisMaskJson, encodeRow, sightOptionsFromTuning, type SeePawn } from '../src/sim2d/vision';
import { MASK_PATH, RADAR_PATH, buildMask, maskJsonText } from '../tools/extract-vismask';
import { LABELS_PATH, buildLabels, evaluate, labelsJsonText, loadVision, reportTable, type VisionLabels } from '../tools/vision-labels';
import { act } from './combat-fixtures';
import { tuning } from './sim2d-fixtures';

const ROOT = new URL('..', import.meta.url);
const read = (rel: string): string => readFileSync(new URL(rel, ROOT), 'utf8');
const { round, nav, mask, sight } = loadVision();

/** A synthetic mask from rows of '#' (wall) and '.' (open); 1 unit per cell, origin (0, rows). */
function gridMask(rows: string[], wallTol = 1, endTol = 0): VisMask {
  const h = rows.length;
  const w = (rows[0] as string).length;
  const cells = new Uint8Array(w * h);
  rows.forEach((r, j) => [...r].forEach((c, i) => (cells[j * w + i] = c === '#' ? 1 : 0)));
  return new VisMask({ width: w, height: h, unitsPerPx: 1, originX: 0, originY: h, cells }, { wallTolerancePx: wallTol, endpointTolerancePx: endTol });
}
/** World point at the centre of cell (i, j) of a gridMask with `h` rows. */
const at = (i: number, j: number, h: number): Vec3 => ({ x: i + 0.5, y: h - j - 0.5, z: 0 });

describe('sight mask file', () => {
  it('is what tools/extract-vismask.ts builds from the radar (deterministic)', () => {
    const jpg = new Uint8Array(readFileSync(new URL(RADAR_PATH, ROOT)));
    const doc = JSON.parse(read(MASK_PATH)) as { source: { sha256: string } };
    expect(maskJsonText(buildMask(jpg), doc.source.sha256)).toBe(read(MASK_PATH));
  });

  it('has the radar transform, 5 units per cell, and decodes to the same cells it encodes', () => {
    const doc = JSON.parse(read(MASK_PATH)) as { width: number; height: number; unitsPerPx: number; originX: number; originY: number };
    expect(doc).toMatchObject({ width: 1024, height: 1024, unitsPerPx: 5, originX: -3230, originY: 1713 });
    const g = decodeVisMaskJson(doc);
    for (let j = 0; j < g.height; j += 37) {
      const runs = encodeRow(g.cells, j * g.width, g.width);
      expect(runs.reduce((a, b) => a + b, 0)).toBe(g.width);
    }
    const c = mask.counts();
    expect(c.open + c.wall + c.cover).toBe(1024 * 1024);
    expect(c.cover).toBeGreaterThan(5_000);
    expect(c.open).toBeGreaterThan(250_000);
    expect(c.open).toBeLessThan(400_000);
  });

  it('opens playable spots and walls off out-of-map space', () => {
    for (const p of [
      { x: 1245, y: -342 }, // T spawn
      { x: -1982, y: 311 }, // B plant
      { x: -2387, y: 815 }, // Truck
      { x: -2364, y: -674 }, // Shop
      { x: -391, y: 909 }, // Back Alley
      { x: -726, y: 243 }, // Catwalk
    ]) {
      expect(mask.isOpen(p), JSON.stringify(p)).toBe(true);
    }
    expect(mask.isOpen({ x: -3000, y: 1500 })).toBe(false);
    expect(mask.isOpen({ x: 2000, y: -3000 })).toBe(false);
    expect(mask.isOpen({ x: -99999, y: 0 })).toBe(false);
  });
});

describe('VisMask.lineOfSight (DDA with tolerances)', () => {
  const rows = ['..........', '..........', '....#.....', '....#.....', '..........', '...##.....', '...##.....', '..........'];
  const m = gridMask(rows);
  const h = rows.length;

  it('a wall one cell thick crossed straight is within the 1-cell tolerance; two cells block', () => {
    expect(m.lineOfSight(at(1, 2, h), at(8, 2, h))).toBe(true);
    expect(m.lineOfSight(at(1, 5, h), at(8, 5, h))).toBe(false);
    expect(m.trace(at(1, 5, h), at(8, 5, h)).maxRunPx).toBeCloseTo(2, 6);
  });

  it('grazing a corner does not block; open space is visible; out of the grid is wall', () => {
    expect(m.lineOfSight({ x: 0.5, y: h - 4.9 }, { x: 9.5, y: h - 4.1 })).toBe(true);
    expect(m.lineOfSight(at(0, 0, h), at(9, 0, h))).toBe(true);
    expect(m.lineOfSight({ x: -5, y: 1 }, { x: 5, y: 1 })).toBe(false);
  });

  it('is exactly symmetric', () => {
    for (let k = 0; k < 200; k++) {
      const a = { x: (k * 37) % 10 + 0.3, y: ((k * 11) % 8) + 0.6 };
      const b = { x: (k * 53) % 10 + 0.7, y: ((k * 29) % 8) + 0.2 };
      expect(m.lineOfSight(a, b)).toBe(m.lineOfSight(b, a));
    }
  });

  it('a wall run touching an end of the segment may be up to the endpoint tolerance', () => {
    const e = gridMask(['###.......'], 1, 3);
    expect(e.lineOfSight({ x: 0.5, y: 0.5 }, { x: 9.5, y: 0.5 })).toBe(true); // 2.5 cells from the start
    const e0 = gridMask(['###.......'], 1, 2);
    expect(e0.lineOfSight({ x: 0.5, y: 0.5 }, { x: 9.5, y: 0.5 })).toBe(false);
  });

  it('on Mirage: the Apartments window (cart → Lokier) is open, Shop → B plant is walled', () => {
    expect(mask.lineOfSight({ x: -1764, y: 794 }, { x: -2139, y: 439 })).toBe(true);
    expect(nav.lineOfSight({ x: -1764, y: 794 }, { x: -2139, y: 439 })).toBe(false);
    expect(mask.lineOfSight({ x: -2364, y: -674 }, { x: -1982, y: 311 })).toBe(false);
  });
});

describe('Sight level check (nav floors)', () => {
  // A lower floor at z 0 everywhere, and an upper floor (z 200) over x in [100, 300].
  const stacked = new NavMesh(
    {
      places: ['Low', 'High'],
      areas: [
        { id: 0, x1: -1000, y1: -100, x2: 1000, y2: 100, z1: 0, z2: 0, place: 0 },
        { id: 1, x1: 100, y1: -100, x2: 300, y2: 100, z1: 200, z2: 200, place: 1 },
      ],
    },
    navOptionsFromTuning(tuning),
  );
  const s = new Sight(null, stacked, sightOptionsFromTuning(tuning));

  it('blocks a line through a floor slab (below → on top), not along either level', () => {
    expect(s.clear({ x: 0, y: 0, z: 0 }, 64, { x: 250, y: 0, z: 200 }, 64)).toBe(false);
    expect(s.clear({ x: 150, y: 0, z: 0 }, 64, { x: 250, y: 0, z: 0 }, 64)).toBe(true);
    expect(s.clear({ x: 150, y: 0, z: 200 }, 64, { x: 290, y: 0, z: 200 }, 64)).toBe(true);
    expect(s.clear({ x: -500, y: 0, z: 0 }, 64, { x: 0, y: 0, z: 0 }, 64)).toBe(true);
  });

  it('on Mirage: Underpass ↔ Catwalk is blocked by the level check (the 2D mask alone sees through)', () => {
    const a = { x: -983, y: 328, z: -368 };
    const b = { x: -726, y: 243, z: -172 };
    expect(mask.lineOfSight(a, b)).toBe(true);
    expect(sight.lineOfSight(a, b)).toBe(false);
  });
});

describe('labelled set (the acceptance)', () => {
  const fixture = JSON.parse(read(LABELS_PATH)) as VisionLabels;
  const results = evaluate(fixture, sight, nav);

  it('the committed fixture is what tools/vision-labels.ts builds from round.json', () => {
    expect(labelsJsonText(buildLabels(round))).toBe(read(LABELS_PATH));
  });

  it('prints the report (run with --reporter=verbose)', () => {
    console.log(`[vision]\n${reportTable(results)}`);
    expect(fixture.mustNotSee.length).toBeGreaterThanOrEqual(8);
    for (const p of fixture.mustNotSee) expect(p.why.length, p.id).toBeGreaterThan(20);
  });

  it('every asserted must-see pair is visible: 100 %', () => {
    const asserted = results.filter((r) => r.kind === 'see' && r.asserted);
    expect(asserted.length).toBeGreaterThanOrEqual(12);
    expect(asserted.filter((r) => !r.visible).map((r) => r.id)).toEqual([]);
  });

  it('no must-not-see pair is visible', () => {
    expect(results.filter((r) => r.kind === 'not' && r.visible).map((r) => r.id)).toEqual([]);
  });

  it('every excluded pair says why: untrusted positions, or an investigated failure with its evidence', () => {
    for (const p of fixture.mustSee) {
      if (p.excluded === null) {
        expect(p.trusted, p.id).toBe(true);
        continue;
      }
      if (!p.trusted) expect(p.excluded, p.id).toMatch(/^untrusted/);
      else expect(p.excluded, p.id).toMatch(/^(level|position|wallbang) \(/);
    }
    const investigated = fixture.mustSee.filter((p) => p.trusted && p.excluded !== null).map((p) => p.id);
    expect(investigated).toEqual(['kill@44.2 barely->zwomp', 'kill@58.85 sp4rtan->barely', 'sighting@44 barely->zwomp', 'sighting@58.6 barely->sp4rtan']);
  });

  it('the mask beats the nav LOS on the recording (the reason for A5)', () => {
    const asserted = results.filter((r) => r.kind === 'see' && r.asserted);
    expect(asserted.filter((r) => r.nav).length).toBeLessThan(asserted.length);
  });
});

describe('sees (contract F5)', () => {
  const roster = round.players.map((p) => ({ id: p.id, team: p.team }));
  const pawn = (id: PlayerId, x: number, y: number, z: number, yaw: number, extra: Partial<SeePawn> = {}): SeePawn => ({ id, pos: { x, y, z }, yaw, crouching: false, alive: true, blind: false, ...extra });
  const noSmoke = { smokeBlocks: (): boolean => false };
  const opts = { fovDeg: tuning.ai.fovDeg, eyeHeight: tuning.damage.eyeHeight, crouchEyeHeight: tuning.damage.crouchEyeHeight };

  it('lists other alive pawns of both teams in FOV with sight, sorted; not blind viewers; dead see and are seen by nobody', () => {
    // cart in the Apartments window looking at B (yaw toward Lokier), Lokier on B looking back, barely next to cart behind him.
    const cart = pawn('cart', -1764, 794, -48, -136.6);
    const lokier = pawn('lokier', -2139, 439, -161, 43.4);
    const barely = pawn('barely', -1700, 794, -48, 0);
    const out = computeSees([barely, cart, lokier], sight, noSmoke, opts);
    expect(out).toEqual([[], ['lokier'], ['barely', 'cart']]);
    // barely turns toward cart: sees his teammate (teammates count).
    expect(computeSees([{ ...barely, yaw: 180 }, cart, lokier], sight, noSmoke, opts)[0]).toEqual(['cart', 'lokier']);
    // Blind cart sees nothing but is still seen.
    expect(computeSees([barely, { ...cart, blind: true }, lokier], sight, noSmoke, opts)).toEqual([[], [], ['barely', 'cart']]);
    // Dead Lokier: nobody sees him and he sees nothing.
    expect(computeSees([barely, cart, { ...lokier, alive: false }], sight, noSmoke, opts)).toEqual([[], [], []]);
    // Dead cart: Lokier still sees barely.
    expect(computeSees([barely, { ...cart, alive: false }, lokier], sight, noSmoke, opts)).toEqual([[], [], ['barely']]);
    // Smoke between them.
    expect(computeSees([barely, cart, lokier], sight, { smokeBlocks: () => true }, opts)).toEqual([[], [], []]);
  });

  it('Sim2DHost.observe() reports it, with the mask, and matches computeSees', () => {
    const host = new Sim2DHost(nav, tuning, roster, null, { mask, seed: 1 });
    const actions: Action[] = [
      { type: 'teleport', id: 'cart', pos: { x: -1764, y: 794, z: -48 }, yaw: -136.6 },
      { type: 'teleport', id: 'lokier', pos: { x: -2139, y: 439, z: -161 }, yaw: 43.4 },
    ];
    PLAYER_IDS.filter((id) => id !== 'cart' && id !== 'lokier').forEach((id, i) => actions.push({ type: 'set_hp', id, hp: 0, armor: 0, helmet: false }, { type: 'teleport', id, pos: { x: 1000 + i, y: 0, z: 0 }, yaw: 0 }));
    host.apply(act(actions));
    const o = host.observe();
    expect(o.pawns.find((p) => p.id === 'cart')?.sees).toEqual(['lokier']);
    expect(o.pawns.find((p) => p.id === 'lokier')?.sees).toEqual(['cart']);
    for (const p of o.pawns.filter((q) => !q.alive)) expect(p.sees).toEqual([]);
  });

  it('costs < 0.5 ms per tick for 10 viewers × 9 targets (recorded positions over the round)', () => {
    // Every 0.5 s of the recording: all ten pawns alive at their recorded spots, looking along their motion.
    const frames: SeePawn[][] = [];
    for (let t = 0; t <= 70; t += 0.5) {
      frames.push(
        PLAYER_IDS.map((id) => {
          const ss = round.tracks[id]?.samples ?? [];
          const i = Math.max(0, Math.min(ss.length - 1, Math.round(t * 10)));
          const s = ss[i] ?? { x: 0, y: 0, z: 0 };
          const q = ss[Math.min(ss.length - 1, i + 5)] ?? s;
          const yaw = q.x === s.x && q.y === s.y ? (i * 47) % 360 : (Math.atan2(q.y - s.y, q.x - s.x) * 180) / Math.PI;
          return pawn(id, s.x, s.y, s.z, yaw);
        }),
      );
    }
    // Warm up, then time.
    for (const f of frames) computeSees(f, sight, noSmoke, opts);
    const reps = 5;
    const t0 = performance.now();
    let seen = 0;
    for (let r = 0; r < reps; r++) for (const f of frames) seen += computeSees(f, sight, noSmoke, opts).reduce((a, x) => a + x.length, 0);
    const perTick = (performance.now() - t0) / (reps * frames.length);
    console.log(`[vision] sees: ${perTick.toFixed(3)} ms per tick (10 × 9, ${frames.length} frames), ${(seen / reps / frames.length).toFixed(1)} pairs visible per tick`);
    expect(seen).toBeGreaterThan(0);
    expect(perTick).toBeLessThan(0.5);
  });
});
