/**
 * F1: first-person frames of the 3D app at given moments (docs/fights.md "Before / after"), through its deterministic
 * test API (docs/app3d.md "Test API"): freeze, seekTick, eyes, render. Prints each camera's yaw / pitch.
 *
 *   npm run build:3d && npx tsx tools/fight-shots.ts [--dist dist-3d] [--at lokier:12.55,cart:18.3] [--out logs/fights] [--tag after]
 *
 * Serves the build on port 4187 and opens it in headless Chromium (as tools/browser-check3d.ts).
 */
import { createServer, type Server } from 'node:http';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = 4187;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.bin': 'application/octet-stream', '.css': 'text/css' };

function serve(dir: string): Server {
  const s = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    const file = join(dir, path.endsWith('/') ? path + 'index.html' : path);
    try {
      if (!file.startsWith(dir) || !statSync(file).isFile()) throw new Error('not found');
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(readFileSync(file));
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  s.listen(PORT, '127.0.0.1');
  return s;
}

async function main(): Promise<void> {
  if (process.env['CHROMIUM_WEBGL_RENDERER'] === undefined) process.env['CHROMIUM_WEBGL_RENDERER'] = 'lavapipe';
  if (process.env['CHROMIUM_LAVAPIPE_THREADS'] === undefined) process.env['CHROMIUM_LAVAPIPE_THREADS'] = 'auto';
  const dir = resolve(ROOT, arg('--dist', 'dist-3d'));
  const tag = arg('--tag', 'shot');
  const at = arg('--at', 'lokier:12.55,cart:18.3,sp4rtan:58.75')
    .split(',')
    .map((s) => {
      const [id, t] = s.split(':');
      return { id: id as string, t: Number(t) };
    });
  const out = resolve(ROOT, arg('--out', 'logs/fights'));
  mkdirSync(out, { recursive: true });
  statSync(join(dir, 'index.html'));
  const server = serve(dir);
  const exe = process.env['CHROME_PATH'];
  const browser = await chromium.launch(exe === undefined ? { headless: true } : { headless: true, executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.waitForFunction(() => window.__cs2sim3d !== undefined, null, { timeout: 180_000 });
    await page.waitForFunction(() => (window.__cs2sim3d?.stats().triangles ?? 0) > 0, null, { timeout: 120_000 });
    for (const { id, t } of [...at].sort((a, b) => a.t - b.t)) {
      const tick = Math.round(t * 64);
      const st = (await page.evaluate(
        ({ id, tick }) => {
          const api = (window.__cs2sim3d as unknown as { test: Record<string, (...a: unknown[]) => unknown> }).test;
          api['freeze']?.(true);
          api['seekTick']?.(tick);
          api['eyes']?.(id);
          return api['render']?.();
        },
        { id, tick },
      )) as { tick: number; camera: { yaw: number; pitch: number } };
      const file = join(out, `${tag}-${id}-${t.toFixed(2)}.png`);
      // The render only: hide the HUD and the menu (DOM overlays: everything that neither is nor holds #view).
      await page.evaluate(() => {
        const view = document.querySelector('#view');
        for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) if (view !== null && el !== view && !el.contains(view)) el.style.visibility = 'hidden';
      });
      await page.locator('#view').screenshot({ path: file });
      console.log(`${tag} ${id} ${t.toFixed(2)} s (tick ${st.tick}): yaw ${st.camera.yaw.toFixed(2)} pitch ${st.camera.pitch.toFixed(2)} → ${file}`);
    }
  } finally {
    await browser.close();
    server.close();
  }
}

void main();
