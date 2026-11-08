/**
 * X1b: a studio model's drawn triangles (MDL + VVD + DX90 VTX), for the render mesh of the map package
 * (tools/bsp/package.ts): the props are drawn as their real meshes, not their collision hulls.
 *
 * Layouts (public Source SDK 2013 headers: `studio.h` for `mstudiobodyparts_t` / `mstudiomodel_t` /
 * `mstudiomesh_t`, `optimize.h` for the VTX, `studio.h` `vertexFileHeader_t` for the VVD; Valve Developer Community
 * "MDL", "VVD", "VTX"):
 *
 * - **MDL** (`studiohdr_t`): `numbodyparts` at 232, `bodypartindex` at 236. A body part is 16 bytes (name, nummodels,
 *   base, modelindex); a model 148 bytes (name[64], type, radius, nummeshes, meshindex, numvertices, vertexindex
 *   (byte offset into the VVD vertices, 48 per vertex), …); a mesh 116 bytes (material, modelindex, numvertices,
 *   vertexoffset (vertex index inside its model), …).
 * - **VVD** (`IDSV` v4): 48-byte vertices (bone weights 16, position 12, normal 12, uv 8) from `vertexDataStart`;
 *   with fixups, LOD `l`'s vertex list is the concatenation of the fixup ranges whose `lod >= l`.
 * - **VTX** (v7): header 36 bytes; body part 8 (numModels, modelOffset); model 8 (numLODs, lodOffset); model LOD 12
 *   (numMeshes, meshOffset, switchPoint); mesh 9 (numStripGroups, stripGroupHeaderOffset, flags); strip group 25, or
 *   33 for MDL v49 models compiled with topology data (CS:GO), detected by which stride makes the offsets valid;
 *   vertex 9 bytes (`origMeshVertID` u16 at 4); indices u16 into the strip group's vertices, read as a triangle list
 *   (strip groups flagged as tristrips are rare in CS:GO and are unrolled).
 *
 * Positions are in the model's frame (x forward, y left, z up), as the engine draws a static prop before its
 * angles, origin and scale are applied. The skin family picks each mesh's material (`MdlInfo.skins`).
 */
import { AssetError, type MdlInfo } from './assets';

function dvOf(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

export interface StudioMesh {
  /** x y z per vertex (model frame). */
  readonly positions: Float64Array;
  /** Vertex indices, three per triangle. */
  readonly tris: Uint32Array;
  /** The skin reference (`mstudiomesh_t.material`) per triangle: index into a skin family row. */
  readonly skinRef: Uint16Array;
}

interface MdlMesh {
  readonly material: number;
  readonly vertexOffset: number;
}
interface MdlModel {
  readonly vertexIndex: number;
  readonly meshes: readonly MdlMesh[];
}

/** Body parts → models → meshes of an MDL (only the fields the drawing needs). */
export function mdlBodyParts(b: Uint8Array): MdlModel[][] {
  const dv = dvOf(b);
  const n = dv.getInt32(232, true);
  const at = dv.getInt32(236, true);
  if (n < 0 || n > 64 || at < 0 || at + n * 16 > b.length) throw new AssetError('mdl: bad body parts');
  const parts: MdlModel[][] = [];
  for (let p = 0; p < n; p++) {
    const bp = at + p * 16;
    const nm = dv.getInt32(bp + 4, true);
    const mi = bp + dv.getInt32(bp + 12, true);
    if (nm < 0 || nm > 256 || mi < 0 || mi + nm * 148 > b.length) throw new AssetError('mdl: bad models');
    const models: MdlModel[] = [];
    for (let m = 0; m < nm; m++) {
      const mo = mi + m * 148;
      const numMeshes = dv.getInt32(mo + 72, true);
      const meshAt = mo + dv.getInt32(mo + 76, true);
      const vertexIndex = dv.getInt32(mo + 84, true);
      if (numMeshes < 0 || numMeshes > 1024 || meshAt < 0 || meshAt + numMeshes * 116 > b.length) throw new AssetError('mdl: bad meshes');
      const meshes: MdlMesh[] = [];
      for (let k = 0; k < numMeshes; k++) {
        const me = meshAt + k * 116;
        meshes.push({ material: dv.getInt32(me, true), vertexOffset: dv.getInt32(me + 12, true) });
      }
      models.push({ vertexIndex, meshes });
    }
    parts.push(models);
  }
  return parts;
}

/** The VVD's vertex positions for one LOD (fixups applied), x y z per vertex. */
export function vvdPositions(b: Uint8Array, lod: number): Float64Array {
  const dv = dvOf(b);
  if (b.length < 64 || dv.getUint32(0, true) !== 0x56534449) throw new AssetError('vvd: bad magic (expected IDSV)');
  const numLods = dv.getInt32(12, true);
  const l = Math.max(0, Math.min(lod, numLods - 1));
  const numFixups = dv.getInt32(48, true);
  const fixupStart = dv.getInt32(52, true);
  const vertexStart = dv.getInt32(56, true);
  const total = dv.getInt32(16, true);
  const at = (i: number): [number, number, number] => {
    const o = vertexStart + i * 48 + 16;
    return [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)];
  };
  const out: number[] = [];
  if (numFixups === 0) {
    const n = dv.getInt32(16 + l * 4, true);
    for (let i = 0; i < n; i++) out.push(...at(i));
  } else {
    for (let f = 0; f < numFixups; f++) {
      const o = fixupStart + f * 12;
      if (dv.getInt32(o, true) < l) continue;
      const src = dv.getInt32(o + 4, true);
      const cnt = dv.getInt32(o + 8, true);
      if (src < 0 || cnt < 0 || src + cnt > total) throw new AssetError('vvd: bad fixup');
      for (let i = 0; i < cnt; i++) out.push(...at(src + i));
    }
  }
  return new Float64Array(out);
}

