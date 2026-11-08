/**
 * The page's data: the round, the nav mesh and the sight mask (JSON), the radar image, and (G3) the 3D world: the CS2
 * Mirage movement mesh and player clips (binary, `data/geometry/*.bin`), the snapped tracks (JSON) and the height map
 * (PNG, the map layer toggle).
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
import geometryUrl from '../../data/geometry/mirage-geometry.bin?url';
import clipsUrl from '../../data/geometry/mirage-clips.bin?url';
import tracksUrl from '../../data/geometry/mirage-tracks.json?url';
import heightUrl from '../../data/geometry/mirage-height.png';
import type { World3dFiles } from './session';
import { DEFAULT_MAP, mapPackagePaths, parseScenario, type MapId, type Scenario } from '../contracts/index';
import { packageUrl, packageWorldUrls } from './map-packages';

/** H3: every scenario (data/scenarios/*.json), parsed; tiny JSON, bundled. */
const SCENARIO_JSON = import.meta.glob<unknown>('../../data/scenarios/*.json', { eager: true, import: 'default' });

export function scenarioList(): Scenario[] {
  return Object.keys(SCENARIO_JSON)
    .sort()
    .map((k) => parseScenario(SCENARIO_JSON[k], (k.split('/').pop() ?? k).replace(/\.json$/, '')));
}

/** H3: a map package's facts and CS2 nav (free play). */
export async function loadFreePlayNav(map: MapId): Promise<{ info: unknown; nav: unknown }> {
  const p = mapPackagePaths(map);
  if (p.info === null || p.nav === null) throw new Error(`map package "${map}" has no nav.json / map.json`);
  const get = async (url: string): Promise<unknown> => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return (await res.json()) as unknown;
  };
  const [info, nav] = await Promise.all([get(packageUrl(p.info, map)), get(packageUrl(p.nav, map))]);
  return { info, nav };
}

/** The JSON values (or their text: parseSessionData takes either) and the decoded radar. */
export interface PageAssets {
  readonly round: unknown;
  readonly nav: unknown;
  readonly vision: unknown;
  readonly radar: HTMLImageElement;
  /** G3: the 3D world (`parseSessionData`'s last argument). */
  readonly world3d: World3dFiles;
  /** G3: the height map (data/geometry/mirage-height.png, radar frame), for the map layer toggle. */
  readonly height: HTMLImageElement;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as unknown;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

/** X1: `map` picks the 3D world's package (`?map=`); the round, nav, sight mask, radar and height map are shared. */
export async function loadAssets(map: MapId = DEFAULT_MAP): Promise<PageAssets> {
  const w = map === DEFAULT_MAP ? { geometry: geometryUrl, clips: clipsUrl, tracks: tracksUrl } : packageWorldUrls(map);
  const [round, nav, vision, radar, geometry, clips, tracks, height] = await Promise.all([
    fetchJson(roundUrl),
    fetchJson(navUrl),
    fetchJson(visionUrl),
    loadImage(radarUrl),
    fetchBytes(w.geometry),
    fetchBytes(w.clips),
    fetchJson(w.tracks),
    loadImage(heightUrl),
  ]);
  return { round, nav, vision, radar, world3d: { geometry, clips, tracks }, height };
}
