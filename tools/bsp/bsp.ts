/**
 * X1: a reader for Source engine BSP files (VBSP, versions 19–21; CS:GO is 21), docs/maps.md "Source BSP".
 *
 * Spec: Valve Developer Community, "Source BSP File Format" (the lump table and struct layouts), cross-checked with
 * the public Source SDK 2013 `bspfile.h` / `bspflags.h` and the open-source readers bsp_tool (snake-biscuits),
 * BSPSource (ata4) and VRF's Source 1 notes. Only what the map packages need is decoded; every reader validates its
 * lump's size against its stride and throws `BspError` on anything inconsistent.
 *
 * Layout: a 1036-byte header (`"VBSP"`, i32 version, 64 × {i32 fileofs, i32 filelen, i32 version, 4-byte fourCC},
 * i32 mapRevision). A lump whose bytes start with `"LZMA"` is compressed (Valve's 17-byte LZMA header, tools/bsp/lzma.ts);
 * game lumps are compressed one by one. All little-endian.
 */
import { decodeValveLzma, isValveLzma } from './lzma';

export class BspError extends Error {
  override readonly name = 'BspError';
}

/** Lump indices (bspfile.h). */
export const LUMP = {
  ENTITIES: 0,
  PLANES: 1,
  TEXDATA: 2,
  VERTEXES: 3,
  VISIBILITY: 4,
  NODES: 5,
  TEXINFO: 6,
  FACES: 7,
  LIGHTING: 8,
  OCCLUSION: 9,
  LEAFS: 10,
  FACEIDS: 11,
  EDGES: 12,
  SURFEDGES: 13,
  MODELS: 14,
  WORLDLIGHTS: 15,
  LEAFFACES: 16,
  LEAFBRUSHES: 17,
  BRUSHES: 18,
  BRUSHSIDES: 19,
  AREAS: 20,
  AREAPORTALS: 21,
  DISPINFO: 26,
  ORIGINALFACES: 27,
  PHYSDISP: 28,
  PHYSCOLLIDE: 29,
  VERTNORMALS: 30,
  VERTNORMALINDICES: 31,
  DISP_LIGHTMAP_ALPHAS: 32,
  DISP_VERTS: 33,
  DISP_LIGHTMAP_SAMPLE_POSITIONS: 34,
  GAME_LUMP: 35,
  LEAFWATERDATA: 36,
  PRIMITIVES: 37,
  PRIMVERTS: 38,
  PRIMINDICES: 39,
  PAKFILE: 40,
  CLIPPORTALVERTS: 41,
  CUBEMAPS: 42,
  TEXDATA_STRING_DATA: 43,
  TEXDATA_STRING_TABLE: 44,
  OVERLAYS: 45,
  LEAFMINDISTTOWATER: 46,
  FACE_MACRO_TEXTURE_INFO: 47,
  DISP_TRIS: 48,
  PHYSCOLLIDESURFACE: 49,
  WATEROVERLAYS: 50,
  LEAF_AMBIENT_INDEX_HDR: 51,
  LEAF_AMBIENT_INDEX: 52,
  LIGHTING_HDR: 53,
  WORLDLIGHTS_HDR: 54,
  LEAF_AMBIENT_LIGHTING_HDR: 55,
  LEAF_AMBIENT_LIGHTING: 56,
  XZIPPAKFILE: 57,
  FACES_HDR: 58,
  MAP_FLAGS: 59,
  OVERLAY_FADES: 60,
} as const;

/**
 * Brush contents flags (bspflags.h). GRENADECLIP and DRONECLIP are CS:GO's reuse of CURRENT_90 / CURRENT_180
 * (CS:GO's bspflags.h, as mirrored in community SDKs: verified on the real file by the materials that carry them,
 * `extract-bsp --report` lists contents per tool material).
 */
