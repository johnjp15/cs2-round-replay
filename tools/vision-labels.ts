/**
 * The labelled vision set (C4 / A5): pairs of points that must see each other (taken from the recording) and pairs
 * that must not (hand-picked), checked against the sight mask. tests/vision.test.ts asserts on the same set.
 *
 *   npx tsx tools/vision-labels.ts            # prints the report, writes logs/vision-labels.png
 *   npx tsx tools/vision-labels.ts --write    # also rewrites the fixture tests/fixtures/vision-labels.json
 *
 * Must see (shooter or observer → target, at that moment):
 * - every kill (`kpos` → `vpos`) and every damage entry with `apos` and `vpos`;
 * - every `sightings[]` entry: each T named in `by` (alive then) → the sighted CT, both from the tracks at `t0`.
 *   When `by` names several players and the recording's camera (`pov`) follows one of them at t0, only that one
 *   counts: the sighting starts on that player's screen (58.6 s, "cart / barely": barely's POV; cart, in Shop
 *   behind the Market wall, sees Sp4rtaN only later in the window).
 * A pair is *untrusted* (listed, not asserted) when an end isn't backed by an `observed` track sample: for kills and
 * damage, no observed sample of that player within ±0.1 s and 16 units of the position; for sightings, the track
 * sample at t0 (or either sample it is interpolated from) is estimated or inferred. Pairs in EXCLUDED (wallbangs and
 * the like, each with its evidence) are listed and not asserted either.
 *
 * Must not see: MUST_NOT_SEE below, each with its justification.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLAYER_IDS, parseRound, parseTuning, type PlayerId, type RoundData, type TrackSample, type Vec3 } from '../src/contracts/index';
import { NavMesh, navOptionsFromTuning } from '../src/sim2d/nav';
import { Sight, VisMask, sightOptionsFromTuning, visOptionsFromTuning } from '../src/sim2d/vision';
import { drawLine, encodePng, marker } from './png';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const LABELS_PATH = 'tests/fixtures/vision-labels.json';

/** Track samples within this many seconds of an event can back a kill or damage position… */
const TRUST_WINDOW_SEC = 0.1;
/** …if they are observed and this close (2D units). */
const TRUST_RADIUS = 16;

export interface Pair {
  readonly id: string;
  readonly a: Vec3;
  readonly b: Vec3;
}

export interface MustSee extends Pair {
  readonly source: 'kill' | 'damage' | 'sighting';
  readonly t: number;
  readonly from: PlayerId;
  readonly to: PlayerId;
  /** Both ends backed by observed track samples. */
  readonly trusted: boolean;
  /** Why the pair is not asserted (untrusted position, wallbang, …), or null. */
  readonly excluded: string | null;
}

export interface MustNotSee extends Pair {
  readonly why: string;
}

export interface VisionLabels {
  readonly note: string;
  readonly mustSee: readonly MustSee[];
  readonly mustNotSee: readonly MustNotSee[];
}

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

/**
 * Hand-picked pairs that must not see each other. Each crosses solid, full-height walls on the map (not just a
 * nav hole), checked on the radar and in-game layout knowledge of Mirage.
 */
