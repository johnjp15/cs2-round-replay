/**
 * H1, single-file build only (vite.single.3d.config.ts swaps it in for `./assets3d`): the 3D page's data from
 * `virtual:cs2-embedded-assets-3d`, gzipped + base64 at build time and inflated with DecompressionStream, as the 2D
 * page does (src/app/assets-embedded.ts). The radar is a `data:` URI. No requests.
 */
import embedded from 'virtual:cs2-embedded-assets-3d';
import { loadImage, type PageAssets3d } from './assets3d';
import { DEFAULT_MAP, type MapId } from '../contracts/index';

function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  const s = atob(base64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function gunzip(base64: string): Response {
  if (typeof DecompressionStream === 'undefined') throw new Error('this browser is too old to open the sim (it needs Safari 16.4 or newer)');
  return new Response(new Blob([bytesOf(base64)]).stream().pipeThrough(new DecompressionStream('gzip')));
}

/** X1: this page embeds only the default map package; another `?map=` needs the normal build (docs/maps.md). */
export async function loadAssets3d(map: MapId = DEFAULT_MAP): Promise<PageAssets3d> {
  if (map !== DEFAULT_MAP) throw new Error(`this page embeds only the ${DEFAULT_MAP} map package, not "${map}"`);
  const text = (v: string): Promise<string> => gunzip(v).text();
  const bytes = async (v: string): Promise<Uint8Array> => new Uint8Array(await gunzip(v).arrayBuffer());
  const [round, nav, vision, geometry, clips, tracks, radar] = await Promise.all([
    text(embedded.round),
    text(embedded.nav),
    text(embedded.vision),
    bytes(embedded.geometry),
    bytes(embedded.clips),
    text(embedded.tracks),
    loadImage(embedded.radar),
  ]);
  return { round, nav, vision, world3d: { geometry, clips, tracks }, radar, render: null };
}
