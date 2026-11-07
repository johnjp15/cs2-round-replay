/**
 * X1: the Source asset formats the Mirage 2020 pipeline touches besides the BSP (docs/maps.md, docs/csgo-2020-files.md):
 *
 * - **VPK** directories (`pak01_dir.vpk`, versions 1 and 2): which archive (`pak01_NNN.vpk`), offset and length hold
 *   each file, plus the preload bytes kept in the directory itself.
 * - **ZIP** (the BSP's PAKFILE lump): stored, deflated and LZMA (method 14, as CS:GO's vbsp writes) entries.
 * - **MDL** headers (`studiohdr_t`, versions 44–49): the hull and view boxes, and the material names with their
 *   search paths (`cdtextures`) and the skin table.
 * - **VTF** headers (7.0–7.5): size, flags and the reflectivity vtex computed (the texture's mean linear colour).
 * - **KeyValues** text (VMT materials, `patch` materials with `include`).
 *
 * Layouts: Valve Developer Community ("VPK File Format", "VTF", "MDL", "KeyValues", "Patch") and the public Source
 * SDK 2013 headers (`studio.h`, `vtf.h`).
 */
import { inflateRawSync } from 'node:zlib';
import { decodeLzmaRaw } from './lzma';

export class AssetError extends Error {
  override readonly name = 'AssetError';
}

