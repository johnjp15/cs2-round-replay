/**
 * X1 test fixtures: writers for tiny synthetic Source files (BSP v21 with box brushes, faces, lightmaps, entities,
 * static props and a pak file; ZIP; VPK v2; MDL and VTF headers), laid out exactly as the readers in tools/bsp/
 * expect (docs/maps.md "Source BSP"). The public maps in tests/fixtures/bsp/ check the readers against real vbsp
 * output; these check what the public maps don't have (player/grenade clips, ladders, buy zones, CS:GO props).
 */
import { LUMP } from '../tools/bsp/bsp';

class Buf {
  private b: number[] = [];
  get length(): number {
    return this.b.length;
  }
  u8(v: number): this {
    this.b.push(v & 255);
    return this;
  }
  u16(v: number): this {
    return this.u8(v).u8(v >>> 8);
  }
  i16(v: number): this {
    return this.u16(v & 0xffff);
  }
  u32(v: number): this {
    return this.u16(v & 0xffff).u16((v >>> 16) & 0xffff);
  }
  i32(v: number): this {
    return this.u32(v >>> 0);
  }
  f32(v: number): this {
    const a = new DataView(new ArrayBuffer(4));
    a.setFloat32(0, v, true);
    for (let i = 0; i < 4; i++) this.u8(a.getUint8(i));
    return this;
  }
  bytes(src: ArrayLike<number>): this {
    for (let i = 0; i < src.length; i++) this.u8(src[i] as number);
    return this;
  }
  str(s: string, fixed?: number): this {
    const e = new TextEncoder().encode(s);
    this.bytes(e);
    if (fixed === undefined) this.u8(0);
    else for (let i = e.length; i < fixed; i++) this.u8(0);
    return this;
  }
  pad(n: number): this {
    for (let i = 0; i < n; i++) this.u8(0);
    return this;
  }
  out(): Uint8Array {
    return new Uint8Array(this.b);
  }
}

export type V3 = readonly [number, number, number];

export interface SynBrush {
  readonly min: V3;
  readonly max: V3;
  readonly contents: number;
  /** Texinfo of every side. */
  readonly texInfo: number;
}

export interface SynModel {
  /** Brush indices (into `brushes`) of this brush entity model (*1, *2, …). */
  readonly brushes: readonly number[];
  readonly min: V3;
  readonly max: V3;
}

export interface SynProp {
  readonly model: number;
  readonly origin: V3;
  readonly angles: V3;
  readonly solid: number;
}

export interface SynBsp {
  readonly version?: number;
  readonly materials: readonly { readonly name: string; readonly reflectivity: V3 }[];
  /** Texinfos: material index and flags. */
  readonly texInfos: readonly { readonly material: number; readonly flags: number }[];
  /** World brushes (model 0). */
  readonly brushes: readonly SynBrush[];
  /** The top face (+z) of these world brushes is drawn, with a 2 × 2 lightmap of this linear grey. */
  readonly drawTops: readonly { readonly brush: number; readonly light: number }[];
  readonly models: readonly SynModel[];
  readonly entities: string;
  readonly props?: { readonly names: readonly string[]; readonly props: readonly SynProp[] };
  readonly pak?: Uint8Array;
}

/** Axis-aligned box brush planes: +x, −x, +y, −y, +z, −z. */
function boxPlanes(b: SynBrush): { n: V3; d: number }[] {
  return [
    { n: [1, 0, 0], d: b.max[0] },
    { n: [-1, 0, 0], d: -b.min[0] },
    { n: [0, 1, 0], d: b.max[1] },
    { n: [0, -1, 0], d: -b.min[1] },
    { n: [0, 0, 1], d: b.max[2] },
    { n: [0, 0, -1], d: -b.min[2] },
  ];
}