export const CONTENTS = {
  EMPTY: 0,
  SOLID: 0x1,
  WINDOW: 0x2,
  AUX: 0x4,
  GRATE: 0x8,
  SLIME: 0x10,
  WATER: 0x20,
  BLOCKLOS: 0x40,
  OPAQUE: 0x80,
  TESTFOGVOLUME: 0x100,
  BLOCKLIGHT: 0x400,
  TEAM1: 0x800,
  TEAM2: 0x1000,
  IGNORE_NODRAW_OPAQUE: 0x2000,
  MOVEABLE: 0x4000,
  AREAPORTAL: 0x8000,
  PLAYERCLIP: 0x10000,
  MONSTERCLIP: 0x20000,
  CURRENT_0: 0x40000,
  GRENADECLIP: 0x80000,
  DRONECLIP: 0x100000,
  CURRENT_270: 0x200000,
  CURRENT_UP: 0x400000,
  CURRENT_DOWN: 0x800000,
  ORIGIN: 0x1000000,
  MONSTER: 0x2000000,
  DEBRIS: 0x4000000,
  DETAIL: 0x8000000,
  TRANSLUCENT: 0x10000000,
  LADDER: 0x20000000,
  HITBOX: 0x40000000,
} as const;

/** What blocks a player's hull (bspflags.h MASK_PLAYERSOLID): solid, moveable, player clip, window, monster, grate. */
export const MASK_PLAYERSOLID = CONTENTS.SOLID | CONTENTS.MOVEABLE | CONTENTS.PLAYERCLIP | CONTENTS.WINDOW | CONTENTS.MONSTER | CONTENTS.GRATE;
/** What stops a bullet (MASK_SHOT without HITBOX / MONSTER / DEBRIS): solid, moveable, window, debris-free. */
export const MASK_SHOT_WORLD = CONTENTS.SOLID | CONTENTS.MOVEABLE | CONTENTS.WINDOW;

/** Surface flags of texinfo (bspflags.h). */
export const SURF = {
  LIGHT: 0x1,
  SKY2D: 0x2,
  SKY: 0x4,
  WARP: 0x8,
  TRANS: 0x10,
  NOPORTAL: 0x20,
  TRIGGER: 0x40,
  NODRAW: 0x80,
  HINT: 0x100,
  SKIP: 0x200,
  NOLIGHT: 0x400,
  BUMPLIGHT: 0x800,
  NOSHADOWS: 0x1000,
  NODECALS: 0x2000,
  NOCHOP: 0x4000,
  HITBOX: 0x8000,
} as const;

export interface LumpInfo {
  readonly offset: number;
  readonly length: number;
  readonly version: number;
  /** For an LZMA-compressed lump, the uncompressed size; else usually 0. */
  readonly fourCC: number;
}

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Plane {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly dist: number;
  readonly type: number;
}

export interface Face {
  readonly planeNum: number;
  readonly side: number;
  readonly onNode: number;
  readonly firstEdge: number;
  readonly numEdges: number;
  readonly texInfo: number;
  readonly dispInfo: number;
  readonly styles: readonly [number, number, number, number];
  readonly lightOfs: number;
  readonly area: number;
  readonly lightmapMins: readonly [number, number];
  readonly lightmapSize: readonly [number, number];
  readonly origFace: number;
}

export interface TexInfo {
  /** textureVecs[2][4] then lightmapVecs[2][4]: s = dot(v, xyz) + w. */
  readonly textureVecs: readonly [readonly [number, number, number, number], readonly [number, number, number, number]];
  readonly lightmapVecs: readonly [readonly [number, number, number, number], readonly [number, number, number, number]];
  readonly flags: number;
  readonly texData: number;
}

export interface TexData {
  /** The texture's average colour in linear space (vtex's reflectivity), 0..1. */
  readonly reflectivity: readonly [number, number, number];
  readonly nameId: number;
  readonly width: number;
  readonly height: number;
}

export interface Brush {
  readonly firstSide: number;
  readonly numSides: number;
  readonly contents: number;
}

export interface BrushSide {
  readonly planeNum: number;
  readonly texInfo: number;
  readonly dispInfo: number;
  readonly bevel: boolean;
}