export const MUST_NOT_SEE: readonly MustNotSee[] = [
  { id: 'shop-bplant', a: v(-2364, -674, -168), b: v(-1982, 311, -160), why: 'Shop (Market) is a room south of B; its north wall (radar: a 2–3 px black line plus a solid block) stands between it and the plant spot' },
  { id: 'underpass-catwalk', a: v(-983, 328, -368), b: v(-726, 243, -172), why: 'the Underpass runs under Catwalk, 196 units lower: the Catwalk floor is between them (the 2D mask alone sees through; the level check blocks)' },
  { id: 'tspawn-ctspawn', a: v(1245, -342, -186), b: v(-1700, -1800, -250), why: 'T spawn and CT spawn are at opposite ends of the map; Palace, A and Jungle buildings lie between' },
  { id: 'backalley-palacealley', a: v(-391, 909, -92), b: v(785, -1144, -264), why: 'Back Alley (north, behind Apartments) and Palace Alley (south) are separated by House, T spawn buildings and Top of Mid walls' },
  { id: 'bsite-asite', a: v(-1939, 209, -166), b: v(-365, -1947, -173), why: 'B and A sites are ~2,700 units apart with Market, CT spawn and Jungle buildings in between' },
  { id: 'apartments-mid', a: v(-1381, 683, -67), b: v(-432, -702, -240), why: 'the Apartments corridor is indoors upstairs; Mid is reached only through Underpass or Catwalk, round two building corners' },
  { id: 'palace-jungle', a: v(738, -2010, -69), b: v(-1075, -1396, -166), why: 'Palace interior is a closed building; its only openings face A site from the balcony, not Jungle behind Connector' },
  { id: 'house-tramp', a: v(323, 786, -136), b: v(320, -1562, -200), why: 'House (north T side) and T Ramp (south) are separated by the T spawn and Top of Mid blocks' },
  { id: 'ticketbooth-tspawn', a: v(-973, -2414, -170), b: v(1245, -342, -186), why: 'Ticket Booth (CT side of A) and T spawn: Palace and the T spawn walls block the line' },
  { id: 'snipersnest-bsite', a: v(-1207, -865, -168), b: v(-1939, 209, -166), why: "Sniper's Nest (window room) looks into Mid, not toward B; Market and the B building walls block" },
  { id: 'bplant-tunnel', a: v(-1982, 311, -160), b: v(-1006, -115, -352), why: 'B plant and the Underpass tunnel: the tunnel is underground behind the Catwalk/Short walls' },
  { id: 'truck-jungle', a: v(-2219, 727, -118), b: v(-1075, -1396, -166), why: 'Truck (back of B) and Jungle: B site, Market and CT spawn walls in between' },
];

/**
 * Trusted must-see pairs that fail, investigated and excluded from the assertion, with the evidence. None is a
 * wallbang; all four are barely's recorded position. `npx tsx tools/vision-labels.ts` prints each one's numbers.
 */
const WRONG_LEVEL =
  "level (not a wallbang): barely's recorded spot is on the Tunnel Stairs (z -315 / -328), behind the stairwell's 5-cell south wall " +
  '(radar y 271-276, no nav area there) and 143 units below Zwomp on Catwalk; in 3D too his eye (z -251) is below the Catwalk floor ' +
  '(-172) at that wall, so nobody standing there sees Catwalk. His track then jumps 89 units and +154 z onto Catwalk in 0.1 s at ' +
  '44.7 s (B3 discontinuity): the recorded spot is wrong and he fired from the top of the stairs at Catwalk level.';
const PILLAR =
  'position (not a wallbang): the line runs 4.6 cells (23 units) inside the south edge of the pillar at the east end of B site ' +
  '(radar x 341-351, y 269-283; a hole in the nav mesh too), 90 units from barely; moving barely 25-28 units sideways clears it. ' +
  'His track holds y 310-312 from 58.2 to 58.8 s while he "runs back toward the bomb" (narrative, 57.6 s), which lies due west at ' +
  'y 311: that straight run goes through the pillar, so he was south of it. The pillar is 55 x 75 units, far beyond AK penetration.';
export const EXCLUDED: Readonly<Record<string, string>> = {
  'kill@44.2 barely->zwomp': WRONG_LEVEL,
  'sighting@44 barely->zwomp': WRONG_LEVEL,
  'kill@58.85 sp4rtan->barely': PILLAR,
  'sighting@58.6 barely->sp4rtan': PILLAR,
};

// ---- building the set -----------------------------------------------------------------------------

function samplesOf(round: RoundData, id: PlayerId): TrackSample[] {
  const tr = round.tracks[id];
  if (tr === undefined) return [];
  return [...tr.samples, ...tr.offGridSamples].sort((p, q) => p.t - q.t);
}

