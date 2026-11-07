/**
 * V0 video parity: screenshots of the built apps at given video seconds (Playwright, headless Chrome).
 *
 * 2D: `dist/` served by `vite preview` on PORT (4181; the browser check uses 4179), `?human=none&seed=1` (watching),
 * `window.__cs2replay.seek(t)` per timestamp in order, then a screenshot of the map canvas (#view) at the whole-map
 * view. The page's observe at the landed tick is returned with the shot so the caller can check it is the same state
 * as the Node run it compares (it is: docs/golden.md "Browser parity").
 *
 * 3D: `dist-3d/` (H1's `npm run build:3d`) with the hook documented in docs/parity.md ("What the 3D mode needs").
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

/**
 * The 3D app (H1). Expects `window.__cs2sim3d` with: `ready: boolean`, `seek(t): Promise<void>` (deterministic: the
 * state at observe tick round(t*64) whatever the path), `spectate(id: string | null)` (first-person camera of that
 * pawn at its eye, its view angles, CS2's 90° 4:3 horizontal FOV at 16:9 = 106.26°), `hud(): {hp, armor, clip,
 * reserve, clock, bombPlanted}`, `project(x, y, z): {x, y, visible} | null` (screen px of a world point through the
 * current camera) and `pawns(): [{id, x, y, z, yaw, pitch, alive}]`; rendering must not depend on wall time
 * (no animation clocks; tracers/muzzle flash keyed to ticks) so a screenshot after seek is reproducible.
 */
export async function shots3d(root: string, schedule: readonly { t: number; watched: string | null }[], dir: string): Promise<(Shot & { hud: unknown; projected: unknown })[]> {
  if (!existsSync(join(root, 'dist-3d', 'index.html'))) throw new Error('dist-3d/index.html missing: the 3D app (H1, npm run build:3d) is not built');
  mkdirSync(dir, { recursive: true });
  const server = startPreview(root, 'dist-3d');
  const out: (Shot & { hud: unknown; projected: unknown })[] = [];
  try {
    const origin = `http://127.0.0.1:${PORT}`;
    await waitForServer(origin + '/', 20_000);
    const browser = await launch();
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.goto(origin + '/?human=none&seed=1');
    await page.waitForFunction(() => (window as unknown as { __cs2sim3d?: { ready: boolean } }).__cs2sim3d?.ready === true, null, { timeout: 60_000 });
    for (const { t, watched } of [...schedule].sort((a, b) => a.t - b.t)) {
      const st = await page.evaluate(async ([s, id]) => {
        interface Hook3d {
          seek(t: number): Promise<void>;
          spectate(id: string | null): void;
          hud(): unknown;
          pawns(): { id: string; x: number; y: number; z: number; alive: boolean }[];
          project(x: number, y: number, z: number): { x: number; y: number; visible: boolean } | null;
        }
        const h = (window as unknown as { __cs2sim3d: Hook3d }).__cs2sim3d;
        await h.seek(s as number);
        h.spectate(id as string | null);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const pawns = h.pawns();
        return { tick: Math.round((s as number) * 64), pawns, hud: h.hud(), projected: pawns.map((p) => ({ id: p.id, head: h.project(p.x, p.y, p.z + 64), feet: h.project(p.x, p.y, p.z) })) };
      }, [t, watched] as const);
      const path = join(dir, `sim3d-${t.toFixed(3)}.jpg`);
      await page.screenshot({ path, type: 'jpeg', quality: 85 });
      out.push({ t, path, tick: st.tick, pawns: st.pawns, hud: st.hud, projected: st.projected });
    }
    await browser.close();
  } finally {
    server.kill();
  }
  return out;
}