export interface Model {
  readonly mins: Vec3;
  readonly maxs: Vec3;
  readonly origin: Vec3;
  readonly headNode: number;
  readonly firstFace: number;
  readonly numFaces: number;
}

export interface BspNode {
  readonly planeNum: number;
  /** Negative children are leaves: leaf = −1 − child. */
  readonly children: readonly [number, number];
  readonly firstFace: number;
  readonly numFaces: number;
}

export interface Leaf {
  readonly contents: number;
  readonly cluster: number;
  readonly firstLeafBrush: number;
  readonly numLeafBrushes: number;
  readonly firstLeafFace: number;
  readonly numLeafFaces: number;
}

export interface DispInfo {
  readonly startPosition: Vec3;
  readonly dispVertStart: number;
  readonly dispTriStart: number;
  readonly power: number;
  readonly minTess: number;
  readonly smoothingAngle: number;
  readonly contents: number;
  readonly mapFace: number;
}

export interface DispVert {
  readonly vx: number;
  readonly vy: number;
  readonly vz: number;
  readonly dist: number;
  readonly alpha: number;
}

export interface GameLumpEntry {
  readonly id: string;
  readonly flags: number;
  readonly version: number;
  readonly offset: number;
  readonly length: number;
}

export interface StaticProp {
  readonly origin: Vec3;
  /** QAngle: pitch, yaw, roll (degrees). */
  readonly angles: readonly [number, number, number];
  readonly model: string;
  readonly solid: number;
  readonly flags: number;
  readonly skin: number;
  readonly fadeMin: number;
  readonly fadeMax: number;
  /** CS:GO v11+: uniform scale (1 otherwise). */
  readonly scale: number;
}

export interface StaticPropLump {
  readonly version: number;
  /** Bytes per prop actually found (lump size / count). */
  readonly stride: number;
  readonly models: readonly string[];
  readonly props: readonly StaticProp[];
}

/** One entity: its key/value pairs in file order (keys may repeat, e.g. outputs). */
export interface Entity {
  readonly pairs: readonly (readonly [string, string])[];
  get(key: string): string | undefined;
}

const HEADER_BYTES = 1036;
const NUM_LUMPS = 64;

function dvOf(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

function countOf(name: string, b: Uint8Array, stride: number): number {
  if (b.length % stride !== 0) throw new BspError(`${name}: lump size ${b.length} is not a multiple of ${stride}`);
  return b.length / stride;
}

function cstring(b: Uint8Array, start: number, max: number): string {
  let end = start;
  while (end < start + max && end < b.length && b[end] !== 0) end++;
  return new TextDecoder('latin1').decode(b.subarray(start, end));
}

class EntityImpl implements Entity {
  constructor(readonly pairs: readonly (readonly [string, string])[]) {}
  get(key: string): string | undefined {
    for (const [k, v] of this.pairs) if (k === key) return v;
    return undefined;
  }
}

/** Parse the entity lump's text: `{ "key" "value" ... }` blocks. */
export function parseEntities(text: string): Entity[] {
  const out: Entity[] = [];
  let i = 0;
  let cur: [string, string][] | null = null;
  let key: string | null = null;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '{') {
      if (cur !== null) throw new BspError(`entities: nested '{' at ${i}`);
      cur = [];
      i++;
    } else if (c === '}') {
      if (cur === null) throw new BspError(`entities: stray '}' at ${i}`);
      if (key !== null) throw new BspError(`entities: key without value at ${i}`);
      out.push(new EntityImpl(cur));
      cur = null;
      i++;
    } else if (c === '"') {
      const end = text.indexOf('"', i + 1);
      if (end < 0) throw new BspError(`entities: unterminated string at ${i}`);
      const s = text.slice(i + 1, end);
      i = end + 1;
      if (cur === null) throw new BspError(`entities: string outside an entity at ${i}`);
      if (key === null) key = s;
      else {
        cur.push([key, s]);
        key = null;
      }
    } else i++;
  }
  if (cur !== null) throw new BspError('entities: unterminated entity');
  return out;
}

