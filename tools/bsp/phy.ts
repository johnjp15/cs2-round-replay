/**
 * X1: Source collision models (VPhysics "vcollide": a model's `.phy` file and the BSP's PHYSCOLLIDE lump), as convex
 * hulls of triangles in Source units (docs/maps.md "Props").
 *
 * A collide is a list of solids. Each solid is a `compactsurfaceheader_t` ("VPHY", i16 version, i16 model type,
 * i32 surface size, drag axis areas, i32 axis map size: 28 bytes) followed by an IVP compact surface: mass centre,
 * rotation inertia, radius, packed deviation/size, i32 offset of the ledge tree root, 3 dummies (48 bytes). Its
 * convex pieces ("ledges", 16 bytes: i32 point offset, client data, packed flags/size, i16 triangle count) each carry
 * 16-byte triangles (packed index word, then 3 edges of u16 start point, 15-bit opposite, 1-bit virtual) and point to
 * an array of 16-byte points (float x y z, hesse). The ledges are found through the ledge tree (28-byte nodes: i32
 * offset of the right child, i32 offset of the ledge, centre, radius, box sizes; a node with no right child is a leaf
 * holding one ledge; the left child follows the node).
 *
 * IVP works in metres with y down: Source (x, y, z) = (ivp.x, ivp.z, −ivp.y) / 0.0254 (vphysics `ConvertPositionToHL`).
 * Layouts after the public Source SDK 2013 (`vcollide_parse`, `phyfile.h`, `ivp_compact_*.hxx`) and the open readers
 * in Crowbar and SourceIO.
 */

export class PhyError extends Error {
  override readonly name = 'PhyError';
}

const METERS_PER_INCH = 0.0254;
const VPHY_ID = 0x59485056; // "VPHY"
const SURFACE_HEADER = 48;
const LEDGE_BYTES = 16;
const TRIANGLE_BYTES = 16;
const POINT_BYTES = 16;
const NODE_BYTES = 28;

/** One convex piece: triangles as x y z per vertex (9 per triangle), Source units, the model's frame. */
export interface ConvexPiece {
  readonly triangles: Float64Array;
}

export interface CollideSolid {
  readonly pieces: readonly ConvexPiece[];
}

