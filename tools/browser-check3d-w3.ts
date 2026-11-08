/**
 * W3: headless screenshots of bullet tracers and impacts (docs/app3d.md "Tracers and impacts").
 *
 *   npm run build:3d && npx tsx tools/browser-check3d-w3.ts [--out /tmp/w3-shots] [--port 4181]
 *
 * (1) first person: take control of cart at 18.2 s, aim at the wall beside Lokier, spray and screenshot mid-spray and
 * after release (the impacts stay); (2) third person: follow Sp4rtaN into the 50 s duel with donk and screenshot while the
 * shots fly. Reports the renderer's live tracer / impact counts. Exit code 1 on page errors.
 */
import { createServer, type Server } from 'node:http';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright-core';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const arg = (n: string, d: string): string => (process.argv.includes(n) ? (process.argv[process.argv.indexOf(n) + 1] ?? d) : d);
const PORT = Number(arg('--port', '4181'));
const OUT = resolve(arg('--out', '/tmp/w3-shots'));
const DIR = resolve(ROOT, 'dist-3d');
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.bin': 'application/octet-stream', '.css': 'text/css' };

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

async function seek(page: Page, t: number): Promise<void> {
  await page.evaluate((t) => window.__cs2sim3d?.seek(t), t);
  await page.waitForFunction((k) => (window.__cs2sim3d?.stats().tick ?? 0) >= k && window.__cs2sim3d?.session().seeking === null, Math.round(t * 64), { timeout: 240_000 });
  await page.waitForTimeout(400);
}

const fx = (p: Page): Promise<unknown> => p.evaluate(() => ({ ...(window.__cs2sim3d?.debug().shotFx.stats ?? {}) }));

/**
 * Freeze the page as soon as a tracer shot of `shooter` is added (the renderer's addShot wrapped in the page), then
 * render that tick exactly: the tracer in flight.
 */
async function freezeOnTracer(p: Page, shooter: string | null, timeoutMs: number): Promise<boolean> {
  await p.evaluate((id) => {
    const s = window.__cs2sim3d;
    if (s === undefined) return;
    const r = s.debug() as unknown as { addShot: (x: { shooter: string; tracer: boolean }) => void; __w3?: boolean; __w3caught?: number };
    const orig = r.addShot.bind(r);
    r.__w3caught = -1;
    r.addShot = (x) => {
      orig(x);
      if ((id === null || x.shooter === id) && x.tracer && (r.__w3caught ?? -1) < 0) {
        r.__w3caught = (x as unknown as { tick: number }).tick;
        (r as unknown as { __w3shot: unknown }).__w3shot = x;
        s.test.freeze(true);
      }
    };
  }, shooter);
  const ok = await p
    .waitForFunction(() => ((window.__cs2sim3d?.debug() as unknown as { __w3caught?: number }).__w3caught ?? -1) >= 0, null, { timeout: timeoutMs, polling: 50 })
    .then(() => true)
    .catch(() => false);
  // The frame that caught it may have run a few more ticks: draw the effects 12 ms after that shot.
  await p.evaluate(() => {
    const r = window.__cs2sim3d?.debug() as unknown as { addShot: unknown; __w3caught?: number; shotFx: { update: (f: { nowMs: number }) => void } };
    const fx = r.shotFx;
    const orig = fx.update.bind(fx);
    const at = (r.__w3caught ?? 0) * 15.625 + 12;
    fx.update = (f) => orig({ ...f, nowMs: at });
    window.__cs2sim3d?.test.freeze(true);
    window.__cs2sim3d?.test.render();
    delete (r as { addShot?: unknown }).addShot;
    delete (fx as { update?: unknown }).update;
  });
  return ok;
}

async function resume(p: Page): Promise<void> {
  await p.evaluate(() => {
    window.__cs2sim3d?.test.freeze(false);
    const b = document.getElementById('pause');
    if (b instanceof HTMLButtonElement && b.textContent === 'Resume') b.click();
  });
}

