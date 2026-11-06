/**
 * Minimal PNG writer for debug images (tools only): 8-bit RGBA, no filtering, zlib from Node.
 * Deterministic: the same pixels give the same bytes.
 */
import { deflateSync } from 'node:zlib';

const CRC_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t.push(c >>> 0);
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const body = Buffer.concat([head.subarray(4), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head.subarray(0, 4), body, crc]);
}

/** Encode `rgba` (width × height × 4 bytes, row-major, top row first) as a PNG file. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  if (rgba.length !== width * height * 4) throw new Error(`encodePng: expected ${width * height * 4} bytes, got ${rgba.length}`);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array(0))]);
}

/** Draw a 1-px line (Bresenham) into an RGBA buffer, blending `color` with alpha `a` (0..1). */
export function drawLine(rgba: Uint8Array, width: number, height: number, x0: number, y0: number, x1: number, y1: number, color: readonly [number, number, number], a = 1): void {
  let x = Math.round(x0);
  let y = Math.round(y0);
  const xe = Math.round(x1);
  const ye = Math.round(y1);
  const dx = Math.abs(xe - x);
  const dy = -Math.abs(ye - y);
  const sx = x < xe ? 1 : -1;
  const sy = y < ye ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    plot(rgba, width, height, x, y, color, a);
    if (x === xe && y === ye) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

/** Blend one pixel. */
export function plot(rgba: Uint8Array, width: number, height: number, x: number, y: number, color: readonly [number, number, number], a = 1): void {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const i = (y * width + x) * 4;
  for (let c = 0; c < 3; c++) rgba[i + c] = Math.round((rgba[i + c] as number) * (1 - a) + (color[c] as number) * a);
  rgba[i + 3] = 255;
}

/** A filled square marker of half-size `r` centred on (x, y). */
export function marker(rgba: Uint8Array, width: number, height: number, x: number, y: number, r: number, color: readonly [number, number, number]): void {
  const cx = Math.round(x);
  const cy = Math.round(y);
  for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (Math.abs(i) === r || Math.abs(j) === r) plot(rgba, width, height, cx + i, cy + j, color, 1);
}
