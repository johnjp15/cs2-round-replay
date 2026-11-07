/**
 * X1: the render package of a map built from a Source BSP (tools/extract-bsp.ts, docs/maps.md "Render package"): the
 * drawn faces, displacements and props as triangles with a material per triangle and a baked sRGB colour per vertex
 * (the material's colour × the face's lightmap at that vertex, exposure-scaled; props: × a sun shade). Pure: no DOM,
 * no Three.js; encoded by the tool, decoded by the 3D app (world-mesh.ts `buildRenderTiles`).
 *
 * Format `G2RM` v1, little-endian; after an 18-byte header everything is unsigned LEB128 varints:
 *
 *   bytes 0-3    "G2RM"
 *   byte  4      version (1)
 *   byte  5      0
 *   bytes 6-7    u16 `quant`: position steps per unit (8: multiples of 1/8 unit, as G2GM)
 *   bytes 8-11   u32 vertex count
 *   bytes 12-15  u32 triangle count
 *   bytes 16-17  u16 material count
 *   vertices     zigzag deltas of x, y, z (× quant) and of r, g, b (0..255) from the previous vertex
 *   triangles    zigzag(a − previous a), zigzag(b − a), zigzag(c − a), material
 *
 * Materials (names, flat colours and where each colour came from) are in the package's manifest
 * (`render.materials`), indexed by the material number.
 */

export const RENDER_MAGIC = 'G2RM';
export const RENDER_VERSION = 1;
const HEADER = 18;

export class RenderPackageError extends Error {
  override readonly name = 'RenderPackageError';
}

export interface RenderMesh {
  readonly quant: number;
  readonly materialCount: number;
  /** Integer positions (× quant), x y z per vertex (Source frame, z up). */
  readonly positions: Int32Array;
  /** sRGB 0..255, r g b per vertex. */
  readonly colors: Uint8Array;
  /** Vertex indices, three per triangle. */
  readonly tris: Int32Array;
  /** Material per triangle. */
  readonly materials: Uint16Array;
}

/** One material of the palette (manifest `render.materials`). */
export interface RenderMaterial {
  readonly name: string;
  /** sRGB 0..1. */
  readonly color: readonly [number, number, number];
  /** Where the colour came from: the VTF's reflectivity (mean colour), the BSP's texdata reflectivity (the same value, computed by vbsp), or the name palette. */
  readonly source: 'vtf' | 'reflectivity' | 'palette';
}

function zigzag(n: number): number {
  return n >= 0 ? n * 2 : -n * 2 - 1;
}

function unzigzag(u: number): number {
  return u % 2 === 0 ? u / 2 : -(u + 1) / 2;
}

export function encodeRenderMesh(m: RenderMesh): Uint8Array {
  const nv = m.positions.length / 3;
  const nt = m.tris.length / 3;
  if (!Number.isInteger(nv) || !Number.isInteger(nt) || m.colors.length !== nv * 3 || m.materials.length !== nt) throw new RenderPackageError('encodeRenderMesh: array lengths disagree');
  if (m.materialCount > 65535 || m.quant < 1 || m.quant > 65535) throw new RenderPackageError('encodeRenderMesh: header field out of range');
  const out: number[] = [];
  const u8 = (b: number): void => {
    out.push(b & 255);
  };
  const u16 = (n: number): void => {
    u8(n);
    u8(n >>> 8);
  };
  const u32 = (n: number): void => {
    for (let k = 0; k < 4; k++) u8(Math.floor(n / 256 ** k));
  };
  const varint = (n: number): void => {
    if (!Number.isInteger(n) || n < 0) throw new RenderPackageError(`varint: ${n}`);
    let v = n;
    while (v >= 128) {
      out.push((v % 128) + 128);
      v = Math.floor(v / 128);
    }
    out.push(v);
  };
  for (const ch of RENDER_MAGIC) u8(ch.charCodeAt(0));
  u8(RENDER_VERSION);
  u8(0);
  u16(m.quant);
  u32(nv);
  u32(nt);
  u16(m.materialCount);
  const prev = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < nv; i++) {
    const cur = [m.positions[i * 3] as number, m.positions[i * 3 + 1] as number, m.positions[i * 3 + 2] as number, m.colors[i * 3] as number, m.colors[i * 3 + 1] as number, m.colors[i * 3 + 2] as number];
    for (let k = 0; k < 6; k++) {
      varint(zigzag((cur[k] as number) - (prev[k] as number)));
      prev[k] = cur[k] as number;
    }
  }
  let pa = 0;
  for (let t = 0; t < nt; t++) {
    const a = m.tris[t * 3] as number;
    const b = m.tris[t * 3 + 1] as number;
    const c = m.tris[t * 3 + 2] as number;
    if (a >= nv || b >= nv || c >= nv || a < 0 || b < 0 || c < 0) throw new RenderPackageError(`triangle ${t} out of range`);
    const mat = m.materials[t] as number;
    if (mat >= m.materialCount) throw new RenderPackageError(`triangle ${t}: material ${mat} of ${m.materialCount}`);
    varint(zigzag(a - pa));
    varint(zigzag(b - a));
    varint(zigzag(c - a));
    varint(mat);
    pa = a;
  }
  return new Uint8Array(out);
}

