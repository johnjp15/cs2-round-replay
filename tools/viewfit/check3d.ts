/**
 * V2: the 3D app's first-person view at given moments, through its deterministic test API (docs/app3d.md "Test API"):
 * the camera's yaw / pitch from a player's eyes against the recorded view in data/round.json, and a screenshot of each
 * (for the view-fit contact sheets, tools/viewfit/sheets.py --app3d).
 *
 *   npm run build:3d && npx tsx tools/viewfit/check3d.ts [--at cart:59.5,cart:18.8] [--out logs/viewfit/app3d]
 *
 * Serves dist-3d/ on port 4186 and opens it in headless Chromium (as tools/browser-check3d.ts). Exits 1 when the
 * camera pitch at a moment with a recorded video view differs from it (at that tick or the one before) by more than 0.5° (the puppet's turn limit
 * reaches any fitted view within a few ticks; B3's aim overrides it during scripted engagements, listed separately).
 */
import { createServer, type Server } from 'node:http';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import type { RoundData, ViewSample } from '../../src/contracts/index';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const PORT = 4186;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DIR = resolve(ROOT, 'dist-3d');

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

/** The recorded view at t (linear between two video samples at most 0.1 s apart), or null. */
function recordedView(view: readonly ViewSample[], t: number): { yaw: number; pitch: number } | null {
  for (let i = 0; i + 1 < view.length; i++) {
    const a = view[i] as ViewSample;
    const b = view[i + 1] as ViewSample;
    if (Math.abs(a.t - t) < 1e-9 && a.pitch !== null && a.source === 'video') return { yaw: a.yaw, pitch: a.pitch };
    if (a.t <= t && t <= b.t && b.t - a.t <= 0.1 + 1e-9 && a.source === 'video' && b.source === 'video' && a.pitch !== null && b.pitch !== null) {
      const f = (t - a.t) / (b.t - a.t);
      const dy = ((((b.yaw - a.yaw) % 360) + 540) % 360) - 180;
      return { yaw: a.yaw + dy * f, pitch: a.pitch + (b.pitch - a.pitch) * f };
    }
  }
  return null;
}

interface CamState {
  tick: number;
  t: number;
  camera: { mode: string; followed: string | null; eye: { x: number; y: number; z: number }; yaw: number; pitch: number; vfovDeg: number; hfovDeg: number };
}

async function main(): Promise<void> {
  if (process.env['CHROMIUM_WEBGL_RENDERER'] === undefined) process.env['CHROMIUM_WEBGL_RENDERER'] = 'lavapipe';
  if (process.env['CHROMIUM_LAVAPIPE_THREADS'] === undefined) process.env['CHROMIUM_LAVAPIPE_THREADS'] = 'auto';
  const at = arg('--at', 'cart:58.85,cart:59.5,cart:59.6,cart:18.4,donk:35.0,barely:53.0,cart:66.1,eradicate:5.0')
    .split(',')
    .map((s) => {
      const [id, t] = s.split(':');
      return { id: id as string, t: Number(t) };
    });
  const out = resolve(ROOT, arg('--out', 'logs/viewfit/app3d'));
  mkdirSync(out, { recursive: true });
  const round = JSON.parse(readFileSync(resolve(ROOT, 'data/round.json'), 'utf8')) as RoundData;
  statSync(join(DIR, 'index.html'));
  const server = serve(DIR);
  const exe = process.env['CHROME_PATH'];
  const browser = await chromium.launch(exe === undefined ? { headless: true } : { headless: true, executablePath: exe });
  const rows: Record<string, unknown>[] = [];
  let failed = false;
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await page.goto(`${ORIGIN}/`);
    await page.waitForFunction(() => window.__cs2sim3d !== undefined, null, { timeout: 120_000 });
    await page.waitForFunction(() => (window.__cs2sim3d?.stats().triangles ?? 0) > 0, null, { timeout: 60_000 });
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
      )) as CamState;
      const file = join(out, `${id}-${t.toFixed(3)}.png`);
      await page.locator('#view').screenshot({ path: file });
      const view = round.tracks[id as keyof RoundData['tracks']]?.view ?? [];
      const rec = recordedView(view, st.t);
      // The pawn's pitch at a tick is the one its input set on the tick before: compare with both.
      const prev = recordedView(view, st.t - 1 / 64);
      const engaged = round.shots.some((s) => s.shooter === id && s.t !== null && Math.abs(s.t - st.t) < 0.35);
      const dp = rec === null ? null : Math.min(Math.abs(st.camera.pitch - rec.pitch), prev === null ? Infinity : Math.abs(st.camera.pitch - prev.pitch));
      const ok = dp === null || engaged || dp <= 0.5;
      if (!ok) failed = true;
      rows.push({ id, t: st.t, tick: st.tick, cameraYaw: st.camera.yaw, cameraPitch: st.camera.pitch, vfov: st.camera.vfovDeg, recorded: rec, engaged, ok, file });
      console.log(`${id} ${st.t.toFixed(3)} s (tick ${st.tick}): camera yaw ${st.camera.yaw.toFixed(2)} pitch ${st.camera.pitch.toFixed(2)}; recorded ${rec === null ? 'none' : `yaw ${rec.yaw.toFixed(2)} pitch ${rec.pitch.toFixed(2)}`}${engaged ? ' (scripted aim)' : ''} ${ok ? 'ok' : 'MISMATCH'}`);
    }
  } finally {
    await browser.close();
    server.close();
  }
  writeFileSync(join(out, 'check3d.json'), JSON.stringify(rows, null, 2) + '\n');
  if (failed) process.exitCode = 1;
}

void main();
