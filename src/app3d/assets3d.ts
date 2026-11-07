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

export interface PageAssets3d {
  readonly round: unknown;
  readonly nav: unknown;
  readonly vision: unknown;
  readonly world3d: World3dFiles;
  /** The CS2 radar (1024 × 1024, transparent outside the playable area). */
  readonly radar: HTMLImageElement;
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

export async function loadAssets3d(): Promise<PageAssets3d> {
  const [round, nav, vision, geometry, clips, tracks, radar] = await Promise.all([
    fetchJson(roundUrl),
    fetchJson(navUrl),
    fetchJson(visionUrl),
    fetchBytes(geometryUrl),
    fetchBytes(clipsUrl),
    fetchJson(tracksUrl),
    loadImage(radarUrl),
  ]);
  return { round, nav, vision, world3d: { geometry, clips, tracks }, radar };
}