/** A parsed Source BSP file. Lumps are decompressed on first use and cached. */
export class BspFile {
  readonly version: number;
  readonly mapRevision: number;
  readonly lumps: readonly LumpInfo[];
  private readonly cache = new Map<number, Uint8Array>();

  constructor(readonly bytes: Uint8Array) {
    if (bytes.length < HEADER_BYTES) throw new BspError('bsp: file shorter than the header');
    const dv = dvOf(bytes);
    if (dv.getUint32(0, true) !== 0x50534256) throw new BspError('bsp: bad magic (expected VBSP)');
    this.version = dv.getInt32(4, true);
    if (this.version < 19 || this.version > 21) throw new BspError(`bsp: unsupported version ${this.version} (19-21)`);
    const lumps: LumpInfo[] = [];
    for (let i = 0; i < NUM_LUMPS; i++) {
      const o = 8 + i * 16;
      const lump = { offset: dv.getInt32(o, true), length: dv.getInt32(o + 4, true), version: dv.getInt32(o + 8, true), fourCC: dv.getUint32(o + 12, true) };
      if (lump.length < 0 || lump.offset < 0 || (lump.length > 0 && lump.offset + lump.length > bytes.length)) throw new BspError(`bsp: lump ${i} out of range (${lump.offset}+${lump.length} > ${bytes.length})`);
      lumps.push(lump);
    }
    this.lumps = lumps;
    this.mapRevision = dv.getInt32(8 + NUM_LUMPS * 16, true);
  }

  /** The lump's bytes, decompressed. */
  lump(index: number): Uint8Array {
    const c = this.cache.get(index);
    if (c !== undefined) return c;
    const info = this.lumps[index];
    if (info === undefined) throw new BspError(`bsp: no lump ${index}`);
    let b = this.bytes.subarray(info.offset, info.offset + info.length);
    if (index !== LUMP.PAKFILE && index !== LUMP.GAME_LUMP && isValveLzma(b)) b = decodeValveLzma(b);
    this.cache.set(index, b);
    return b;
  }

  /** True if the lump is stored LZMA-compressed. */
  compressed(index: number): boolean {
    const info = this.lumps[index];
    return info !== undefined && isValveLzma(this.bytes.subarray(info.offset, info.offset + Math.min(info.length, 17)));
  }

  entities(): Entity[] {
    const b = this.lump(LUMP.ENTITIES);
    let end = b.length;
    while (end > 0 && b[end - 1] === 0) end--;
    return parseEntities(new TextDecoder('latin1').decode(b.subarray(0, end)));
  }

  planes(): Plane[] {
    const b = this.lump(LUMP.PLANES);
    const dv = dvOf(b);
    const n = countOf('planes', b, 20);
    const out: Plane[] = new Array<Plane>(n);
    for (let i = 0; i < n; i++) {
      const o = i * 20;
      out[i] = { nx: dv.getFloat32(o, true), ny: dv.getFloat32(o + 4, true), nz: dv.getFloat32(o + 8, true), dist: dv.getFloat32(o + 12, true), type: dv.getInt32(o + 16, true) };
    }
    return out;
  }

  /** Vertex positions, x y z per vertex. */
  vertices(): Float64Array {
    const b = this.lump(LUMP.VERTEXES);
    const dv = dvOf(b);
    const n = countOf('vertexes', b, 12);
    const out = new Float64Array(n * 3);
    for (let i = 0; i < n * 3; i++) out[i] = dv.getFloat32(i * 4, true);
    return out;
  }

  /** Edge vertex indices, two per edge. */
  edges(): Uint16Array {
    const b = this.lump(LUMP.EDGES);
    const dv = dvOf(b);
    const n = countOf('edges', b, 4);
    const out = new Uint16Array(n * 2);
    for (let i = 0; i < n * 2; i++) out[i] = dv.getUint16(i * 2, true);
    return out;
  }