/** A model's triangles at a LOD (clamped to the model's last LOD). */
export function readStudioMesh(mdlBytes: Uint8Array, mdl: MdlInfo, vvd: Uint8Array, vtx: Uint8Array, lod: number, bodyGroup = 0): StudioMesh {
  const parts = mdlBodyParts(mdlBytes);
  const dv = dvOf(vtx);
  if (vtx.length < 36 || dv.getInt32(0, true) !== 7) throw new AssetError('vtx: unsupported version');
  const vtxLods = dv.getInt32(20, true);
  const l = Math.max(0, Math.min(lod, vtxLods - 1));
  const pos = vvdPositions(vvd, l);
  const nBody = dv.getInt32(28, true);
  const bodyAt = dv.getInt32(32, true);
  if (nBody !== parts.length) throw new AssetError(`vtx: ${nBody} body parts, mdl has ${parts.length}`);
  const tris: number[] = [];
  const refs: number[] = [];
  const nVerts = pos.length / 3;
  // Strip group stride: 25 (SDK 2013) or 33 (CS:GO's MDL v49 with topology fields). Try 33 first for v49.
  const strides = mdl.version >= 49 ? [33, 25] : [25, 33];
  let lastError: unknown = null;
  for (const sgStride of strides) {
    tris.length = 0;
    refs.length = 0;
    try {
      let body = bodyGroup;
      for (let p = 0; p < nBody; p++) {
        const bp = bodyAt + p * 8;
        const nModels = dv.getInt32(bp, true);
        const modelAt = bp + dv.getInt32(bp + 4, true);
        const mdlModels = parts[p] as MdlModel[];
        if (nModels !== mdlModels.length) throw new AssetError('vtx: model count mismatch');
        if (nModels === 0) continue;
        // The body group picks one model per body part (the engine's default body 0 → model 0 of each part).
        const pick = body % nModels;
        body = Math.floor(body / nModels);
        const mo = modelAt + pick * 8;
        const nLods = dv.getInt32(mo, true);
        const lodAt = mo + dv.getInt32(mo + 4, true);
        const ll = Math.min(l, nLods - 1);
        if (ll < 0) continue;
        const lo = lodAt + ll * 12;
        const nMeshes = dv.getInt32(lo, true);
        const meshAt = lo + dv.getInt32(lo + 4, true);
        const mm = mdlModels[pick] as MdlModel;
        if (nMeshes !== mm.meshes.length) throw new AssetError('vtx: mesh count mismatch');
        for (let k = 0; k < nMeshes; k++) {
          const me = meshAt + k * 9;
          const nSg = dv.getInt32(me, true);
          const sgAt = me + dv.getInt32(me + 4, true);
          const mesh = mm.meshes[k] as MdlMesh;
          const base = mm.vertexIndex / 48 + mesh.vertexOffset;
          for (let g = 0; g < nSg; g++) {
            const sg = sgAt + g * sgStride;
            if (sg + 25 > vtx.length) throw new AssetError('vtx: strip group out of range');
            const sgVerts = dv.getInt32(sg, true);
            const vertAt = sg + dv.getInt32(sg + 4, true);
            const nIdx = dv.getInt32(sg + 8, true);
            const idxAt = sg + dv.getInt32(sg + 12, true);
            const flags = vtx[sg + 24] as number;
            if (sgVerts < 0 || nIdx < 0 || vertAt < 0 || idxAt < 0 || vertAt + sgVerts * 9 > vtx.length || idxAt + nIdx * 2 > vtx.length) throw new AssetError('vtx: strip group data out of range');
            const vid = (i: number): number => {
              const sv = dv.getUint16(idxAt + i * 2, true);
              if (sv >= sgVerts) throw new AssetError('vtx: index out of range');
              const v = base + dv.getUint16(vertAt + sv * 9 + 4, true);
              if (v >= nVerts) throw new AssetError('vtx: vertex out of range');
              return v;
            };
            const strip = (flags & 0x02) !== 0;
            if (!strip) {
              if (nIdx % 3 !== 0) throw new AssetError('vtx: index count not a multiple of 3');
              for (let i = 0; i < nIdx; i += 3) {
                tris.push(vid(i), vid(i + 1), vid(i + 2));
                refs.push(mesh.material);
              }
            } else {
              for (let i = 2; i < nIdx; i++) {
                const a = vid(i - 2);
                const b = vid(i - 1);
                const c = vid(i);
                if (a === b || b === c || a === c) continue;
                if (i % 2 === 0) tris.push(a, b, c);
                else tris.push(b, a, c);
                refs.push(mesh.material);
              }
            }
          }
        }
      }
      return { positions: pos, tris: new Uint32Array(tris), skinRef: new Uint16Array(refs) };
    } catch (e) {
      if (!(e instanceof AssetError)) throw e;
      lastError = e;
    }
  }
  throw lastError instanceof AssetError ? lastError : new AssetError('vtx: unreadable');
}