function dvOf(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

function cstr(b: Uint8Array, at: number): { s: string; next: number } {
  let e = at;
  while (e < b.length && b[e] !== 0) e++;
  if (e >= b.length) throw new AssetError('unterminated string');
  return { s: new TextDecoder('latin1').decode(b.subarray(at, e)), next: e + 1 };
}

// ---- VPK ---------------------------------------------------------------------------------------------------------

export interface VpkEntry {
  /** Lower-case path with forward slashes, e.g. `materials/de_mirage/base/mirage_floor_01.vmt`. */
  readonly path: string;
  readonly crc: number;
  readonly preload: Uint8Array;
  /** Archive number (pak01_NNN.vpk), or 0x7fff for data stored in the directory file after the tree. */
  readonly archive: number;
  readonly offset: number;
  readonly length: number;
}

export const VPK_DIR_ARCHIVE = 0x7fff;

export class VpkDir {
  readonly version: number;
  readonly entries: ReadonlyMap<string, VpkEntry>;
  /** Where data stored in the directory file itself starts (header + tree). */
  readonly dataStart: number;

  constructor(readonly bytes: Uint8Array) {
    const dv = dvOf(bytes);
    if (bytes.length < 12 || dv.getUint32(0, true) !== 0x55aa1234) throw new AssetError('vpk: bad signature');
    this.version = dv.getUint32(4, true);
    const treeSize = dv.getUint32(8, true);
    const header = this.version === 1 ? 12 : this.version === 2 ? 28 : -1;
    if (header < 0) throw new AssetError(`vpk: unsupported version ${this.version}`);
    this.dataStart = header + treeSize;
    const entries = new Map<string, VpkEntry>();
    let o = header;
    const end = header + treeSize;
    for (;;) {
      const ext = cstr(bytes, o);
      o = ext.next;
      if (ext.s === '') break;
      for (;;) {
        const dir = cstr(bytes, o);
        o = dir.next;
        if (dir.s === '') break;
        for (;;) {
          const name = cstr(bytes, o);
          o = name.next;
          if (name.s === '') break;
          if (o + 18 > end) throw new AssetError('vpk: tree truncated');
          const crc = dv.getUint32(o, true);
          const preloadBytes = dv.getUint16(o + 4, true);
          const archive = dv.getUint16(o + 6, true);
          const offset = dv.getUint32(o + 8, true);
          const length = dv.getUint32(o + 12, true);
          if (dv.getUint16(o + 16, true) !== 0xffff) throw new AssetError('vpk: bad entry terminator');
          o += 18;
          const preload = bytes.subarray(o, o + preloadBytes);
          o += preloadBytes;
          const path = `${dir.s === ' ' ? '' : `${dir.s}/`}${name.s}${ext.s === ' ' ? '' : `.${ext.s}`}`.toLowerCase();
          entries.set(path, { path, crc, preload, archive, offset, length });
        }
      }
    }
    this.entries = entries;
  }

  get(path: string): VpkEntry | undefined {
    return this.entries.get(normalizePath(path));
  }

  /** The archive file name for an entry: `pak01_NNN.vpk` (or the directory itself). */
  static archiveName(prefix: string, archive: number): string {
    return archive === VPK_DIR_ARCHIVE ? `${prefix}_dir.vpk` : `${prefix}_${String(archive).padStart(3, '0')}.vpk`;
  }

  /** An entry's bytes, given a reader for archive slices. */
  read(e: VpkEntry, slice: (archive: number, offset: number, length: number) => Uint8Array): Uint8Array {
    const out = new Uint8Array(e.preload.length + e.length);
    out.set(e.preload, 0);
    if (e.length > 0) {
      const data = e.archive === VPK_DIR_ARCHIVE ? this.bytes.subarray(this.dataStart + e.offset, this.dataStart + e.offset + e.length) : slice(e.archive, e.offset, e.length);
      if (data.length !== e.length) throw new AssetError(`vpk: ${e.path}: short read (${data.length} of ${e.length})`);
      out.set(data, e.preload.length);
    }
    return out;
  }
}

/** Lower case, forward slashes, no leading slash. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').toLowerCase();
}

// ---- ZIP (the BSP's PAKFILE lump) --------------------------------------------------------------------------------

export interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
}

export function zipEntries(b: Uint8Array): ZipEntry[] {
  if (b.length < 22) return [];
  const dv = dvOf(b);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new AssetError('zip: no end of central directory');
  const count = dv.getUint16(eocd + 10, true);
  let o = dv.getUint32(eocd + 16, true);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(o, true) !== 0x02014b50) throw new AssetError('zip: bad central directory entry');
    const method = dv.getUint16(o + 10, true);
    const compressedSize = dv.getUint32(o + 20, true);
    const size = dv.getUint32(o + 24, true);
    const nameLen = dv.getUint16(o + 28, true);
    const extraLen = dv.getUint16(o + 30, true);
    const commentLen = dv.getUint16(o + 32, true);
    const localOffset = dv.getUint32(o + 42, true);
    const name = normalizePath(new TextDecoder('latin1').decode(b.subarray(o + 46, o + 46 + nameLen)));
    out.push({ name, method, compressedSize, size, localOffset });
    o += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export function zipRead(b: Uint8Array, e: ZipEntry): Uint8Array {
  const dv = dvOf(b);
  const o = e.localOffset;
  if (dv.getUint32(o, true) !== 0x04034b50) throw new AssetError(`zip: ${e.name}: bad local header`);
  const start = o + 30 + dv.getUint16(o + 26, true) + dv.getUint16(o + 28, true);
  const data = b.subarray(start, start + e.compressedSize);
  if (e.method === 0) return data.slice();
  if (e.method === 8) return new Uint8Array(inflateRawSync(data));
  if (e.method === 14) {
    // ZIP LZMA: u8 major, u8 minor, u16 properties size (5), the properties, then the raw stream.
    const propsSize = dv.getUint16(start + 2, true);
    return decodeLzmaRaw(data.subarray(4, 4 + propsSize), data, 4 + propsSize, e.size);
  }
  throw new AssetError(`zip: ${e.name}: unsupported method ${e.method}`);
}

// ---- MDL ---------------------------------------------------------------------------------------------------------

export interface MdlInfo {
  readonly version: number;
  readonly checksum: number;
  readonly name: string;
  readonly hullMin: readonly [number, number, number];
  readonly hullMax: readonly [number, number, number];
  readonly viewMin: readonly [number, number, number];
  readonly viewMax: readonly [number, number, number];
  readonly flags: number;
  /** Material names (without search path), in texture-index order. */
  readonly textures: readonly string[];
  /** Material search paths (`cdtextures`), e.g. `models/props/de_mirage/`. */
  readonly cdTextures: readonly string[];
  /** skinFamilies[family][ref] = texture index. */
  readonly skins: readonly (readonly number[])[];
}

