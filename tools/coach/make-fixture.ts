/**
 * Build the committed fixture tests/coach/fixtures/test-demo-r4.craw.gz from the public test demo:
 * every event, projectile, inventory and the scoreboard; the full tick grid of one round (`--round`, default 4); and
 * from every other round only the rows ingest reads (start, freeze end, end, and each blind's tick, ±1). Players are
 * renamed T1…T5 / CT1…CT5 by the side they start on, Steam IDs replaced by fake ones (the repo is public).
 *
 *   npm run coach -- parse local/demos/test_demo.dem      (once, writes the cache)
 *   tsx tools/coach/make-fixture.ts [--round 4]
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { allocTicks, PLAYER_COLUMNS, TEAM_T, TICK_COLUMNS, rowAtOrAfter } from '../../src/coach/model/raw';
import type { RawDemo, RawTicks } from '../../src/coach/model/raw';
import { decodeRawDemo, encodeRawDemo } from '../../src/coach/model/raw-codec';
import { ingestMatch } from '../../src/coach/ingest/index';
import { TEST_DEMO, TEST_DEMO_PATH } from './fetch-test-demo';
import { parseDemoNode } from './parse-node';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Keep only the given rows of a tick grid. */
export function selectRows(ticks: RawTicks, P: number, rows: number[]): RawTicks {
  const out = allocTicks(rows.length, P);
  rows.forEach((t, k) => {
    for (const c of Object.keys(TICK_COLUMNS) as (keyof typeof TICK_COLUMNS)[]) out[c][k] = ticks[c][t] ?? 0;
    for (const c of Object.keys(PLAYER_COLUMNS) as (keyof typeof PLAYER_COLUMNS)[]) {
      out[c].set(ticks[c].subarray(t * P, t * P + P), k * P);
    }
  });
  return out;
}

/** Replace names and Steam IDs: T1…T5 / CT1…CT5 by the side at the first present row. */
export function anonymize(raw: RawDemo): RawDemo {
  const P = raw.players.length;
  const side: number[] = raw.players.map((_, p) => {
    for (let t = 0; t < raw.ticks.count; t++) if (raw.ticks.present[t * P + p] === 1) return raw.ticks.team[t * P + p] ?? 0;
    return 0;
  });
  let nt = 0, nct = 0;
  const players = raw.players.map((pl, p) => {
    const name = side[p] === TEAM_T ? `T${++nt}` : `CT${++nct}`;
    return { steamId: pl.bot ? `BOT-${name}` : `7656119900000${String(p + 1).padStart(4, '0')}`, name, bot: pl.bot };
  });
  return { ...raw, players };
}

function main(): void {
  const k = process.argv.indexOf('--round');
  const roundNumber = k >= 0 ? Number(process.argv[k + 1]) : 4;
  const cache = resolve(ROOT, `local/coach-cache/${TEST_DEMO.sha256}.craw`);
  let raw: RawDemo;
  try {
    raw = decodeRawDemo(readFileSync(cache));
  } catch {
    raw = parseDemoNode(TEST_DEMO_PATH).raw;
  }
  const match = ingestMatch(raw);
  const P = raw.players.length;
  const rows = new Set<number>();
  const addTick = (tick: number): void => {
    const t = rowAtOrAfter(raw.ticks, tick);
    for (const d of [-1, 0, 1]) if (t + d >= 0 && t + d < raw.ticks.count) rows.add(t + d);
  };
  for (const r of match.rounds) {
    if (r.number === roundNumber) for (let t = r.rowStart; t < r.rowEnd; t++) rows.add(t);
    addTick(r.startTick);
    if (r.freezeEndTick !== null) addTick(r.freezeEndTick);
    addTick(r.endTick);
  }
  for (const b of raw.events.blinds) addTick(b.tick);
  rows.add(raw.ticks.count - 1);
  const sorted = [...rows].sort((a, b) => a - b);
  const fixture = anonymize({ ...raw, ticks: selectRows(raw.ticks, P, sorted) });
  const bytes = gzipSync(encodeRawDemo(fixture), { level: 9 });
  const out = resolve(ROOT, `tests/coach/fixtures/test-demo-r${roundNumber}.craw.gz`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bytes);
  console.log(`${out}: ${sorted.length} rows, ${(bytes.length / 1048576).toFixed(2)} MB, sha256 ${createHash('sha256').update(bytes).digest('hex')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
