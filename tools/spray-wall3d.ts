/**
 * R1 (backlog #54): the AK-47 spray as the player sees it in the 3D app, measured in headless Chromium.
 *
 *   npm run build:3d && npx tsx tools/spray-wall3d.ts [--dir dist-3d] [--out docs/img/spray-ak47-wall.png] [--json out.json]
 *
 * Serves the built page, takes control of cart at 18.2 s (AK-47), stands still with the mouse still, holds mouse 1
 * for a full magazine (30 bullets) and records, for every bullet of the human, the shot ray (eye → impact) and the
 * camera the frame showed (`Sim3DHost.aimView` with the app's recoil tracking). The impacts are put on a wall 500 u
 * in front of the start view (screen coordinates: x + = right, y + = up, units), and the camera path likewise.
 * Writes a PNG (< 100 KB): grey grid every 10 u, numbered-by-colour impacts (bullet 1 dark → 30 bright), the
 * camera path as a line, and prints the per-bullet table as JSON.
 */
import { createServer, type Server } from 'node:http';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { drawLine, encodePng, marker, plot } from './png';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
const DIR = resolve(ROOT, arg('--dir', 'dist-3d'));
const OUT = resolve(ROOT, arg('--out', 'docs/img/spray-ak47-wall.png'));
const JSON_OUT = arg('--json', '');
const PORT = Number(arg('--port', '4186'));
const ORIGIN = `http://127.0.0.1:${PORT}`;
const WALL = 500;
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

interface Rec {
  tick: number;
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
  look: { yaw: number; pitch: number };
  camera: { yaw: number; pitch: number };
  /** (camera − camera at tracking 0) / (crosshair − view), pitch: the share of the bullets' punch the screen shows. */
  tracked: number;
}

const DEG = 180 / Math.PI;
const wrap = (a: number): number => ((((a + 180) % 360) + 360) % 360) - 180;

