/**
 * Map packs for the replay: `pack.json` (the radar transform and the lower-level split) and the radar images, from
 * `MAP_PACK_BASE` (config.ts). Cached per map for the page's lifetime. docs/coach/maps.md has the format.
 */
import { mapPackUrl } from './config';

export interface RadarInfo {
  pos_x: number;
  pos_y: number;
  scale: number;
  width: number;
  height: number;
  lowerBelowZ: number | null;
  files: { default: string; lower: string | null };
}

export interface MapView {
  map: string;
  radar: RadarInfo;
  upper: HTMLImageElement | null;
  lower: HTMLImageElement | null;
  /** The square part of the radar (radar pixels) the replay shows: the drawn area of both levels plus a margin. */
  view: { x: number; y: number; size: number };
  /** Why the radar is missing, if it is. */
  error: string | null;
}

/** Bounding box of the drawn (opaque, not black) pixels of the images, as a square with a 4 % margin. */
function contentView(r: RadarInfo, imgs: (HTMLImageElement | null)[]): { x: number; y: number; size: number } {
  const full = { x: 0, y: 0, size: Math.max(r.width, r.height) };
  const cv = document.createElement('canvas');
  cv.width = r.width;
  cv.height = r.height;
  const g = cv.getContext('2d', { willReadFrequently: true });
  if (!g) return full;
  let x0 = r.width;
  let y0 = r.height;
  let x1 = -1;
  let y1 = -1;
  for (const img of imgs) {
    if (!img) continue;
    g.clearRect(0, 0, r.width, r.height);
    g.drawImage(img, 0, 0, r.width, r.height);
    const d = g.getImageData(0, 0, r.width, r.height).data;
    for (let y = 0; y < r.height; y += 2) {
      for (let x = 0; x < r.width; x += 2) {
        const i = (y * r.width + x) * 4;
        if ((d[i + 3] ?? 0) < 40 || (d[i] ?? 0) + (d[i + 1] ?? 0) + (d[i + 2] ?? 0) < 45) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return full;
  const size = Math.max(x1 - x0, y1 - y0) * 1.08;
  return { x: (x0 + x1) / 2 - size / 2, y: (y0 + y1) / 2 - size / 2, size };
}

const cache = new Map<string, Promise<MapView>>();

async function image(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  await img.decode();
  return img;
}

/** A plain transform when there is no pack: fits ±4096 units. */
const FALLBACK: RadarInfo = { pos_x: -4096, pos_y: 4096, scale: 8, width: 1024, height: 1024, lowerBelowZ: null, files: { default: '', lower: null } };

export function loadMap(map: string): Promise<MapView> {
  let p = cache.get(map);
  if (!p) {
    p = (async (): Promise<MapView> => {
      try {
        const res = await fetch(mapPackUrl(map, 'pack.json'));
        if (!res.ok) throw new Error(`no map pack for ${map} (HTTP ${res.status})`);
        const pack = (await res.json()) as { radar: RadarInfo };
        const r = pack.radar;
        const [upper, lower] = await Promise.all([
          image(mapPackUrl(map, r.files.default)),
          r.files.lower ? image(mapPackUrl(map, r.files.lower)) : Promise.resolve(null),
        ]);
        return { map, radar: r, upper, lower, view: contentView(r, [upper, lower]), error: null };
      } catch (err) {
        return { map, radar: FALLBACK, upper: null, lower: null, view: { x: 0, y: 0, size: 1024 }, error: err instanceof Error ? err.message : String(err) };
      }
    })();
    cache.set(map, p);
  }
  return p;
}

/** World (Source units) → radar pixel. */
export function toRadar(r: RadarInfo, x: number, y: number): [number, number] {
  return [(x - r.pos_x) / r.scale, (r.pos_y - y) / r.scale];
}