function dvOf(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

/** The ledges of one compact surface starting at `s` (byte offset in `b`), by walking the ledge tree. */
function surfaceLedges(b: Uint8Array, s: number, size: number): number[] {
  const dv = dvOf(b);
  const rootOfs = dv.getInt32(s + 32, true);
  const ledges: number[] = [];
  if (rootOfs <= 0 || rootOfs >= size) {
    // No tree: a single ledge right after the header.
    ledges.push(s + SURFACE_HEADER);
    return ledges;
  }
  const stack: number[] = [s + rootOfs];
  let guard = 0;
  while (stack.length > 0) {
    if (++guard > 1_000_000) throw new PhyError('phy: ledge tree loops');
    const node = stack.pop() as number;
    if (node < s || node + NODE_BYTES > s + size) throw new PhyError('phy: ledge tree node out of range');
    const right = dv.getInt32(node, true);
    const ledge = dv.getInt32(node + 4, true);
    if (right === 0) {
      if (ledge === 0) throw new PhyError('phy: leaf node without a ledge');
      ledges.push(node + ledge);
    } else {
      stack.push(node + right, node + NODE_BYTES);
    }
  }
  return ledges.sort((x, y) => x - y);
}

function readLedge(b: Uint8Array, at: number, end: number): ConvexPiece {
  const dv = dvOf(b);
  if (at < 0 || at + LEDGE_BYTES > end) throw new PhyError('phy: ledge out of range');
  const pointOfs = dv.getInt32(at, true);
  const nTri = dv.getInt16(at + 12, true);
  if (nTri <= 0 || at + LEDGE_BYTES + nTri * TRIANGLE_BYTES > end) throw new PhyError(`phy: ledge with ${nTri} triangles out of range`);
  const points = at + pointOfs;
  const tris = new Float64Array(nTri * 9);
  for (let t = 0; t < nTri; t++) {
    const o = at + LEDGE_BYTES + t * TRIANGLE_BYTES;
    for (let e = 0; e < 3; e++) {
      const edge = dv.getUint32(o + 4 + e * 4, true);
      const p = edge & 0xffff;
      const po = points + p * POINT_BYTES;
      if (po < 0 || po + 12 > b.length) throw new PhyError('phy: point out of range');
      const x = dv.getFloat32(po, true);
      const y = dv.getFloat32(po + 4, true);
      const z = dv.getFloat32(po + 8, true);
      tris[t * 9 + e * 3] = x / METERS_PER_INCH;
      tris[t * 9 + e * 3 + 1] = z / METERS_PER_INCH;
      tris[t * 9 + e * 3 + 2] = -y / METERS_PER_INCH;
    }
  }
  return { triangles: tris };
}

/** One solid's bytes (starting at its "VPHY" header) → its convex pieces. */
export function readSolid(b: Uint8Array, at: number, size: number): CollideSolid {
  const dv = dvOf(b);
  if (size < 28 + SURFACE_HEADER) throw new PhyError('phy: solid too small');
  if (dv.getUint32(at, true) !== VPHY_ID) throw new PhyError('phy: solid is not VPHY (pre-2006 format is not supported)');
  const surfaceSize = dv.getInt32(at + 8, true);
  const s = at + 28;
  const end = Math.min(at + size, s + Math.max(surfaceSize, 0));
  if (end - s < SURFACE_HEADER) throw new PhyError('phy: surface too small');
  const pieces = surfaceLedges(b, s, end - s).map((l) => readLedge(b, l, end));
  return { pieces };
}

/** A `.phy` file: a 16-byte header (i32 header size, i32 id, i32 solid count, i32 checksum), then each solid as i32 size + bytes, then text. */
export function readPhy(b: Uint8Array): { checksum: number; solids: CollideSolid[]; text: string } {
  const dv = dvOf(b);
  if (b.length < 16) throw new PhyError('phy: file too short');
  const headerSize = dv.getInt32(0, true);
  const count = dv.getInt32(8, true);
  const checksum = dv.getInt32(12, true);
  if (headerSize < 16 || count < 0 || count > 4096) throw new PhyError(`phy: bad header (size ${headerSize}, solids ${count})`);
  let o = headerSize;
  const solids: CollideSolid[] = [];
  for (let i = 0; i < count; i++) {
    if (o + 4 > b.length) throw new PhyError('phy: truncated');
    const size = dv.getInt32(o, true);
    if (size <= 0 || o + 4 + size > b.length) throw new PhyError(`phy: solid ${i} out of range`);
    solids.push(readSolid(b, o + 4, size));
    o += 4 + size;
  }
  return { checksum, solids, text: new TextDecoder('latin1').decode(b.subarray(o)).replace(/\0+$/, '') };
}

/** The BSP's PHYSCOLLIDE lump: per brush model {i32 model, i32 data size, i32 key data size, i32 solids}, solids, key text; ends at model −1. */
export function readPhysCollideLump(b: Uint8Array): { model: number; solids: CollideSolid[] }[] {
  const dv = dvOf(b);
  const out: { model: number; solids: CollideSolid[] }[] = [];
  let o = 0;
  while (o + 16 <= b.length) {
    const model = dv.getInt32(o, true);
    if (model === -1) break;
    const dataSize = dv.getInt32(o + 4, true);
    const keySize = dv.getInt32(o + 8, true);
    const count = dv.getInt32(o + 12, true);
    o += 16;
    const dataEnd = o + dataSize;
    if (dataSize < 0 || keySize < 0 || dataEnd + keySize > b.length) throw new PhyError(`physcollide: model ${model} out of range`);
    const solids: CollideSolid[] = [];
    let p = o;
    for (let i = 0; i < count; i++) {
      const size = dv.getInt32(p, true);
      if (size <= 0 || p + 4 + size > dataEnd) throw new PhyError(`physcollide: model ${model} solid ${i} out of range`);
      solids.push(readSolid(b, p + 4, size));
      p += 4 + size;
    }
    out.push({ model, solids });
    o = dataEnd + keySize;
  }
  return out;
}
