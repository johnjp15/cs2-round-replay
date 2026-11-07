/**
 * V0 video parity: screenshots of the built apps at given video seconds (Playwright, headless Chrome).
 *
 * 2D: `dist/` served by `vite preview` on PORT (4181; the browser check uses 4179), `?human=none&seed=1` (watching),
 * `window.__cs2replay.seek(t)` per timestamp in order, then a screenshot of the map canvas (#view) at the whole-map
 * view. The page's observe at the landed tick is returned with the shot so the caller can check it is the same state
 * as the Node run it compares (it is: docs/golden.md "Browser parity").
 *
 * 3D: `dist-3d/` (H1's `npm run build:3d`) through `window.__cs2sim3d.test` (docs/app3d.md "Test API"), see shots3d.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';

export const PORT = 4181;

export interface Shot {
  readonly t: number;
  readonly path: string;
  /** The page's newest observe tick after the seek, and its pawns' x/y (for the Node cross-check). */
  readonly tick: number;
  readonly pawns: readonly { id: string; x: number; y: number; alive: boolean }[];
}

async function waitForServer(url: string, ms: number): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > end) throw new Error(`server at ${url} did not start (is port ${PORT} taken? see docs/parity.md)`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

export function startPreview(root: string, outDir: string): ChildProcess {
  const vite = fileURLToPath(new URL('../../node_modules/vite/bin/vite.js', import.meta.url));
  return spawn(process.execPath, [vite, 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort', '--outDir', outDir], { cwd: root, stdio: 'ignore' });
}

async function launch(): Promise<Browser> {
  const exe = process.env['CHROME_PATH'];
  return chromium.launch(exe === undefined ? { headless: true } : { headless: true, executablePath: exe });
}

async function seek2d(page: Page, t: number): Promise<void> {
  await page.evaluate((s) => window.__cs2replay?.seek(s), t);
  await page.waitForFunction(() => window.__cs2replay?.stats().seeking === false, null, { timeout: 120_000, polling: 'raf' });
  // Two frames so the renderer has drawn the landed state.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** Screenshots of the 2D app (watching) at each t, ascending; skips files already in `dir` unless `force`. */
export async function shots2d(root: string, times: readonly number[], dir: string): Promise<Shot[]> {
  if (!existsSync(join(root, 'dist', 'index.html'))) throw new Error('dist/index.html missing: run npm run build first');
  mkdirSync(dir, { recursive: true });
  const server = startPreview(root, 'dist');
  const out: Shot[] = [];
  try {
    const origin = `http://127.0.0.1:${PORT}`;
    await waitForServer(origin + '/', 20_000);
    const browser = await launch();
    const page = await browser.newPage({ viewport: { width: 1100, height: 860 } });
    await page.goto(origin + '/?human=none&seed=1');
    await page.waitForFunction(() => window.__cs2replay !== undefined);
    // The status panel covers part of the map on a desktop: close it (Tab toggles it) for a clean radar view.
    const panelOpen = await page.evaluate(() => window.__cs2replay?.stats().overlays.panel ?? false);
    if (panelOpen) await page.keyboard.press('Tab');
    const canvas = page.locator('#view');
    for (const t of [...times].sort((a, b) => a - b)) {
      await seek2d(page, t);
      const st = await page.evaluate(() => {
        const o = window.__cs2replay?.session().observe();
        return o === undefined ? null : { tick: o.tick, pawns: o.pawns.map((p) => ({ id: p.id, x: p.pos.x, y: p.pos.y, alive: p.alive })) };
      });
      if (st === null) throw new Error('no session in the page');
      const path = join(dir, `sim-${t.toFixed(3)}.jpg`);
      await canvas.screenshot({ path, type: 'jpeg', quality: 80 });
      out.push({ t, path, tick: st.tick, pawns: st.pawns });
    }
    await browser.close();
  } finally {
    server.kill();
  }
  return out;
}

/** One 3D shot: the page's state at the landed tick, the camera it drew and the spectated pawn's view angles. */
export interface Shot3d extends Shot {
  readonly watched: string;
  readonly pawns: readonly { id: string; x: number; y: number; z: number; yaw: number; pitch: number; alive: boolean; hp: number; armor: number; clip: number }[];
  readonly camera: { mode: string; followed: string; eye: { x: number; y: number; z: number } | null; yaw: number | null; pitch: number | null; hfovDeg: number; vfovDeg: number; width: number; height: number };
}

/** Viewport of the 3D shots: the video's 16:9 at 2/3 size (the similarity compares at 480 x 270; software WebGL). */
export const VIEW3D = { width: 1280, height: 720 } as const;

/**
 * The 3D app (H1's src/app3d, `npm run build:3d` -> dist-3d/) through its deterministic test API,
 * `window.__cs2sim3d.test` (docs/app3d.md "Test API"): `freeze(true)` once, then per timestamp in ascending order
 * `seekTick(k)` (k = the observe after tick round(64 t), as the 2D comparison), `eyes(id)` of the player the video is
 * spectating then (round.json `pov`: the camera schedule), `render()` (exactly that tick: no interpolation, effects at
 * tick x 15.625 ms) and a screenshot of `#view`. The page's pawns at that tick are returned for the Node cross-check.
 */
export async function shots3d(root: string, schedule: readonly { t: number; tick: number; watched: string }[], dir: string): Promise<Shot3d[]> {
  if (!existsSync(join(root, 'dist-3d', 'index.html'))) throw new Error('dist-3d/index.html missing: run npm run build:3d first');
  mkdirSync(dir, { recursive: true });
  const server = startPreview(root, 'dist-3d');
  const out: Shot3d[] = [];
  try {
    const origin = `http://127.0.0.1:${PORT}`;
    await waitForServer(origin + '/', 20_000);
    const browser = await launch();
    const page = await browser.newPage({ viewport: VIEW3D });
    await page.goto(origin + '/?human=none&seed=1');
    await page.waitForFunction(() => window.__cs2sim3d?.test !== undefined && (window.__cs2sim3d.stats().triangles ?? 0) > 0, null, { timeout: 120_000 });
    await page.evaluate(() => window.__cs2sim3d?.test.freeze(true));
    const canvas = page.locator('#view');
    for (const { t, tick, watched } of [...schedule].sort((a, b) => a.t - b.t)) {
      const st = await page.evaluate(([k, id]) => {
        const api = window.__cs2sim3d;
        if (api === undefined) throw new Error('no __cs2sim3d');
        const reached = api.test.seekTick(k as number);
        api.test.eyes(id as Parameters<typeof api.test.eyes>[0]);
        const s = api.test.render();
        const o = api.session().observe();
        return {
          reached,
          camera: s.camera,
          pawns: o.pawns.map((p) => ({ id: p.id, x: p.pos.x, y: p.pos.y, z: p.pos.z, yaw: p.yaw, pitch: p.pitch, alive: p.alive, hp: p.hp, armor: p.armor, clip: p.ammo.clip })),
        };
      }, [tick, watched] as const);
      const path = join(dir, `sim3d-${t.toFixed(3)}.jpg`);
      await canvas.screenshot({ path, type: 'jpeg', quality: 85 });
      out.push({ t, path, tick: st.reached, watched, pawns: st.pawns, camera: st.camera as Shot3d['camera'] });
    }
    await browser.close();
  } finally {
    server.kill();
  }
  return out;
}
