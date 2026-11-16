/** KM: the committed map packs (data/coach/maps/, tools/coach/build-map-pack.ts) and sight on the Mirage pack. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { LosWorld } from '../../src/coach/derive/los';
import { PACK_BUDGET, PACK_FORMAT, POOL_MAPS, convexHull, cullMesh, packDir, pngSize, type CoachMapPack } from '../../tools/coach/build-map-pack';

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const file = (p: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../../${p}`, import.meta.url)));
const pack = (map: string): CoachMapPack => JSON.parse(new TextDecoder().decode(file(`${packDir(map)}/pack.json`))) as CoachMapPack;

describe('map packs', () => {
  it.each([...POOL_MAPS])('%s: files match pack.json and fit the budget', (map) => {
    const p = pack(map);
    expect(p.format).toBe(PACK_FORMAT);
    expect(p.map).toBe(map);
    expect(p.fetchBytes).toBeLessThanOrEqual(PACK_BUDGET);
    expect(p.fetchBytes).toBe(p.files.reduce((s, f) => s + f.bytes, 0));
    for (const f of p.files) {
      const b = file(`${packDir(map)}/${f.name}`);
      expect(b.length).toBe(f.bytes);
      expect(sha(b)).toBe(f.sha256);
      if (f.name.endsWith('.gz')) {
        const raw = new Uint8Array(gunzipSync(b));
        expect(raw.length).toBe(f.rawBytes);
        expect(sha(raw)).toBe(f.rawSha256);
      }
    }
    const radar = pngSize(file(`${packDir(map)}/radar.png`));
    expect([radar.width, radar.height]).toEqual([p.radar.width, p.radar.height]);
    expect(p.radar.lowerBelowZ === null).toBe(p.radar.files.lower === null);
    expect(existsSync(new URL(`../../${packDir(map)}/radar_lower.png`, import.meta.url))).toBe(p.radar.files.lower !== null);
  });

  it('two-level maps carry their split', () => {
    expect(pack('de_nuke').radar.lowerBelowZ).toBe(-495);
    expect(pack('de_train').radar.lowerBelowZ).toBe(-50);
    expect(pack('de_vertigo').radar.lowerBelowZ).toBe(11700);
    expect(pack('de_mirage').radar).toMatchObject({ pos_x: -3230, pos_y: 1713, scale: 5, lowerBelowZ: null });
  });

  it('culls only triangles outside the grown hull prism', () => {
    const hull = convexHull([
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
      [50, 50],
    ]);
    expect(hull).toEqual([
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ]);
    // Triangles: inside; just outside x but within the margin; far outside x; inside xy but above the slab; spanning the slab.
    const v = [10, 10, 0, 20, 10, 0, 10, 20, 0, 105, 10, 0, 120, 10, 0, 105, 20, 0, 300, 10, 0, 320, 10, 0, 300, 20, 0, 10, 10, 500, 20, 10, 500, 10, 20, 500, 10, 10, -500, 20, 10, 500, 10, 20, 0];
    const tris = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
    const out = cullMesh({ verts: Float64Array.from(v), tris: Uint32Array.from(tris) }, hull, 10, -100, 300);
    expect([...out.tris]).toEqual([0, 1, 2, 3, 4, 5, 12, 13, 14]);
  });
});

describe('sight on the Mirage pack', () => {
  const w = LosWorld.fromBytes(new Uint8Array(gunzipSync(file(`${packDir('de_mirage')}/los.bin.gz`))));
  it('sees a real B-site kill and not across the map', () => {
    // From the public test demo, round 2 (tick 12308): an AK kill on B site at 165 units.
    const a = { x: -2291.15, y: 488.12, z: -167.97 };
    const v = { x: -2323.9, y: 328.3, z: -167.97, yaw: 70.4, duck: 0 };
    expect(w.visible(w.eyePosition(a, 0), v).mask).not.toBe(0);
    // T spawn to CT spawn: walls and buildings between.
    expect(w.visible(w.eyePosition({ x: 1216, y: -112, z: -165 }, 0), { x: -1696, y: -1976, z: -165, yaw: 0, duck: 0 }).any).toBe(false);
  });
});
