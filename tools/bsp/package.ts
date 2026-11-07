/**
 * X1: a map package from a Source BSP (docs/maps.md): the collision (`MapGeometry` meshes: world, player clips,
 * grenade clips), the render mesh (`G2RM`, src/app3d/render-package.ts) and the gameplay entities. Pure: the BSP
 * and an asset lookup in, typed arrays and plain data out; tools/extract-bsp.ts does the files.
 *
 * Collision is what the engine moves a player against (MASK_PLAYERSOLID):
 * - **world**: every brush of the world model and of solid brush entities whose contents block a player (SOLID,
 *   WINDOW, GRATE, MOVEABLE), as the polygons of its planes; every displacement's triangles; every solid static prop
 *   (and solid `prop_dynamic`) as its `.phy` convex hulls when the model files are there, else its model's hull box,
 *   else (no model files at all) nothing, counted in `stats.propsWithoutModel`.
 * - **clips**: PLAYERCLIP brushes without SOLID (invisible walls, clip ramps). Separate, as the CS2 package's clips
 *   are, so the movement merges them (`combineMeshes`) and sight ignores them.
 * - **grenadeClips**: GRENADECLIP brushes (the grenades' own invisible walls), for the grenade physics.
 * Ladders, water and triggers (buy zones, bomb sites) are boxes in `entities`.
 */
import type { GeometryMesh } from '../../src/sim2d/geometry';
import type { RenderMaterial, RenderMesh } from '../../src/app3d/render-package';
import { BspFile, CONTENTS, LUMP, SURF, type Entity, type Face, type TexInfo } from './bsp';
import { angleMatrix, boxTriangles, brushFaces, displacementMesh, facePolygon, fan, FaceLightmap, modelBrushes, NODRAW_FLAGS, transformPoints } from './geometry';
import { AssetError, baseMaterialName, mdlMaterialPaths, normalizePath, readMdl, readVmt, readVtfHeader, zipEntries, zipRead, type MdlInfo } from './assets';
import { PhyError, readPhy } from './phy';

/** Build parameters (written into the manifest). */
export const PACKAGE_PARAMS = {
  /** Position steps per unit in both meshes (as the CS2 package: 1/8 unit). */
  quant: 8,
  /** Brush contents that block a player's hull besides PLAYERCLIP (bspflags.h MASK_PLAYERSOLID). */
  solidContents: CONTENTS.SOLID | CONTENTS.WINDOW | CONTENTS.GRATE | CONTENTS.MOVEABLE,
  /** The lightmap luminance (Rec. 709 weights) that renders as the material's own colour: this percentile of the drawn faces' mean lightmaps... */
  exposurePercentile: 0.9,
  /** ... scaled by this. */
  exposureScale: 1,
  /** The darkest a lightmapped surface gets (fraction of its material colour), so shadows keep their colour. */
  minLight: 0.06,
  /** Props have no lightmap: their shade is ambient + diffuse × max(0, n · sun). */
  propAmbient: 0.55,
  propDiffuse: 0.45,
} as const;

/** Brush entities whose brushes are solid to players (func_brush with Solidity 1, "never solid", is excluded). */
const SOLID_BRUSH_CLASSES = new Set(['func_brush', 'func_wall', 'func_wall_toggle', 'func_breakable', 'func_breakable_surf', 'func_door', 'func_door_rotating', 'func_movelinear', 'func_physbox', 'func_rotating', 'func_tracktrain', 'func_detail_blocker']);
/** Brush entities that are drawn (the solid ones plus the non-solid visible ones). */
const DRAWN_BRUSH_CLASSES = new Set([...SOLID_BRUSH_CLASSES, 'func_illusionary', 'func_lod', 'func_dustmotes', 'func_smokevolume']);
const DRAWN_BRUSH_SKIP = new Set(['func_dustmotes', 'func_smokevolume']);
/** Static prop / prop_dynamic solid types (const.h). */
const SOLID_NONE = 0;
const SOLID_BBOX = 2;
const SOLID_VPHYSICS = 6;

/** A model's files and material colour, as far as the asset folder has them. */
export interface AssetLookup {
  /** A game file by its path (`models/…/x.mdl`, `materials/…/x.vmt`), or null. The BSP's pak file is searched first by the package itself. */
  read(path: string): Uint8Array | null;
}

export const NO_ASSETS: AssetLookup = { read: () => null };