/** An observed sample of `id` within ±TRUST_WINDOW_SEC of t and TRUST_RADIUS of p. */
function backed(round: RoundData, id: PlayerId, t: number, p: Vec3): boolean {
  return samplesOf(round, id).some((s) => Math.abs(s.t - t) <= TRUST_WINDOW_SEC + 1e-9 && s.confidence === 'observed' && Math.hypot(s.x - p.x, s.y - p.y) <= TRUST_RADIUS);
}

/** Track position at t: the sample at t if there is one, else linear between its neighbours (observed only if both are). */
export function trackAt(round: RoundData, id: PlayerId, t: number): { pos: Vec3; observed: boolean } | null {
  const ss = samplesOf(round, id);
  const exact = ss.find((s) => Math.abs(s.t - t) < 1e-9);
  if (exact !== undefined) return { pos: v(exact.x, exact.y, exact.z), observed: exact.confidence === 'observed' };
  const i = ss.findIndex((s) => s.t > t);
  if (i <= 0) return null;
  const p = ss[i - 1] as TrackSample;
  const q = ss[i] as TrackSample;
  const f = (t - p.t) / (q.t - p.t);
  const lerp = (a: number, b: number): number => Math.round(a + (b - a) * f);
  return { pos: v(lerp(p.x, q.x), lerp(p.y, q.y), lerp(p.z, q.z)), observed: p.confidence === 'observed' && q.confidence === 'observed' };
}

function fmtT(t: number): string {
  return String(Math.round(t * 1000) / 1000);
}

/** Derive the must-see pairs from the round (deterministic order: kills, damage, sightings, each in file order). */
export function buildMustSee(round: RoundData): MustSee[] {
  const out: MustSee[] = [];
  const add = (p: Omit<MustSee, 'excluded'>): void => {
    const reason = EXCLUDED[p.id] ?? null;
    out.push({ ...p, excluded: reason ?? (p.trusted ? null : 'untrusted position (estimated or inferred track)') });
  };
  for (const k of round.kills) {
    add({ id: `kill@${fmtT(k.t)} ${k.killer}->${k.victim}`, source: 'kill', t: k.t, from: k.killer, to: k.victim, a: k.kpos, b: k.vpos, trusted: backed(round, k.killer, k.t, k.kpos) && backed(round, k.victim, k.t, k.vpos) });
  }
  for (const d of round.damage) {
    if (d.apos === null || d.vpos === null || d.attacker === null) continue;
    add({ id: `damage@${fmtT(d.t)} ${d.attacker}->${d.victim}`, source: 'damage', t: d.t, from: d.attacker, to: d.victim, a: d.apos, b: d.vpos, trusted: backed(round, d.attacker, d.t, d.apos) && backed(round, d.victim, d.t, d.vpos) });
  }
  for (const s of round.sightings) {
    const target = trackAt(round, s.who, s.t0);
    if (target === null) continue;
    const named = PLAYER_IDS.filter((id) => new RegExp(`\\b${id}\\b`).test(s.by));
    const pov = round.pov.find((q) => q.t0 <= s.t0 + 1e-9 && s.t0 < q.t1 - 1e-9)?.target ?? null;
    const by = named.length > 1 && pov !== null && named.includes(pov) ? [pov] : named;
    for (const obs of by) {
      const player = round.players.find((p) => p.id === obs);
      if (player === undefined || player.team === round.players.find((p) => p.id === s.who)?.team) continue;
      if (player.deathT !== null && player.deathT < s.t0) continue;
      const from = trackAt(round, obs, s.t0);
      if (from === null) continue;
      add({ id: `sighting@${fmtT(s.t0)} ${obs}->${s.who}`, source: 'sighting', t: s.t0, from: obs, to: s.who, a: from.pos, b: target.pos, trusted: from.observed && target.observed });
    }
  }
  return out;
}

export function buildLabels(round: RoundData): VisionLabels {
  return {
    note: 'Generated by tools/vision-labels.ts (--write) from data/round.json and its hand-picked list; tests/vision.test.ts checks the mask against it. docs/vision.md.',
    mustSee: buildMustSee(round),
    mustNotSee: MUST_NOT_SEE,
  };
}

