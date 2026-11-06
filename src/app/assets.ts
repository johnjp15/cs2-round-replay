/**
 * The page's data: the round, the nav mesh and the sight mask (JSON), and the radar image.
 *
 * Normal build (`npm run build`): the JSON files are emitted next to the page and fetched in parallel with the
 * radar, so they are cached separately and don't bloat the script.
 *
 * Single-file build (`npm run build:single`, vite.single.config.ts): main.ts's import of this module is
 * redirected to `assets-embedded.ts`, which reads the same files from the page itself and makes no requests
 * (docs/deploy.md). Both export `loadAssets()` with this signature.
 *
 * `tuning.json` is small and imported directly by main.ts in both builds.
 */
import roundUrl from '../../data/round.json?url';
import navUrl from '../../data/mirage-nav.json?url';
import visionUrl from '../../data/mirage-vismask.json?url';
import radarUrl from '../../data/mirage-radar.jpg';

/** The JSON values (or their text: parseSessionData takes either) and the decoded radar. */
export interface PageAssets {
  readonly round: unknown;
  readonly nav: unknown;
  readonly vision: unknown;
  readonly radar: HTMLImageElement;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as unknown;
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

export async function loadAssets(): Promise<PageAssets> {
  const [round, nav, vision, radar] = await Promise.all([fetchJson(roundUrl), fetchJson(navUrl), fetchJson(visionUrl), loadImage(radarUrl)]);
  return { round, nav, vision, radar };
}
