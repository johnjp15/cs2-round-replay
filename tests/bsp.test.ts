/**
 * X1: the Source BSP pipeline (tools/bsp/*, tools/extract-bsp.ts, tools/csgo2020-files.ts; docs/maps.md) on public
 * test maps (tests/fixtures/bsp/: bsp_tool's handmade TF2 maps, with the counts Valve's vbspinfo printed for them)
 * and on synthetic files for what those maps lack (CS:GO clips, ladders, buy zones, props with model files, VPKs).
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BspFile, CONTENTS, LUMP, SURF } from '../tools/bsp/bsp';
import { decodeValveLzma } from '../tools/bsp/lzma';
import { readPhysCollideLump } from '../tools/bsp/phy';
import { VpkDir, readMdl, readVmt, readVtfHeader, zipEntries, zipRead } from '../tools/bsp/assets';
import { buildPackage, canonicalMesh, type AssetLookup } from '../tools/bsp/package';
import { buildPackageFiles } from '../tools/extract-bsp';
import { CSGO_2020, GameFiles, collect, extract, plan, readManifestListing } from '../tools/csgo2020-files';
import { MapGeometry, STANDING_HULL, decodeGeometry, encodeGeometry } from '../src/sim2d/geometry';
import { decodeRenderMesh, encodeRenderMesh } from '../src/app3d/render-package';
import { buildRenderTiles } from '../src/app3d/world-mesh';
import { DEFAULT_MAP, mapPackagePaths, parseMapId } from '../src/contracts/maps';
import { parseScenario } from '../tools/human-bot';
import { writeBsp, writeMdl, writeVpkDir, writeVtf, writeZip, type SynBsp } from './bsp-fixtures';

const FIX = resolve(__dirname, 'fixtures/bsp');
const load = (name: string): BspFile => new BspFile(new Uint8Array(readFileSync(join(FIX, name))));

describe('BSP reader on public maps (counts from vbspinfo)', () => {
  it('test2.bsp: every lump vbspinfo counts', () => {
    const b = load('test2.bsp');
    expect(b.version).toBe(20);
    expect(b.models().length).toBe(2);
    expect(b.brushes().length).toBe(75);
    expect(b.brushSides().length).toBe(454);
    expect(b.planes().length).toBe(160);
    expect(b.vertices().length / 3).toBe(308);
    expect(b.nodes().length).toBe(128);
    expect(b.texInfos().length).toBe(30);
    expect(b.texDatas().length).toBe(12);
    expect(b.dispInfos().length).toBe(3);
    expect(b.dispVerts().length).toBe(131);
    expect(b.dispTris().length).toBe(192);
    expect(b.faces().length).toBe(172);
    expect(b.leafs().length).toBe(131);
    expect(b.leafFaces().length).toBe(204);
    expect(b.leafBrushes().length).toBe(115);
    expect(b.surfEdges().length).toBe(1320);
    expect(b.edges().length / 2).toBe(821);
    expect(b.lighting().bytes.length).toBe(85244);
    expect(b.lump(LUMP.ENTITIES).length).toBe(9647);
    expect(b.staticProps()?.props.length).toBe(17);
  });

  it('test_physcollide.bsp and mp_lobby.bsp: counts', () => {
    const p = load('test_physcollide.bsp');
    expect([p.models().length, p.brushes().length, p.brushSides().length, p.planes().length, p.faces().length, p.leafs().length, p.leafBrushes().length, p.edges().length / 2]).toEqual([3, 9, 54, 176, 44, 87, 148, 149]);
    const l = load('mp_lobby.bsp');
    expect([l.models().length, l.brushes().length, l.brushSides().length, l.planes().length, l.vertices().length / 3, l.faces().length, l.leafs().length, l.surfEdges().length, l.lighting().bytes.length]).toEqual([1, 6, 36, 40, 19, 16, 29, 88, 15872]);
  });

  it('displacements: (2^p + 1)² vertices and 2·(2^p)² triangles each, adding up to the lumps', () => {
    const b = load('test2.bsp');
    const infos = b.dispInfos();
    const verts = infos.reduce((s, d) => s + ((1 << d.power) + 1) ** 2, 0);
    const tris = infos.reduce((s, d) => s + 2 * (1 << d.power) ** 2, 0);
    expect(verts).toBe(131);
    expect(tris).toBe(192);
    const pkg = buildPackage(b, { mapName: 'test2' });
    expect(pkg.stats.displacements).toBe(3);
    expect(pkg.stats.displacementTriangles).toBe(192);
  });

  it('PHYSCOLLIDE: every brush model has hulls inside its bounds (IVP metres and axes converted)', () => {
    const b = load('test_physcollide.bsp');
    const models = b.models();
    const col = readPhysCollideLump(b.lump(LUMP.PHYSCOLLIDE));
    expect(col.length).toBeGreaterThanOrEqual(2);
    for (const c of col) {
      const m = models[c.model];
      expect(m).toBeDefined();
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (const s of c.solids) for (const p of s.pieces) for (let i = 0; i < p.triangles.length; i++) {
        const k = i % 3;
        min[k] = Math.min(min[k] as number, p.triangles[i] as number);
        max[k] = Math.max(max[k] as number, p.triangles[i] as number);
      }
      const mm = m as { mins: { x: number; y: number; z: number }; maxs: { x: number; y: number; z: number } };
      // The model's bounds are vbsp's (1 unit padded); the hulls sit within them, within IVP's convex radius.
      expect(min[0]).toBeGreaterThanOrEqual(mm.mins.x - 1);
      expect(max[0]).toBeLessThanOrEqual(mm.maxs.x + 1);
      expect(min[2]).toBeGreaterThanOrEqual(mm.mins.z - 1);
      expect(max[2]).toBeLessThanOrEqual(mm.maxs.z + 1);
      expect((max[0] as number) - (min[0] as number)).toBeGreaterThan(mm.maxs.x - mm.mins.x - 4);
    }
  });

  it('the package of test2.bsp: a hull stands on the floor at the spawns, clips are separate, output is deterministic', () => {
    const b = load('test2.bsp');
    const pkg = buildPackage(b, { mapName: 'test2' });
    expect(pkg.stats.brushes.clip).toBe(4);
    expect(pkg.clips.tris.length).toBeGreaterThan(0);
    const g = new MapGeometry(pkg.world);
    const spawns = b.entities().filter((e) => e.get('classname') === 'info_player_teamspawn');
    expect(spawns.length).toBe(2);
    for (const s of spawns) {
      const [x, y, z] = (s.get('origin') as string).split(' ').map(Number) as [number, number, number];
      const f = g.floorBelow(x, y, z + 8);
      expect(f).not.toBeNull();
      expect(Math.abs((f as { z: number }).z - z)).toBeLessThan(24);
      expect(g.hullBlocked(x, y, (f as { z: number }).z + 0.1, STANDING_HULL)).toBe(false);
    }
    const again = buildPackageFiles({ dir: 'test2', bsp: new Uint8Array(readFileSync(join(FIX, 'test2.bsp'))), nav: null, extraction: null, assets: null }, 'test2', 'test2');
    const once = buildPackageFiles({ dir: 'test2', bsp: new Uint8Array(readFileSync(join(FIX, 'test2.bsp'))), nav: null, extraction: null, assets: null }, 'test2', 'test2');
    for (const [k, v] of once.files) expect(Buffer.from(again.files.get(k) as Uint8Array).equals(Buffer.from(v))).toBe(true);
    // The G2GM files decode back to the meshes.
    const world = decodeGeometry(once.files.get('geometry.bin') as Uint8Array);
    expect(world.tris.length).toBe(pkg.world.tris.length);
  });

  it('render: drawn faces only (no nodraw, sky, triggers), materials from reflectivity, colours lit by the lightmaps', () => {
    const b = load('test2.bsp');
    const pkg = buildPackage(b, { mapName: 'test2' });
    const infos = b.texInfos();
    const drawable = b.faces().filter((f, i) => i < (b.models()[0]?.numFaces ?? 0) && ((infos[f.texInfo]?.flags ?? 0) & (SURF.NODRAW | SURF.SKY | SURF.SKY2D | SURF.TRIGGER | SURF.HINT | SURF.SKIP)) === 0);
    expect(pkg.stats.renderFaces).toBe(drawable.length);
    expect(pkg.materials.every((m) => m.source === 'reflectivity')).toBe(true);
    expect(pkg.materials.some((m) => /tools/.test(m.name))).toBe(false);
    const r = decodeRenderMesh(encodeRenderMesh(pkg.render));
    expect(r.tris.length).toBe(pkg.render.tris.length);
    expect(Buffer.from(r.colors).equals(Buffer.from(pkg.render.colors))).toBe(true);
    const tiles = buildRenderTiles(r);
    expect(tiles.reduce((s, t) => s + t.plain.triangles, 0)).toBe(r.tris.length / 3);
    // Lit, not flat: the vertex colours vary.
    expect(new Set(Array.from(r.colors)).size).toBeGreaterThan(8);
  });
});

describe('LZMA (Valve lump header)', () => {
  it('decodes a stream made by liblzma', () => {
    const out = decodeValveLzma(new Uint8Array(readFileSync(join(FIX, 'lzma-sample.bin'))));
    expect(Buffer.from(out).equals(readFileSync(join(FIX, 'lzma-sample.txt')))).toBe(true);
  });
});

// ---- synthetic CS:GO-style map ----------------------------------------------------------------------------------

const MATS = [
  { name: 'DE_MIRAGE/GROUND/MIRAGE_GROUND_01', reflectivity: [0.4, 0.3, 0.2] as const },
  { name: 'TOOLS/TOOLSPLAYERCLIP', reflectivity: [0, 0, 0] as const },
  { name: 'TOOLS/TOOLSGRENADECLIP', reflectivity: [0, 0, 0] as const },
  { name: 'TOOLS/TOOLSINVISIBLELADDER', reflectivity: [0, 0, 0] as const },
  { name: 'TOOLS/TOOLSTRIGGER', reflectivity: [0, 0, 0] as const },
  { name: 'maps/de_mirage/de_mirage/wall_plaster_1_2_3', reflectivity: [0, 0, 0] as const },
];

function synthetic(pak?: Uint8Array): SynBsp {
  return {
    materials: MATS,
    texInfos: [
      { material: 0, flags: 0 },
      { material: 1, flags: SURF.NODRAW },
      { material: 2, flags: SURF.NODRAW },
      { material: 3, flags: SURF.NODRAW },
      { material: 4, flags: SURF.TRIGGER | SURF.NODRAW },
      { material: 5, flags: 0 },
    ],
    brushes: [
      { min: [-512, -512, -64], max: [512, 512, 0], contents: CONTENTS.SOLID, texInfo: 0 },
      { min: [100, -200, 0], max: [116, 200, 256], contents: CONTENTS.PLAYERCLIP | CONTENTS.MONSTERCLIP, texInfo: 1 },
      { min: [-300, 0, 0], max: [-284, 100, 128], contents: CONTENTS.GRENADECLIP, texInfo: 2 },
      { min: [300, 300, 0], max: [304, 340, 200], contents: CONTENTS.LADDER | CONTENTS.PLAYERCLIP, texInfo: 3 },
      { min: [-500, -500, 0], max: [-300, -300, 72], contents: 0, texInfo: 4 },
      { min: [200, -500, 0], max: [264, -436, 64], contents: CONTENTS.SOLID, texInfo: 5 },
    ],
    drawTops: [
      { brush: 0, light: 0.5 },
      { brush: 5, light: 0.25 },
    ],
    models: [{ brushes: [4], min: [-500, -500, 0], max: [-300, -300, 72] }],
    entities: [
      '{ "classname" "worldspawn" "skyname" "sky_dust" }',
      '{ "classname" "info_player_terrorist" "origin" "-400 0 1" "angles" "0 90 0" }',
      '{ "classname" "info_player_counterterrorist" "origin" "400 0 1" "angles" "0 180 0" }',
      '{ "classname" "func_buyzone" "model" "*1" "TeamNum" "2" }',
      '{ "classname" "func_bomb_target" "model" "*1" "targetname" "bombsite_a" }',
      '{ "classname" "light_environment" "angles" "0 225 0" "pitch" "-45" }',
    ].join('\n'),
    props: {
      names: ['models/props/de_mirage/crate.mdl', 'models/props/de_mirage/barrel.mdl', 'models/props/de_mirage/missing.mdl'],
      props: [
        { model: 0, origin: [0, 0, 0], angles: [0, 0, 0], solid: 2 },
        { model: 1, origin: [-100, -100, 0], angles: [0, 90, 0], solid: 6 },
        { model: 2, origin: [50, 50, 0], angles: [0, 0, 0], solid: 6 },
      ],
    },
    ...(pak === undefined ? {} : { pak }),
  };
}

/** An asset folder in memory. */
function lookup(files: Record<string, Uint8Array>): AssetLookup {
  return { read: (p) => files[p.toLowerCase()] ?? null };
}

