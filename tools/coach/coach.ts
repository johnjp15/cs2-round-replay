/**
 * The coach CLI.
 *
 *   npm run coach -- parse <demo> [--out file]   parse with the native parser, write the RawDemo cache
 *   npm run coach -- inspect <demo|cache> [--fresh]   header, rounds, scoreboard and reconciliation
 *   npm run coach -- report <demo|cache> --user <name|slot|A1…B5> [--no-los] [--fresh]
 *        analyze for one player: prints the top fixes (numbers, lobby ranks, evidence moments), strengths and the
 *        lobby table of every metric; writes the report JSON to local/coach-reports/. Loads the map pack's sight
 *        mesh (data/coach/maps/<map>/los.bin.gz) when it exists.
 *
 * The cache lives in local/coach-cache/<sha256 of the demo>.craw (gitignored). `inspect` uses it when present unless
 * `--fresh` is given; a `.craw` or `.craw.gz` path is read directly.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { decodeRawDemo, encodeRawDemo } from '../../src/coach/model/raw-codec';
import type { RawDemo } from '../../src/coach/model/raw';
import { ingestMatch, reconcile, STAT_KEYS } from '../../src/coach/ingest/index';
import { analyze, reportJson } from '../../src/coach/analyze/index';
import { LosWorld } from '../../src/coach/derive/los';
import type { Match } from '../../src/coach/model/match';
import type { MatchReport } from '../../src/coach/model/report';
import { confidenceText, lobbyRankText, metricValue, playerLabel, roundClock } from '../../src/coach/report/format';
import { parseDemoNode } from './parse-node';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CACHE_DIR = resolve(ROOT, 'local/coach-cache');

const mb = (n: number): string => `${(n / 1048576).toFixed(1)} MB`;

function cachePath(demo: string): string {
  const sha = createHash('sha256').update(readFileSync(demo)).digest('hex');
  return resolve(CACHE_DIR, `${sha}.craw`);
}

function parseAndCache(demo: string, out?: string): RawDemo {
  const { raw, stats } = parseDemoNode(demo, {
    onProgress: (phase, done) => { if (phase !== 'ticks' || done === 1) process.stderr.write(`  ${phase} ${(done * 100).toFixed(0)}%\n`); },
  });
  const bytes = encodeRawDemo(raw);
  const path = out ?? resolve(CACHE_DIR, `${raw.header.demoSha256}.craw`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  console.log(`parsed in ${(stats.ms / 1000).toFixed(1)} s, peak RSS ${stats.peakRssMb.toFixed(0)} MB, ${stats.chunks} tick chunks`);
  console.log(`RawDemo: ${raw.ticks.count} ticks × ${raw.players.length} players; ${mb(bytes.length)} on disk → ${path}`);
  return raw;
}

function load(input: string, fresh: boolean): RawDemo {
  if (/\.craw(\.gz)?$/.test(input)) {
    const buf = readFileSync(input);
    return decodeRawDemo(input.endsWith('.gz') ? gunzipSync(buf) : buf);
  }
  const cache = cachePath(input);
  if (!fresh && existsSync(cache)) {
    console.log(`(cache ${cache})`);
    return decodeRawDemo(readFileSync(cache));
  }
  return parseAndCache(input);
}

function pad(s: string | number, n: number): string {
  const t = String(s);
  return t.length >= n ? t : t + ' '.repeat(n - t.length);
}
function lpad(s: string | number, n: number): string {
  const t = String(s);
  return t.length >= n ? t : ' '.repeat(n - t.length) + t;
}

function inspect(raw: RawDemo): boolean {
  const t0 = performance.now();
  const match = ingestMatch(raw);
  const recon = reconcile(raw, match);
  const h = raw.header;
  console.log(`\n${h.map} · ${h.source} · patch ${h.patch ?? '?'} · ${h.tickRate} tick · ${h.parser}`);
  console.log(`server: ${h.server}`);
  console.log(`demo: ${h.bytes} bytes, sha256 ${h.demoSha256}`);
  let typed = 0;
  for (const v of Object.values(raw.ticks)) if (ArrayBuffer.isView(v)) typed += v.byteLength;
  console.log(`ticks: ${raw.ticks.count} rows (${raw.ticks.tick[0]}–${raw.ticks.tick[raw.ticks.count - 1]}) × ${raw.players.length} players = ${mb(typed)} of typed arrays`);
  const ev = raw.events as unknown as Record<string, unknown[]>;
  console.log(`events: ${Object.keys(ev).map((k) => `${k} ${ev[k]?.length ?? 0}`).join(', ')}`);
  console.log(`projectiles ${raw.projectiles.length}, inventories ${raw.inventories.length}`);
  console.log(`\nscore A ${match.meta.score.A} – ${match.meta.score.B} B (game: ${match.meta.gameScore.A}–${match.meta.gameScore.B}); winner ${match.meta.winner ?? 'none'}${match.meta.surrendered ? `; ${match.meta.surrendered} surrendered` : ''}`);
  for (const n of match.meta.notes) console.log(`note: ${n}`);

  console.log(`\n${pad('#', 4)}${pad('played', 7)}${pad('kind', 11)}${pad('start', 7)}${pad('frz end', 8)}${pad('end', 7)}${pad('T', 3)}${pad('CT', 4)}${pad('winner', 10)}${pad('reason', 15)}${pad('score', 7)}${pad('bomb', 18)}economy A | B`);
  for (const r of match.rounds) {
    const bomb = r.bomb.plantTick === null ? '' : `plant ${r.bomb.plantTick}${r.bomb.defuseTick !== null ? ' def' : r.bomb.explodeTick !== null ? ' boom' : ''}`;
    const eco = (t: 'A' | 'B'): string => `${r.economy[t].buy} $${r.economy[t].equipValue}`;
    console.log(
      `${pad(r.number, 4)}${pad(r.played ? 'yes' : 'no', 7)}${pad(r.kind, 11)}${pad(r.startTick, 7)}${pad(r.freezeEndTick ?? '-', 8)}${pad(r.endTick, 7)}` +
      `${pad(r.sides.T, 3)}${pad(r.sides.CT, 4)}${pad(r.winner ? `${r.winner} (${r.winnerSide})` : '-', 10)}${pad(r.reasonName, 15)}` +
      `${pad(`${r.scoreAfter.A}-${r.scoreAfter.B}`, 7)}${pad(bomb, 18)}${eco('A')} | ${eco('B')}`,
    );
  }

  const short: Record<string, string> = { kills: 'K', deaths: 'D', assists: 'A', damage: 'DMG', headshotKills: 'HS', enemiesFlashed: 'EF', utilityDamage: 'UD' };
  console.log(`\nscoreboard at tick ${recon.tick} (ours; [demo] where it differs)`);
  console.log(`${pad('slot', 5)}${pad('team', 5)}${pad('name', 20)}${STAT_KEYS.map((k) => lpad(short[k] ?? k, 10)).join('')}`);
  const order = [...recon.rows].sort((a, b) => (match.players[a.p]?.team ?? '').localeCompare(match.players[b.p]?.team ?? '') || (b.ours.damage - a.ours.damage));
  for (const r of order) {
    const pl = match.players[r.p];
    const cells = STAT_KEYS.map((k) => {
      const d = r.demo?.[k];
      return lpad(d === undefined || d === r.ours[k] ? `${r.ours[k]}` : `${r.ours[k]} [${d}]`, 10);
    }).join('');
    console.log(`${pad(r.p, 5)}${pad(pl?.team ?? '?', 5)}${pad((pl?.name ?? '').slice(0, 19), 20)}${cells}`);
  }
  console.log(`\nreconciliation: ${recon.ok ? 'OK: kills, deaths, assists, damage, headshot kills and utility damage match the demo for every player' : `${recon.mismatches} differing (player, stat) pairs in K/D/A/DMG/HS/UD`}`);
  console.log(`enemies flashed (approximate, docs/coach/contracts.md "Reconciliation"): ${recon.flashMismatches} of ${recon.rows.length} players differ`);
  console.log(`ingest + reconcile ${(performance.now() - t0).toFixed(0)} ms; peak RSS ${mb(process.resourceUsage().maxRSS * 1024)}`);
  return recon.ok;
}

/** A slot from a slot number, an anonymous label (A1…B5) or a (case-insensitive, unique) part of a name. */
function resolveUser(match: Match, who: string): number {
  if (/^\d+$/.test(who)) return Number(who);
  const byLabel = match.players.find((p) => playerLabel(match, p.slot) === who.toUpperCase());
  if (byLabel) return byLabel.slot;
  const hits = match.players.filter((p) => p.name.toLowerCase().includes(who.toLowerCase()));
  if (hits.length === 1 && hits[0]) return hits[0].slot;
  throw new Error(`--user ${who}: ${hits.length === 0 ? 'no player matches' : `${hits.length} players match`}`);
}

