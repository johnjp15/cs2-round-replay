/**
 * H3: map packages from any awpy-data map (tools/build-map.ts, docs/maps.md) and CS2's nav as the LIVE AI's
 * (src/engine/nav/cs2-nav.ts, docs/nav.md "CS2 nav"). The full Mirage rebuild (mesh, clips, height image) is
 * `npm run map:check` (CI); here the parts that are quick.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bombsiteAt, mapPackagePaths, parseMapInfo, type MapId, type MapInfo, type Vec3 } from '../src/contracts/index';
import { Cs2Nav } from '../src/engine/nav/cs2-nav';
import { legacyMapNav } from '../src/sim2d/ai';
import { encodeGeometry } from '../src/sim2d/geometry';
import { buildMap, committedSource, crc32, staleFiles } from '../tools/build-map';
import { readCs2NavFile } from '../tools/cs2-nav-file';
import { BIN_PATH, PARAMS, buildMesh, readAwmh } from '../tools/extract-geometry';
import { nav as grid } from './sim2d-fixtures';

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const file = (p: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../${p}`, import.meta.url)));

function load(id: MapId): { info: MapInfo; nav: Cs2Nav } {
  const p = mapPackagePaths(id);
  const info = parseMapInfo(readFileSync(new URL(`../${p.info as string}`, import.meta.url), 'utf8'));
  return { info, nav: Cs2Nav.fromJson(readFileSync(new URL(`../${p.nav as string}`, import.meta.url), 'utf8'), info) };
}

describe('tools/build-map.ts', () => {
  it('rebuilds the Mirage collision mesh byte for byte through the generic path', () => {
    const src = committedSource('de_mirage');
    const bin = encodeGeometry(buildMesh(readAwmh(src.mesh), PARAMS.quant).mesh);
    expect(sha(bin)).toBe(sha(file(BIN_PATH)));
  });

  it('rebuilds the committed nav.json and map.json of mirage-cs2 and de_dust2 (and the dust2 radar)', () => {
    for (const map of ['de_mirage', 'de_dust2']) {
      const b = buildMap(map, committedSource(map), { skipGeometry: true });
      expect(staleFiles(b), map).toEqual([]);
    }
  }, 60_000);

  it('reads every CS2 nav field the AI needs (Mirage: 2,544 areas, 6,381 connections, 2 ladders)', () => {
    const n = readCs2NavFile(file('data/source/cs2/de_mirage.nav'));
    expect(n.version).toBe(36);
    expect(n.areas.length).toBe(2544);
    expect(n.areas.reduce((s, a) => s + a.connections.reduce((t, e) => t + e.length, 0), 0)).toBe(6381);
    expect(n.ladders.length).toBe(2);
    expect(crc32(file('data/source/cs2/de_mirage.nav'))).toBe('d93ad855');
  });

  it('dust2: bomb sites from the radar outlines contain the retakes planter spots; spawns are on the nav, out of the sites', () => {
    const { info, nav } = load('de_dust2');
    expect(info.bombsites.map((b) => b.name)).toEqual(['A', 'B']);
    for (const b of info.bombsites) {
      expect(bombsiteAt(info, b.plant)?.name).toBe(b.name);
      expect(nav.isWalkable(b.plant)).toBe(true);
    }
    for (const team of ['T', 'CT'] as const) {
      expect(info.spawns[team].length).toBe(5);
      for (const s of info.spawns[team]) {
        expect(nav.isWalkable(s)).toBe(true);
        expect(bombsiteAt(info, s)).toBeNull();
      }
    }
  });
});

describe('CS2 nav pathfinding (Cs2Nav)', () => {
  it('dust2: paths from both spawns to both sites; every leg but a jump is a straight walk', () => {
    const { info, nav } = load('de_dust2');
    for (const team of ['T', 'CT'] as const) {
      for (const site of info.bombsites) {
        const from = info.spawns[team][0] as Vec3;
        const p = nav.path(from, site.plant);
        expect(p, `${team} → ${site.name}`).not.toBeNull();
        const path = p as Vec3[];
        const len = Cs2Nav.pathLength(path);
        expect(len).toBeGreaterThan(Math.hypot(site.plant.x - from.x, site.plant.y - from.y) - 1);
        expect(len).toBeLessThan(6000);
        for (let i = 1; i < path.length; i++) if (!nav.isJumpPoint(path[i] as Vec3)) expect(nav.segmentWalkable(path[i - 1] as Vec3, path[i] as Vec3), `${team} → ${site.name} leg ${i}`).toBe(true);
        expect(nav.inBombsite(path[path.length - 1] as Vec3)).toBe(true);
      }
    }
  });

  it('Mirage: the CS2 nav and the 2020 grid agree on where the sites and spawns are', () => {
    const { info, nav } = load('mirage-cs2');
    const legacy = legacyMapNav(grid);
    for (const s of info.bombsites) expect(legacy.inBombsite(s.plant), s.name).toBe(true);
    for (const team of ['T', 'CT'] as const) {
      const a = nav.spawnCentre(team) as Vec3;
      const b = legacy.spawnCentre(team) as Vec3;
      expect(Math.hypot(a.x - b.x, a.y - b.y), team).toBeLessThan(700);
    }
    const p = nav.path(info.spawns.T[0] as Vec3, (info.bombsites[1] as MapInfo['bombsites'][number]).plant);
    expect(p).not.toBeNull();
  });

  it('snaps off-mesh points onto the nearest floor and finds a blast escape', () => {
    const { info, nav } = load('de_dust2');
    const site = info.bombsites[0] as MapInfo['bombsites'][number];
    const off = { x: site.plant.x + 5000, y: site.plant.y, z: site.plant.z };
    expect(nav.isWalkable(off)).toBe(false);
    expect(nav.isWalkable(nav.snap(off))).toBe(true);
    const out = nav.escapeSpot(site.plant, site.plant, 1814) as Vec3;
    expect(Math.hypot(out.x - site.plant.x, out.y - site.plant.y, out.z - site.plant.z)).toBeGreaterThanOrEqual(1814);
  });
});