async function main(): Promise<void> {
  if (process.env['CHROMIUM_WEBGL_RENDERER'] === undefined) process.env['CHROMIUM_WEBGL_RENDERER'] = 'lavapipe';
  mkdirSync(OUT, { recursive: true });
  const server = serve(DIR);
  const exe = process.env['CHROME_PATH'];
  const browser = await chromium.launch(exe === undefined ? { headless: true } : { headless: true, executablePath: exe });
  const errors: string[] = [];
  const report: Record<string, unknown> = {};
  try {
    const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await p.goto(`http://127.0.0.1:${PORT}/`);
    await p.waitForFunction(() => window.__cs2sim3d !== undefined, null, { timeout: 120_000 });
    await p.waitForFunction(() => (window.__cs2sim3d?.stats().triangles ?? 0) > 0, null, { timeout: 60_000 });
    // (2) Third person first (the round as recorded): Sp4rtaN's 50.3 s duel with donk, followed from behind.
    await p.evaluate(() => (document.getElementById('start') as HTMLButtonElement | null)?.click());
    await seek(p, 49.6);
    await p.evaluate(() => window.__cs2sim3d?.camera('follow', 'sp4rtan'));
    await p.evaluate(() => {
      const b = document.getElementById('pause');
      if (b instanceof HTMLButtonElement && b.textContent === 'Resume') b.click();
    });
    await p.evaluate(() => (document.querySelector('button[data-speed="0.25"]') as HTMLButtonElement | null)?.click());
    report['thirdTracer'] = await freezeOnTracer(p, null, 120_000);
    await p.screenshot({ path: join(OUT, 'third-tracer.jpg'), type: 'jpeg', quality: 85, timeout: 120_000 });
    // The same instant from the side: a free camera 260 u to the left of the shot's midpoint, looking at it.
    report['thirdSide'] = await p.evaluate(() => {
      const r = window.__cs2sim3d?.debug() as unknown as { __w3shot?: { muzzle: { x: number; y: number; z: number }; to: { x: number; y: number; z: number } }; shotFx: { update: (f: { nowMs: number }) => void }; __w3caught?: number };
      const sh = r.__w3shot;
      if (sh === undefined) return null;
      const dx = sh.to.x - sh.muzzle.x;
      const dy = sh.to.y - sh.muzzle.y;
      const l = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, 300 / l);
      const mid = { x: sh.muzzle.x + dx * k * 0.5, y: sh.muzzle.y + dy * k * 0.5, z: sh.muzzle.z };
      const cam = { x: mid.x - (dy / l) * 260, y: mid.y + (dx / l) * 260, z: mid.z + 30 };
      const yaw = (Math.atan2(mid.y - cam.y, mid.x - cam.x) * 180) / Math.PI;
      window.__cs2sim3d?.test.pose(cam.x, cam.y, cam.z, yaw, 6);
      const fx = r.shotFx;
      const orig = fx.update.bind(fx);
      const at = (r.__w3caught ?? 0) * 15.625 + 12;
      fx.update = (f) => orig({ ...f, nowMs: at });
      window.__cs2sim3d?.test.render();
      delete (fx as { update?: unknown }).update;
      return { cam, yaw };
    });
    await p.screenshot({ path: join(OUT, 'third-side.jpg'), type: 'jpeg', quality: 85, timeout: 120_000 });
    await p.evaluate(() => window.__cs2sim3d?.camera('follow', 'sp4rtan'));
    report['thirdFx'] = await fx(p);
    await resume(p);
    report['third'] = await fx(p);
    // (1) First person: cart at 18.2 s.
    await seek(p, 18.2);
    await p.evaluate(() => {
      const b = document.getElementById('pause');
      if (b instanceof HTMLButtonElement && b.textContent === 'Resume') b.click();
    });
    await p.evaluate(() => (document.querySelector('button[data-speed="1"]') as HTMLButtonElement | null)?.click());
    await p.evaluate(() => window.__cs2sim3d?.takeControl());
    await p.waitForTimeout(500);
    report['human'] = await p.evaluate(() => window.__cs2sim3d?.stats().human ?? null);
    const look = await p.evaluate(() => window.__cs2sim3d?.aimAt('lokier'));
    if (look !== undefined) await p.evaluate((l) => window.__cs2sim3d?.setLook(l.yaw + 4, l.pitch + 2), look);
    const box = await p.locator('#view').boundingBox();
    if (box !== null) {
      await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await p.mouse.down();
      report['firstTracer'] = await freezeOnTracer(p, 'cart', 20_000);
      await p.screenshot({ path: join(OUT, 'first-tracer.jpg'), type: 'jpeg', quality: 85, timeout: 120_000 });
      report['firstTracerFx'] = await p.evaluate(() => {
        const fx = window.__cs2sim3d?.debug().shotFx as unknown as { stats: unknown; tracers: unknown[]; tracer: { geom: { instanceCount: number }; arrays: Record<string, Float32Array> } };
        return { stats: { ...(fx.stats as object) }, tracers: JSON.parse(JSON.stringify(fx.tracers)) as unknown, count: fx.tracer.geom.instanceCount, iT: Array.from(fx.tracer.arrays['iT']?.slice(0, 8) ?? []), iA: Array.from(fx.tracer.arrays['iA']?.slice(0, 6) ?? []), iB: Array.from(fx.tracer.arrays['iB']?.slice(0, 6) ?? []), tick: window.__cs2sim3d?.stats().tick, cam: window.__cs2sim3d?.test.state().camera };
      });
      await resume(p);
      await p.waitForTimeout(700);
      await p.evaluate(() => {
        window.__cs2sim3d?.test.freeze(true);
        window.__cs2sim3d?.test.render();
      });
      await p.screenshot({ path: join(OUT, 'first-spray.jpg'), type: 'jpeg', quality: 85, timeout: 120_000 });
      await resume(p);
      report['firstSpray'] = await fx(p);
      await p.mouse.up();
    }
    await p.waitForTimeout(1200);
    await p.screenshot({ path: join(OUT, 'first-after.jpg'), type: 'jpeg', quality: 85, timeout: 120_000 });
    report['firstAfter'] = await fx(p);
    report['stats'] = await p.evaluate(() => {
      const s = window.__cs2sim3d?.stats();
      return s === undefined ? null : { humanShots: s.humanShots, humanHits: s.humanHits, costMs: s.costMs };
    });
  } finally {
    await browser.close();
    server.close();
  }
  console.log(JSON.stringify({ ...report, errors }, null, 2));
  if (errors.length > 0) process.exitCode = 1;
}

void main();
