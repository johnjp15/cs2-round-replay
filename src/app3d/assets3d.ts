/**
 * H1: the 3D page's data (docs/app3d.md "Data"): the round, the nav mesh and the sight mask (JSON; the Core, the
 * LIVE AI's nav and the grenades' 2D sight), the CS2 world mesh and player clips (binary), the snapped tracks, and the
 * CS2 radar image (data/source/cs2/de_mirage.png: the floors' colours and the minimap).
 *
 * Normal build (`npm run build:3d`): fetched next to the page. Single-file build (`npm run build:single:3d`,
 * vite.single.3d.config.ts): main.ts's import of this module is redirected to assets3d-embedded.ts, which reads the
 * same files from the page itself. Both export `loadAssets3d()`.
 */
import roundUrl from '../../data/round.json?url';
import navUrl from '../../data/mirage-nav.json?url';
import visionUrl from '../../data/mirage-vismask.json?url';
import geometryUrl from '../../data/geometry/mirage-geometry.bin?url';
import clipsUrl from '../../data/geometry/mirage-clips.bin?url';
import tracksUrl from '../../data/geometry/mirage-tracks.json?url';
import radarUrl from '../../data/source/cs2/de_mirage.png';
import type { World3dFiles } from '../app/session';
import { packageUrl, packageWorldUrls } from '../app/map-packages';
import { DEFAULT_MAP, mapPackagePaths, type MapId } from '../contracts/index';

export interface PageAssets3d {
  readonly round: unknown;
  readonly nav: unknown;
  readonly vision: unknown;
  readonly world3d: World3dFiles;
  /** The CS2 radar (1024 × 1024, transparent outside the playable area). */
  readonly radar: HTMLImageElement;
  /** X1: the package's render mesh (G2RM, src/app3d/render-package.ts), or null: the view derives one from the collision mesh and the radar. */
  readonly render: Uint8Array | null;
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

export async function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

/** X1: `map` picks the 3D world's package (`?map=`, docs/maps.md). */
export async function loadAssets3d(map: MapId = DEFAULT_MAP): Promise<PageAssets3d> {
  const w = map === DEFAULT_MAP ? { geometry: geometryUrl, clips: clipsUrl, tracks: tracksUrl } : packageWorldUrls(map);
  const renderPath = mapPackagePaths(map).render;
  const [round, nav, vision, geometry, clips, tracks, radar, render] = await Promise.all([
    fetchJson(roundUrl),
    fetchJson(navUrl),
    fetchJson(visionUrl),
    fetchBytes(w.geometry),
    fetchBytes(w.clips),
    fetchJson(w.tracks),
    loadImage(radarUrl),
    renderPath === null ? Promise.resolve(null) : fetchBytes(packageUrl(renderPath, map)),
  ]);
  return { round, nav, vision, world3d: { geometry, clips, tracks }, radar, render };
}
