/**
 * K8: check a map knowledge file (data/coach/knowledge/<map>.json) against a demo (docs/coach/strategy.md
 * "Checking a new demo").
 *
 *   npx tsx tools/coach/knowledge-check.ts <demo.dem | file.craw[.gz]> [--strict]
 *
 * Prints: the place names the demo used during live play with their player-samples and the zone each falls in;
 * `unknown` names (used by the demo, missing from the file: unclassified until someone adds them); `unused` names
 * (in the file, never seen in this demo); and the bomb-site ids of the plants with the site their planter stood on,
 * for the file's `checkedAgainst[].siteIds`. With --strict it exits 1 when a name is unknown or a site id disagrees.
 * Prints no player names.
 */
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createContext } from '../../src/coach/analyze/context';
import { STRAT_GRID } from '../../src/coach/derive/strategy/grid';
import { checkPlaces, knowledgeFor, PlaceLookup } from '../../src/coach/derive/strategy/knowledge';
import { ingestMatch } from '../../src/coach/ingest/index';
import { FLAG, rowAtOrAfter } from '../../src/coach/model/raw';
import type { RawDemo } from '../../src/coach/model/raw';
import { decodeRawDemo } from '../../src/coach/model/raw-codec';
import { parseDemoNode } from './parse-node';

function load(input: string): RawDemo {
  if (!existsSync(input)) throw new Error(`no such file: ${input}`);
  if (/\.craw(\.gz)?$/.test(input)) {
    const buf = readFileSync(input);
    return decodeRawDemo(input.endsWith('.gz') ? gunzipSync(buf) : buf);
  }
  return parseDemoNode(input).raw;
}

function main(argv: readonly string[]): number {
  const input = argv.find((a) => !a.startsWith('--'));
  const strict = argv.includes('--strict');
  if (input === undefined) {
    console.error('usage: knowledge-check <demo.dem | file.craw[.gz]> [--strict]');
    return 2;
  }
  const raw = load(input);
  const map = raw.header.map;
  const k = knowledgeFor(map);
  if (k === null) {
    console.log(`${map}: no knowledge file (data/coach/knowledge/${map}.json). Strategy detectors are off for this map.`);
    return strict ? 1 : 0;
  }
  const match = ingestMatch(raw);
  const P = raw.players.length;
  // Live-play samples per place id (freeze end to round end, living players).
  const count = new Map<number, number>();
  for (const r of match.rounds) {
    if (!r.played || r.freezeEndTick === null) continue;
    const a = rowAtOrAfter(raw.ticks, r.freezeEndTick);
    const b = rowAtOrAfter(raw.ticks, r.endTick + 1);
    for (let t = a; t < b; t++) for (let p = 0; p < P; p++) {
      const i = t * P + p;
      if (raw.ticks.present[i] !== 1 || ((raw.ticks.flags[i] ?? 0) & FLAG.alive) === 0) continue;
      const id = raw.ticks.place[i] ?? 0;
      count.set(id, (count.get(id) ?? 0) + 1);
    }
  }
  const lookup = new PlaceLookup(k, raw.names.places);
  const used = [...count.keys()].map((id) => raw.names.places[id] ?? '').filter((n) => n !== '');
  const res = checkPlaces(k, used);
  console.log(`${map} (${k.verified ? 'verified' : 'DRAFT, unverified'}), demo ${raw.header.demoSha256.slice(0, 12)}: ${used.length} place names used, ${res.classified} classified, ${res.unknown.length} unknown, ${res.unused.length} unused`);
  console.log('\nplace                     samples  zone');
  const rows = [...count.entries()].map(([id, n]) => ({ name: raw.names.places[id] ?? '', n, z: lookup.zoneOfPlace[id] ?? -1 })).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  for (const r of rows) {
    const zone = r.name === '' ? '(no name)' : r.z >= 0 ? (lookup.zone(r.z)?.id ?? '?') : 'UNKNOWN';
    console.log(`${(r.name || "''").padEnd(24)} ${String(r.n).padStart(8)}  ${zone}`);
  }
  if (res.unknown.length > 0) console.log(`\nunknown (add to a zone; until then unclassified): ${res.unknown.join(', ')}`);
  if (res.unused.length > 0) console.log(`unused (in the file, not in this demo): ${res.unused.join(', ')}`);
  // Site ids of the plants.
  const ctx = createContext(raw, match);
  const grid = ctx.table(STRAT_GRID);
  const ids = new Map<number, Set<string>>();
  for (const g of grid.rounds) {
    if (g.round.bomb.plantTick === null) continue;
    const s = ids.get(g.round.bomb.site) ?? new Set<string>();
    s.add(g.plantSite ?? '?');
    ids.set(g.round.bomb.site, s);
  }
  let bad = false;
  const known = new Map<string, string>();
  for (const c of k.checkedAgainst) for (const [id, s] of Object.entries(c.siteIds)) known.set(id, s);
  console.log('\nplant site ids (from the planter\'s place):');
  for (const [id, s] of [...ids.entries()].sort((a, b) => a[0] - b[0])) {
    const list = [...s].sort().join('/');
    const file = known.get(String(id));
    const note = file === undefined ? 'not in the file' : file === list ? 'matches the file' : `the file says ${file}`;
    if (s.size > 1 || (file !== undefined && file !== list)) bad = true;
    console.log(`  site ${id} → ${list}  (${note})`);
  }
  if (ids.size === 0) console.log('  no plants in this demo');
  if (grid.unknown.length > 0) console.log(`\nunclassified strategy samples: ${grid.unknown.map((u) => `${u.name} ${u.samples}`).join(', ')}`);
  return strict && (res.unknown.length > 0 || bad) ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