export function readMdl(b: Uint8Array): MdlInfo {
  const dv = dvOf(b);
  if (b.length < 236 || dv.getUint32(0, true) !== 0x54534449) throw new AssetError('mdl: bad magic (expected IDST)');
  const version = dv.getInt32(4, true);
  if (version < 44 || version > 49) throw new AssetError(`mdl: unsupported version ${version}`);
  const v3 = (o: number): [number, number, number] => [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)];
  const name = new TextDecoder('latin1').decode(b.subarray(12, 76)).replace(/\0.*$/s, '');
  const numTextures = dv.getInt32(204, true);
  const textureIndex = dv.getInt32(208, true);
  const numCd = dv.getInt32(212, true);
  const cdIndex = dv.getInt32(216, true);
  const numSkinRef = dv.getInt32(220, true);
  const numSkinFamilies = dv.getInt32(224, true);
  const skinIndex = dv.getInt32(228, true);
  if (numTextures < 0 || numTextures > 4096 || numCd < 0 || numCd > 256) throw new AssetError('mdl: bad texture counts');
  const textures: string[] = [];
  for (let i = 0; i < numTextures; i++) {
    const t = textureIndex + i * 64;
    textures.push(cstr(b, t + dv.getInt32(t, true)).s);
  }
  const cdTextures: string[] = [];
  for (let i = 0; i < numCd; i++) cdTextures.push(cstr(b, dv.getInt32(cdIndex + i * 4, true)).s);
  const skins: number[][] = [];
  for (let f = 0; f < numSkinFamilies && f < 256; f++) {
    const row: number[] = [];
    for (let r = 0; r < numSkinRef; r++) row.push(dv.getInt16(skinIndex + (f * numSkinRef + r) * 2, true));
    skins.push(row);
  }
  return { version, checksum: dv.getInt32(8, true), name, hullMin: v3(104), hullMax: v3(116), viewMin: v3(128), viewMax: v3(140), flags: dv.getInt32(152, true), textures, cdTextures, skins };
}

/** Candidate material paths (`materials/<cd><name>.vmt`) for a model's texture, in search order. */
export function mdlMaterialPaths(m: MdlInfo, textureIndex: number): string[] {
  const t = m.textures[textureIndex];
  if (t === undefined) return [];
  const cds = m.cdTextures.length > 0 ? m.cdTextures : [''];
  return cds.map((cd) => normalizePath(`materials/${cd}${t}.vmt`));
}

// ---- VTF ---------------------------------------------------------------------------------------------------------

export interface VtfInfo {
  readonly version: readonly [number, number];
  readonly width: number;
  readonly height: number;
  readonly flags: number;
  readonly frames: number;
  /** vtex's mean linear colour, 0..1. */
  readonly reflectivity: readonly [number, number, number];
  readonly highResFormat: number;
  readonly mipmapCount: number;
}

/** A VTF header (the first 80 bytes are enough for every field here). */
export function readVtfHeader(b: Uint8Array): VtfInfo {
  const dv = dvOf(b);
  if (b.length < 64 || dv.getUint32(0, true) !== 0x00465456) throw new AssetError('vtf: bad magic');
  return {
    version: [dv.getUint32(4, true), dv.getUint32(8, true)],
    width: dv.getUint16(16, true),
    height: dv.getUint16(18, true),
    flags: dv.getUint32(20, true),
    frames: dv.getUint16(24, true),
    reflectivity: [dv.getFloat32(32, true), dv.getFloat32(36, true), dv.getFloat32(40, true)],
    highResFormat: dv.getInt32(52, true),
    mipmapCount: b[56] as number,
  };
}

