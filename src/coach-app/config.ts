/**
 * Page-level constants. `MAP_PACK_BASE` is where map packs (`<map>/pack.json`, `radar.png`, `radar_lower.png`,
 * `los.bin.gz`) are fetched from, relative to the page. The dev and preview servers serve `data/coach/maps/` there
 * (vite.coach.config.ts); the published build serves packs differently (card K7), which changes only this line.
 */
export const MAP_PACK_BASE = './data/coach/maps/';

/** Absolute URL of a map pack's file (the worker gets absolute URLs: it has no document base). */
export function mapPackUrl(map: string, file: string, base: string = MAP_PACK_BASE): string {
  return new URL(`${base}${encodeURIComponent(map)}/${encodeURIComponent(file)}`, location.href).href;
}

/** CS2 competitive clock: round time and the C4 timer, seconds (mp_roundtime_defuse 1:55, mp_c4timer 40). */
export const ROUND_SEC = 115;
export const BOMB_SEC = 40;
/** Defuse time with and without a kit, seconds. */
export const DEFUSE_KIT_SEC = 5;
export const DEFUSE_SEC = 10;
/** A "Watch" deep link opens this many seconds before the evidence's focus tick. */
export const WATCH_LEAD_SEC = 5;