export function decodeRenderMesh(bytes: Uint8Array): RenderMesh {
  if (bytes.length < HEADER) throw new RenderPackageError('render package: too short');
  for (let i = 0; i < 4; i++) if (bytes[i] !== RENDER_MAGIC.charCodeAt(i)) throw new RenderPackageError('render package: bad magic (expected G2RM)');
  if (bytes[4] !== RENDER_VERSION) throw new RenderPackageError(`render package: unsupported version ${bytes[4] as number}`);
  const u16 = (o: number): number => (bytes[o] as number) + (bytes[o + 1] as number) * 256;
  const u32 = (o: number): number => u16(o) + u16(o + 2) * 65536;
  const quant = u16(6);
  const nv = u32(8);
  const nt = u32(12);
  const materialCount = u16(16);
  let o = HEADER;
  const varint = (): number => {
    let v = 0;
    let mul = 1;
    for (;;) {
      if (o >= bytes.length) throw new RenderPackageError('render package: truncated');
      const b = bytes[o++] as number;
      v += (b & 127) * mul;
      if (b < 128) return v;
      mul *= 128;
    }
  };
  const positions = new Int32Array(nv * 3);
  const colors = new Uint8Array(nv * 3);
  const prev = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < nv; i++) {
    for (let k = 0; k < 6; k++) prev[k] = (prev[k] as number) + unzigzag(varint());
    positions[i * 3] = prev[0] as number;
    positions[i * 3 + 1] = prev[1] as number;
    positions[i * 3 + 2] = prev[2] as number;
    for (let k = 0; k < 3; k++) {
      const c = prev[3 + k] as number;
      if (c < 0 || c > 255) throw new RenderPackageError(`render package: vertex ${i} colour out of range`);
      colors[i * 3 + k] = c;
    }
  }
  const tris = new Int32Array(nt * 3);
  const materials = new Uint16Array(nt);
  let pa = 0;
  for (let t = 0; t < nt; t++) {
    const a = pa + unzigzag(varint());
    const b = a + unzigzag(varint());
    const c = a + unzigzag(varint());
    const mat = varint();
    if (a < 0 || b < 0 || c < 0 || a >= nv || b >= nv || c >= nv) throw new RenderPackageError(`render package: triangle ${t} out of range`);
    if (mat >= materialCount) throw new RenderPackageError(`render package: triangle ${t} has material ${mat} of ${materialCount}`);
    tris[t * 3] = a;
    tris[t * 3 + 1] = b;
    tris[t * 3 + 2] = c;
    materials[t] = mat;
    pa = a;
  }
  if (o !== bytes.length) throw new RenderPackageError(`render package: ${bytes.length - o} trailing bytes`);
  return { quant, materialCount, positions, colors, tris, materials };
}