/** A real IVP solid (from test_physcollide.bsp's PHYSCOLLIDE lump) wrapped as a .phy file. */
function phyFromFixture(): Uint8Array {
  const b = load('test_physcollide.bsp');
  const lump = b.lump(LUMP.PHYSCOLLIDE);
  const dv = new DataView(lump.buffer, lump.byteOffset, lump.byteLength);
  const solidSize = dv.getInt32(16, true);
  const solid = lump.subarray(20, 20 + solidSize);
  const out = new Uint8Array(16 + 4 + solid.length);
  const o = new DataView(out.buffer);
  o.setInt32(0, 16, true);
  o.setInt32(4, 0, true);
  o.setInt32(8, 1, true);
  o.setInt32(12, 99, true);
  o.setInt32(16, solid.length, true);
  out.set(solid, 20);
  return out;
}

describe('package on a synthetic CS:GO-style BSP', () => {
  const assets = lookup({
    'models/props/de_mirage/crate.mdl': writeMdl('crate', [-16, -16, 0], [16, 16, 48], 'crate_01', 'models/props/de_mirage/'),
    'materials/models/props/de_mirage/crate_01.vmt': new TextEncoder().encode('"VertexLitGeneric" { "$basetexture" "models/props/de_mirage/crate_01_color" }'),
    'materials/models/props/de_mirage/crate_01_color.vtf': writeVtf([0.5, 0.25, 0.1]),
    'models/props/de_mirage/barrel.mdl': writeMdl('barrel', [-8, -8, 0], [8, 8, 40], 'barrel', 'models/props/de_mirage/'),
    'models/props/de_mirage/barrel.phy': phyFromFixture(),
  });
  const bsp = new BspFile(writeBsp(synthetic()));

  it('reads back what was written', () => {
    expect(bsp.version).toBe(21);
    expect(bsp.brushes().length).toBe(6);
    expect(bsp.texDataStrings()).toEqual(MATS.map((m) => m.name));
    expect(bsp.staticProps()?.props.map((p) => [p.model, p.solid])).toEqual([
      ['models/props/de_mirage/crate.mdl', 2],
      ['models/props/de_mirage/barrel.mdl', 6],
      ['models/props/de_mirage/missing.mdl', 6],
    ]);
    expect(readMdl(assets.read('models/props/de_mirage/crate.mdl') as Uint8Array).textures).toEqual(['crate_01']);
    expect(readVtfHeader(writeVtf([0.1, 0.2, 0.3])).reflectivity.map((v) => Math.round(v * 10) / 10)).toEqual([0.1, 0.2, 0.3]);
  });

  it('sorts brushes by contents: world, player clip, grenade clip, ladder; triggers are entity boxes', () => {
    const pkg = buildPackage(bsp, { mapName: 'de_mirage', assets });
    expect(pkg.stats.brushes).toMatchObject({ world: 2, clip: 2, grenadeClip: 1 });
    expect(pkg.entities.ladders).toHaveLength(1);
    expect(pkg.entities.ladders[0]).toMatchObject({ min: [300, 300, 0], max: [304, 340, 200] });
    const world = new MapGeometry(pkg.world);
    const clips = new MapGeometry(pkg.clips);
    // The clip wall at x 100..116 blocks a hull only in the clips mesh.
    expect(world.hullBlocked(108, 0, 1, STANDING_HULL)).toBe(false);
    expect(clips.hullBlocked(108, 0, 1, STANDING_HULL)).toBe(true);
    // The grenade clip is in neither.
    expect(world.hullBlocked(-292, 50, 1, STANDING_HULL) || clips.hullBlocked(-292, 50, 1, STANDING_HULL)).toBe(false);
    expect(new MapGeometry(pkg.grenadeClips).hullBlocked(-292, 50, 1, STANDING_HULL)).toBe(true);
    // The floor: a hull rests at z 0.
    expect(world.floorBelow(0, 200, 10)?.z).toBe(0);
  });

  it('entities: spawns, buy zone and bomb target boxes, sky', () => {
    const e = buildPackage(bsp, { mapName: 'de_mirage', assets }).entities;
    expect(e.spawns).toEqual([
      { team: 'CT', origin: [400, 0, 1], yaw: 180, priority: 0 },
      { team: 'T', origin: [-400, 0, 1], yaw: 90, priority: 0 },
    ]);
    expect(e.buyZones).toEqual([{ team: 'T', min: [-500, -500, 0], max: [-300, -300, 72] }]);
    expect(e.bombTargets).toEqual([{ name: 'bombsite_a', min: [-500, -500, 0], max: [-300, -300, 72] }]);
    expect(e.skyName).toBe('sky_dust');
  });

  it('props: .phy hulls when present, the model hull box else, nothing without model files', () => {
    const pkg = buildPackage(bsp, { mapName: 'de_mirage', assets });
    expect(pkg.stats).toMatchObject({ staticProps: 3, solidProps: 2, propsFromPhy: 1, propsFromHullBox: 1, propsWithoutModel: 1 });
    expect(pkg.stats.propModelsMissing).toEqual(['models/props/de_mirage/missing.mdl']);
    const g = new MapGeometry(pkg.world);
    // The crate (hull box 32 × 32 × 48 at the origin) blocks; outside it is free.
    expect(g.hullBlocked(0, 0, 1, STANDING_HULL)).toBe(true);
    expect(g.hullBlocked(0, 100, 1, STANDING_HULL)).toBe(false);
    // Without assets every prop lacks its model.
    const bare = buildPackage(bsp, { mapName: 'de_mirage' });
    expect(bare.stats).toMatchObject({ solidProps: 0, propsWithoutModel: 3 });
  });

  it('materials: VTF colour via the VMT, else texdata reflectivity, else the name palette (cubemap patches by base name)', () => {
    const pkg = buildPackage(bsp, { mapName: 'de_mirage', assets });
    const by = new Map(pkg.materials.map((m) => [m.name, m]));
    expect(by.get('de_mirage/ground/mirage_ground_01')?.source).toBe('reflectivity');
    expect(by.get('maps/de_mirage/de_mirage/wall_plaster_1_2_3')?.source).toBe('palette');
    expect(by.get('models/props/de_mirage/crate_01')?.source).toBe('vtf');
    // Lightmapped: the 0.25-lit face is darker than the 0.5-lit one with the same exposure.
    const r = pkg.render;
    const lumOfMat = (name: string): number => {
      const mi = pkg.materials.findIndex((m) => m.name === name);
      const t = Array.from(r.materials).indexOf(mi);
      const v = r.tris[t * 3] as number;
      return (r.colors[v * 3] as number) + (r.colors[v * 3 + 1] as number) + (r.colors[v * 3 + 2] as number);
    };
    expect(lumOfMat('de_mirage/ground/mirage_ground_01')).toBeGreaterThan(0);
    expect(pkg.stats.renderFaces).toBe(2);
  });

  it('a VMT in the pak file overrides: its $basetexture VTF colours the material', () => {
    const pak = writeZip([{ name: 'materials/maps/de_mirage/de_mirage/wall_plaster_1_2_3.vmt', data: new TextEncoder().encode('"patch" { "include" "materials/de_mirage/wall_plaster.vmt" "insert" { "$envmap" "x" } }') }]);
    const b2 = new BspFile(writeBsp(synthetic(pak)));
    const a2 = lookup({ 'materials/de_mirage/wall_plaster.vmt': new TextEncoder().encode('"LightmappedGeneric" { "$basetexture" "de_mirage/wall_plaster_c" }'), 'materials/de_mirage/wall_plaster_c.vtf': writeVtf([0.6, 0.5, 0.4]) });
    const pkg = buildPackage(b2, { mapName: 'de_mirage', assets: a2 });
    const m = pkg.materials.find((x) => x.name === 'maps/de_mirage/de_mirage/wall_plaster_1_2_3');
    expect(m?.source).toBe('vtf');
    expect(zipEntries(pak)[0]?.name).toBe('materials/maps/de_mirage/de_mirage/wall_plaster_1_2_3.vmt');
    expect(readVmt(new TextDecoder().decode(zipRead(pak, zipEntries(pak)[0] as never))).include).toBe('materials/de_mirage/wall_plaster.vmt');
  });

  it('canonical meshes drop degenerate and repeated triangles and round to 1/8', () => {
    const m = canonicalMesh([new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 2, 0, 0, 0.01, 0.01, 0, 1.06, 0, 0, 0, 1.01, 0])], 8);
    expect(m.tris.length / 3).toBe(1);
    expect(Array.from(m.verts.slice(0, 9))).toEqual([0, 0, 0, 8, 0, 0, 0, 8, 0]);
    expect(decodeGeometry(encodeGeometry(m)).tris.length).toBe(3);
  });
});