  surfEdges(): Int32Array {
    const b = this.lump(LUMP.SURFEDGES);
    const dv = dvOf(b);
    const n = countOf('surfedges', b, 4);
    const out = new Int32Array(n);
    for (let i = 0; i < n; i++) out[i] = dv.getInt32(i * 4, true);
    return out;
  }

  faces(lump: number = LUMP.FACES): Face[] {
    const b = this.lump(lump);
    const dv = dvOf(b);
    const n = countOf('faces', b, 56);
    const out: Face[] = new Array<Face>(n);
    for (let i = 0; i < n; i++) {
      const o = i * 56;
      out[i] = {
        planeNum: dv.getUint16(o, true),
        side: b[o + 2] as number,
        onNode: b[o + 3] as number,
        firstEdge: dv.getInt32(o + 4, true),
        numEdges: dv.getInt16(o + 8, true),
        texInfo: dv.getInt16(o + 10, true),
        dispInfo: dv.getInt16(o + 12, true),
        styles: [b[o + 16] as number, b[o + 17] as number, b[o + 18] as number, b[o + 19] as number],
        lightOfs: dv.getInt32(o + 20, true),
        area: dv.getFloat32(o + 24, true),
        lightmapMins: [dv.getInt32(o + 28, true), dv.getInt32(o + 32, true)],
        lightmapSize: [dv.getInt32(o + 36, true), dv.getInt32(o + 40, true)],
        origFace: dv.getInt32(o + 44, true),
      };
    }
    return out;
  }

