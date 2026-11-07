/**
 * H3: read a CS2 `.nav` file (versions 35 and 36) as far as the ladders: places, polygons, areas (id, attribute
 * flags, hull, polygon, connections per edge, ladder links) and ladders. Layout as in ValveResourceFormat's
 * `NavMesh/NavMeshFile.cs`, `NavMeshArea.cs`, `NavMeshLadder.cs` (docs/maps.md "CS2 nav"). KV3 blocks are skipped by
 * their header sizes (tools/extract-geometry.ts `readCs2Nav` does the same as far as the areas, for the clips).
 *
 * Build-time only (tools/build-map.ts): the map package stores the result as `nav.json` (src/engine/nav/cs2-nav.ts
 * reads that), so the browser never parses KV3.
 */

/** NavAttributeFlags (nav version ≥ 35; VRF `NavAttributeFlags.cs`). Bits 19 and up are game specific. */
export const NAV_ATTR = {
  jump: 0x2,
  noJump: 0x8,
  stop: 0x10,
  run: 0x20,
  walk: 0x40,
  avoid: 0x80,
  transient: 0x100,
  dontHide: 0x200,
  stand: 0x400,
  noHostages: 0x800,
  stairs: 0x1000,
  noMerge: 0x2000,
  obstacleTop: 0x4000,
  nonZUp: 0x8000,
  crouchHeight: 0x10000,
  nonZUpTransition: 0x20000,
  crawlHeight: 0x40000,
} as const;

export interface Cs2NavConnection {
  readonly area: number;
  readonly edge: number;
}

export interface Cs2NavFileArea {
  readonly id: number;
  /** Attribute flags (the low 32 bits; nothing above bit 18 is named). */
  readonly flags: number;
  readonly flagsHigh: number;
  readonly hull: number;
  /** Corner xyz triples (3 or more corners). */
  readonly corners: readonly number[];
  /** Connections leaving each edge (edge i runs from corner i to corner i + 1). */
  readonly connections: readonly (readonly Cs2NavConnection[])[];
  readonly laddersAbove: readonly number[];
  readonly laddersBelow: readonly number[];
}

export interface Cs2NavFileLadder {
  readonly id: number;
  readonly width: number;
  readonly top: readonly [number, number, number];
  readonly bottom: readonly [number, number, number];
  readonly length: number;
  readonly direction: number;
  /** Area ids (0 = none): top forward, left, right, behind; bottom, bottom left, bottom right. */
  readonly topForward: number;
  readonly topLeft: number;
  readonly topRight: number;
  readonly topBehind: number;
  readonly bottom0: number;
  readonly bottomLeft: number;
  readonly bottomRight: number;
}

export interface Cs2NavFile {
  readonly version: number;
  readonly subVersion: number;
  readonly places: readonly string[];
  readonly areas: readonly Cs2NavFileArea[];
  readonly ladders: readonly Cs2NavFileLadder[];
}

