/**
 * Browser parser benchmark: builds a minimal page with Vite (the real worker + WebAssembly bundle), opens it in
 * headless Chrome (playwright-core, CHROME_PATH=/usr/bin/google-chrome), hands it the demo as a File through an
 * <input type=file> (the path a user's drop takes), parses it in the worker and reports wall time per stage, the
 * WebAssembly memory, the page's JS heap and the peak RSS of the whole Chrome process tree; then extrapolates to a
 * 150 MB and a 250 MB demo.
 *   CHROME_PATH=/usr/bin/google-chrome npx tsx tools/coach/bench-parser.ts [demo ...] [--runs N]
 * Default demos: local/demos/test_demo.dem and its .bz2/.zst/.gz siblings when present. Output also goes to
 * logs/coach-parser-bench/result.json.
 */
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { build } from 'vite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = resolve(ROOT, 'logs/coach-parser-bench');
const TEST_DEMO = process.env['COACH_TEST_DEMO'] ?? resolve(ROOT, 'local/demos/test_demo.dem');

const MAIN_TS = `
import { parseDemoWithStats } from '${resolve(ROOT, 'src/coach-parser/index.ts')}';
declare global { interface Window { runBench(): Promise<unknown> } }
window.runBench = async () => {
  const input = document.getElementById('f') as HTMLInputElement;
  const file = input.files![0]!;
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  let heapPeak = mem?.usedJSHeapSize ?? 0;
  const progress: [string, number, number][] = [];
  const t0 = performance.now();
  const timer = setInterval(() => { heapPeak = Math.max(heapPeak, mem?.usedJSHeapSize ?? 0); }, 50);
  const { raw, stats } = await parseDemoWithStats(file, (s, f) => progress.push([s, Math.round(f * 1000) / 1000, Math.round(performance.now() - t0)]));
  const wallMs = performance.now() - t0;
  clearInterval(timer);
  heapPeak = Math.max(heapPeak, mem?.usedJSHeapSize ?? 0);
  let typedBytes = 0;
  for (const v of Object.values(raw.ticks)) if (ArrayBuffer.isView(v)) typedBytes += v.byteLength;
  return {
    wallMs, stats, heapPeakBytes: heapPeak, typedBytes, progressUpdates: progress.length, progress: progress.slice(0, 40),
    ticks: raw.ticks.count, players: raw.players.length, bullets: raw.events.bullets.length, kills: raw.events.kills.length,
    map: raw.header.map,
  };
};
`;
const INDEX_HTML = `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>coach parser bench</title></head>
<body><input id="f" type="file"><script type="module" src="./main.ts"></script></body></html>`;

