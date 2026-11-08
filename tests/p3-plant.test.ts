/**
 * P3: the C4 lies where barely's POV shows it (docs/round-data.md "The plant spot"), inside the 2020 BSP's B target,
 * and sp4rtan kit-defuses it out of cart's sight (the video: cart sprays into the cylinder stack, 65.0-66.8 s).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { bombsiteAt, mapPackagePaths, parseMapInfo, parseRound, parseTuning, type MapId, type PlayerId, type RoundData, type Vec3 } from "../src/contracts/index";
import { applyTracks3d, type Tracks3d } from "../src/contracts/tracks3d";
import { MapGeometry, combineMeshes, decodeGeometry } from "../src/sim2d/geometry";
import { MeshSight, meshSightOptionsFromTuning } from "../src/sim2d/mesh-sight";
import { bombTargetFor } from "../tools/build-map";

const ROOT = resolve(__dirname, "..");
const read = (p: string): string => readFileSync(resolve(ROOT, p), "utf8");
const round = parseRound(JSON.parse(read("data/round.json")));
const tuning = parseTuning(JSON.parse(read("data/tuning.json")));
const info = parseMapInfo(JSON.parse(read("data/maps/mirage-cs2/map.json")));
const bsp = JSON.parse(read("data/maps/mirage-2020/manifest.json")) as {
  entities: { bombTargets: { name: string; min: [number, number, number]; max: [number, number, number] }[] };
};

function snapped(map: MapId): RoundData {
  return applyTracks3d(round, JSON.parse(read(mapPackagePaths(map).tracks)) as Tracks3d);
}

function at(r: RoundData, id: PlayerId, t: number): Vec3 {
  const s = r.tracks[id]?.samples.find((q) => Math.abs(q.t - t) < 1e-6);
  if (s === undefined) throw new Error(`${id} has no sample at ${t}`);
  return { x: s.x, y: s.y, z: s.z };
}

describe("P3: the plant spot", () => {
  it("is inside the BSP's B target, and the bomb sites come from the BSP", () => {
    const b = bombTargetFor(bsp.entities.bombTargets, "B");
    if (b === null) throw new Error("no B target");
    expect(b.name).toBe("B site");
    expect(bombTargetFor(bsp.entities.bombTargets, "A")?.name).toBe("A site");
    const p = round.bomb.pos;
    expect(p).toEqual({ x: -1882, y: 243, z: -160 });
    expect(p.x >= b.min[0] && p.x <= b.max[0] && p.y >= b.min[1] && p.y <= b.max[1]).toBe(true);
    // map.json: the target box grown by the 16-unit half hull, origin z from (bottom - 72) to the top.
    const site = info.bombsites.find((s) => s.name === "B");
    if (site === undefined) throw new Error("no B site in map.json");
    expect(site.rects).toEqual([{ x1: b.min[0] - 16, y1: b.min[1] - 16, x2: b.max[0] + 16, y2: b.max[1] + 16 }]);
    expect([site.z1, site.z2]).toEqual([b.min[2] - 72, b.max[2]]);
    expect(bombsiteAt(info, p)?.name).toBe("B");
  });

  it("barely stands on it while planting (the C4 drops at the planter's feet)", () => {
    for (let t = 24.2; t <= 27.4 + 1e-6; t += 0.1) {
      const q = at(round, "barely", Math.round(t * 10) / 10);
      expect([q.x, q.y]).toEqual([round.bomb.pos.x, round.bomb.pos.y]);
    }
  });

  for (const map of ["mirage-cs2", "mirage-2020"] as const) {
    it(`${map}: cart can't see sp4rtan defusing beside it (65.0-66.8 s), and sp4rtan is in defuse range`, () => {
      const p = mapPackagePaths(map);
      const g = new MapGeometry(combineMeshes(decodeGeometry(new Uint8Array(readFileSync(resolve(ROOT, p.geometry)))), decodeGeometry(new Uint8Array(readFileSync(resolve(ROOT, p.clips))))));
      const sight = new MeshSight(g, meshSightOptionsFromTuning(tuning));
      const r = snapped(map);
      let seen = 0;
      for (let k = 650; k <= 668; k++) {
        const t = k / 10;
        const cart = at(r, "cart", t);
        const sp = at(r, "sp4rtan", t);
        expect(Math.hypot(sp.x - round.bomb.pos.x, sp.y - round.bomb.pos.y)).toBeLessThanOrEqual(tuning.bomb.defuseRange);
        for (const crouching of [false, true]) if (sight.visible({ pos: cart, crouching: false }, { pos: sp, crouching })) seen++;
      }
      expect(seen).toBe(0);
    });
  }
});
