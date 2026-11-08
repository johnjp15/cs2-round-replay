/**
 * H6 (#85): the death fade in the 3D browser check (tools/browser-check3d.ts calls `h6Checks`; alone:
 * `npm run check:browser:3d -- --only h6`). Live play (a death needs the Scene to see it happen), on the page's frame
 * loop driven by hand at 60 fps of round time (`perf.driver('manual')`, `perf.step`), so it doesn't depend on the
 * machine's speed. Watching the golden no-human run through cart's eyes (first person), from 68.8 s:
 *  (a) 69.5 s, just after cart's death (tick 4442): his own view, the eye dropping below standing height, no
 *      crosshair, still on cart; (b) 70.4 s, ~1 s in: on the ground, about half black (his death wasn't a headshot);
 *  (c) 71.6 s, past 2 s: the fade is over and the camera is on another player.
 * Screenshots `docs/img/app3d-h6-fade-*.jpg`.
 *
 * Then the HUD (#65, #67), deterministic through the test API (`test.freeze`, `seekTick`, `eyes`, `render`: each
 * seek rebuilds the Scene, which restores the round's history from the session log), 1280 × 720, `app3d-h6-hud-*.jpg`:
 *  (a) 27.6 s through cart's eyes (T): "The bomb has been planted / 40 seconds till detonation", the C4 icon instead
 *      of the clock (no countdown), the score CT left and T right, cart's money;
 *  (b) 66.0 s, the defuse, through sp4rtan's eyes (the defusing CT): the defuse bar; (c) through cart's (T): none;
 *  (d) 70.5 s: "Counter-Terrorists Win / The bomb has been defused";
 *  then the kill feed after a seek: Lokier's death (18.8 s) is in it at 19.5 s and at 24.7 s, gone at 24.9 s (6 s).
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

interface HudState {
  hud: { clock: string; clockClass: string; defuse: boolean; alert: boolean; banner: string; money: string };
  score: string;
  alertText: string;
  feed: string[];
}

/** Seek to `t` s through `id`'s eyes, render one exact frame, read the HUD. */
async function hudAt(page: Page, t: number, id: string): Promise<HudState> {
  return page.evaluate(
    ({ t, id }) => {
      const api = window.__cs2sim3d;
      if (api === undefined) throw new Error('no 3D hook');
      api.test.seekTick(Math.round(t * 64) + 1);
      api.test.eyes(id as Parameters<typeof api.test.eyes>[0]);
      api.test.render();
      // (No named helpers in here: tsx's __name wrapper doesn't exist in the page.)
      return {
        hud: api.stats().hud,
        score: [...(document.getElementById('top')?.children ?? [])].map((c) => c.id).join(' '),
        alertText: document.getElementById('alert')?.textContent ?? '',
        feed: [...(document.getElementById('killfeed')?.children ?? [])].map((c) => c.textContent ?? ''),
      };
    },
    { t, id },
  );
}

/** #65 / #67: the team-correct bomb HUD, the plant alert, the win banner, the money, the kill feed after a seek. */
async function hudChecks(ctx: H6Context, problems: string[], report: Record<string, unknown>): Promise<void> {
  const page = await ctx.open(1280, 720);
  const shot = async (name: string): Promise<string> => {
    const path = join(ctx.out, `app3d-h6-hud-${name}.jpg`);
    await page.screenshot({ path, type: 'jpeg', quality: 70 });
    return path;
  };
  const shots: string[] = [];
  await page.evaluate(() => window.__cs2sim3d?.test.freeze(true));
  const a = await hudAt(page, 27.6, 'cart');
  shots.push(await shot('a-plant-t'));
  if (!a.hud.alert || !a.alertText.includes('The bomb has been planted') || !a.alertText.includes('40 seconds till detonation')) problems.push(`h6 plant alert: ${JSON.stringify(a.alertText)}`);
  if (!a.hud.clockClass.includes('c4') || a.hud.clock !== '') problems.push(`h6 C4 icon instead of the clock: ${a.hud.clockClass} "${a.hud.clock}"`);
  if (a.score !== 'score-ct clock score-t') problems.push(`h6 score sides (CT left, T right): ${a.score}`);
  if (!a.hud.money.startsWith('$')) problems.push(`h6 cart's money: ${a.hud.money}`);
  const b = await hudAt(page, 66, 'sp4rtan');
  shots.push(await shot('b-defuse-ct'));
  const c = await hudAt(page, 66, 'cart');
  shots.push(await shot('c-defuse-t'));
  if (!b.hud.defuse) problems.push('h6 the defusing CT sees no defuse bar at 66 s');
  if (c.hud.defuse) problems.push('h6 the T sees the defuse bar at 66 s');
  if (b.hud.clock !== '' || c.hud.clock !== '') problems.push(`h6 a bomb countdown at 66 s: CT "${b.hud.clock}", T "${c.hud.clock}"`);
  const d = await hudAt(page, 70.5, 'cart');
  shots.push(await shot('d-banner'));
  if (!d.hud.banner.includes('Counter-Terrorists Win') || !d.hud.banner.includes('The bomb has been defused')) problems.push(`h6 win banner: ${JSON.stringify(d.hud.banner)}`);
  const k1 = await hudAt(page, 19.5, 'cart');
  const k2 = await hudAt(page, 18.8 + 5.9, 'cart');
  const k3 = await hudAt(page, 18.8 + 6.1, 'cart');
  const lok = (xs: string[]): boolean => xs.some((x) => x.toLowerCase().includes('lokier'));
  const feed = { at19_5: k1.feed, at24_7: k2.feed, at24_9: k3.feed };
  if (!lok(k1.feed) || !lok(k2.feed) || lok(k3.feed)) problems.push(`h6 kill feed after a seek / 6 s: ${JSON.stringify(feed)}`);
  report['h6hud'] = { plant: a, defuse: { ct: b, t: c }, banner: d, feed, screenshots: shots };
  await page.evaluate(() => window.__cs2sim3d?.test.freeze(false));
  await page.close();
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
  await hudChecks(ctx, problems, report);
}