async function buildPage(): Promise<string> {
  const src = join(OUT, 'page');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'main.ts'), MAIN_TS);
  writeFileSync(join(src, 'index.html'), INDEX_HTML);
  const dist = join(OUT, 'dist');
  await build({
    root: src, base: './', configFile: false, logLevel: 'warn', publicDir: false,
    build: { outDir: dist, emptyOutDir: true, target: 'es2022' },
    worker: { format: 'es' },
  });
  return dist;
}

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css' };
function serve(dir: string): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const p = join(dir, decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/'));
    const f = p.endsWith('/') ? join(p, 'index.html') : p;
    if (!f.startsWith(dir) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' });
    res.end(readFileSync(f));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => {
    const a = server.address();
    ok({ server, url: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/` });
  }));
}

/** Sum of RSS (bytes) of the Chrome process whose command line holds `marker`, and all its descendants. */
function treeRss(marker: string): number {
  const parent = new Map<number, number>();
  let rootPid = -1;
  for (const d of readdirSync('/proc')) {
    const pid = Number(d);
    if (!Number.isInteger(pid)) continue;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      parent.set(pid, ppid);
      if (rootPid < 0 && readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(marker) && !readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--type=')) rootPid = pid;
    } catch { /* process gone */ }
  }
  if (rootPid < 0) return 0;
  let sum = 0;
  for (const pid of parent.keys()) {
    let q = pid, inTree = false;
    for (let hops = 0; hops < 10 && q > 1; hops++) { if (q === rootPid) { inTree = true; break; } q = parent.get(q) ?? 0; }
    if (!inTree) continue;
    try {
      const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
      if (m) sum += Number(m[1]) * 1024;
    } catch { /* gone */ }
  }
  return sum;
}

interface PageResult {
  wallMs: number; heapPeakBytes: number; typedBytes: number; progressUpdates: number; ticks: number; players: number;
  bullets: number; kills: number; map: string; progress: [string, number, number][];
  stats: { stages: Record<string, number>; totalMs: number; wasmMemoryBytes: number; container: string; fileBytes: number; demoBytes: number };
}

const MB = 1048576;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runsAt = args.indexOf('--runs');
  const runs = runsAt >= 0 ? Number(args[runsAt + 1] ?? 1) : 1;
  let demos = args.filter((a, i) => !a.startsWith('--') && (runsAt < 0 || i !== runsAt + 1));
  if (demos.length === 0) demos = [TEST_DEMO, ...['bz2', 'zst', 'gz'].map((e) => `${TEST_DEMO}.${e}`)].filter((p) => existsSync(p));
  if (demos.length === 0) { console.error(`no demo (looked for ${TEST_DEMO})`); process.exit(2); }

  const dist = await buildPage();
  const { server, url } = await serve(dist);
  const userDir = join(tmpdir(), `coach-bench-${process.pid}`);
  const exe = process.env['CHROME_PATH'];
  const ctx = await chromium.launchPersistentContext(userDir, {
    headless: true, args: ['--enable-precise-memory-info'], ...(exe !== undefined ? { executablePath: exe } : {}),
  });
  const results: { demo: string; run: number; idleRssBytes: number; peakRssBytes: number; page: PageResult }[] = [];
  try {
    for (const demo of demos) {
      for (let run = 0; run < runs; run++) {
        const page = await ctx.newPage();
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
        await page.goto(url);
        await page.setInputFiles('#f', demo);
        await new Promise((r) => setTimeout(r, 500));
        const idle = treeRss(userDir);
        let peak = idle;
        const sampler = setInterval(() => { peak = Math.max(peak, treeRss(userDir)); }, 100);
        let r: PageResult;
        try {
          r = await page.evaluate(() => (window as unknown as { runBench(): Promise<unknown> }).runBench()) as PageResult;
        } finally {
          clearInterval(sampler);
        }
        peak = Math.max(peak, treeRss(userDir));
        if (errors.length > 0) console.error('page errors:', errors);
        results.push({ demo, run, idleRssBytes: idle, peakRssBytes: peak, page: r });
        const st = Object.entries(r.stats.stages).map(([k, v]) => `${k} ${(v / 1000).toFixed(2)}`).join(', ');
        console.log(`${demo.split('/').pop()} run ${run + 1}: ${(r.wallMs / 1000).toFixed(2)} s wall (${st}); ` +
          `wasm memory ${(r.stats.wasmMemoryBytes / MB).toFixed(0)} MB; page JS heap peak ${(r.heapPeakBytes / MB).toFixed(0)} MB; ` +
          `Chrome RSS idle ${(idle / MB).toFixed(0)} → peak ${(peak / MB).toFixed(0)} MB (+${((peak - idle) / MB).toFixed(0)}); ` +
          `${r.ticks} ticks × ${r.players}, ${r.bullets} bullets, ${r.progressUpdates} progress updates`);
        await page.close();
      }
    }
  } finally {
    await ctx.close();
    server.close();
    rmSync(userDir, { recursive: true, force: true });
  }

  // Extrapolation from the plain .dem runs (best of the runs): time and the parse's memory scale with the demo's
  // size (ticks × players); the fixed part is the module and Chrome's own baseline.
  const dem = results.filter((x) => x.page.stats.container === 'dem');
  if (dem.length > 0) {
    const best = dem.reduce((a, b) => (b.page.wallMs < a.page.wallMs ? b : a));
    const bytes = best.page.stats.demoBytes;
    const lines: string[] = [];
    for (const target of [150e6, 250e6]) {
      const k = target / bytes;
      lines.push(`${(target / 1e6).toFixed(0)} MB demo (×${k.toFixed(2)}): ~${((best.page.wallMs * k) / 1000).toFixed(0)} s here, ` +
        `wasm memory ~${((best.page.stats.wasmMemoryBytes * k) / MB).toFixed(0)} MB, Chrome RSS growth ~${(((best.peakRssBytes - best.idleRssBytes) * k) / MB).toFixed(0)} MB`);
    }
    console.log('linear extrapolation:\n  ' + lines.join('\n  '));
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'result.json'), JSON.stringify(results.map((x) => ({ ...x, demo: x.demo.split('/').pop() })), null, 1));
}

void main();
