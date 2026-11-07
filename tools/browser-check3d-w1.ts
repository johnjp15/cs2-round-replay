/**
 * W1: the controls of the 3D page in headless Chromium (playwright-core), on a build (`npm run build:3d`):
 *
 *   npx tsx tools/browser-check3d-w1.ts [--single] [--port 4183]
 *
 *  1. Ctrl+scroll, ⌘+scroll and a trackpad pinch (CDP Input.synthesizePinchGesture, mouse source) don't zoom the page:
 *     visualViewport.scale, devicePixelRatio and innerWidth stay; a synthesized Ctrl+wheel and Ctrl+W keydown are
 *     defaultPrevented. A control page without the game shows the same pinch does zoom (the check can fail).
 *  2. Take control of cart (Start, seek 18.2 s, E): the AK spray kicks the view but the crosshair stays at the
 *     centre; with "Crosshair follows recoil" it moves off centre.
 *  3. "Jump on scroll down": one wheel notch over the view jumps (cart leaves the ground) and keeps the weapon.
 *  4. 3 → knife, Q → back to the AK, Q → knife again; F inspects (viewmodel phase `inspect`), mouse 1 cuts it off
 *     with a slash (the host's swing).
 *  5. P pauses and resumes; one Backspace doesn't restart, two within 1 s do; Enter starts the round.
 *
 * Prints a JSON report and exits 1 on any problem.
 */
import { readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const arg = (n: string, d: string): string => (process.argv.includes(n) ? (process.argv[process.argv.indexOf(n) + 1] ?? d) : d);
const PORT = Number(arg('--port', '4183'));
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DIR = resolve(ROOT, process.argv.includes('--single') ? 'dist-single-3d' : 'dist-3d');
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.bin': 'application/octet-stream', '.css': 'text/css' };

function serve(dir: string): Server {
  const s = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    if (path === '/control.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><meta name="viewport" content="width=device-width"><body style="height:2000px">control</body>');
      return;
    }
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

interface Zoom {
  scale: number;
  dpr: number;
  inner: number;
}
const zoomOf = (p: Page): Promise<Zoom> => p.evaluate(() => ({ scale: window.visualViewport?.scale ?? 1, dpr: window.devicePixelRatio, inner: window.innerWidth }));

async function tryZoom(p: Page): Promise<void> {
  const cdp = await p.context().newCDPSession(p);
  await p.mouse.move(400, 300);
  for (const mod of ['Control', 'Meta']) {
    await p.keyboard.down(mod);
    for (let i = 0; i < 5; i++) await p.mouse.wheel(0, -400);
    await p.keyboard.up(mod);
  }
  await cdp.send('Input.synthesizePinchGesture', { x: 400, y: 300, scaleFactor: 2.5, relativeSpeed: 800, gestureSourceType: 'mouse' }).catch(() => undefined);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 400, y: 300, deltaX: 0, deltaY: -500, modifiers: 2 });
  await p.waitForTimeout(500);
}

interface PawnLite {
  weapon: string;
  onGround: boolean;
  vel: { z: number };
}

const cart = (p: Page): Promise<PawnLite> => p.evaluate(() => window.__cs2sim3d?.session().observe().pawns.find((q) => q.id === 'cart') as unknown as PawnLite);
const vm = (p: Page): Promise<{ phase: string; weapon: string } | null> => p.evaluate(() => window.__cs2a1?.stats().viewmodel ?? null);
const phase = (p: Page): Promise<string> => p.evaluate(() => window.__cs2sim3d?.stats().phase ?? '');
/** Set a settings checkbox as a click would (the bar can sit under the stage in a short headless viewport). */
async function setBox(p: Page, id: string, on: boolean): Promise<void> {
  await p.evaluate(
    ([id, on]) => {
      const b = document.getElementById(id as string) as HTMLInputElement;
      if (b.checked !== on) {
        b.checked = on as boolean;
        b.dispatchEvent(new Event('change'));
      }
    },
    [id, on] as const,
  );
}
const xhair = (p: Page): Promise<string | null> => p.evaluate(() => document.getElementById('crosshair')?.getAttribute('style') ?? null);

async function waitFor(p: Page, f: () => Promise<boolean>, ms = 15_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await f()) return true;
    await p.waitForTimeout(40);
  }
  return false;
}

const tickOf = (p: Page): Promise<number> => p.evaluate(() => window.__cs2sim3d?.stats().tick ?? 0);

/** Wait `n` game ticks (the loaded box runs the round slower than real time). */
async function ticks(p: Page, n: number): Promise<void> {
  const t0 = await tickOf(p);
  await waitFor(p, async () => (await tickOf(p)) >= t0 + n, 120_000);
}