/** Write a VBSP file. Every model's tree is a single leaf holding its brushes (headNode = −1 − leaf). */
export function writeBsp(s: SynBsp): Uint8Array {
  const version = s.version ?? 21;
  const lumps = new Map<number, Uint8Array>();
  const allBrushes = s.brushes;
  // Planes and sides.
  const planes = new Buf();
  const sides = new Buf();
  const brushes = new Buf();
  let planeCount = 0;
  let sideCount = 0;
  const addPlane = (n: V3, d: number): number => {
    planes.f32(n[0]).f32(n[1]).f32(n[2]).f32(d).i32(n[0] !== 0 ? 0 : n[1] !== 0 ? 1 : 2);
    return planeCount++;
  };
  for (const b of allBrushes) {
    const first = sideCount;
    for (const p of boxPlanes(b)) {
      sides.u16(addPlane(p.n, p.d)).i16(b.texInfo).i16(-1).u8(0).u8(0);
      sideCount++;
    }
    brushes.i32(first).i32(6).i32(b.contents);
  }
  // Faces: the drawn tops.
  const verts = new Buf();
  const edges = new Buf();
  const surf = new Buf();
  const faces = new Buf();
  const light = new Buf();
  let nv = 0;
  let ne = 1;
  edges.u16(0).u16(0); // edge 0 is unused by convention
  const faceIds: number[] = [];
  s.drawTops.forEach((t, k) => {
    const b = allBrushes[t.brush] as SynBrush;
    const z = b.max[2];
    // Clockwise seen from above (the file's order around the normal).
    const corners: V3[] = [
      [b.min[0], b.min[1], z],
      [b.min[0], b.max[1], z],
      [b.max[0], b.max[1], z],
      [b.max[0], b.min[1], z],
    ];
    const v0 = nv;
    for (const c of corners) {
      verts.f32(c[0]).f32(c[1]).f32(c[2]);
      nv++;
    }
    const firstEdge = ne - 1;
    for (let i = 0; i < 4; i++) {
      edges.u16(v0 + i).u16(v0 + ((i + 1) % 4));
      surf.i32(ne);
      ne++;
    }
    const plane = addPlane([0, 0, 1], z);
    const lightOfs = light.length;
    // 2 × 2 luxels, ColorRGBExp32 with exponent 0: value / 255.
    const g = Math.round(t.light * 255);
    for (let i = 0; i < 4; i++) light.u8(g).u8(g).u8(g).u8(0);
    faces
      .u16(plane)
      .u8(0)
      .u8(0)
      .i32(firstEdge)
      .i16(4)
      .i16(b.texInfo)
      .i16(-1)
      .i16(0)
      .bytes([0, 255, 255, 255])
      .i32(lightOfs)
      .f32((b.max[0] - b.min[0]) * (b.max[1] - b.min[1]))
      .i32(0)
      .i32(0)
      .i32(1)
      .i32(1)
      .i32(k)
      .u16(0)
      .u16(0)
      .u32(0);
    faceIds.push(k);
  });
  // surfedges index into the edges list from 1; firstEdge counts surfedges from 0.
  // Texinfo: texture vecs unused; lightmap vecs map the brush top onto the 2 × 2 luxels (s = (x − min.x) / size.x).
  const texinfo = new Buf();
  s.texInfos.forEach((ti) => {
    const b = allBrushes[s.drawTops.find((t) => (allBrushes[t.brush] as SynBrush).texInfo === s.texInfos.indexOf(ti))?.brush ?? 0] as SynBrush | undefined;
    const sx = b === undefined ? 1 : 1 / (b.max[0] - b.min[0]);
    const sy = b === undefined ? 1 : 1 / (b.max[1] - b.min[1]);
    texinfo.f32(1).f32(0).f32(0).f32(0).f32(0).f32(1).f32(0).f32(0);
    texinfo
      .f32(sx)
      .f32(0)
      .f32(0)
      .f32(b === undefined ? 0 : -b.min[0] * sx)
      .f32(0)
      .f32(sy)
      .f32(0)
      .f32(b === undefined ? 0 : -b.min[1] * sy);
    texinfo.i32(ti.flags).i32(ti.material);
  });
  const texdata = new Buf();
  const strData = new Buf();
  const strTable = new Buf();
  s.materials.forEach((m, i) => {
    strTable.i32(strData.length);
    strData.str(m.name);
    texdata.f32(m.reflectivity[0]).f32(m.reflectivity[1]).f32(m.reflectivity[2]).i32(i).i32(64).i32(64).i32(64).i32(64);
  });
  // Leaves: 0 = the world's, then one per brush model. Leaf faces: the world leaf holds every drawn face.
  const leafs = new Buf();
  const leafBrushes = new Buf();
  const leafFaces = new Buf();
  for (const f of faceIds) leafFaces.u16(f);
  const leafOf = (brushList: readonly number[], faceCount: number, area: number): void => {
    const first = leafBrushes.length / 2;
    for (const b of brushList) leafBrushes.u16(b);
    leafs.i32(0).i16(0).u16(area).pad(12).u16(0).u16(faceCount).u16(first).u16(brushList.length).i16(-1).pad(2);
  };
  const inModels = new Set(s.models.flatMap((m) => m.brushes));
  leafOf(
    allBrushes.map((_, i) => i).filter((i) => !inModels.has(i)),
    faceIds.length,
    1,
  );
  for (const m of s.models) leafOf(m.brushes, 0, 1);
  const models = new Buf();
  const wmin: [number, number, number] = [Infinity, Infinity, Infinity];
  const wmax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const b of allBrushes) for (let k = 0; k < 3; k++) {
    wmin[k] = Math.min(wmin[k] as number, b.min[k] as number);
    wmax[k] = Math.max(wmax[k] as number, b.max[k] as number);
  }
  models.f32(wmin[0]).f32(wmin[1]).f32(wmin[2]).f32(wmax[0]).f32(wmax[1]).f32(wmax[2]).f32(0).f32(0).f32(0).i32(-1).i32(0).i32(faceIds.length);
  s.models.forEach((m, k) => {
    models.f32(m.min[0]).f32(m.min[1]).f32(m.min[2]).f32(m.max[0]).f32(m.max[1]).f32(m.max[2]).f32(0).f32(0).f32(0).i32(-2 - k).i32(faceIds.length).i32(0);
  });
  lumps.set(LUMP.ENTITIES, new Buf().str(s.entities).out());
  lumps.set(LUMP.PLANES, planes.out());
  lumps.set(LUMP.TEXDATA, texdata.out());
  lumps.set(LUMP.VERTEXES, verts.out());
  lumps.set(LUMP.TEXINFO, texinfo.out());
  lumps.set(LUMP.FACES, faces.out());
  lumps.set(LUMP.LIGHTING, light.out());
  lumps.set(LUMP.LEAFS, leafs.out());
  lumps.set(LUMP.EDGES, edges.out());
  lumps.set(LUMP.SURFEDGES, surf.out());
  lumps.set(LUMP.MODELS, models.out());
  lumps.set(LUMP.LEAFFACES, leafFaces.out());
  lumps.set(LUMP.LEAFBRUSHES, leafBrushes.out());
  lumps.set(LUMP.BRUSHES, brushes.out());
  lumps.set(LUMP.BRUSHSIDES, sides.out());
  lumps.set(LUMP.TEXDATA_STRING_DATA, strData.out());
  lumps.set(LUMP.TEXDATA_STRING_TABLE, strTable.out());
  if (s.pak !== undefined) lumps.set(LUMP.PAKFILE, s.pak);
  // Layout: header, then the lumps in index order; the game lump last (its entries hold absolute offsets).
  const HEADER = 1036;
  const order = [...lumps.keys()].sort((a, b) => a - b);
  let at = HEADER;
  const placed = new Map<number, { offset: number; bytes: Uint8Array }>();
  for (const i of order) {
    const bytes = lumps.get(i) as Uint8Array;
    placed.set(i, { offset: at, bytes });
    at += bytes.length + ((4 - (bytes.length % 4)) % 4);
  }
  if (s.props !== undefined) {
    const sp = new Buf();
    sp.i32(s.props.names.length);
    for (const n of s.props.names) sp.str(n, 128);
    sp.i32(0);
    sp.i32(s.props.props.length);
    for (const p of s.props.props) {
      sp.f32(p.origin[0]).f32(p.origin[1]).f32(p.origin[2]).f32(p.angles[0]).f32(p.angles[1]).f32(p.angles[2]);
      sp.u16(p.model).u16(0).u16(0).u8(p.solid).u8(0).i32(0).f32(0).f32(0);
      sp.pad(76 - 44 - 4).f32(1);
    }
    const body = sp.out();
    const dirBytes = 4 + 16;
    const g = new Buf().i32(1);
    g.u32((0x73 << 24) | (0x70 << 16) | (0x72 << 8) | 0x70).u16(0).u16(11).i32(at + dirBytes).i32(body.length);
    g.bytes(body);
    placed.set(LUMP.GAME_LUMP, { offset: at, bytes: g.out() });
    at += g.length;
  }
  const file = new Uint8Array(at + 4);
  const dv = new DataView(file.buffer);
  dv.setUint32(0, 0x50534256, true);
  dv.setInt32(4, version, true);
  for (const [i, p] of placed) {
    dv.setInt32(8 + i * 16, p.offset, true);
    dv.setInt32(8 + i * 16 + 4, p.bytes.length, true);
    dv.setInt32(8 + i * 16 + 8, i === LUMP.LEAFS ? 1 : 0, true);
    file.set(p.bytes, p.offset);
  }
  dv.setInt32(8 + 64 * 16, 7, true);
  return file;
}