export function labelsJsonText(labels: VisionLabels): string {
  return JSON.stringify(labels, null, 2) + '\n';
}

// ---- evaluation -----------------------------------------------------------------------------------

export interface LoadedVision {
  readonly round: RoundData;
  readonly nav: NavMesh;
  readonly mask: VisMask;
  /** Mask plus the level check: what `sees` uses. */
  readonly sight: Sight;
}

export function loadVision(): LoadedVision {
  const read = (rel: string): unknown => JSON.parse(readFileSync(resolve(ROOT, rel), 'utf8')) as unknown;
  const tuning = parseTuning(read('data/tuning.json'));
  const nav = NavMesh.fromJson(read('data/mirage-nav.json'), navOptionsFromTuning(tuning));
  const mask = VisMask.fromJson(read('data/mirage-vismask.json'), visOptionsFromTuning(tuning.ai));
  return { round: parseRound(read('data/round.json')), nav, mask, sight: new Sight(mask, nav, sightOptionsFromTuning(tuning)) };
}

export interface PairResult {
  readonly id: string;
  /**
   * Smallest sideways shift (units, perpendicular to the line, either end, either side, up to MAX_SHIFT) that flips
   * the mask's answer, with which end moved; null if none within MAX_SHIFT. Small for must-see failures caused by
   * position error, large for robust must-not-see pairs.
   */
  readonly flip: { readonly units: number; readonly end: 'a' | 'b' } | null;
  readonly kind: 'see' | 'not';
  readonly asserted: boolean;
  /** The answer that counts: Sight.lineOfSight (2D mask and the level check, standing eyes). */
  readonly visible: boolean;
  /** The 2D mask alone. */
  readonly mask: boolean;
  readonly nav: boolean;
  readonly maxRunPx: number;
  readonly runAt: { readonly x: number; readonly y: number } | null;
  readonly note: string;
}

/** Largest sideways shift tried by `flipShift` (units). */
export const MAX_SHIFT = 96;

/** See PairResult.flip. */
export function flipShift(mask: VisMask, a: Vec3, b: Vec3): { units: number; end: 'a' | 'b' } | null {
  const base = mask.lineOfSight(a, b);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len === 0) return null;
  const nx = -(b.y - a.y) / len;
  const ny = (b.x - a.x) / len;
  for (let d = 1; d <= MAX_SHIFT; d++) {
    for (const s of [1, -1]) {
      const sa = { x: a.x + nx * d * s, y: a.y + ny * d * s, z: a.z };
      if (mask.lineOfSight(sa, b) !== base) return { units: d, end: 'a' };
      const sb = { x: b.x + nx * d * s, y: b.y + ny * d * s, z: b.z };
      if (mask.lineOfSight(a, sb) !== base) return { units: d, end: 'b' };
    }
  }
  return null;
}

export function evaluate(labels: VisionLabels, sight: Sight, nav: NavMesh): PairResult[] {
  const mask = sight.mask;
  if (mask === null) throw new Error('evaluate: needs a sight mask');
  const out: PairResult[] = [];
  const one = (p: Pair, kind: 'see' | 'not', asserted: boolean, note: string): PairResult => {
    const tr = mask.trace(p.a, p.b);
    return { id: p.id, flip: flipShift(mask, p.a, p.b), kind, asserted, visible: sight.lineOfSight(p.a, p.b), mask: tr.visible, nav: nav.lineOfSight(p.a, p.b), maxRunPx: tr.maxRunPx, runAt: tr.runAt, note };
  };
  for (const p of labels.mustSee) out.push(one(p, 'see', p.excluded === null, p.excluded ?? ''));
  for (const p of labels.mustNotSee) out.push(one(p, 'not', true, p.why));
  return out;
}