function loadLos(map: string): LosWorld | null {
  const f = resolve(ROOT, `data/coach/maps/${map}/los.bin.gz`);
  if (!existsSync(f)) return null;
  return LosWorld.fromBytes(new Uint8Array(gunzipSync(readFileSync(f))));
}

function fmtValue(v: number, unit: string): string {
  return metricValue(v, unit);
}

function printReport(rep: MatchReport, match: Match): void {
  const byId = new Map(rep.findings.map((f) => [f.id, f]));
  const show = (id: string, k: number, kind: string): void => {
    const f = byId.get(id);
    if (!f) return;
    const sc = f.scoring;
    const why = sc ? `impact ${sc.rawImpact.toFixed(2)} × excess ${sc.excess.toFixed(2)} = ${f.impact.toFixed(2)}; confidence ${sc.confidence.toFixed(2)} (${confidenceText(sc.confidence)}); fixability ${sc.fixability}; recurrence ${sc.recurrence}` : `impact ${f.impact.toFixed(2)} × confidence ${f.confidence.toFixed(2)}`;
    console.log(`\n${kind} ${k}. ${f.title}   [${f.id}; ${why}; priority ${f.priority.toFixed(2)}]`);
    console.log(`   ${f.summary}`);
    if (f.why) console.log(`   why: ${f.why}`);
    for (const m of f.metrics) console.log(`   · ${m.id} = ${fmtValue(m.value, m.unit)} (n ${m.n}), ${lobbyRankText(m) || 'unranked'} in the lobby`);
    for (const a of f.advice) console.log(`   → ${a.text}${a.drill ? ` Drill: ${a.drill}` : ''}`);
    for (const e of f.evidence) console.log(`   ▶ ${e.kind} ${roundClock(match, e.focus)} (ticks ${e.tick0}–${e.tick1}, focus ${e.focus}): ${e.caption}`);
  };
  console.log(`\nreport for ${playerLabel(match, rep.user)} (slot ${rep.user}): ${rep.findings.length} findings, ${rep.metrics.length} metrics`);
  rep.topFixes.forEach((id, k) => show(id, k + 1, 'FIX'));
  rep.strengths.forEach((id, k) => show(id, k + 1, 'STRENGTH'));
  const others = rep.findings.filter((f) => !rep.topFixes.includes(f.id) && !rep.strengths.includes(f.id));
  if (others.length > 0) console.log(`\nother findings: ${others.map((f) => `${f.id} (${f.polarity}, ${f.priority.toFixed(2)})`).join(', ')}`);
  const slots = match.players.map((p) => p.slot).sort((a, b) => playerLabel(match, a).localeCompare(playerLabel(match, b)));
  console.log(`\nlobby (value / rank):\n${pad('metric', 40)}${slots.map((s) => lpad(playerLabel(match, s), 13)).join('')}`);
  for (const m of rep.metrics) {
    console.log(`${pad(m.id, 40)}${slots.map((s) => lpad(fmtValue(m.lobby[s] ?? NaN, m.unit), 13)).join('')}`);
  }
}