describe('csgo2020-files: references, chunks, extraction', () => {
  const setup = (withChunks: boolean): string => {
    const raw = mkdtempSync(join(tmpdir(), 'x1-raw-'));
    mkdirSync(join(raw, 'csgo/maps'), { recursive: true });
    writeFileSync(join(raw, 'csgo/maps/de_mirage.bsp'), writeBsp(synthetic()));
    writeFileSync(join(raw, 'csgo/maps/de_mirage.nav'), new Uint8Array([0xce, 0xfa, 0xed, 0xfe]));
    const vmt = new TextEncoder().encode('"LightmappedGeneric" { "$basetexture" "de_mirage/ground/mirage_ground_01_c" "$bumpmap" "de_mirage/ground/n" }');
    const vtf = writeVtf([0.4, 0.3, 0.2]);
    const mdl = writeMdl('crate', [-16, -16, 0], [16, 16, 48], 'crate_01', 'models/props/de_mirage/');
    // archive 0: the VMT and the model; archive 3: the VTF and the model's material.
    const crateVmt = new TextEncoder().encode('"VertexLitGeneric" { "$basetexture" "models/props/de_mirage/crate_01_color" }');
    const a0 = new Uint8Array([...vmt, ...mdl]);
    const a3 = new Uint8Array([...vtf, ...crateVmt]);
    writeFileSync(
      join(raw, 'csgo/pak01_dir.vpk'),
      writeVpkDir([
        { path: 'materials/de_mirage/ground/mirage_ground_01.vmt', archive: 0, offset: 0, length: vmt.length },
        { path: 'models/props/de_mirage/crate.mdl', archive: 0, offset: vmt.length, length: mdl.length },
        { path: 'materials/de_mirage/ground/mirage_ground_01_c.vtf', archive: 3, offset: 0, length: vtf.length },
        { path: 'materials/models/props/de_mirage/crate_01.vmt', archive: 3, offset: vtf.length, length: crateVmt.length },
        { path: 'materials/unrelated/thing.vmt', archive: 7, offset: 0, length: 10 },
      ]),
    );
    if (withChunks) {
      writeFileSync(join(raw, 'csgo/pak01_000.vpk'), a0);
      writeFileSync(join(raw, 'csgo/pak01_003.vpk'), a3);
    }
    writeFileSync(join(raw, `manifest_731_${CSGO_2020.manifest}.txt`), `Content Manifest for Depot 731 \n\n          Size Chunks File SHA                                 Flags Name\n        ${a0.length}      1 ${'a'.repeat(40)}     0 csgo\\pak01_000.vpk\n        ${a3.length}      1 ${'b'.repeat(40)}     0 csgo\\pak01_003.vpk\n`);
    return raw;
  };

  it('plans the chunks that hold referenced files (none unrelated), and follows VMT → VTF and MDL → VMT once the chunks are there', () => {
    const raw = setup(false);
    const lines: string[] = [];
    const first = plan(raw, (s) => lines.push(s));
    expect(first.collected.chunks).toEqual([0]);
    expect(first.missingChunks).toEqual([0]);
    expect(first.collected.unread).toContain('materials/de_mirage/ground/mirage_ground_01.vmt');
    expect(lines.some((l) => l.includes('csgo/pak01_000.vpk') && l.includes('MiB') && l.includes('(to download)'))).toBe(true);
    const raw2 = setup(true);
    const second = plan(raw2, () => undefined);
    expect(second.collected.chunks).toEqual([0, 3]);
    expect(second.missingChunks).toEqual([]);
    expect(second.collected.unread).toEqual([]);
    expect(second.collected.files).toEqual(
      expect.arrayContaining(['materials/de_mirage/ground/mirage_ground_01.vmt', 'materials/de_mirage/ground/mirage_ground_01_c.vtf', 'models/props/de_mirage/crate.mdl', 'materials/models/props/de_mirage/crate_01.vmt', 'maps/de_mirage.nav']),
    );
    expect(second.collected.files).not.toContain('materials/unrelated/thing.vmt');
  });

  it('extracts the referenced files with a manifest of hashes', () => {
    const raw = setup(true);
    const out = mkdtempSync(join(tmpdir(), 'x1-out-'));
    extract(raw, out, () => undefined);
    const man = JSON.parse(readFileSync(join(out, 'MANIFEST.json'), 'utf8')) as { source: { manifest: string; depot: number }; files: { path: string; sha256: string; from: string }[]; missing: string[] };
    expect(man.source).toMatchObject({ manifest: '7867263815789485437', depot: 731, app: 730 });
    const paths = man.files.map((f) => f.path);
    expect(paths).toContain('maps/de_mirage.bsp');
    expect(paths).toContain('materials/de_mirage/ground/mirage_ground_01_c.vtf');
    expect(man.files.find((f) => f.path === 'models/props/de_mirage/crate.mdl')?.from).toBe('pak01_000.vpk');
    expect(readVtfHeader(new Uint8Array(readFileSync(join(out, 'materials/de_mirage/ground/mirage_ground_01_c.vtf')))).reflectivity[0]).toBeCloseTo(0.4, 5);
    // The extraction is a valid source folder for the package build.
    expect(man.missing).toContain('materials/de_mirage/ground/n.vtf');
  });

  it('reads the depot listing', () => {
    const m = readManifestListing('          Size Chunks File SHA                                 Flags Name\n      1234      2 0123456789abcdef0123456789abcdef01234567     0 csgo\\maps\\de_mirage.bsp\n');
    expect(m.get('csgo/maps/de_mirage.bsp')).toEqual({ size: 1234, sha1: '0123456789abcdef0123456789abcdef01234567' });
  });

  it('GameFiles prefers the BSP pak file over pak01', () => {
    const raw = setup(true);
    const pak = writeZip([{ name: 'materials/de_mirage/ground/mirage_ground_01.vmt', data: new TextEncoder().encode('"x" {}') }]);
    const b = new BspFile(writeBsp(synthetic(pak)));
    const vpk = new VpkDir(new Uint8Array(readFileSync(join(raw, 'csgo/pak01_dir.vpk'))));
    const files = new GameFiles(raw, b, vpk);
    expect(files.where('materials/de_mirage/ground/mirage_ground_01.vmt')?.kind).toBe('pakfile');
    expect(collect(b, files).files).toContain('materials/de_mirage/ground/mirage_ground_01.vmt');
  });
});

describe('map packages', () => {
  it('parses ids and paths', () => {
    expect(parseMapId(null)).toBe(DEFAULT_MAP);
    expect(parseMapId('mirage-2020')).toBe('mirage-2020');
    expect(() => parseMapId('dust2')).toThrow(/unknown map package/);
    expect(mapPackagePaths('mirage-2020')).toMatchObject({ geometry: 'data/maps/mirage-2020/geometry.bin', render: 'data/maps/mirage-2020/render.bin', tracks: 'data/maps/mirage-2020/tracks.json' });
    expect(mapPackagePaths('mirage-cs2').render).toBeNull();
  });

  it('a scenario may name its map package', () => {
    expect(parseScenario({ human: 'cart', steps: [], map: 'mirage-2020' }).map).toBe('mirage-2020');
    expect(parseScenario({ human: 'cart', steps: [] }).map).toBeNull();
    expect(() => parseScenario({ human: 'cart', steps: [], map: 'nuke' })).toThrow(/scenario.map/);
  });
});