export interface Box {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface PackageEntities {
  readonly spawns: readonly { readonly team: 'T' | 'CT'; readonly origin: readonly [number, number, number]; readonly yaw: number; readonly priority: number }[];
  readonly bombTargets: readonly ({ readonly name: string } & Box)[];
  readonly buyZones: readonly ({ readonly team: 'T' | 'CT' | 'any' } & Box)[];
  readonly ladders: readonly Box[];
  readonly water: readonly Box[];
  readonly skyCamera: readonly [number, number, number] | null;
  readonly skyName: string | null;
  readonly entityCounts: Readonly<Record<string, number>>;
}

export interface PackageStats {
  readonly brushes: Readonly<Record<string, number>>;
  readonly worldTriangles: number;
  readonly clipTriangles: number;
  readonly grenadeClipTriangles: number;
  readonly displacements: number;
  readonly displacementTriangles: number;
  readonly staticProps: number;
  readonly solidProps: number;
  readonly propsFromPhy: number;
  readonly propsFromHullBox: number;
  readonly propsWithoutModel: number;
  readonly propModelsMissing: readonly string[];
  readonly renderFaces: number;
  readonly renderTriangles: number;
  readonly skyboxFacesDropped: number;
  readonly materials: Readonly<Record<RenderMaterial['source'], number>>;
  readonly exposure: number;
}

export interface MapPackage {
  readonly world: GeometryMesh;
  readonly clips: GeometryMesh;
  readonly grenadeClips: GeometryMesh;
  readonly render: RenderMesh;
  readonly colors: Uint8Array;
  readonly materials: readonly RenderMaterial[];
  readonly entities: PackageEntities;
  readonly stats: PackageStats;
  readonly bounds: Box;
}

// ---- canonical G2GM meshes -----------------------------------------------------------------------------------

/**
 * Triangles (9 numbers each) → a canonical G2GM mesh: coordinates rounded to 1/quant, equal vertices merged,
 * degenerate (zero integer area) and repeated triangles (either winding) dropped, each triangle rotated so its
 * smallest index is first (winding kept), sorted by (a, b, c). Vertices are numbered in order of first use.
 */
export function canonicalMesh(triangles: readonly Float64Array[], quant: number): GeometryMesh {
  const index = new Map<string, number>();
  const verts: number[] = [];
  const vid = (x: number, y: number, z: number): number => {
    const qx = Math.round(x * quant);
    const qy = Math.round(y * quant);
    const qz = Math.round(z * quant);
    const k = `${qx},${qy},${qz}`;
    let i = index.get(k);
    if (i === undefined) {
      i = verts.length / 3;
      index.set(k, i);
      verts.push(qx, qy, qz);
    }
    return i;
  };
  const tris: [number, number, number][] = [];
  const seen = new Set<string>();
  for (const block of triangles) {
    for (let o = 0; o + 9 <= block.length; o += 9) {
      const ids = [vid(block[o] as number, block[o + 1] as number, block[o + 2] as number), vid(block[o + 3] as number, block[o + 4] as number, block[o + 5] as number), vid(block[o + 6] as number, block[o + 7] as number, block[o + 8] as number)];
      const [a, b, c] = ids as [number, number, number];
      if (a === b || b === c || a === c) continue;
      const ax = verts[a * 3] as number;
      const ay = verts[a * 3 + 1] as number;
      const az = verts[a * 3 + 2] as number;
      const ux = (verts[b * 3] as number) - ax;
      const uy = (verts[b * 3 + 1] as number) - ay;
      const uz = (verts[b * 3 + 2] as number) - az;
      const vx = (verts[c * 3] as number) - ax;
      const vy = (verts[c * 3 + 1] as number) - ay;
      const vz = (verts[c * 3 + 2] as number) - az;
      if (uy * vz - uz * vy === 0 && uz * vx - ux * vz === 0 && ux * vy - uy * vx === 0) continue;
      const m = Math.min(a, b, c);
      const t: [number, number, number] = m === a ? [a, b, c] : m === b ? [b, c, a] : [c, a, b];
      const key = [...t].sort((p, q) => p - q).join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      tris.push(t);
    }
  }
  tris.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
  const out = new Int32Array(tris.length * 3);
  tris.forEach((t, i) => out.set(t, i * 3));
  return { quant, verts: new Int32Array(verts), tris: out };
}

// ---- entities ------------------------------------------------------------------------------------------------

function vec(s: string | undefined): [number, number, number] | null {
  if (s === undefined) return null;
  const p = s.trim().split(/\s+/).map(Number);
  if (p.length < 3 || p.some((v) => !Number.isFinite(v))) return null;
  return [p[0] as number, p[1] as number, p[2] as number];
}

function modelIndexOf(e: Entity): number | null {
  const m = e.get('model');
  if (m === undefined || !m.startsWith('*')) return null;
  const n = Number(m.slice(1));
  return Number.isInteger(n) && n > 0 ? n : null;
}

function modelBox(bsp: BspFile, e: Entity): Box | null {
  const k = modelIndexOf(e);
  const m = k === null ? undefined : bsp.models()[k];
  if (m === undefined) return null;
  const o = vec(e.get('origin')) ?? [0, 0, 0];
  return { min: [m.mins.x + o[0], m.mins.y + o[1], m.mins.z + o[2]], max: [m.maxs.x + o[0], m.maxs.y + o[1], m.maxs.z + o[2]] };
}

function brushBox(bsp: BspFile, brush: number): Box {
  const b = bsp.brushes()[brush];
  if (b === undefined) throw new AssetError(`brush ${brush} out of range`);
  const polys = brushFaces(bsp.planes(), bsp.brushSides(), b.firstSide, b.numSides);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const p of polys) {
    for (let i = 0; i < p.points.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = p.points[i + k] as number;
        if (v < (min[k] as number)) min[k] = v;
        if (v > (max[k] as number)) max[k] = v;
      }
    }
  }
  return { min, max };
}