async function main(): Promise<void> {
  const server = serve(DIR);
  const exe = process.env['CHROME_PATH'];
  const browser = await chromium.launch({ ...(exe !== undefined ? { executablePath: exe } : {}), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const p = await browser.newPage({ viewport: { width: 960, height: 600 } });
    p.on('pageerror', (e) => console.error('page error', e.message));
    await p.goto(`${ORIGIN}/`);
    await p.waitForFunction(() => window.__cs2sim3d !== undefined, null, { timeout: 120_000 });
    await p.waitForFunction(() => (window.__cs2sim3d?.stats().triangles ?? 0) > 0, null, { timeout: 60_000 });
    await p.click('#start');
    await p.evaluate(() => window.__cs2sim3d?.seek(18.2));
    await p.waitForFunction(() => (window.__cs2sim3d?.stats().tick ?? 0) >= 1165, null, { timeout: 180_000 });
    await p.evaluate(() => {
      const b = document.getElementById('pause');
      if (b instanceof HTMLButtonElement && b.textContent === 'Resume') b.click();
    });
    await p.keyboard.press('KeyE');
    await p.waitForTimeout(600);
    // Record the human's shots (patched on the session's host after the takeover, which may build a new session).
    await p.evaluate(() => {
      const app = window.__cs2sim3d;
      if (app === undefined) throw new Error('no app');
      const s = app.session() as unknown as { human: string | null; host: { shots: () => { shooter: string; from: unknown; to: unknown }[]; aimView: (id: string, v: unknown, tracking?: number) => { camera: { pitch: number }; crosshair: { pitch: number } }; observe: () => { tick: number } } };
      const h = s.host;
      const orig = h.shots.bind(h);
      const rec: unknown[] = [];
      (window as unknown as { __r1: unknown[] }).__r1 = rec;
      h.shots = () => {
        const r = orig();
        const look = app.stats().look;
        const tick = h.observe().tick;
        // shots() is read more than once per tick (tracers, audio): keep each tick's shot once.
        if (rec.some((q) => (q as { tick: number }).tick === tick)) return r;
        for (const x of r) if (x.shooter === s.human) {
            const av = h.aimView(x.shooter, look);
            const shake = h.aimView(x.shooter, look, 0).camera; // tracking 0: the view punch (screen shake) alone
            rec.push({ tick, from: x.from, to: x.to, look, camera: av.camera, tracked: (av.camera.pitch - shake.pitch) / Math.min(-1e-9, av.crosshair.pitch - look.pitch) });
          }
        return r;
      };
    });
    const box = await p.locator('#view').boundingBox();
    if (box === null) throw new Error('no #view');
    await p.evaluate(() => window.__cs2sim3d?.setLook(window.__cs2sim3d.stats().look.yaw, 0));
    await p.waitForTimeout(1500);
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await p.mouse.down();
    await p.waitForFunction(() => ((window as unknown as { __r1?: unknown[] }).__r1?.length ?? 0) >= 30, null, { timeout: 60_000 });
    await p.mouse.up();
    const recs = (await p.evaluate(() => (window as unknown as { __r1: unknown[] }).__r1)) as Rec[];
    const look0 = recs[0]?.look ?? { yaw: 0, pitch: 0 };
    // Wall coordinates: angles relative to the start view, projected on a plane WALL units ahead.
    const onWall = (yaw: number, pitch: number): [number, number] => [-WALL * Math.tan(wrap(yaw - look0.yaw) / DEG), -WALL * Math.tan((pitch - look0.pitch) / DEG)];
    const rows = recs.slice(0, 30).map((r, i) => {
      const d = { x: r.to.x - r.from.x, y: r.to.y - r.from.y, z: r.to.z - r.from.z };
      const yaw = Math.atan2(d.y, d.x) * DEG;
      const pitch = -Math.atan2(d.z, Math.hypot(d.x, d.y)) * DEG;
      const [ix, iy] = onWall(yaw, pitch);
      const [cx, cy] = onWall(r.camera.yaw, r.camera.pitch);
      return { bullet: i + 1, tick: r.tick, impact: [round(ix), round(iy)], camera: [round(cx), round(cy)], lookMoved: round(Math.hypot(wrap(r.look.yaw - look0.yaw), r.look.pitch - look0.pitch)), tracked: Math.round(r.tracked * 1e4) / 1e4 };
    });
    console.log(JSON.stringify(rows));
    if (JSON_OUT !== '') writeFileSync(resolve(ROOT, JSON_OUT), JSON.stringify(rows, null, 1));
    writeFileSync(OUT, render(rows));
    console.log(`wrote ${OUT}`);
  } finally {
    await browser.close();
    server.close();
  }
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}

/** 400 × 520 px, 4 px per unit: x −50..50 u, y −10..120 u (bullet 1 at the origin, 10 u from the bottom). */
function render(rows: { impact: number[]; camera: number[] }[]): Buffer {
  const W = 400;
  const H = 520;
  const S = 4;
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) rgba.set([250, 250, 248, 255], i * 4);
  const px = (x: number, y: number): [number, number] => [W / 2 + x * S, H - 40 - y * S];
  for (let g = -50; g <= 50; g += 10) {
    const [x] = px(g, 0);
    drawLine(rgba, W, H, x, 0, x, H - 1, g === 0 ? [170, 170, 170] : [222, 222, 222]);
  }
  for (let g = -10; g <= 120; g += 10) {
    const [, y] = px(0, g);
    drawLine(rgba, W, H, 0, y, W - 1, y, g === 0 ? [170, 170, 170] : [222, 222, 222]);
  }
  // Camera path (blue line), then impacts (dark red → orange by bullet number).
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]?.camera ?? [0, 0];
    const b = rows[i]?.camera ?? [0, 0];
    const [x0, y0] = px(a[0] ?? 0, a[1] ?? 0);
    const [x1, y1] = px(b[0] ?? 0, b[1] ?? 0);
    drawLine(rgba, W, H, x0, y0, x1, y1, [40, 90, 200]);
    drawLine(rgba, W, H, x0 + 1, y0, x1 + 1, y1, [40, 90, 200]);
  }
  rows.forEach((r, i) => {
    const t = rows.length > 1 ? i / (rows.length - 1) : 0;
    const c: [number, number, number] = [Math.round(120 + 135 * t), Math.round(20 + 140 * t), 20];
    const [x, y] = px(r.impact[0] ?? 0, r.impact[1] ?? 0);
    for (let k = 1; k <= 3; k++) marker(rgba, W, H, x, y, k, c);
    plot(rgba, W, H, Math.round(x), Math.round(y), c);
  });
  return encodePng(W, H, rgba);
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