function report(raw: RawDemo, who: string, useLos: boolean): void {
  const t0 = performance.now();
  const match = ingestMatch(raw);
  const user = resolveUser(match, who);
  const los = useLos ? loadLos(raw.header.map) : null;
  const t1 = performance.now();
  const rep = analyze(raw, match, { user, los });
  const t2 = performance.now();
  printReport(rep, match);
  const dir = resolve(ROOT, 'local/coach-reports');
  mkdirSync(dir, { recursive: true });
  const out = resolve(dir, `${raw.header.demoSha256.slice(0, 12)}-${playerLabel(match, user)}.json`);
  writeFileSync(out, reportJson(rep, 1));
  console.log(`\ningest + map pack ${(t1 - t0).toFixed(0)} ms (sight mesh ${los ? 'loaded' : 'not loaded'}); analyze ${(t2 - t1).toFixed(0)} ms; peak RSS ${mb(process.resourceUsage().maxRSS * 1024)}`);
  console.log(`report JSON → ${out}`);
}

function main(): void {
  const [cmd, input, ...rest] = process.argv.slice(2);
  if (!cmd || !input || !['parse', 'inspect', 'report'].includes(cmd)) {
    console.error('usage: coach parse <demo> [--out file] | coach inspect <demo|file.craw> [--fresh] | coach report <demo|file.craw> --user <name|slot|A1…B5> [--no-los]');
    process.exit(2);
  }
  if (cmd === 'report') {
    const k = rest.indexOf('--user');
    const who = k >= 0 ? rest[k + 1] : undefined;
    if (who === undefined) {
      console.error('coach report: --user <name|slot|A1…B5> is required');
      process.exit(2);
    }
    report(load(input, rest.includes('--fresh')), who, !rest.includes('--no-los'));
    return;
  }
  if (cmd === 'parse') {
    const k = rest.indexOf('--out');
    parseAndCache(input, k >= 0 ? rest[k + 1] : undefined);
    console.log(`peak RSS ${mb(process.resourceUsage().maxRSS * 1024)}`);
    return;
  }
  const ok = inspect(load(input, rest.includes('--fresh')));
  process.exitCode = ok ? 0 : 1;
}

main();