export function readEntities(bsp: BspFile, ladderBrushes: readonly number[], waterBrushes: readonly number[]): PackageEntities {
  const ents = bsp.entities();
  const counts: Record<string, number> = {};
  for (const e of ents) {
    const c = e.get('classname') ?? '?';
    counts[c] = (counts[c] ?? 0) + 1;
  }
  const spawns: { team: 'T' | 'CT'; origin: [number, number, number]; yaw: number; priority: number }[] = [];
  const bombTargets: ({ name: string } & Box)[] = [];
  const buyZones: ({ team: 'T' | 'CT' | 'any' } & Box)[] = [];
  let skyCamera: [number, number, number] | null = null;
  for (const e of ents) {
    const c = e.get('classname');
    if (c === 'info_player_terrorist' || c === 'info_player_counterterrorist') {
      const o = vec(e.get('origin'));
      const a = vec(e.get('angles'));
      if (o !== null) spawns.push({ team: c === 'info_player_terrorist' ? 'T' : 'CT', origin: o, yaw: a === null ? 0 : a[1], priority: Number(e.get('priority') ?? '0') || 0 });
    } else if (c === 'func_bomb_target') {
      const b = modelBox(bsp, e);
      if (b !== null) bombTargets.push({ name: e.get('targetname') ?? '', ...b });
    } else if (c === 'func_buyzone') {
      const b = modelBox(bsp, e);
      const t = e.get('TeamNum') ?? e.get('teamnum');
      if (b !== null) buyZones.push({ team: t === '2' ? 'T' : t === '3' ? 'CT' : 'any', ...b });
    } else if (c === 'sky_camera') skyCamera = vec(e.get('origin'));
  }
  const byPos = <T extends Box>(a: T, b: T): number => a.min[0] - b.min[0] || a.min[1] - b.min[1] || a.min[2] - b.min[2];
  spawns.sort((a, b) => (a.team < b.team ? -1 : a.team > b.team ? 1 : 0) || a.origin[0] - b.origin[0] || a.origin[1] - b.origin[1]);
  bombTargets.sort(byPos);
  buyZones.sort(byPos);
  const sortedCounts: Record<string, number> = {};
  for (const k of Object.keys(counts).sort()) sortedCounts[k] = counts[k] as number;
  const world = ents.find((e) => e.get('classname') === 'worldspawn');
  return {
    spawns,
    bombTargets,
    buyZones,
    ladders: ladderBrushes.map((b) => brushBox(bsp, b)).sort(byPos),
    water: waterBrushes.map((b) => brushBox(bsp, b)).sort(byPos),
    skyCamera,
    skyName: world?.get('skyname') ?? null,
    entityCounts: sortedCounts,
  };
}

// ---- materials -----------------------------------------------------------------------------------------------

