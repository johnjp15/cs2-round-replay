/** H1: the 3D page's world mesh (src/app3d/world-mesh.ts): every triangle once, classified and coloured from the radar. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIRAGE_RADAR } from '../src/app3d/coords';
import { FLOOR_SAND, RadarSampler, buildWorldTiles, floorArt } from '../src/app3d/world-mesh';
import { worldMesh } from '../src/sim3d/index';
import { decodePngRgba } from '../tools/extract-geometry';
import { ROOT } from '../tools/harness';

const g = worldMesh(new Uint8Array(readFileSync(resolve(ROOT, 'data/geometry/mirage-geometry.bin'))));
const png = decodePngRgba(new Uint8Array(readFileSync(resolve(ROOT, 'data/source/cs2/de_mirage.png'))));
const radar = { width: png.width, height: png.height, data: png.rgba };

describe('world mesh (H1)', () => {
  const art = floorArt(radar);
  const { tiles, stats } = buildWorldTiles(g, new RadarSampler(art, MIRAGE_RADAR), MIRAGE_RADAR, radar);

  it('keeps every triangle exactly once', () => {
    const n = tiles.reduce((a, t) => a + t.floor.triangles + t.plain.triangles, 0);
    expect(n).toBe(g.triangleCount);
    expect(stats.floors + stats.indoorFloors + stats.walls + stats.undersides).toBe(g.triangleCount);
    for (const t of tiles) {
      expect(t.floor.positions.length).toBe(t.floor.triangles * 9);
      expect(t.floor.uvs.length).toBe(t.floor.triangles * 6);
      expect(t.plain.colors.length).toBe(t.plain.triangles * 9);
      // UVs from the radar transform; a vertex of a floor whose centre is on the radar may lie a little off it (clamped).
      for (const v of t.floor.uvs) expect(v > -0.1 && v < 1.1).toBe(true);
    }
    console.log(JSON.stringify(stats));
  });

  it('the floor art is sand outside the playable area and sand-toned inside', () => {
    expect([art.data[0], art.data[1], art.data[2], art.data[3]]).toEqual(FLOOR_SAND.map((c) => Math.round(c * 255)).concat(255));
    // B site (radar ~ (230, 140) px): warm, red ≥ blue.
    const o = (140 * 1024 + 230) * 4;
    expect((art.data[o] as number) >= (art.data[o + 2] as number)).toBe(true);
  });
});