/**
 * Vertex clustering (Rossignac–Borrel): every vertex moves to the mean of its `cell`-unit grid cell, triangles that
 * collapse or repeat are dropped. Keeps a prop's silhouette to about a cell, at a fraction of its triangles (the
 * render mesh is low-fi: one colour per material, no textures). Deterministic.
 */
export function clusterMesh(m: StudioMesh, cell: number): StudioMesh {
  if (cell <= 0) return m;
  const n = m.positions.length / 3;
  const keyOf = new Map<number, number>();
  const remap = new Int32Array(n);
  const sums: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = m.positions[i * 3] as number;
    const y = m.positions[i * 3 + 1] as number;
    const z = m.positions[i * 3 + 2] as number;
    // Models span well under ±2^16 cells per axis at these cell sizes.
    const k = (Math.floor(x / cell) + 32768) * 4294967296 + (Math.floor(y / cell) + 32768) * 65536 + (Math.floor(z / cell) + 32768);
    let c = keyOf.get(k);
    if (c === undefined) {
      c = sums.length / 4;
      keyOf.set(k, c);
      sums.push(0, 0, 0, 0);
    }
    remap[i] = c;
    sums[c * 4] = (sums[c * 4] as number) + x;
    sums[c * 4 + 1] = (sums[c * 4 + 1] as number) + y;
    sums[c * 4 + 2] = (sums[c * 4 + 2] as number) + z;
    sums[c * 4 + 3] = (sums[c * 4 + 3] as number) + 1;
  }
  const nc = sums.length / 4;
  const pos = new Float64Array(nc * 3);
  for (let c = 0; c < nc; c++) for (let k = 0; k < 3; k++) pos[c * 3 + k] = (sums[c * 4 + k] as number) / (sums[c * 4 + 3] as number);
  const tris: number[] = [];
  const refs: number[] = [];
  const seen = new Set<number>();
  for (let t = 0; t < m.tris.length; t += 3) {
    const a = remap[m.tris[t] as number] as number;
    const b = remap[m.tris[t + 1] as number] as number;
    const c = remap[m.tris[t + 2] as number] as number;
    if (a === b || b === c || a === c) continue;
    const lo = Math.min(a, b, c);
    const hi = Math.max(a, b, c);
    const key = (lo * 131072 + (a + b + c - lo - hi)) * 131072 + hi; // < 2^51: vertex counts stay under 2^17
    if (seen.has(key)) continue;
    seen.add(key);
    tris.push(a, b, c);
    refs.push(m.skinRef[t / 3] as number);
  }
  return { positions: pos, tris: new Uint32Array(tris), skinRef: new Uint16Array(refs) };
}