/** Poll `f` for `n` game ticks; true as soon as it holds. */
async function within(p: Page, n: number, f: () => Promise<boolean>): Promise<boolean> {
  const t0 = await tickOf(p);
  while ((await tickOf(p)) < t0 + n) {
    if (await f()) return true;
    await p.waitForTimeout(20);
  }
  return f();
}

async function main(): Promise<void> {
  if (process.env['CHROMIUM_WEBGL_RENDERER'] === undefined) process.env['CHROMIUM_WEBGL_RENDERER'] = 'lavapipe';
  statSync(join(DIR, 'index.html'));
  const server = serve(DIR);
  const exe = process.env['CHROME_PATH'];
  const browser: Browser = await chromium.launch(exe === undefined ? { headless: true } : { headless: true, executablePath: exe });
  const problems: string[] = [];
  const report: Record<string, unknown> = {};
  try {
    // 1. The control page zooms; the game page doesn't.
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const control = await ctx.newPage();
    await control.goto(`${ORIGIN}/control.html`);
    const c0 = await zoomOf(control);
    await tryZoom(control);
    const c1 = await zoomOf(control);
    report['controlPage'] = { before: c0, after: c1 };
    const p = await ctx.newPage();
    p.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    await p.goto(`${ORIGIN}/`);
    await p.waitForFunction(() => (window.__cs2sim3d?.stats().triangles ?? 0) > 0, null, { timeout: 120_000 });
    const z0 = await zoomOf(p);
    await tryZoom(p);
    const z1 = await zoomOf(p);
    const prevented = await p.evaluate(() => {
      const v = document.getElementById('view') as HTMLCanvasElement;
      const w = new WheelEvent('wheel', { ctrlKey: true, deltaY: -100, cancelable: true, bubbles: true });
      v.dispatchEvent(w);
      const w2 = new WheelEvent('wheel', { ctrlKey: true, deltaY: -100, cancelable: true, bubbles: true });
      document.getElementById('bar')?.dispatchEvent(w2);
      const k = new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', ctrlKey: true, cancelable: true, bubbles: true });
      document.body.dispatchEvent(k);
      return { wheelOverView: w.defaultPrevented, wheelOverBar: w2.defaultPrevented, ctrlW: k.defaultPrevented };
    });
    report['zoom'] = { before: z0, after: z1, prevented, controlZoomed: c1.scale !== c0.scale || c1.dpr !== c0.dpr };
    // The same pinch (a trackpad pinch: Chromium sends it as Ctrl+wheel) does zoom a page without the game.
    if (c1.scale === c0.scale) problems.push(`the control page didn't zoom either (the check proves nothing): ${JSON.stringify(report['controlPage'])}`);
    if (z1.scale !== z0.scale || z1.dpr !== z0.dpr || z1.inner !== z0.inner) problems.push(`the game page zoomed: ${JSON.stringify(report['zoom'])}`);
    if (!prevented.wheelOverView || !prevented.wheelOverBar || !prevented.ctrlW) problems.push(`not prevented: ${JSON.stringify(prevented)}`);

    // 2. Take control and spray: the crosshair stays at the centre.
    await p.evaluate(() => localStorage.setItem('cs2-sim3d-settings', JSON.stringify({ autoFullscreen: false })));
    await p.goto(`${ORIGIN}/?human=cart`);
    await p.waitForFunction(() => (window.__cs2sim3d?.stats().triangles ?? 0) > 0, null, { timeout: 120_000 });
    await p.evaluate(() => window.__cs2sim3d?.perf.start());
    await waitFor(p, async () => (await p.evaluate(() => window.__cs2sim3d?.stats().tick ?? 0)) > 90, 60_000);
    await p.keyboard.press('Digit1');
    await waitFor(p, async () => (await cart(p)).weapon === 'ak47', 20_000);
    // The AK's deploy (1 s of game time; the loaded box runs slower than real time).
    const t0 = await p.evaluate(() => window.__cs2sim3d?.stats().tick ?? 0);
    await waitFor(p, async () => (await p.evaluate(() => window.__cs2sim3d?.stats().tick ?? 0)) > t0 + 80, 60_000);
    const box = await p.locator('#view').boundingBox();
    const cx = (box?.x ?? 0) + (box?.width ?? 0) / 2;
    const cy = (box?.y ?? 0) + (box?.height ?? 0) / 2;
    await p.mouse.move(cx, cy);
    const spray = async (): Promise<{ styles: (string | null)[]; shots: number }> => {
      const s0 = await p.evaluate(() => window.__cs2sim3d?.stats().humanShots ?? 0);
      await p.mouse.down();
      const styles: (string | null)[] = [];
      const t0 = await tickOf(p);
      while ((await tickOf(p)) < t0 + 40) styles.push(await xhair(p));
      await p.mouse.up();
      return { styles, shots: (await p.evaluate(() => window.__cs2sim3d?.stats().humanShots ?? 0)) - s0 };
    };
    const fixed = await spray();
    await ticks(p, 100);
    await setBox(p, 'set-xhair-recoil', true);
    const follow = await spray();
    await setBox(p, 'set-xhair-recoil', false);
    report['crosshair'] = { fixed, follow };
    if (fixed.shots < 3 || fixed.styles.some((s) => s !== null)) problems.push(`crosshair moved with follow-recoil off: ${JSON.stringify(fixed)}`);
    if (!follow.styles.some((s) => s !== null && s.includes('translate'))) problems.push(`crosshair didn't follow with the setting on: ${JSON.stringify(follow)}`);

    // 3. Wheel jump.
    await setBox(p, 'set-wheel-jump-down', true);
    await ticks(p, 100);
    const w0 = await cart(p);
    await p.mouse.move(cx, cy);
    await p.mouse.wheel(0, 120);
    const jumped = await within(p, 64, async () => !(await cart(p)).onGround);
    const w1 = await cart(p);
    report['wheelJump'] = { before: w0, jumped, weaponAfter: w1.weapon };
    if (!w0.onGround || !jumped) problems.push(`wheel down didn't jump: ${JSON.stringify(report['wheelJump'])}`);
    if (w1.weapon !== w0.weapon) problems.push(`wheel changed the weapon: ${w0.weapon} → ${w1.weapon}`);
    await ticks(p, 80);

    // 4. Q lastinv, F inspect, knife slash.
    const seq: string[] = [(await cart(p)).weapon];
    await p.keyboard.press('Digit3');
    await waitFor(p, async () => (await cart(p)).weapon === 'knife');
    seq.push((await cart(p)).weapon);
    await p.keyboard.press('KeyQ');
    await waitFor(p, async () => (await cart(p)).weapon !== 'knife');
    seq.push((await cart(p)).weapon);
    await p.keyboard.press('KeyQ');
    await waitFor(p, async () => (await cart(p)).weapon === 'knife');
    seq.push((await cart(p)).weapon);
    report['lastinv'] = seq;
    if (seq.join(',') !== 'ak47,knife,ak47,knife') problems.push(`Q: ${seq.join(' → ')}`);
    await ticks(p, 80); // the knife's deploy (1.0 s)
    await p.keyboard.press('KeyF');
    const inspecting = await within(p, 40, async () => (await vm(p))?.phase === 'inspect');
    await p.mouse.down();
    const swung = await within(p, 40, async () => (await vm(p))?.phase === 'swing');
    await p.mouse.up();
    report['inspect'] = { inspecting, cutBySlash: swung };
    if (!inspecting || !swung) problems.push(`inspect / slash: ${JSON.stringify(report['inspect'])}`);

    // 5. Hotkeys.
    await p.keyboard.press('KeyP');
    const paused = await phase(p);
    await p.keyboard.press('KeyP');
    const resumed = await phase(p);
    await p.evaluate(() => {
      (window as unknown as { __kd: number[] }).__kd = [];
      window.addEventListener('keydown', (e) => (window as unknown as { __kd: (number | string)[] }).__kd.push(e.code, Math.round(performance.now())), true);
    });
    await p.keyboard.press('Backspace');
    await p.waitForTimeout(150);
    const afterOne = await phase(p);
    await p.keyboard.press('Backspace');
    await p.waitForTimeout(300);
    const afterTwo = await phase(p);
    await p.keyboard.press('Enter');
    await p.waitForTimeout(300);
    const started = await phase(p);
    const tips = await p.evaluate(() => ['start', 'pause', 'restart'].map((id) => document.getElementById(id)?.title ?? ''));
    report['kd'] = await p.evaluate(() => (window as unknown as { __kd: unknown }).__kd);
    report['hotkeys'] = { paused, resumed, afterOne, afterTwo, started, tips };
    // The two Backspace presses as the page got them: on a loaded box a long frame can push them over 1 s apart.
    const kd = report['kd'] as (string | number)[];
    const gap = (kd[3] as number) - (kd[1] as number);
    if (gap > 1000 && afterTwo === 'running') report['hotkeysNote'] = `the presses arrived ${gap} ms apart: no restart, as designed`;
    else if (paused !== 'paused' || resumed !== 'running' || afterOne !== 'running' || afterTwo !== 'ready' || started !== 'running') problems.push(`hotkeys: ${JSON.stringify(report['hotkeys'])}`);
    if (!tips[2]?.includes('Backspace twice')) problems.push(`restart tooltip: ${tips[2]}`);
    await p.screenshot({ path: '/tmp/w1-check.jpg', type: 'jpeg', quality: 70 });
  } finally {
    await browser.close();
    server.close();
  }
  console.log(JSON.stringify({ report, problems }, null, 2));
  if (problems.length > 0) process.exit(1);
}

void main();
