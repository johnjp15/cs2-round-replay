/**
 * KM: line-of-sight benchmark on realistic player pairs (docs/coach/maps.md "Benchmark").
 *
 *   npx tsx tools/coach/bench-los.ts [demo.dem] [--map de_mirage] [--every 16] [--seconds 3]
 *
 * Samples the demo every `--every` ticks, takes every pair of living players on opposite teams (both directions),
 * and times `LosWorld.visible` (eye to the seven body points, no early exit) and the bare segment test over those
 * pairs. Also checks the pack's culled, 1/2-unit sight mesh against the sims' full Mirage mesh
 * (data/geometry/mirage-geometry.bin) on the same segments: they should agree on (nearly) every one.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BODY_POINTS, type LosTarget, type Vec3 } from '../../src/coach/derive/los';
import { MapGeometry } from '../../src/sim2d/geometry';
import { loadDemoParser, loadWorld } from './los-check';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const now = (): number => performance.now();

function main(argv: readonly string[]): void {
  let demo = '/home/claude/coach-data/demos/test_demo.dem';
  let map = 'de_mirage';
  let every = 16;
  let seconds = 3;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--map') map = argv[++i] ?? map;
    else if (a === '--every') every = Number(argv[++i]);
    else if (a === '--seconds') seconds = Number(argv[++i]);
    else demo = a;
  }
  const parser = loadDemoParser();
  const t0 = now();
  const world = loadWorld(map);
  const loadMs = now() - t0;
  const freeze = parser.parseEvents(demo, ['round_freeze_end', 'round_end']);
  // Live windows: freeze end → round end.
  const windows: [number, number][] = [];
  let start: number | null = null;
  for (const e of [...freeze].sort((a, b) => (a['tick'] as number) - (b['tick'] as number))) {
    if (e['event_name'] === 'round_freeze_end') start = e['tick'] as number;
    else if (start !== null) {
      windows.push([start, e['tick'] as number]);
      start = null;
    }
  }
  const ticks: number[] = [];
  for (const [a, b] of windows) for (let t = a; t < b; t += every) ticks.push(t);
  const rows = parser.parseTicks(demo, ['X', 'Y', 'Z', 'yaw', 'duck_amount', 'is_alive', 'team_num'], ticks);
  const byTick = new Map<number, { p: LosTarget; team: number }[]>();
  for (const r of rows) {
    if (r['is_alive'] !== true || typeof r['X'] !== 'number') continue;
    const t = r['tick'] as number;
    const list = byTick.get(t) ?? [];
    list.push({ p: { x: r['X'] as number, y: r['Y'] as number, z: r['Z'] as number, yaw: r['yaw'] as number, duck: (r['duck_amount'] as number) ?? 0 }, team: r['team_num'] as number });
    byTick.set(t, list);
  }
  const eyes: Vec3[] = [];
  const targets: LosTarget[] = [];
  for (const t of [...byTick.keys()].sort((a, b) => a - b)) {
    const list = byTick.get(t) ?? [];
    for (const a of list) for (const b of list) if (a.team !== b.team) {
      eyes.push(world.eyePosition(a.p, a.p.duck));
      targets.push(b.p);
    }
  }
  const pairs = eyes.length;
  // Segments (eye → each body point) for the bare test and the comparison.
  const segs = new Float64Array(pairs * BODY_POINTS.length * 6);
  let len = 0;
  for (let i = 0; i < pairs; i++) {
    const e = eyes[i] as Vec3;
    for (let k = 0; k < BODY_POINTS.length; k++) {
      const b = world.bodyPoint(targets[i] as LosTarget, k);
      segs.set([e.x, e.y, e.z, b.x, b.y, b.z], (i * BODY_POINTS.length + k) * 6);
      len += Math.hypot(b.x - e.x, b.y - e.y, b.z - e.z);
    }
  }
  const nseg = pairs * BODY_POINTS.length;
  const g = world.geometry;
  // Warm up, then time whole passes for at least `seconds`.
  const bare = (): number => {
    let clear = 0;
    for (let s = 0; s < nseg; s++) {
      const o = s * 6;
      if (!g.sightBlocked(segs[o] as number, segs[o + 1] as number, segs[o + 2] as number, segs[o + 3] as number, segs[o + 4] as number, segs[o + 5] as number)) clear++;
    }
    return clear;
  };
  const vis = (): number => {
    let any = 0;
    for (let i = 0; i < pairs; i++) if (world.visible(eyes[i] as Vec3, targets[i] as LosTarget).any) any++;
    return any;
  };
  const time = (f: () => number, count = nseg): { perSec: number; result: number; runs: number } => {
    f();
    let runs = 0;
    let result = 0;
    const s0 = now();
    while (now() - s0 < seconds * 1000) {
      result = f();
      runs++;
    }
    return { perSec: (runs * count) / ((now() - s0) / 1000), result, runs };
  };
  const b = time(bare);
  const v = time(vis);
  // The clear segments alone: the slow case (the trace walks the whole line).
  const clearIdx: number[] = [];
  for (let s = 0; s < nseg; s++) {
    const o = s * 6;
    if (!g.sightBlocked(segs[o] as number, segs[o + 1] as number, segs[o + 2] as number, segs[o + 3] as number, segs[o + 4] as number, segs[o + 5] as number)) clearIdx.push(s);
  }
  let clearLen = 0;
  for (const s of clearIdx) clearLen += Math.hypot((segs[s * 6 + 3] as number) - (segs[s * 6] as number), (segs[s * 6 + 4] as number) - (segs[s * 6 + 1] as number), (segs[s * 6 + 5] as number) - (segs[s * 6 + 2] as number));
  const c = time(() => {
    let k = 0;
    for (const s of clearIdx) {
      const o = s * 6;
      if (!g.sightBlocked(segs[o] as number, segs[o + 1] as number, segs[o + 2] as number, segs[o + 3] as number, segs[o + 4] as number, segs[o + 5] as number)) k++;
    }
    return k;
  }, clearIdx.length);
  // Agreement with the sims' full Mirage mesh (quant 8, not culled).
  let agree = -1;
  if (map === 'de_mirage') {
    const full = MapGeometry.fromBytes(new Uint8Array(readFileSync(resolve(ROOT, 'data/geometry/mirage-geometry.bin'))));
    agree = 0;
    for (let s = 0; s < nseg; s++) {
      const o = s * 6;
      const p = [segs[o], segs[o + 1], segs[o + 2], segs[o + 3], segs[o + 4], segs[o + 5]] as [number, number, number, number, number, number];
      if (g.sightBlocked(...p) === full.sightBlocked(...p)) agree++;
    }
  }
  console.log(`map ${map}: ${g.triangleCount} triangles, decode + broad phase ${loadMs.toFixed(0)} ms; ${byTick.size} ticks (every ${every}), ${pairs} enemy pairs, ${nseg} segments, mean ${(len / nseg).toFixed(0)} units; ${b.result} clear (${((100 * b.result) / nseg).toFixed(1)} %), ${v.result} pairs see some point`);
  console.log(`segment tests (sightBlocked): ${Math.round(b.perSec).toLocaleString('en-US')} per second (${b.runs} passes)`);
  console.log(`visible() (7 points, no early exit): ${Math.round(v.perSec).toLocaleString('en-US')} segment tests per second, ${Math.round(v.perSec / BODY_POINTS.length).toLocaleString('en-US')} pair queries per second`);
  console.log(`clear segments only (${clearIdx.length}, mean ${(clearLen / Math.max(1, clearIdx.length)).toFixed(0)} units): ${Math.round(c.perSec).toLocaleString('en-US')} per second`);
  if (agree >= 0) console.log(`agreement with data/geometry/mirage-geometry.bin: ${agree} of ${nseg} segments (${((100 * agree) / nseg).toFixed(3)} %)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
