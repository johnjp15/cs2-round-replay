/**
 * KM: the callout vocabulary of a demo (docs/coach/maps.md "Place names"). awpy-data's navs carry no place names, so
 * the demos are the source: every living player's `last_place_name` on every sampled tick, with the player-tick count,
 * centroid and bounding box of the positions seen under each name.
 *
 *   npx tsx tools/coach/places-report.ts [demo.dem] [--every 1] [--out data/coach/maps/<map>/places.json]
 *
 * Without --out the JSON goes to stdout. Only live play counts (round_freeze_end → round_end). Sorted by name, so the
 * same demo gives the same file.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadDemoParser } from './los-check';

export const PLACES_FORMAT = 'coach-places@1';

interface Acc {
  n: number;
  sx: number;
  sy: number;
  sz: number;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

const r1 = (v: number): number => Math.round(v);

function main(argv: readonly string[]): void {
  let demo = '/home/claude/coach-data/demos/test_demo.dem';
  let every = 1;
  let out: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--every') every = Number(argv[++i]);
    else if (a === '--out') out = argv[++i] ?? null;
    else demo = a;
  }
  const parser = loadDemoParser();
  const bytes = new Uint8Array(readFileSync(demo));
  const sha = createHash('sha256').update(bytes).digest('hex');
  const header = (parser as unknown as { parseHeader(p: string): Record<string, unknown> }).parseHeader(demo);
  const map = String(header['map_name'] ?? 'unknown');
  const ev = parser.parseEvents(demo, ['round_freeze_end', 'round_end']).sort((a, b) => (a['tick'] as number) - (b['tick'] as number));
  const ticks: number[] = [];
  let start: number | null = null;
  for (const e of ev) {
    if (e['event_name'] === 'round_freeze_end') start = e['tick'] as number;
    else if (start !== null) {
      for (let t = start; t < (e['tick'] as number); t += every) ticks.push(t);
      start = null;
    }
  }
  const acc = new Map<string, Acc>();
  let rows = 0;
  // In chunks of ticks, to keep the parser's row objects bounded.
  const CHUNK = 4000;
  for (let c = 0; c < ticks.length; c += CHUNK) {
    for (const r of parser.parseTicks(demo, ['X', 'Y', 'Z', 'last_place_name', 'is_alive'], ticks.slice(c, c + CHUNK))) {
      if (r['is_alive'] !== true || typeof r['X'] !== 'number') continue;
      rows++;
      const name = String(r['last_place_name'] ?? '');
      const x = r['X'] as number;
      const y = r['Y'] as number;
      const z = r['Z'] as number;
      let a = acc.get(name);
      if (a === undefined) {
        a = { n: 0, sx: 0, sy: 0, sz: 0, minX: x, minY: y, minZ: z, maxX: x, maxY: y, maxZ: z };
        acc.set(name, a);
      }
      a.n++;
      a.sx += x;
      a.sy += y;
      a.sz += z;
      a.minX = Math.min(a.minX, x);
      a.minY = Math.min(a.minY, y);
      a.minZ = Math.min(a.minZ, z);
      a.maxX = Math.max(a.maxX, x);
      a.maxY = Math.max(a.maxY, y);
      a.maxZ = Math.max(a.maxZ, z);
    }
  }
  const places = [...acc.keys()]
    .sort()
    .map((name) => {
      const a = acc.get(name) as Acc;
      return { name, playerTicks: a.n, centroid: { x: r1(a.sx / a.n), y: r1(a.sy / a.n), z: r1(a.sz / a.n) }, bounds: { minX: r1(a.minX), minY: r1(a.minY), minZ: r1(a.minZ), maxX: r1(a.maxX), maxY: r1(a.maxY), maxZ: r1(a.maxZ) } };
    });
  const report = {
    format: PLACES_FORMAT,
    map,
    note: 'Callout names (last_place_name) seen in demos, with living-player ticks during live play, centroid and bounding box (Source units, feet origins). Built by tools/coach/places-report.ts.',
    sources: [{ demoSha256: sha, bytes: bytes.length, ticks: ticks.length, every, playerTicks: rows }],
    places,
  };
  const text = JSON.stringify(report, null, 1) + '\n';
  if (out === null) process.stdout.write(text);
  else {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out), text);
    console.log(`${map}: ${places.length} place names from ${rows} player-ticks → ${out}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