export function reportTable(results: readonly PairResult[]): string {
  const lines = [
    '| pair | expect | asserted | sight | 2D mask | nav LOS | longest wall run (cells) | mask flips with a shift of | note |',
    '| --- | --- | --- | --- | --- | --- | ---: | --- | --- |',
  ];
  const yn = (b: boolean): string => (b ? 'visible' : 'blocked');
  for (const r of results) {
    const ok = r.kind === 'see' ? r.visible : !r.visible;
    const flip = r.flip === null ? `> ${MAX_SHIFT} u` : `${r.flip.units} u (${r.flip.end === 'a' ? 'from' : 'to'})`;
    lines.push(`| ${r.id} | ${r.kind === 'see' ? 'see' : 'not see'} | ${r.asserted ? 'yes' : 'no'} | ${yn(r.visible)}${r.asserted && !ok ? ' **FAIL**' : ''} | ${yn(r.mask)} | ${yn(r.nav)} | ${r.maxRunPx.toFixed(1)} | ${flip} | ${r.note} |`);
  }
  const see = results.filter((r) => r.kind === 'see' && r.asserted);
  const not = results.filter((r) => r.kind === 'not');
  const n = (xs: readonly PairResult[], f: (r: PairResult) => boolean): number => xs.filter(f).length;
  lines.push('');
  lines.push(
    `must see (asserted): ${n(see, (r) => r.visible)} / ${see.length} visible (2D mask ${n(see, (r) => r.mask)}, nav LOS ${n(see, (r) => r.nav)}); ` +
      `must not see: ${n(not, (r) => r.visible)} / ${not.length} visible (2D mask ${n(not, (r) => r.mask)}, nav LOS ${n(not, (r) => r.nav)})`,
  );
  return lines.join('\n');
}

/** The mask over the radar with the pairs: must-see green (visible) / red (blocked), must-not-see blue (blocked) / magenta (visible). */
export function labelsImage(labels: VisionLabels, results: readonly PairResult[], mask: VisMask, radarRgba: Uint8Array): Uint8Array {
  const w = mask.width;
  const h = mask.height;
  const out = new Uint8Array(radarRgba);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (!mask.isWallCell(i, j)) continue;
      const k = (j * w + i) * 4;
      for (let c = 0; c < 3; c++) out[k + c] = Math.round((out[k + c] as number) * 0.45 + (c === 0 ? 150 : 0) * 0.55);
    }
  }
  const pairs: Pair[] = [...labels.mustSee, ...labels.mustNotSee];
  pairs.forEach((p, n) => {
    const r = results[n] as PairResult;
    const color: [number, number, number] = r.kind === 'see' ? (r.visible ? [40, 230, 60] : [255, 40, 40]) : r.visible ? [255, 0, 255] : [60, 140, 255];
    const a = mask.toPx(p.a);
    const b = mask.toPx(p.b);
    drawLine(out, w, h, a.px, a.py, b.px, b.py, color, r.asserted ? 1 : 0.5);
    marker(out, w, h, a.px, a.py, 2, color);
    marker(out, w, h, b.px, b.py, 2, color);
  });
  return out;
}

async function main(): Promise<void> {
  const write = process.argv.includes('--write');
  const { round, nav, mask, sight } = loadVision();
  const labels = buildLabels(round);
  const results = evaluate(labels, sight, nav);
  console.log(reportTable(results));
  if (write) {
    const p = resolve(ROOT, LABELS_PATH);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, labelsJsonText(labels), 'utf8');
    console.log(`wrote ${p}`);
  }
  const { default: jpeg } = await import('jpeg-js');
  const img = jpeg.decode(readFileSync(resolve(ROOT, 'data/mirage-radar.jpg')), { useTArray: true, formatAsRGBA: true });
  const png = resolve(ROOT, 'logs/vision-labels.png');
  mkdirSync(dirname(png), { recursive: true });
  writeFileSync(png, encodePng(mask.width, mask.height, labelsImage(labels, results, mask, new Uint8Array(img.data))));
  console.log(`wrote ${png}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main();
}