export function readCs2NavFile(bytes: Uint8Array): Cs2NavFile {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const need = (n: number): void => {
    if (o + n > bytes.length) throw new Error(`nav: truncated at byte ${o}`);
  };
  const u8 = (): number => {
    need(1);
    return dv.getUint8(o++);
  };
  const u16 = (): number => {
    need(2);
    const v = dv.getUint16(o, true);
    o += 2;
    return v;
  };
  const u32 = (): number => {
    need(4);
    const v = dv.getUint32(o, true);
    o += 4;
    return v;
  };
  const f32 = (): number => {
    need(4);
    const v = dv.getFloat32(o, true);
    o += 4;
    return v;
  };
  const kv3 = (): void => {
    o = Math.ceil(o / 8) * 8;
    if (u32() !== 0x4b563305) throw new Error('nav: expected a KV3 v5 block');
    o += 16; // format GUID
    const compression = u32();
    o += 4; // dictionary id, frame size
    o += 16; // counts: bytes1, bytes4, bytes8, types
    o += 4; // objects, arrays
    o += 8; // sizes: uncompressed total, compressed total
    const blocks = u32();
    const blobBytes = u32();
    o += 8; // bytes2 count, block compressed sizes
    const unc1 = u32();
    const comp1 = u32();
    const unc2 = u32();
    const comp2 = u32();
    o += 32; // buffer 2 counts, node counts
    o += compression === 0 ? unc1 + unc2 : comp1 + comp2;
    if (blocks > 0) {
      if (compression !== 0) throw new Error('nav: compressed KV3 blobs are not supported');
      o += blobBytes;
    }
  };
  if (u32() !== 0xfeedface) throw new Error('nav: bad magic');
  const version = u32();
  if (version !== 35 && version !== 36) throw new Error(`nav: only versions 35 and 36 are supported, got ${version}`);
  const subVersion = u32();
  u8(); // analyzed
  const placeCount = u16();
  const places: string[] = [];
  for (let i = 0; i < placeCount; i++) {
    const len = u16();
    need(len);
    places.push(new TextDecoder().decode(bytes.subarray(o, o + len)).replace(/\0+$/, ''));
    o += len;
  }
  u8(); // has unnamed areas
  if (version >= 36) kv3(); // movable mesh settings
  const nc = u32();
  const cornerXyz = new Float64Array(nc * 3);
  for (let i = 0; i < nc * 3; i++) cornerXyz[i] = f32();
  const np = u32();
  const polys: number[][] = [];
  for (let i = 0; i < np; i++) {
    const k = u8();
    const idx: number[] = [];
    for (let j = 0; j < k; j++) idx.push(u32());
    u32(); // movable mesh id (v35+)
    polys.push(idx);
  }
  if ((u32() & 1) !== 0) {
    const gravity = u32();
    o += gravity * 12; // corner gravity
  }
  const movable = u32();
  if (movable !== 0) throw new Error('nav: movable meshes are not supported');
  if (version >= 36) kv3(); // game data
  const na = u32();
  const areas: Cs2NavFileArea[] = [];
  for (let i = 0; i < na; i++) {
    const id = u32();
    const flags = u32();
    const flagsHigh = u32();
    const hull = u8();
    const poly = polys[u32()];
    if (poly === undefined) throw new Error('nav: bad polygon index');
    f32(); // unused, always 0
    const connections: Cs2NavConnection[][] = [];
    for (let c = 0; c < poly.length; c++) {
      const n = u32();
      const edge: Cs2NavConnection[] = [];
      for (let k = 0; k < n; k++) edge.push({ area: u32(), edge: u32() });
      connections.push(edge);
    }
    if (u8() !== 0) throw new Error('nav: hiding spots on areas are not supported');
    if (u32() !== 0) throw new Error('nav: encounter paths are not supported');
    const laddersAbove: number[] = [];
    for (let k = u32(); k > 0; k--) laddersAbove.push(u32());
    const laddersBelow: number[] = [];
    for (let k = u32(); k > 0; k--) laddersBelow.push(u32());
    const corners: number[] = [];
    for (const v of poly) corners.push(cornerXyz[v * 3] as number, cornerXyz[v * 3 + 1] as number, cornerXyz[v * 3 + 2] as number);
    areas.push({ id, flags, flagsHigh, hull, corners, connections, laddersAbove, laddersBelow });
  }
  const ladders: Cs2NavFileLadder[] = [];
  for (let n = u32(); n > 0; n--) {
    const id = u32();
    const width = f32();
    const top: [number, number, number] = [f32(), f32(), f32()];
    const bottom: [number, number, number] = [f32(), f32(), f32()];
    const length = f32();
    const direction = u32();
    ladders.push({ id, width, top, bottom, length, direction, topForward: u32(), topLeft: u32(), topRight: u32(), topBehind: u32(), bottom0: u32(), bottomLeft: u32(), bottomRight: u32() });
  }
  return { version, subVersion, places, areas, ladders };
}
