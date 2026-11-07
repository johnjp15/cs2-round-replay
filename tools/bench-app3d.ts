/**
 * P1: frame-time benchmark of the 3D page in headless Chromium (docs/app3d.md "Performance").
 *
 *   npm run build:3d && npm run bench:3d [-- --frames 1500] [--only <scenario,…>] [--size 1280x720] [--query "&dpr=1"] [--out <file.json>] [--label <name>]
 *
 * Serves dist-3d/ on port 4182, opens `?bench=1` (src/app3d/bench3d.ts: the page runs its scenarios itself) in
 * headless Chromium with --enable-precise-memory-info (exact heap readings) and prints, per scenario, the
 * main-thread ms per frame (p50 / p95 / p99), the fps-equivalent (1000 / p50), the rate the driver actually ran,
 * the per-phase p50s (input, sim, scene, render, hud), the sim's ms per tick, the draw calls and the heap allocated
 * per frame. The JSON goes to `--out` (default logs/bench-app3d.json).
 *
 * The sandbox's Chromium has no GPU: WebGL is software (SwiftShader / lavapipe), so the GPU's work runs on the same
 * two shared cores and the "ran fps" of the uncapped driver is bounded by it. The phase times are the page's own
 * main-thread work (what a real GPU doesn't take away); they are the numbers to compare.
 */
import { createServer, type Server } from 'node:http';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, loadavg } from 'node:os';
import { chromium } from 'playwright-core';
import type { BenchResult } from '../src/app3d/bench3d';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = 4182;
const ORIGIN = `http://127.0.0.1:${PORT}`;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
const FRAMES = Number(arg('--frames', '1500'));
const [W, H] = arg('--size', '1280x720').split('x').map(Number) as [number, number];
const QUERY = arg('--query', '');
const OUT = resolve(ROOT, arg('--out', 'logs/bench-app3d.json'));
const LABEL = arg('--label', '');
const DIR = resolve(ROOT, 'dist-3d');
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.bin': 'application/octet-stream', '.css': 'text/css' };

function serve(dir: string): Server {
  const s = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    const file = join(dir, path.endsWith('/') ? path + 'index.html' : path);
    try {
      if (!file.startsWith(dir) || !statSync(file).isFile()) throw new Error('not found');
      // Cross-origin isolated: performance.now() at 5 µs resolution instead of 100 µs.
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' });
      res.end(readFileSync(file));
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  s.listen(PORT, '127.0.0.1');
  return s;
}

const f = (x: number): string => x.toFixed(x < 10 ? 3 : 1);

function table(r: BenchResult): string {
  const lines = [
    `| scenario | frame p50 | p95 | p99 | fps-eq (1000/p50) | ran fps | input | sim | scene | render | hud | sim ms/tick (p50 / p99) | draw calls | heap KB/frame |`,
    `| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`,
  ];
  for (const s of r.scenarios) {
    const p = s.report.phases;
    lines.push(
      `| ${s.name} | ${f(s.report.frame.p50)} | ${f(s.report.frame.p95)} | ${f(s.report.frame.p99)} | ${s.report.fpsEquivalent.toFixed(0)} | ${s.fps.toFixed(0)} | ${f(p.input.p50)} | ${f(p.sim.p50)} | ${f(p.scene.p50)} | ${f(p.render.p50)} | ${f(p.hud.p50)} | ${f(s.report.simPerTick.p50)} / ${f(s.report.simPerTick.p99)} | ${s.drawCalls} | ${s.heapBytesPerFrame === null ? '–' : (s.heapBytesPerFrame / 1024).toFixed(2)} |`,
    );
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  if (process.env['CHROMIUM_WEBGL_RENDERER'] === undefined) process.env['CHROMIUM_WEBGL_RENDERER'] = 'lavapipe';
  if (process.env['CHROMIUM_LAVAPIPE_THREADS'] === undefined) process.env['CHROMIUM_LAVAPIPE_THREADS'] = 'auto';
  statSync(join(DIR, 'index.html'));
  const server = serve(DIR);
  const exe = process.env['CHROME_PATH'];
  const args = ['--enable-precise-memory-info'];
  const browser = await chromium.launch(exe === undefined ? { headless: true, args } : { headless: true, executablePath: exe, args });
  const problems: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console error: ${m.text()}`);
    });
    const load0 = loadavg()[0] ?? 0;
    await page.goto(`${ORIGIN}/?bench=${arg('--only', '1')}&frames=${FRAMES}${QUERY}`);
    await page.waitForFunction(() => window.__cs2bench?.done === true, null, { timeout: 900_000, polling: 500 });
    const out = await page.evaluate(() => window.__cs2bench);
    if (out === undefined || out.result === null) throw new Error(`bench failed: ${out?.error ?? 'no result'}`);
    const load1 = loadavg()[0] ?? 0;
    const result = { label: LABEL, date: new Date().toISOString(), load: { before: load0, after: load1, cores: cpus().length }, ...out.result };
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n');
    console.log(`${out.result.renderer} · ${W}×${H} · machine load ${load0.toFixed(1)} → ${load1.toFixed(1)} on ${cpus().length} cores`);
    console.log(table(out.result));
    console.log(`→ ${OUT.replace(ROOT + '/', '')}`);
  } finally {
    await browser.close();
    server.close();
  }
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
}

await main();
