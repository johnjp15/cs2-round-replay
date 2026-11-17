/**
 * K8: look at the strategy tables on the 2D replay, round by round (docs/coach/strategy.md "The nine rounds").
 *
 *   CHROME_PATH=/usr/bin/google-chrome npx tsx tools/coach/strategy-check.ts [--craw file] [--user slot] [--no-build]
 *
 * Builds and serves the page like tools/coach/browser-check.ts, drops the `.craw`, picks the player, then for every
 * played round seeks the replay to three moments the tables name (the setup time, the Ts' first entry into the lane
 * they hit through, and the site entry or the plant) and saves a screenshot of each to logs/coach/strategy/
 * (gitignored: real demos show real names). Prints what the tables say for each round next to the file names, so the
 * two can be compared by eye.
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';
import { createContext } from '../../src/coach/analyze/context';
import { STRAT_HITS } from '../../src/coach/derive/strategy/hits';
import { STRAT_LANES } from '../../src/coach/derive/strategy/lanes';
import { STRAT_SETUPS } from '../../src/coach/derive/strategy/setups';
import { ingestMatch } from '../../src/coach/ingest/index';
import { decodeRawDemo } from '../../src/coach/model/raw-codec';
import { playerLabel } from '../../src/coach/report/format';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = resolve(ROOT, 'logs/coach/strategy');
const argv = process.argv.slice(2);
const arg = (name: string, d: string): string => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? (argv[i + 1] ?? d) : d;
};
const PORT = Number(arg('--port', '4184'));
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CRAW = resolve(arg('--craw', '/home/claude/coach-data/cache/84a1a4191302bdd2a3bbb5a727842093744b1fb1a228aeec630369e44b622cb2.craw'));
const USER = Number(arg('--user', '5'));

interface Engine { track: { round: number } | null; play(on?: boolean): void; seek(t: number): void }
const engine = (): Engine | undefined => (window as unknown as { __coach?: { replay?: Engine } }).__coach?.replay;

async function seekTo(page: Page, tick: number): Promise<void> {
  await page.evaluate(`(() => { const e = window.__coach.replay; e.play(false); e.seek(${tick}); })()`);
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

async function waitForServer(url: string, ms: number): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`server at ${url} did not start`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  if (!argv.includes('--no-build')) {
    const b = spawnSync('npm', ['run', 'build:coach'], { cwd: ROOT, stdio: 'inherit' });
    if (b.status !== 0) throw new Error('build:coach failed');
  }
  const buf = readFileSync(CRAW);
  const raw = decodeRawDemo(CRAW.endsWith('.gz') ? gunzipSync(buf) : buf);
  const match = ingestMatch(raw);
  const ctx = createContext(raw, match);
  const hits = ctx.table(STRAT_HITS);
  const lanes = ctx.table(STRAT_LANES);
  const setups = ctx.table(STRAT_SETUPS);
  const L = (p: number): string => playerLabel(match, p);
  const vite = resolve(ROOT, 'node_modules/vite/bin/vite.js');
  const server: ChildProcess = spawn(process.execPath, [vite, 'preview', '--config', 'vite.coach.config.ts', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
  try {
    await waitForServer(ORIGIN + '/', 15_000);
    const exe = process.env['CHROME_PATH'];
    const browser = await chromium.launch(exe === undefined ? { headless: true } : { headless: true, executablePath: exe });
    const page = await (await browser.newContext({ viewport: { width: 1360, height: 960 } })).newPage();
    await page.goto(ORIGIN + '/');
    await page.setInputFiles('[data-testid="file-input"]', CRAW);
    await page.waitForSelector('[data-testid="picker"]', { timeout: 60_000 });
    await page.click(`[data-testid="pick"][data-slot="${USER}"]`);
    await page.waitForFunction(() => {
      const e = (window as unknown as { __coach?: { replay?: { track: unknown; map: unknown } } }).__coach?.replay;
      return e !== undefined && e.track !== null && e.map !== null;
    }, undefined, { timeout: 60_000 });
    void engine;
    for (const h of hits) {
      const n = h.round;
      await page.click(`.rounds a[href$="/r/${n}"]`);
      await page.waitForFunction((x) => (window as unknown as { __coach: { replay?: Engine } }).__coach.replay?.track?.round === x, n);
      const s = setups.find((x) => x.round === n);
      const r = match.rounds.find((x) => x.number === n);
      const fe = r?.freezeEndTick ?? 0;
      const sec = (t: number | null): string => (t === null ? '-' : `${Math.round((t - fe) / 64)}s`);
      const via = lanes.filter((l) => l.round === n && h.lanes.includes(l.laneId));
      const moments: [string, number | null][] = [
        ['setup', s?.setupTick ?? null],
        ['lane', via[0]?.firstTTick ?? null],
        ['entry', h.entryTick],
        ['plant', h.plantTick],
      ];
      const files: string[] = [];
      for (const [what, tick] of moments) {
        if (tick === null) continue;
        await seekTo(page, tick);
        const f = `r${n}-${what}-${sec(tick)}.png`;
        await page.locator('[data-testid="replay-canvas"]').screenshot({ path: join(OUT, f) });
        files.push(f);
      }
      console.log(`R${n}: hit ${h.site ?? 'none'} at ${sec(h.entryTick)} with ${h.committed.map(L).join(',')} via ${h.lanes.join('+') || '-'}; plant ${h.plantSite ?? '-'} ${sec(h.plantTick)}; setup ${s?.label}; lanes: ${lanes.filter((l) => l.round === n && l.taken).map((l) => `${l.laneId}${l.contested ? '(c)' : '(open)'}`).join(' ')}; winner ${r?.winnerSide}`);
      console.log(`     ${files.join('  ')}`);
    }
    await browser.close();
  } finally {
    server.kill();
  }
}

main().catch((e: unknown) => { console.error(e); process.exitCode = 1; });