function linearToSrgb(c: number): number {
  const v = Math.max(0, Math.min(1, c));
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

/** A hand palette by material name (sRGB), for materials with neither a VTF nor a reflectivity. First match wins. */
export const NAME_PALETTE: readonly (readonly [RegExp, readonly [number, number, number]])[] = [
  [/water/, [0.2, 0.32, 0.34]],
  [/glass|window/, [0.55, 0.62, 0.64]],
  [/wood|crate|plank|door/, [0.5, 0.36, 0.22]],
  [/metal|steel|pipe|rail|grate|fence/, [0.45, 0.45, 0.46]],
  [/tile|floor/, [0.62, 0.55, 0.45]],
  [/brick/, [0.62, 0.42, 0.3]],
  [/plaster|stucco|wall/, [0.78, 0.69, 0.55]],
  [/ground|dirt|sand/, [0.74, 0.63, 0.47]],
  [/stone|rock|concrete|cobble/, [0.66, 0.6, 0.5]],
  [/cloth|fabric|awning|tarp/, [0.55, 0.3, 0.25]],
  [/./, [0.7, 0.62, 0.5]],
];

function paletteColor(name: string): [number, number, number] {
  for (const [re, c] of NAME_PALETTE) if (re.test(name)) return [c[0], c[1], c[2]];
  return [0.7, 0.62, 0.5];
}

/** Resolves material names to colours: VTF reflectivity via the VMT's $basetexture (BSP pak file first, then the asset folder), else the BSP's texdata reflectivity, else the palette. */
export class MaterialResolver {
  private readonly pak = new Map<string, Uint8Array>();
  private readonly cache = new Map<string, { color: [number, number, number]; source: RenderMaterial['source'] } | null>();

  constructor(
    bsp: BspFile,
    private readonly assets: AssetLookup,
    private readonly mapName: string,
  ) {
    const zip = bsp.pakfile();
    for (const e of zipEntries(zip)) if (e.name.endsWith('.vmt')) this.pak.set(e.name, zipRead(zip, e));
  }

  private file(path: string): Uint8Array | null {
    return this.pak.get(normalizePath(path)) ?? this.assets.read(normalizePath(path));
  }

  /** The VTF's linear mean colour of a material (following patch includes), or null. */
  vtfColor(material: string, depth = 0): [number, number, number] | null {
    const key = normalizePath(material).replace(/\.vmt$/, '');
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit === null ? null : hit.color;
    let out: [number, number, number] | null = null;
    const bytes = this.file(`materials/${key}.vmt`) ?? this.file(`materials/${baseMaterialName(key, this.mapName)}.vmt`);
    if (bytes !== null && depth < 4) {
      try {
        const vmt = readVmt(new TextDecoder('latin1').decode(bytes));
        const tex = vmt.params.get('$basetexture');
        if (tex !== undefined) {
          const vtf = this.file(`materials/${normalizePath(tex).replace(/\.vtf$/, '')}.vtf`);
          if (vtf !== null) {
            const r = readVtfHeader(vtf).reflectivity;
            if (r.every((v) => Number.isFinite(v))) out = [r[0], r[1], r[2]];
          }
        }
        if (out === null && vmt.include !== null) out = this.vtfColor(vmt.include.replace(/^materials\//, ''), depth + 1);
      } catch (e) {
        if (!(e instanceof AssetError)) throw e;
      }
    }
    this.cache.set(key, out === null ? null : { color: out, source: 'vtf' });
    return out;
  }
}

// ---- the package ---------------------------------------------------------------------------------------------

function lum(c: readonly [number, number, number]): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** Sun direction (unit, pointing toward the sun) from light_environment's angles and pitch, else from above-south-west. */
function sunOf(ents: readonly Entity[]): [number, number, number] {
  const e = ents.find((x) => x.get('classname') === 'light_environment');
  const a = vec(e?.get('angles'));
  if (e === undefined || a === null) return [-0.35, -0.45, 0.82];
  const pitch = Number(e.get('pitch') ?? a[0]);
  const p = ((Number.isFinite(pitch) ? pitch : a[0]) * Math.PI) / 180;
  const y = (a[1] * Math.PI) / 180;
  // The light shines along (cos p cos y, cos p sin y, −sin p) for pitch measured down; the sun is opposite.
  const d: [number, number, number] = [-Math.cos(p) * Math.cos(y), -Math.cos(p) * Math.sin(y), Math.abs(Math.sin(p))];
  const n = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / n, d[1] / n, d[2] / n];
}

interface PropModel {
  readonly mdl: MdlInfo | null;
  /** Convex hull triangles in the model frame (from .phy), or null. */
  readonly hulls: Float64Array | null;
}

export interface BuildOptions {
  readonly mapName: string;
  readonly assets?: AssetLookup;
}

export function buildPackage(bsp: BspFile, options: BuildOptions): MapPackage {
  const assets = options.assets ?? NO_ASSETS;
  const P = PACKAGE_PARAMS;
  const planes = bsp.planes();
  const sides = bsp.brushSides();
  const brushes = bsp.brushes();
  const models = bsp.models();
  const ents = bsp.entities();

  // Brushes: the world's and the solid brush entities'.
  const brushCounts: Record<string, number> = { world: 0, clip: 0, grenadeClip: 0, ladder: 0, water: 0, other: 0 };
  const worldTris: Float64Array[] = [];
  const clipTris: Float64Array[] = [];
  const grenadeTris: Float64Array[] = [];
  const ladders: number[] = [];
  const water: number[] = [];
  const brushTris = (bi: number, shift: readonly [number, number, number]): Float64Array => {
    const b = brushes[bi];
    if (b === undefined) throw new AssetError(`brush ${bi} out of range`);
    const parts = brushFaces(planes, sides, b.firstSide, b.numSides).map((f) => fan(f.points));
    const n = parts.reduce((s, p) => s + p.length, 0);
    const out = new Float64Array(n);
    let o = 0;
    for (const p of parts) {
      for (let i = 0; i < p.length; i++) out[o + i] = (p[i] as number) + (shift[i % 3] as number);
      o += p.length;
    }
    return out;
  };
  const classify = (bi: number, shift: readonly [number, number, number], entitySolid: boolean): void => {
    const c = (brushes[bi] as { contents: number }).contents;
    if ((c & P.solidContents) !== 0) {
      if (entitySolid) {
        worldTris.push(brushTris(bi, shift));
        brushCounts.world = (brushCounts.world as number) + 1;
      }
    } else if ((c & CONTENTS.PLAYERCLIP) !== 0) {
      clipTris.push(brushTris(bi, shift));
      brushCounts.clip = (brushCounts.clip as number) + 1;
    } else if ((c & CONTENTS.GRENADECLIP) !== 0) {
      grenadeTris.push(brushTris(bi, shift));
      brushCounts.grenadeClip = (brushCounts.grenadeClip as number) + 1;
    } else if ((c & CONTENTS.LADDER) !== 0) {
      ladders.push(bi);
      brushCounts.ladder = (brushCounts.ladder as number) + 1;
    } else if ((c & (CONTENTS.WATER | CONTENTS.SLIME)) !== 0) {
      water.push(bi);
      brushCounts.water = (brushCounts.water as number) + 1;
    } else brushCounts.other = (brushCounts.other as number) + 1;
    // A brush can be both a ladder and solid/clip (vbsp keeps the flags): list it as a ladder too.
    if ((c & CONTENTS.LADDER) !== 0 && (c & (P.solidContents | CONTENTS.PLAYERCLIP | CONTENTS.GRENADECLIP)) !== 0) ladders.push(bi);
  };
  for (const bi of modelBrushes(bsp, 0)) classify(bi, [0, 0, 0], true);
  const drawnModels: { model: number; shift: [number, number, number] }[] = [{ model: 0, shift: [0, 0, 0] }];
  for (const e of ents) {
    const k = modelIndexOf(e);
    const cls = e.get('classname') ?? '';
    if (k === null || models[k] === undefined) continue;
    const shift = vec(e.get('origin')) ?? [0, 0, 0];
    const solid = SOLID_BRUSH_CLASSES.has(cls) && !(cls === 'func_brush' && e.get('Solidity') === '1');
    if (SOLID_BRUSH_CLASSES.has(cls)) for (const bi of modelBrushes(bsp, k)) classify(bi, shift, solid);
    if (DRAWN_BRUSH_CLASSES.has(cls) && !DRAWN_BRUSH_SKIP.has(cls)) drawnModels.push({ model: k, shift });
  }

  // Displacements (collision and render share the mesh).
  const verts = bsp.vertices();
  const edges = bsp.edges();
  const surfEdges = bsp.surfEdges();
  const { faces } = bsp.drawFaces();
  const texInfos = bsp.texInfos();
  const texDatas = bsp.texDatas();
  const names = bsp.texInfoMaterials();
  const dispInfos = bsp.dispInfos();
  const dispVerts = bsp.dispVerts();
  const dispTris = bsp.dispTris();
  const light = bsp.lighting().bytes;
  let dispTriCount = 0;
  const dispMeshes = new Map<number, ReturnType<typeof displacementMesh>>();
  faces.forEach((f, fi) => {
    if (f.dispInfo < 0) return;
    const info = dispInfos[f.dispInfo];
    if (info === undefined) throw new AssetError(`face ${fi}: dispinfo ${f.dispInfo} out of range`);
    const m = displacementMesh(info, facePolygon(f, verts, edges, surfEdges), dispVerts, dispTris);
    dispMeshes.set(fi, m);
    const tri = new Float64Array(m.tris.length * 3);
    for (let i = 0; i < m.tris.length; i++) for (let k = 0; k < 3; k++) tri[i * 3 + k] = m.positions[(m.tris[i] as number) * 3 + k] as number;
    worldTris.push(tri);
    dispTriCount += m.tris.length / 3;
  });

  // Static props and solid prop_dynamics.
  const propCache = new Map<string, PropModel>();
  const propModel = (path: string): PropModel => {
    const key = normalizePath(path);
    const hit = propCache.get(key);
    if (hit !== undefined) return hit;
    const mdlBytes = assets.read(key);
    let mdl: MdlInfo | null = null;
    let hulls: Float64Array | null = null;
    if (mdlBytes !== null) {
      try {
        mdl = readMdl(mdlBytes);
      } catch (e) {
        if (!(e instanceof AssetError)) throw e;
      }
      const phy = assets.read(key.replace(/\.mdl$/, '.phy'));
      if (phy !== null) {
        try {
          const solids = readPhy(phy).solids;
          const parts = solids.flatMap((s) => s.pieces.map((p) => p.triangles));
          const n = parts.reduce((s, p) => s + p.length, 0);
          if (n > 0) {
            hulls = new Float64Array(n);
            let o = 0;
            for (const p of parts) {
              hulls.set(p, o);
              o += p.length;
            }
          }
        } catch (e) {
          if (!(e instanceof PhyError)) throw e;
        }
      }
    }
    const out = { mdl, hulls };
    propCache.set(key, out);
    return out;
  };
  interface PlacedProp {
    readonly model: string;
    readonly origin: [number, number, number];
    readonly angles: [number, number, number];
    readonly scale: number;
    readonly solid: number;
    readonly skin: number;
  }
  const placed: PlacedProp[] = [];
  const sp = bsp.staticProps();
  for (const p of sp?.props ?? []) placed.push({ model: p.model, origin: [p.origin.x, p.origin.y, p.origin.z], angles: [p.angles[0], p.angles[1], p.angles[2]], scale: p.scale, solid: p.solid, skin: p.skin });
  for (const e of ents) {
    const cls = e.get('classname') ?? '';
    const m = e.get('model');
    if (!(cls === 'prop_dynamic' || cls === 'prop_dynamic_override' || cls === 'prop_physics_multiplayer' || cls === 'prop_physics' || cls === 'prop_physics_override') || m === undefined || !m.toLowerCase().endsWith('.mdl')) continue;
    const o = vec(e.get('origin'));
    if (o === null) continue;
    const solid = Number(e.get('solid') ?? String(SOLID_VPHYSICS));
    placed.push({ model: m, origin: o, angles: vec(e.get('angles')) ?? [0, 0, 0], scale: Number(e.get('modelscale') ?? '1') || 1, solid: Number.isFinite(solid) ? solid : SOLID_VPHYSICS, skin: Number(e.get('skin') ?? '0') || 0 });
  }
  let solidProps = 0;
  let fromPhy = 0;
  let fromBox = 0;
  let withoutModel = 0;
  const missingModels = new Set<string>();
  const propRender: { tris: Float64Array; model: string; skin: number }[] = [];
  for (const p of placed) {
    const pm = propModel(p.model);
    const m = angleMatrix(p.angles[0], p.angles[1], p.angles[2]);
    let local: Float64Array | null = null;
    if (pm.hulls !== null) local = pm.hulls;
    else if (pm.mdl !== null) {
      const valid = (lo: readonly number[], hi: readonly number[]): boolean => hi.every((v, k) => v > (lo[k] as number));
      const h = valid(pm.mdl.hullMin, pm.mdl.hullMax) ? { min: pm.mdl.hullMin, max: pm.mdl.hullMax } : { min: pm.mdl.viewMin, max: pm.mdl.viewMax };
      if (valid(h.min, h.max)) local = boxTriangles(h.min, h.max);
    }
    if (local === null) {
      missingModels.add(normalizePath(p.model));
      if (p.solid !== SOLID_NONE) withoutModel++;
      continue;
    }
    const world = transformPoints(local, m, p.scale, p.origin[0], p.origin[1], p.origin[2]);
    propRender.push({ tris: world, model: normalizePath(p.model), skin: p.skin });
    if (p.solid === SOLID_NONE) continue;
    solidProps++;
    if (p.solid === SOLID_VPHYSICS && pm.hulls !== null) fromPhy++;
    else if (p.solid === SOLID_BBOX || pm.hulls === null) fromBox++;
    worldTris.push(world);
  }

  // Render: drawn faces of the world and the drawn brush entities, minus the 3D skybox's area.
  const ents2 = readEntities(bsp, [...new Set(ladders)].sort((a, b) => a - b), water);
  const skyFaces = new Set<number>();
  if (ents2.skyCamera !== null) {
    const leafs = bsp.leafs();
    const leafFaces = bsp.leafFaces();
    const skyArea = (leafs[bsp.leafAt(...ents2.skyCamera)] as { area: number }).area;
    for (const leaf of leafs) if (leaf.area === skyArea) for (let k = 0; k < leaf.numLeafFaces; k++) skyFaces.add(leafFaces[leaf.firstLeafFace + k] as number);
  }
  const resolver = new MaterialResolver(bsp, assets, options.mapName);
  const matIndex = new Map<string, number>();
  const materials: RenderMaterial[] = [];
  const matSources: Record<RenderMaterial['source'], number> = { vtf: 0, reflectivity: 0, palette: 0 };
  const linearOf: number[][] = [];
  const material = (name: string, reflectivity: readonly [number, number, number] | null): number => {
    const key = normalizePath(name);
    const hit = matIndex.get(key);
    if (hit !== undefined) return hit;
    const vtf = resolver.vtfColor(key);
    let lin: [number, number, number];
    let source: RenderMaterial['source'];
    if (vtf !== null && lum(vtf) > 0) {
      lin = vtf;
      source = 'vtf';
    } else if (reflectivity !== null && lum(reflectivity) > 0) {
      lin = [reflectivity[0], reflectivity[1], reflectivity[2]];
      source = 'reflectivity';
    } else {
      const s = paletteColor(baseMaterialName(key, options.mapName));
      lin = s.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number];
      source = 'palette';
    }
    const i = materials.length;
    matIndex.set(key, i);
    materials.push({ name: key, color: [linearToSrgb(lin[0]), linearToSrgb(lin[1]), linearToSrgb(lin[2])], source });
    linearOf.push(lin);
    matSources[source]++;
    return i;
  };

  interface RFace {
    readonly pos: Float64Array;
    readonly tris: Int32Array;
    readonly light: Float64Array;
    readonly mat: number;
  }
  const rfaces: RFace[] = [];
  const faceLums: number[] = [];
  let dropped = 0;
  for (const { model, shift } of drawnModels) {
    const md = models[model];
    if (md === undefined) continue;
    for (let fi = md.firstFace; fi < md.firstFace + md.numFaces; fi++) {
      const f = faces[fi] as Face | undefined;
      if (f === undefined) continue;
      const ti = texInfos[f.texInfo] as TexInfo | undefined;
      if (ti === undefined || (ti.flags & NODRAW_FLAGS) !== 0) continue;
      if (model === 0 && skyFaces.has(fi)) {
        dropped++;
        continue;
      }
      const td = texDatas[ti.texData];
      const mat = material(names[f.texInfo] ?? 'unknown', td?.reflectivity ?? null);
      const lm = (ti.flags & SURF.NOLIGHT) !== 0 ? null : FaceLightmap.of(light, f, ti);
      const disp = dispMeshes.get(fi);
      let pos: Float64Array;
      let tris: Int32Array;
      let samplePos: Float64Array;
      if (disp !== undefined) {
        pos = disp.positions;
        tris = disp.tris;
        samplePos = disp.base;
      } else {
        pos = facePolygon(f, verts, edges, surfEdges);
        samplePos = pos;
        const n = pos.length / 3;
        tris = new Int32Array((n - 2) * 3);
        for (let i = 1; i < n - 1; i++) tris.set([0, i, i + 1], (i - 1) * 3);
      }
      const nv = pos.length / 3;
      const lightArr = new Float64Array(nv * 3);
      for (let i = 0; i < nv; i++) {
        const c = lm === null ? ([1, 1, 1] as [number, number, number]) : lm.sample(samplePos[i * 3] as number, samplePos[i * 3 + 1] as number, samplePos[i * 3 + 2] as number);
        lightArr.set(c, i * 3);
      }
      if (lm !== null) faceLums.push(lum(lm.mean()));
      const shifted = new Float64Array(pos.length);
      for (let i = 0; i < pos.length; i++) shifted[i] = (pos[i] as number) + (shift[i % 3] as number);
      rfaces.push({ pos: shifted, tris, light: lightArr, mat });
    }
  }
  faceLums.sort((a, b) => a - b);
  const ref = faceLums.length === 0 ? 1 : (faceLums[Math.min(faceLums.length - 1, Math.floor(faceLums.length * P.exposurePercentile))] as number);
  const exposure = ref > 0 ? P.exposureScale / ref : 1;
  // Props: shaded by the sun, coloured by their first material.
  const sun = sunOf(ents);
  const propMat = (model: string, skin: number): number => {
    const pm = propCache.get(model);
    const mdl = pm?.mdl ?? null;
    if (mdl !== null && mdl.textures.length > 0) {
      const family = mdl.skins[skin] ?? mdl.skins[0];
      const tex = family?.[0] ?? 0;
      for (const path of mdlMaterialPaths(mdl, tex)) {
        const name = path.replace(/^materials\//, '').replace(/\.vmt$/, '');
        if (resolver.vtfColor(name) !== null) return material(name, null);
      }
      const first = mdlMaterialPaths(mdl, tex)[0];
      if (first !== undefined) return material(first.replace(/^materials\//, '').replace(/\.vmt$/, ''), null);
    }
    return material(model, null);
  };

  // Assemble the render mesh.
  const q = P.quant;
  const positions: number[] = [];
  const colors: number[] = [];
  const triIdx: number[] = [];
  const triMat: number[] = [];
  const pushVertex = (x: number, y: number, z: number, lin: readonly number[], l: readonly [number, number, number]): void => {
    positions.push(Math.round(x * q), Math.round(y * q), Math.round(z * q));
    for (let k = 0; k < 3; k++) colors.push(Math.round(linearToSrgb((lin[k] as number) * Math.max(P.minLight, l[k] as number)) * 255));
  };
  for (const f of rfaces) {
    const base = positions.length / 3;
    const lin = linearOf[f.mat] as number[];
    for (let i = 0; i < f.pos.length / 3; i++) pushVertex(f.pos[i * 3] as number, f.pos[i * 3 + 1] as number, f.pos[i * 3 + 2] as number, lin, [(f.light[i * 3] as number) * exposure, (f.light[i * 3 + 1] as number) * exposure, (f.light[i * 3 + 2] as number) * exposure]);
    for (let t = 0; t < f.tris.length; t += 3) {
      triIdx.push(base + (f.tris[t] as number), base + (f.tris[t + 1] as number), base + (f.tris[t + 2] as number));
      triMat.push(f.mat);
    }
  }
  for (const pr of propRender) {
    const mat = propMat(pr.model, pr.skin);
    const lin = linearOf[mat] as number[];
    for (let o = 0; o + 9 <= pr.tris.length; o += 9) {
      const ux = (pr.tris[o + 3] as number) - (pr.tris[o] as number);
      const uy = (pr.tris[o + 4] as number) - (pr.tris[o + 1] as number);
      const uz = (pr.tris[o + 5] as number) - (pr.tris[o + 2] as number);
      const vx = (pr.tris[o + 6] as number) - (pr.tris[o] as number);
      const vy = (pr.tris[o + 7] as number) - (pr.tris[o + 1] as number);
      const vz = (pr.tris[o + 8] as number) - (pr.tris[o + 2] as number);
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz);
      if (nl === 0) continue;
      const shade = P.propAmbient + P.propDiffuse * Math.max(0, Math.abs((nx * sun[0] + ny * sun[1] + nz * sun[2]) / nl));
      const base = positions.length / 3;
      for (let k = 0; k < 3; k++) pushVertex(pr.tris[o + k * 3] as number, pr.tris[o + k * 3 + 1] as number, pr.tris[o + k * 3 + 2] as number, lin, [shade, shade, shade]);
      triIdx.push(base, base + 1, base + 2);
      triMat.push(mat);
    }
  }

  const world = canonicalMesh(worldTris, q);
  const clips = canonicalMesh(clipTris, q);
  const grenadeClips = canonicalMesh(grenadeTris, q);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < world.verts.length; i++) {
    const k = i % 3;
    const v = (world.verts[i] as number) / q;
    if (v < (min[k] as number)) min[k] = v;
    if (v > (max[k] as number)) max[k] = v;
  }
  const render: RenderMesh = { quant: q, materialCount: materials.length, positions: new Int32Array(positions), colors: new Uint8Array(colors), tris: new Int32Array(triIdx), materials: new Uint16Array(triMat) };
  return {
    world,
    clips,
    grenadeClips,
    render,
    colors: render.colors,
    materials,
    entities: ents2,
    bounds: { min, max },
    stats: {
      brushes: brushCounts,
      worldTriangles: world.tris.length / 3,
      clipTriangles: clips.tris.length / 3,
      grenadeClipTriangles: grenadeClips.tris.length / 3,
      displacements: dispMeshes.size,
      displacementTriangles: dispTriCount,
      staticProps: sp?.props.length ?? 0,
      solidProps,
      propsFromPhy: fromPhy,
      propsFromHullBox: fromBox,
      propsWithoutModel: withoutModel,
      propModelsMissing: [...missingModels].sort(),
      renderFaces: rfaces.length,
      renderTriangles: triMat.length,
      skyboxFacesDropped: dropped,
      materials: matSources,
      exposure,
    },
  };
}

/** Lumps the package reads (for the manifest's provenance). */
export const PACKAGE_LUMPS = ['ENTITIES', 'PLANES', 'TEXDATA', 'VERTEXES', 'NODES', 'TEXINFO', 'FACES', 'LIGHTING', 'LEAFS', 'EDGES', 'SURFEDGES', 'MODELS', 'LEAFFACES', 'LEAFBRUSHES', 'BRUSHES', 'BRUSHSIDES', 'DISPINFO', 'DISP_VERTS', 'DISP_TRIS', 'GAME_LUMP', 'PAKFILE', 'TEXDATA_STRING_DATA', 'TEXDATA_STRING_TABLE', 'LIGHTING_HDR', 'FACES_HDR'] as const satisfies readonly (keyof typeof LUMP)[];
