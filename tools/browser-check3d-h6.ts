/**
 * H6 (#85): the death fade in the 3D browser check (tools/browser-check3d.ts calls `h6Checks`; alone:
 * `npm run check:browser:3d -- --only h6`). Live play (a death needs the Scene to see it happen), on the page's frame
 * loop driven by hand at 60 fps of round time (`perf.driver('manual')`, `perf.step`), so it doesn't depend on the
 * machine's speed. Watching the golden no-human run through cart's eyes (first person), from 68.8 s:
 *  (a) 69.5 s, just after cart's death (tick 4442): his own view, the eye dropping below standing height, no
 *      crosshair, still on cart; (b) 70.4 s, ~1 s in: on the ground, about half black (his death wasn't a headshot);
 *  (c) 71.6 s, past 2 s: the fade is over and the camera is on another player.
 * Screenshots `docs/img/app3d-h6-fade-*.jpg`.
 */
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';

export interface H6Context {
  readonly open: (w: number, h: number) => Promise<Page>;
  readonly out: string;
}

interface FadeState {
  tick: number;
  followed: string;
  eyeZ: number | null;
  black: number;
  crosshair: boolean;
  feed: string;
}

const read = (page: Page): Promise<FadeState> =>
  page.evaluate(() => {
    const api = window.__cs2sim3d;
    if (api === undefined) throw new Error('no 3D hook');
    const ts = api.test.state();
    const fade = document.getElementById('deathfade');
    return {
      tick: ts.tick,
      followed: ts.camera.followed,
      eyeZ: ts.camera.eye?.z ?? null,
      black: fade === null || fade.hidden ? 0 : Number(fade.style.opacity || '0'),
      crosshair: document.getElementById('crosshair')?.hidden === false,
      feed: document.getElementById('killfeed')?.textContent ?? '',
    };
  });

/** Run frames of 1/60 s (manual driver) until the observe tick reaches `tick`. */
async function runTo(page: Page, tick: number): Promise<void> {
  await page.evaluate((tick) => {
    const api = window.__cs2sim3d;
    if (api === undefined) throw new Error('no 3D hook');
    const w = window as unknown as { __h6now?: number };
    let now = w.__h6now ?? 0;
    for (let i = 0; i < 20000 && api.stats().tick < tick; i++) {
      now += 1000 / 60;
      api.perf.step(now);
    }
    w.__h6now = now;
  }, tick);
}

export async function h6Checks(_browser: Browser, ctx: H6Context, problems: string[], report: Record<string, unknown>): Promise<void> {
  const page = await ctx.open(1280, 720);
  const shot = async (name: string): Promise<string> => {
    const path = join(ctx.out, `app3d-h6-fade-${name}.jpg`);
    await page.screenshot({ path, type: 'jpeg', quality: 70 });
    return path;
  };
  await page.evaluate(() => {
    const api = window.__cs2sim3d;
    api?.perf.driver('manual');
    api?.camera('pov', 'cart');
    api?.seek(68.8);
  });
  await runTo(page, Math.round(68.8 * 64));
  await page.evaluate(() => {
    window.__cs2sim3d?.perf.start();
    window.__cs2sim3d?.camera('pov', 'cart');
  });
  const before = (await runTo(page, Math.round(69.3 * 64)), await read(page));
  await runTo(page, Math.round(69.5 * 64));
  const a = await read(page);
  const shots = [await shot('a-69.5s')];
  await runTo(page, Math.round(70.4 * 64));
  const b = await read(page);
  shots.push(await shot('b-70.4s'));
  await runTo(page, Math.round(71.6 * 64));
  const c = await read(page);
  shots.push(await shot('c-71.6s'));
  const out = { before, a, b, c, screenshots: shots };
  report['h6'] = out;
  if (before.followed !== 'cart' || before.black !== 0) problems.push(`h6 before cart's death: ${JSON.stringify(before)}`);
  if (a.followed !== 'cart' || a.crosshair || a.eyeZ === null || before.eyeZ === null || !(a.eyeZ < before.eyeZ - 1)) problems.push(`h6 death fade at 69.5 s: ${JSON.stringify({ before, a })}`);
  if (b.followed !== 'cart' || !(b.black >= 0.3 && b.black > a.black) || b.eyeZ === null || a.eyeZ === null || !(b.eyeZ <= a.eyeZ)) problems.push(`h6 death fade at 70.4 s: ${JSON.stringify(b)}`);
  if (c.followed === 'cart' || c.black !== 0) problems.push(`h6 after the death fade (71.6 s): ${JSON.stringify(c)}`);
  await page.close();
}