/** A ZIP with stored (method 0) entries. */
export function writeZip(files: readonly { readonly name: string; readonly data: Uint8Array }[]): Uint8Array {
  const out = new Buf();
  const central = new Buf();
  for (const f of files) {
    const name = new TextEncoder().encode(f.name);
    const offset = out.length;
    out.u32(0x04034b50).u16(10).u16(0).u16(0).u32(0).u32(0).u32(f.data.length).u32(f.data.length).u16(name.length).u16(0).bytes(name).bytes(f.data);
    central.u32(0x02014b50).u16(10).u16(10).u16(0).u16(0).u32(0).u32(0).u32(f.data.length).u32(f.data.length).u16(name.length).u16(0).u16(0).u16(0).u16(0).u32(0).u32(offset).bytes(name);
  }
  const cdOffset = out.length;
  const cd = central.out();
  out.bytes(cd);
  out.u32(0x06054b50).u16(0).u16(0).u16(files.length).u16(files.length).u32(cd.length).u32(cdOffset).u16(0);
  return out.out();
}

/** A VPK v2 directory: entries in archives (`archive` ≥ 0) at given offsets. */
export function writeVpkDir(entries: readonly { readonly path: string; readonly archive: number; readonly offset: number; readonly length: number }[]): Uint8Array {
  const byExt = new Map<string, Map<string, { name: string; archive: number; offset: number; length: number }[]>>();
  for (const e of entries) {
    const slash = e.path.lastIndexOf('/');
    const dir = slash < 0 ? ' ' : e.path.slice(0, slash);
    const file = e.path.slice(slash + 1);
    const dot = file.lastIndexOf('.');
    const ext = dot < 0 ? ' ' : file.slice(dot + 1);
    const name = dot < 0 ? file : file.slice(0, dot);
    const d = byExt.get(ext) ?? new Map();
    byExt.set(ext, d);
    const list = d.get(dir) ?? [];
    d.set(dir, list);
    list.push({ name, archive: e.archive, offset: e.offset, length: e.length });
  }
  const tree = new Buf();
  for (const [ext, dirs] of byExt) {
    tree.str(ext);
    for (const [dir, list] of dirs) {
      tree.str(dir);
      for (const f of list) tree.str(f.name).u32(0).u16(0).u16(f.archive).u32(f.offset).u32(f.length).u16(0xffff);
      tree.u8(0);
    }
    tree.u8(0);
  }
  tree.u8(0);
  const t = tree.out();
  return new Buf().u32(0x55aa1234).u32(2).u32(t.length).u32(0).u32(0).u32(0).u32(0).bytes(t).out();
}