// ---- KeyValues (VMT) ---------------------------------------------------------------------------------------------

/** A KeyValues node: a string value or a block of children (keys lower-cased, order kept). */
export type KvValue = string | KvBlock;
export interface KvBlock {
  readonly entries: readonly (readonly [string, KvValue])[];
}

function kvTokens(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '{' || c === '}') {
      out.push(c);
      i++;
    } else if (c === '"') {
      const e = text.indexOf('"', i + 1);
      if (e < 0) throw new AssetError('kv: unterminated string');
      out.push(`"${text.slice(i + 1, e)}`);
      i = e + 1;
    } else if (/\s/.test(c)) i++;
    else {
      let e = i;
      while (e < text.length && !/[\s{}"]/.test(text[e] as string)) e++;
      out.push(`"${text.slice(i, e)}`);
      i = e;
    }
  }
  return out;
}

/** Parse KeyValues text into its top-level pairs (a VMT: one pair, shader name → block). */
export function parseKeyValues(text: string): KvBlock {
  const t = kvTokens((text.charCodeAt(0) === 0xfeff ? text.slice(1) : text));
  let i = 0;
  const block = (top: boolean): KvBlock => {
    const entries: [string, KvValue][] = [];
    while (i < t.length) {
      const k = t[i++] as string;
      if (k === '}') {
        if (top) throw new AssetError('kv: stray }');
        return { entries };
      }
      if (k === '{') throw new AssetError('kv: block without a key');
      const v = t[i++];
      if (v === undefined) throw new AssetError(`kv: key ${k.slice(1)} without value`);
      if (v === '{') entries.push([k.slice(1).toLowerCase(), block(false)]);
      else if (v === '}') throw new AssetError(`kv: key ${k.slice(1)} without value`);
      else {
        entries.push([k.slice(1).toLowerCase(), v.slice(1)]);
        // A conditional like [$X360] after a value: skip it.
        if (t[i]?.startsWith('"[') === true) i++;
      }
    }
    if (!top) throw new AssetError('kv: unterminated block');
    return { entries };
  };
  return block(true);
}

export interface Material {
  /** The shader (lower case), e.g. `lightmappedgeneric`, `worldvertextransition`, `patch`. */
  readonly shader: string;
  /** Top-level parameters ($basetexture, $surfaceprop, …), keys lower case. */
  readonly params: ReadonlyMap<string, string>;
  /** For a `patch` material: the material it includes. */
  readonly include: string | null;
}

export function readVmt(text: string): Material {
  const kv = parseKeyValues(text);
  const first = kv.entries[0];
  if (first === undefined || typeof first[1] === 'string') throw new AssetError('vmt: no shader block');
  const params = new Map<string, string>();
  let include: string | null = null;
  const take = (b: KvBlock): void => {
    for (const [k, v] of b.entries) {
      if (typeof v === 'string') {
        if (k === 'include') include = normalizePath(v);
        else if (!params.has(k)) params.set(k, v);
      } else if (k === 'insert' || k === 'replace') take(v);
    }
  };
  take(first[1]);
  return { shader: first[0], params, include };
}

/**
 * The base material of a CS:GO/Source cubemap patch material: vbsp writes `maps/<map>/<material>_<x>_<y>_<z>` (and
 * `maps/<map>/<material>_wvt_patch` for blends) into the BSP's pak file, pointing back at `<material>`.
 */
export function baseMaterialName(name: string, map: string): string {
  const n = normalizePath(name);
  const prefix = `maps/${map.toLowerCase()}/`;
  if (!n.startsWith(prefix)) return n;
  return n
    .slice(prefix.length)
    .replace(/_wvt_patch$/, '')
    .replace(/_-?\d+_-?\d+_-?\d+$/, '');
}