  texInfos(): TexInfo[] {
    const b = this.lump(LUMP.TEXINFO);
    const dv = dvOf(b);
    const n = countOf('texinfo', b, 72);
    const out: TexInfo[] = new Array<TexInfo>(n);
    const v4 = (o: number): [number, number, number, number] => [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true), dv.getFloat32(o + 12, true)];
    for (let i = 0; i < n; i++) {
      const o = i * 72;
      out[i] = { textureVecs: [v4(o), v4(o + 16)], lightmapVecs: [v4(o + 32), v4(o + 48)], flags: dv.getInt32(o + 64, true), texData: dv.getInt32(o + 68, true) };
    }
    return out;
  }

  texDatas(): TexData[] {
    const b = this.lump(LUMP.TEXDATA);
    const dv = dvOf(b);
    const n = countOf('texdata', b, 32);
    const out: TexData[] = new Array<TexData>(n);
    for (let i = 0; i < n; i++) {
      const o = i * 32;
      out[i] = { reflectivity: [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)], nameId: dv.getInt32(o + 12, true), width: dv.getInt32(o + 16, true), height: dv.getInt32(o + 20, true) };
    }
    return out;
  }

  /** Material names by texdata string id (TEXDATA_STRING_TABLE offsets into TEXDATA_STRING_DATA). */
  texDataStrings(): string[] {
    const table = this.lump(LUMP.TEXDATA_STRING_TABLE);
    const data = this.lump(LUMP.TEXDATA_STRING_DATA);
    const dv = dvOf(table);
    const n = countOf('texdata string table', table, 4);
    const out: string[] = new Array<string>(n);
    for (let i = 0; i < n; i++) {
      const o = dv.getInt32(i * 4, true);
      if (o < 0 || o >= data.length) throw new BspError(`texdata string ${i}: offset ${o} out of range`);
      out[i] = cstring(data, o, data.length - o);
    }
    return out;
  }

  /** The material name of each texinfo ('' when it has no texdata). */
  texInfoMaterials(): string[] {
    const names = this.texDataStrings();
    const td = this.texDatas();
    return this.texInfos().map((ti) => {
      const d = td[ti.texData];
      return d === undefined ? '' : (names[d.nameId] ?? '');
    });
  }

  brushes(): Brush[] {
    const b = this.lump(LUMP.BRUSHES);
    const dv = dvOf(b);
    const n = countOf('brushes', b, 12);
    const out: Brush[] = new Array<Brush>(n);
    for (let i = 0; i < n; i++) out[i] = { firstSide: dv.getInt32(i * 12, true), numSides: dv.getInt32(i * 12 + 4, true), contents: dv.getInt32(i * 12 + 8, true) };
    return out;
  }

  /** Brush sides (8 bytes: u16 planenum, i16 texinfo, i16 dispinfo, then bevel: i16 in SDK 2013, u8 bevel + u8 thin in CS:GO; the low byte is the bevel flag in both). */
  brushSides(): BrushSide[] {
    const b = this.lump(LUMP.BRUSHSIDES);
    const dv = dvOf(b);
    const n = countOf('brushsides', b, 8);
    const out: BrushSide[] = new Array<BrushSide>(n);
    for (let i = 0; i < n; i++) {
      const o = i * 8;
      out[i] = { planeNum: dv.getUint16(o, true), texInfo: dv.getInt16(o + 2, true), dispInfo: dv.getInt16(o + 4, true), bevel: (b[o + 6] as number) !== 0 };
    }
    return out;
  }

  models(): Model[] {
    const b = this.lump(LUMP.MODELS);
    const dv = dvOf(b);
    const n = countOf('models', b, 48);
    const v = (o: number): Vec3 => ({ x: dv.getFloat32(o, true), y: dv.getFloat32(o + 4, true), z: dv.getFloat32(o + 8, true) });
    const out: Model[] = new Array<Model>(n);
    for (let i = 0; i < n; i++) {
      const o = i * 48;
      out[i] = { mins: v(o), maxs: v(o + 12), origin: v(o + 24), headNode: dv.getInt32(o + 36, true), firstFace: dv.getInt32(o + 40, true), numFaces: dv.getInt32(o + 44, true) };
    }
    return out;
  }

  nodes(): BspNode[] {
    const b = this.lump(LUMP.NODES);
    const dv = dvOf(b);
    const n = countOf('nodes', b, 32);
    const out: BspNode[] = new Array<BspNode>(n);
    for (let i = 0; i < n; i++) {
      const o = i * 32;
      out[i] = { planeNum: dv.getInt32(o, true), children: [dv.getInt32(o + 4, true), dv.getInt32(o + 8, true)], firstFace: dv.getUint16(o + 24, true), numFaces: dv.getUint16(o + 26, true) };
    }
    return out;
  }

  /** Leaves: 32 bytes (lump version 1, BSP 20+), or 56 with the ambient light cube (lump version 0). */
  leafs(): Leaf[] {
    const b = this.lump(LUMP.LEAFS);
    const dv = dvOf(b);
    const stride = (this.lumps[LUMP.LEAFS] as LumpInfo).version === 0 && this.version <= 19 ? 56 : 32;
    const n = countOf('leafs', b, stride);
    const out: Leaf[] = new Array<Leaf>(n);
    for (let i = 0; i < n; i++) {
      const o = i * stride;
      out[i] = {
        contents: dv.getInt32(o, true),
        cluster: dv.getInt16(o + 4, true),
        firstLeafFace: dv.getUint16(o + 20, true),
        numLeafFaces: dv.getUint16(o + 22, true),
        firstLeafBrush: dv.getUint16(o + 24, true),
        numLeafBrushes: dv.getUint16(o + 26, true),
      };
    }
    return out;
  }

  leafBrushes(): Uint16Array {
    const b = this.lump(LUMP.LEAFBRUSHES);
    const dv = dvOf(b);
    const n = countOf('leafbrushes', b, 2);
    const out = new Uint16Array(n);
    for (let i = 0; i < n; i++) out[i] = dv.getUint16(i * 2, true);
    return out;
  }

  /**
   * Displacement infos. The documented stride is 176 bytes (SDK 2013); the stride is taken from the lump size and
   * the number of displacements the faces reference, so a branch with a different tail still reads (the fields used
   * are all at the front).
   */
  dispInfos(): DispInfo[] {
    const b = this.lump(LUMP.DISPINFO);
    if (b.length === 0) return [];
    let count = 0;
    for (const f of this.faces()) if (f.dispInfo >= 0) count = Math.max(count, f.dispInfo + 1);
    if (count === 0) return [];
    const stride = b.length / count;
    if (!Number.isInteger(stride) || stride < 48) throw new BspError(`dispinfo: lump size ${b.length} doesn't divide into ${count} displacements`);
    const dv = dvOf(b);
    const out: DispInfo[] = new Array<DispInfo>(count);
    for (let i = 0; i < count; i++) {
      const o = i * stride;
      out[i] = {
        startPosition: { x: dv.getFloat32(o, true), y: dv.getFloat32(o + 4, true), z: dv.getFloat32(o + 8, true) },
        dispVertStart: dv.getInt32(o + 12, true),
        dispTriStart: dv.getInt32(o + 16, true),
        power: dv.getInt32(o + 20, true),
        minTess: dv.getInt32(o + 24, true),
        smoothingAngle: dv.getFloat32(o + 28, true),
        contents: dv.getInt32(o + 32, true),
        mapFace: dv.getUint16(o + 36, true),
      };
    }
    return out;
  }

  dispVerts(): DispVert[] {
    const b = this.lump(LUMP.DISP_VERTS);
    const dv = dvOf(b);
    const n = countOf('disp verts', b, 20);
    const out: DispVert[] = new Array<DispVert>(n);
    for (let i = 0; i < n; i++) {
      const o = i * 20;
      out[i] = { vx: dv.getFloat32(o, true), vy: dv.getFloat32(o + 4, true), vz: dv.getFloat32(o + 8, true), dist: dv.getFloat32(o + 12, true), alpha: dv.getFloat32(o + 16, true) };
    }
    return out;
  }

  /** Per displacement triangle tags (u16: SURFACE 0x1, WALKABLE 0x2, BUILDABLE 0x4, SURFPROP1 0x8, SURFPROP2 0x10). */
  dispTris(): Uint16Array {
    const b = this.lump(LUMP.DISP_TRIS);
    const dv = dvOf(b);
    const n = countOf('disp tris', b, 2);
    const out = new Uint16Array(n);
    for (let i = 0; i < n; i++) out[i] = dv.getUint16(i * 2, true);
    return out;
  }

  /** The game lump directory (offsets are from the start of the file). */
  gameLumps(): GameLumpEntry[] {
    const b = this.lump(LUMP.GAME_LUMP);
    if (b.length < 4) return [];
    const dv = dvOf(b);
    const n = dv.getInt32(0, true);
    if (n < 0 || 4 + n * 16 > b.length) throw new BspError(`game lump: bad count ${n}`);
    const out: GameLumpEntry[] = [];
    for (let i = 0; i < n; i++) {
      const o = 4 + i * 16;
      const idNum = dv.getUint32(o, true);
      const id = String.fromCharCode((idNum >>> 24) & 255, (idNum >>> 16) & 255, (idNum >>> 8) & 255, idNum & 255);
      out.push({ id, flags: dv.getUint16(o + 4, true), version: dv.getUint16(o + 6, true), offset: dv.getInt32(o + 8, true), length: dv.getInt32(o + 12, true) });
    }
    return out;
  }

  /** A game lump's bytes, decompressed (flags bit 0 or an "LZMA" header). */
  gameLump(id: string): { entry: GameLumpEntry; bytes: Uint8Array } | null {
    const e = this.gameLumps().find((g) => g.id === id);
    if (e === undefined) return null;
    if (e.offset < 0 || e.offset + e.length > this.bytes.length) throw new BspError(`game lump ${id}: out of range`);
    let b = this.bytes.subarray(e.offset, e.offset + e.length);
    if (isValveLzma(b)) b = decodeValveLzma(b);
    return { entry: e, bytes: b };
  }

  /**
   * Static props (game lump `sprp`). The per-prop size depends on the lump version (4: 56 bytes … CS:GO 10/11: 76);
   * the reader checks the size it finds against the version and reads the fields every version shares, then the
   * version-specific tail (v11's uniform scale).
   */
  staticProps(): StaticPropLump | null {
    const g = this.gameLump('sprp');
    if (g === null) return null;
    const b = g.bytes;
    const dv = dvOf(b);
    let o = 0;
    const nDict = dv.getInt32(o, true);
    o += 4;
    if (nDict < 0 || o + nDict * 128 > b.length) throw new BspError(`sprp: bad dictionary count ${nDict}`);
    const models: string[] = [];
    for (let i = 0; i < nDict; i++) models.push(cstring(b, o + i * 128, 128));
    o += nDict * 128;
    const nLeaf = dv.getInt32(o, true);
    o += 4 + nLeaf * 2;
    const nProps = dv.getInt32(o, true);
    o += 4;
    if (nProps < 0) throw new BspError(`sprp: bad prop count ${nProps}`);
    if (nProps === 0) return { version: g.entry.version, stride: 0, models, props: [] };
    const stride = (b.length - o) / nProps;
    if (!Number.isInteger(stride) || stride < 56) throw new BspError(`sprp: ${b.length - o} bytes don't divide into ${nProps} props`);
    const version = g.entry.version;
    // The documented size for the version (STATIC_PROP_SIZES) is not enforced: branches disagree (TF2 writes the
    // 72-byte SDK 2013 layout as version 10). The fields read below sit at the same offsets in every layout.
    const props: StaticProp[] = [];
    for (let i = 0; i < nProps; i++) {
      const p = o + i * stride;
      const type = dv.getUint16(p + 24, true);
      const model = models[type];
      if (model === undefined) throw new BspError(`sprp: prop ${i} uses model ${type} of ${models.length}`);
      // v11 (CS:GO): ... FlagsEx (u32) at 68, UniformScale (f32) at 72.
      const scale = version >= 11 && stride === 76 ? dv.getFloat32(p + 72, true) : 1;
      props.push({
        origin: { x: dv.getFloat32(p, true), y: dv.getFloat32(p + 4, true), z: dv.getFloat32(p + 8, true) },
        angles: [dv.getFloat32(p + 12, true), dv.getFloat32(p + 16, true), dv.getFloat32(p + 20, true)],
        model,
        solid: b[p + 30] as number,
        flags: b[p + 31] as number,
        skin: dv.getInt32(p + 32, true),
        fadeMin: dv.getFloat32(p + 36, true),
        fadeMax: dv.getFloat32(p + 40, true),
        scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
      });
    }
    return { version, stride, models, props };
  }

  /** The lightmap lump to use: LDR (8) when present, else HDR (53). Both are ColorRGBExp32 samples. */
  lighting(): { lump: number; bytes: Uint8Array } {
    const ldr = this.lump(LUMP.LIGHTING);
    if (ldr.length > 0) return { lump: LUMP.LIGHTING, bytes: ldr };
    return { lump: LUMP.LIGHTING_HDR, bytes: this.lump(LUMP.LIGHTING_HDR) };
  }

  /** The embedded pak file (a zip archive). */
  pakfile(): Uint8Array {
    return this.lump(LUMP.PAKFILE);
  }
}

/** Static prop sizes by sprp version (VDC; v7* (SDK 2013 MP) is 72 and also appears as v10 in TF2). */
export const STATIC_PROP_SIZES: Readonly<Record<number, number>> = { 4: 56, 5: 60, 6: 64, 7: 68, 8: 68, 9: 72, 10: 76, 11: 76 };

/** Decode a ColorRGBExp32 sample to linear RGB (0..1 is the LDR range; can exceed 1). */
export function rgbExp(b: Uint8Array, o: number): [number, number, number] {
  const e = ((b[o + 3] as number) << 24) >> 24;
  const k = 2 ** e / 255;
  return [(b[o] as number) * k, (b[o + 1] as number) * k, (b[o + 2] as number) * k];
}
