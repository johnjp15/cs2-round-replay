/**
 * Single-file build only (vite.single.config.ts swaps it in for `./assets`): the round, nav and sight-mask JSON
 * and the radar come from `virtual:cs2-embedded-assets`, which the build fills in, so the page makes no requests.
 *
 * The JSON is gzipped and base64-encoded at build time (about 103 KB instead of 1.18 MB as escaped text) and
 * inflated here with `DecompressionStream` (Safari 16.4+, Chrome 80+, Firefox 113+). `CS2_SINGLE_RAW=1` at build
 * time embeds it as plain text instead, for comparison. The radar is a `data:` URI (decoded in memory, not fetched).
 */
import embedded from 'virtual:cs2-embedded-assets';
import type { PageAssets } from './assets';

function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  const s = atob(base64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function inflate(base64: string): Promise<string> {
  if (typeof DecompressionStream === 'undefined') throw new Error('this browser is too old to open the replay (it needs Safari 16.4 or newer)');
  const stream = new Blob([bytesOf(base64)]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
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

export async function loadAssets(): Promise<PageAssets> {
  const [round, nav, vision, radar] = await Promise.all([text(embedded.round), text(embedded.nav), text(embedded.vision), loadImage(embedded.radar)]);
  return { round, nav, vision, radar };
}