/** An MDL header (studiohdr_t v48) with a hull box and one material in one search path. */
export function writeMdl(name: string, hullMin: V3, hullMax: V3, material: string, cdTexture: string): Uint8Array {
  const b = new Buf();
  b.u32(0x54534449).i32(48).i32(1234).str(name, 64).i32(600);
  b.pad(104 - b.length);
  for (const v of [...hullMin, ...hullMax, ...hullMin, ...hullMax]) b.f32(v);
  b.i32(0); // flags at 152
  b.pad(204 - b.length);
  b.i32(1).i32(300).i32(1).i32(260).i32(1).i32(1).i32(280);
  b.pad(260 - b.length);
  b.i32(450); // cdtexture offset
  b.pad(280 - b.length);
  b.i16(0); // skin table: family 0, ref 0 → texture 0
  b.pad(300 - b.length);
  b.i32(400 - 300); // texture name offset (relative to the texture struct)
  b.pad(400 - b.length);
  b.str(material);
  b.pad(450 - b.length);
  b.str(cdTexture);
  b.pad(600 - b.length);
  return b.out();
}

/** A VTF 7.2 header with a reflectivity (linear mean colour). */
export function writeVtf(reflectivity: V3): Uint8Array {
  const b = new Buf();
  b.u32(0x00465456).u32(7).u32(2).u32(80).u16(64).u16(64).u32(0).u16(1).u16(0).pad(4);
  b.f32(reflectivity[0]).f32(reflectivity[1]).f32(reflectivity[2]).pad(4);
  b.f32(1).i32(13).u8(7).i32(-1).u8(0).u8(0);
  b.pad(80 - b.length);
  return b.out();
}
