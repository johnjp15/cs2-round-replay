/**
 * Single-file build only (vite.single.config.ts swaps it in for `./assets`): the round, nav and sight-mask JSON,
 * the radar and (G3) the 3D world (movement mesh and clips as bytes, snapped tracks, height map) come from
 * `virtual:cs2-embedded-assets`, which the build fills in, so the page makes no requests.
 *
 * The JSON is gzipped and base64-encoded at build time (about 103 KB instead of 1.18 MB as escaped text) and
 * inflated here with `DecompressionStream` (Safari 16.4+, Chrome 80+, Firefox 113+). `CS2_SINGLE_RAW=1` at build
 * time embeds it as plain text instead, for comparison. The radar is a `data:` URI (decoded in memory, not fetched).
 */
import embedded from 'virtual:cs2-embedded-assets';
import type { PageAssets } from './assets';
import { DEFAULT_MAP, type MapId } from '../contracts/index';

function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  const s = atob(base64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function gunzip(base64: string): Response {
  if (typeof DecompressionStream === 'undefined') throw new Error('this browser is too old to open the replay (it needs Safari 16.4 or newer)');
  return new Response(new Blob([bytesOf(base64)]).stream().pipeThrough(new DecompressionStream('gzip')));
}

async function inflate(base64: string): Promise<string> {
  return gunzip(base64).text();
}

/** A binary file: always gzip + base64 (CS2_SINGLE_RAW only changes the JSON). */
async function inflateBytes(base64: string): Promise<Uint8Array> {
  return new Uint8Array(await gunzip(base64).arrayBuffer());
}

async function text(value: string): Promise<string> {
  return embedded.encoding === 'gzip-base64' ? inflate(value) : value;
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

/** X1: this page embeds only the default map package; another `?map=` needs the normal build (docs/maps.md). */
export async function loadAssets(map: MapId = DEFAULT_MAP): Promise<PageAssets> {
  if (map !== DEFAULT_MAP) throw new Error(`this page embeds only the ${DEFAULT_MAP} map package, not "${map}"`);
  const [round, nav, vision, radar, geometry, clips, tracks, height] = await Promise.all([
    text(embedded.round),
    text(embedded.nav),
    text(embedded.vision),
    loadImage(embedded.radar),
    inflateBytes(embedded.geometry),
    inflateBytes(embedded.clips),
    text(embedded.tracks),
    loadImage(embedded.height),
  ]);
  return { round, nav, vision, radar, world3d: { geometry, clips, tracks }, height };
}
