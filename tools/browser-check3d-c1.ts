/**
 * C1: the human climbs Mirage B's van in the 3D page (headless Chromium, playwright-core), on a build (`npm run build:3d`):
 *
 *   npx tsx tools/browser-check3d-c1.ts [--single] [--port 4184]
 *
 * Take control of cart (`?human=cart`), teleport him next to the van (the Truck near Lokier's recorded spot) with the
 * host's `teleport` action, and drive him with the real keys (W, Space, Ctrl) as the page reads them:
 *  1. onto: from the box at z -45 he walks north and jumps; he lands on the van's box roof (z ≈ -8, y > 800);
 *  2. on: from the box roof he jumps west up onto the cab (z 24–30), then runs south along the van's roof
 *     (it was walled by clip prisms: he stopped at y 808 or could not stand at all) to its end (y < 700, z > 15);
 *  3. off: from the roof he runs west and jumps; he lands on the ground below (z < -60).
 * Positions come from `session().observe()`. Prints a JSON report and exits 1 on any problem.
 */
import { readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const arg = (n: string, d: string): string => (process.argv.includes(n) ? (process.argv[process.argv.indexOf(n) + 1] ?? d) : d);
const PORT = Number(arg('--port', '4184'));
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DIR = resolve(ROOT, process.argv.includes('--single') ? 'dist-single-3d' : 'dist-3d');
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

interface Pos {
  x: number;
  y: number;
  z: number;
  onGround: boolean;
}

const here = (p: Page): Promise<Pos> =>
  p.evaluate(() => {
    const o = window.__cs2sim3d?.session().observe().pawns.find((q) => q.id === 'cart');
    return { x: o?.pos.x ?? NaN, y: o?.pos.y ?? NaN, z: o?.pos.z ?? NaN, onGround: (o as { onGround?: boolean } | undefined)?.onGround ?? true };
  });

/** Stand cart at (x, y, z) facing `yaw` (degrees CCW from +x), alive and still. */
async function place(p: Page, x: number, y: number, z: number, yaw: number): Promise<void> {
  await p.evaluate(
    ([px, py, pz, pyaw]) => {
      const s = window.__cs2sim3d?.session();
      s?.host.apply({ inputs: [], actions: [{ type: 'teleport', id: 'cart', pos: { x: px, y: py, z: pz }, yaw: pyaw }, { type: 'set_hp', id: 'cart', hp: 100, armor: 100, helmet: true }], status: [] } as never);
      window.__cs2sim3d?.setLook(pyaw, 0);
    },
    [x, y, z, yaw] as const,
  );
  await p.waitForTimeout(500);
}

/** Hold W; press Space (and hold Ctrl in the air) when `trigger` says so; stop `after` ms later. */
async function runJump(p: Page, trigger: (q: Pos) => boolean, after = 1600, duck = true, walk = false): Promise<void> {
  if (walk) await p.keyboard.down('Shift');
  await p.keyboard.down('KeyW');
  const t0 = Date.now();
  while (Date.now() - t0 < 6000) {
    const q = await here(p);
    if (trigger(q)) {
      await p.keyboard.down('Space');
      if (duck) await p.keyboard.down('Control');
      await p.waitForTimeout(after);
      break;
    }
    await p.waitForTimeout(5);
  }
  await p.keyboard.up('Space');
  await p.keyboard.up('Control');
  await p.keyboard.up('KeyW');
  await p.keyboard.up('Shift');
  await p.waitForTimeout(700);
}

async function main(): Promise<void> {
  statSync(join(DIR, 'index.html'));
  const server = serve(DIR);
  const exe = process.env['CHROME_PATH'];
  const browser: Browser = await chromium.launch(exe === undefined ? { headless: true } : { headless: true, executablePath: exe });
  const problems: string[] = [];
  const report: Record<string, unknown> = {};
  try {
    const p = await browser.newPage({ viewport: { width: 960, height: 540 } });
    p.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    await p.goto(`${ORIGIN}/?human=cart`);
    await p.waitForFunction(() => (window.__cs2sim3d?.stats().triangles ?? 0) > 0, null, { timeout: 120_000 });
    await p.click('#start').catch(() => undefined);
    await p.waitForFunction(() => (window.__cs2sim3d?.stats().tick ?? 0) > 60, null, { timeout: 120_000 });
    const sees = await p.evaluate(() => window.__cs2sim3d?.session().human ?? null);
    if (sees !== 'cart') problems.push(`human is ${String(sees)}, not cart`);

    // A jump here is timed by the page's frame rate (software WebGL), so each try is repeated (up to 5) until it lands.
    const attempt = async (name: string, tries: number, go: () => Promise<Pos>, ok: (q: Pos) => boolean): Promise<Pos> => {
      let q = await go();
      let n = 1;
      while (!ok(q) && n < tries) {
        q = await go();
        n++;
      }
      report[name] = { tries: n, ended: q };
      if (!ok(q)) problems.push(`${name}: after ${n} tries ended at ${JSON.stringify(q)}`);
      return q;
    };

    // 1. onto: the box (z -45) -> the van's box roof.
    await attempt(
      'onto',
      5,
      async () => {
        await place(p, -2380, 690, -45, 80);
        await runJump(p, (q) => q.y > 746, 1500, true, true);
        return here(p);
      },
      (q) => q.z > -12 && q.z < 4 && q.y > 800 && q.onGround,
    );

    // 2. on: the box roof -> the cab (jump up 32), then south along the roof.
    await attempt(
      'cab',
      5,
      async () => {
        await place(p, -2356, 832, -8, 180);
        await p.keyboard.down('Space');
        await p.keyboard.down('KeyW');
        await p.keyboard.down('Control');
        await p.waitForTimeout(1200);
        await p.keyboard.up('Space');
        await p.keyboard.up('Control');
        await p.keyboard.up('KeyW');
        await p.waitForTimeout(700);
        return here(p);
      },
      (q) => q.z > 20 && q.onGround,
    );
    await place(p, -2388, 830, 24, 270);
    await p.keyboard.down('KeyW');
    await p.waitForTimeout(1800);
    await p.keyboard.up('KeyW');
    const walked = await here(p);
    report['walkedSouth'] = walked;
    if (!(walked.y < 700)) problems.push(`on: walking south along the van roof stopped at y ${walked.y.toFixed(0)} (an invisible wall)`);
    // Jumping on the roof: a jump in place lifts him ~57 units and he lands on it.
    await place(p, -2402, 740, 23, 270);
    const j0 = await here(p);
    let top = j0.z;
    await p.keyboard.down('Space');
    for (let i = 0; i < 40; i++) {
      top = Math.max(top, (await here(p)).z);
      await p.waitForTimeout(12);
    }
    await p.keyboard.up('Space');
    await p.waitForTimeout(700);
    const j1 = await here(p);
    report['jumpOnRoof'] = { from: j0, apex: top, to: j1 };
    if (!(top - j0.z > 40 && Math.abs(j1.z - j0.z) < 2 && j1.onGround)) problems.push(`on: jump on the roof: ${JSON.stringify(report['jumpOnRoof'])}`);

    // 3. off: the roof -> the ground to the west.
    await place(p, -2402, 740, 23, 180);
    await runJump(p, (q) => q.x < -2412, 1500, false);
    const off = await here(p);
    report['off'] = off;
    if (!(off.z < -60 && off.onGround)) problems.push(`off: ended at ${JSON.stringify(off)}, not on the ground below`);
  } finally {
    await browser.close();
    server.close();
  }
  console.log(JSON.stringify({ report, problems }, null, 2));
  if (problems.length > 0) process.exit(1);
}

void main();
