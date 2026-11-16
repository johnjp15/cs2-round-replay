/**
 * KM: validate the line-of-sight service against real kills (docs/coach/maps.md "Sight check").
 *
 *   npx tsx tools/coach/los-check.ts [demo.dem] [--map de_mirage] [--json logs/coach/los-check.json]
 *
 * Parses the demo with the native @laihoe/demoparser2 (default: /home/claude/coach-data/demos/test_demo.dem, or
 * local/demos/test_demo.dem), takes every `player_death` by a bullet weapon that is neither `penetrated` (a wallbang)
 * nor `thrusmoke`, and asks `LosWorld.visible` whether the attacker's eye saw any of the victim's body points at the
 * kill tick, using both players' positions, yaw and duck amount from the tick data. Failures are retried at the tick
 * before. It also checks the smoke model: through-smoke kills should cross a smoke the `SmokeField` builds from the
 * demo's detonations, and the visible kills should not be hidden by one.
 *
 * Prints markdown (no player names: the demo is public but names are never committed) and writes the details as JSON.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { LosWorld, SmokeField, BODY_POINTS, type LosTarget, type SmokeDetonation, type Vec3 } from '../../src/coach/derive/los';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEMO_PATHS = ['/home/claude/coach-data/demos/test_demo.dem', resolve(ROOT, 'local/demos/test_demo.dem')];
/** Weapons whose kills are not bullets. */
const NON_BULLET = new Set(['hegrenade', 'inferno', 'molotov', 'incgrenade', 'flashbang', 'smokegrenade', 'decoy', 'world', 'planted_c4', 'c4', 'knife', 'knife_t', 'bayonet', 'taser_none']);

/** The part of @laihoe/demoparser2's API this tool uses. */
export interface DemoParser {
  parseEvents(path: string, events: string[], player?: string[], other?: string[]): Record<string, unknown>[];
  parseTicks(path: string, fields: string[], ticks?: number[] | null): Record<string, unknown>[];
}

export function loadDemoParser(): DemoParser {
  const req = createRequire(import.meta.url);
  return req('@laihoe/demoparser2') as DemoParser;
}

export function loadWorld(map: string): LosWorld {
  const gz = new Uint8Array(readFileSync(resolve(ROOT, `data/coach/maps/${map}/los.bin.gz`)));
  return LosWorld.fromBytes(new Uint8Array(gunzipSync(gz)));
}

export interface PlayerAt extends LosTarget {
  readonly pitch: number;
  readonly place: string;
}

export interface KillCase {
  readonly tick: number;
  readonly round: number;
  readonly weapon: string;
  readonly headshot: boolean;
  readonly thrusmoke: boolean;
  readonly penetrated: boolean;
  readonly attacker: string;
  readonly victim: string;
}

const n = (v: unknown): number => (typeof v === 'number' ? v : NaN);

/** Every tick row of the given ticks, keyed `${tick}:${steamid}`. */
export function playersAt(parser: DemoParser, demo: string, ticks: readonly number[]): Map<string, PlayerAt> {
  const rows = parser.parseTicks(demo, ['X', 'Y', 'Z', 'yaw', 'pitch', 'duck_amount', 'last_place_name'], [...new Set(ticks)].sort((a, b) => a - b));
  const out = new Map<string, PlayerAt>();
  for (const r of rows) out.set(`${n(r['tick'])}:${String(r['steamid'])}`, { x: n(r['X']), y: n(r['Y']), z: n(r['Z']), yaw: n(r['yaw']), pitch: n(r['pitch']), duck: n(r['duck_amount']), place: String(r['last_place_name'] ?? '') });
  return out;
}

export function smokeDetonations(parser: DemoParser, demo: string): SmokeDetonation[] {
  const ev = parser.parseEvents(demo, ['smokegrenade_detonate', 'smokegrenade_expired']);
  const open = new Map<number, { x: number; y: number; z: number; startTick: number }>();
  const out: SmokeDetonation[] = [];
  for (const e of [...ev].sort((a, b) => n(a['tick']) - n(b['tick']))) {
    const id = n(e['entityid']);
    if (e['event_name'] === 'smokegrenade_detonate') open.set(id, { x: n(e['x']), y: n(e['y']), z: n(e['z']), startTick: n(e['tick']) });
    else {
      const d = open.get(id);
      if (d !== undefined) out.push({ ...d, endTick: n(e['tick']) });
      open.delete(id);
    }
  }
  for (const d of open.values()) out.push({ ...d, endTick: null });
  return out;
}

interface Result {
  readonly kill: KillCase;
  readonly a: PlayerAt;
  readonly v: PlayerAt;
  readonly dist: number;
  readonly mask: number;
  readonly maskPrev: number | null;
  readonly smokeBlocked: boolean;
  /** Where the eye → victim-chest segment first meets the mesh (null: clear). */
  readonly blockAt: Vec3 | null;
}

function fmt(p: { x: number; y: number; z: number }): string {
  return `(${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)})`;
}

function main(argv: readonly string[]): void {
  let demo = DEMO_PATHS.find((p) => existsSync(p)) ?? (DEMO_PATHS[0] as string);
  let map = 'de_mirage';
  let jsonOut = resolve(ROOT, 'logs/coach/los-check.json');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--map') map = argv[++i] ?? map;
    else if (a === '--json') jsonOut = resolve(argv[++i] ?? jsonOut);
    else demo = a;
  }
  const parser = loadDemoParser();
  const world = loadWorld(map);
  const deaths = parser.parseEvents(demo, ['player_death'], [], ['total_rounds_played']);
  const kills: KillCase[] = [];
  let skipped = { nonBullet: 0, penetrated: 0, noPlayers: 0 };
  for (const e of deaths) {
    const weapon = String(e['weapon'] ?? '');
    const k: KillCase = { tick: n(e['tick']), round: n(e['total_rounds_played']) + 1, weapon, headshot: e['headshot'] === true, thrusmoke: e['thrusmoke'] === true, penetrated: n(e['penetrated']) > 0, attacker: String(e['attacker_steamid'] ?? ''), victim: String(e['user_steamid'] ?? '') };
    if (NON_BULLET.has(weapon) || weapon.startsWith('knife')) skipped.nonBullet++;
    else if (k.penetrated) skipped.penetrated++;
    else if (k.attacker === '' || k.attacker === 'null' || k.attacker === k.victim) skipped.noPlayers++;
    else kills.push(k);
  }
  kills.sort((a, b) => a.tick - b.tick || (a.victim < b.victim ? -1 : 1));
  const at = playersAt(parser, demo, kills.flatMap((k) => [k.tick, k.tick - 1]));
  const smokes = new SmokeField(world, smokeDetonations(parser, demo));
  const results: Result[] = [];
  for (const k of kills) {
    const a = at.get(`${k.tick}:${k.attacker}`);
    const v = at.get(`${k.tick}:${k.victim}`);
    if (a === undefined || v === undefined) {
      skipped = { ...skipped, noPlayers: skipped.noPlayers + 1 };
      continue;
    }
    const eye = world.eyePosition(a, a.duck);
    const mask = world.visible(eye, v).mask;
    let maskPrev: number | null = null;
    let blockAt: Vec3 | null = null;
    if (mask === 0) {
      const a1 = at.get(`${k.tick - 1}:${k.attacker}`);
      const v1 = at.get(`${k.tick - 1}:${k.victim}`);
      if (a1 !== undefined && v1 !== undefined) maskPrev = world.visible(world.eyePosition(a1, a1.duck), v1).mask;
      const c = world.bodyPoint(v, 1);
      const f = world.geometry.traceSight(eye.x, eye.y, eye.z, c.x, c.y, c.z);
      if (f < 1) blockAt = { x: eye.x + (c.x - eye.x) * f, y: eye.y + (c.y - eye.y) * f, z: eye.z + (c.z - eye.z) * f };
    }
    // Smoke: does any body point the mesh shows sit behind opaque smoke? (all points for through-smoke kills)
    let smokeBlocked = false;
    for (let i = 0; i < BODY_POINTS.length; i++) {
      if (!k.thrusmoke && (mask & (1 << i)) === 0) continue;
      if (smokes.blocks(eye, world.bodyPoint(v, i), k.tick)) {
        smokeBlocked = true;
        break;
      }
    }
    results.push({ kill: k, a, v, dist: Math.hypot(v.x - a.x, v.y - a.y, v.z - a.z), mask, maskPrev, smokeBlocked, blockAt });
  }
  const clean = results.filter((r) => !r.kill.thrusmoke);
  const smoky = results.filter((r) => r.kill.thrusmoke);
  const vis = clean.filter((r) => r.mask !== 0);
  const visPrev = clean.filter((r) => r.mask === 0 && (r.maskPrev ?? 0) !== 0);
  const pct = (x: number, y: number): string => (y === 0 ? '–' : `${((100 * x) / y).toFixed(1)} %`);
  const lines: string[] = [];
  lines.push(`Demo ${demo.split('/').pop()}, map ${map}: ${deaths.length} deaths; ${skipped.nonBullet} not by a bullet, ${skipped.penetrated} wallbangs, ${skipped.noPlayers} without both players, ${smoky.length} through smoke.`);
  lines.push('');
  lines.push('| | kills | visible at the kill tick | visible at the tick before (failures only) |');
  lines.push('| --- | ---: | ---: | ---: |');
  lines.push(`| bullet kills, not wallbang, not through smoke | ${clean.length} | ${vis.length} (${pct(vis.length, clean.length)}) | +${visPrev.length} → ${pct(vis.length + visPrev.length, clean.length)} |`);
  lines.push(`| head point visible | | ${clean.filter((r) => (r.mask & 1) !== 0).length} | |`);
  lines.push(`| through smoke (for the smoke model) | ${smoky.length} | ${smoky.filter((r) => r.mask !== 0).length} by the mesh | |`);
  lines.push('');
  lines.push(`Smoke model: ${smoky.filter((r) => r.smokeBlocked).length} of ${smoky.length} through-smoke kills cross opaque smoke; ${vis.filter((r) => r.smokeBlocked).length} of ${vis.length} visible clean kills would be hidden by smoke (false positives); ${smokes.floods} smokes flooded.`);
  const fails = clean.filter((r) => r.mask === 0);
  if (fails.length > 0) {
    lines.push('');
    lines.push('| round | tick | weapon | attacker (place, feet, duck) | victim (place, feet, duck) | distance | tick − 1 | first block on the eye → chest line |');
    lines.push('| ---: | ---: | --- | --- | --- | ---: | --- | --- |');
    for (const r of fails) {
      lines.push(`| ${r.kill.round} | ${r.kill.tick} | ${r.kill.weapon} | ${r.a.place} ${fmt(r.a)} ${r.a.duck.toFixed(2)} | ${r.v.place} ${fmt(r.v)} ${r.v.duck.toFixed(2)} | ${r.dist.toFixed(0)} | ${r.maskPrev === null ? '–' : r.maskPrev !== 0 ? 'visible' : 'blocked'} | ${r.blockAt === null ? '–' : fmt(r.blockAt)} |`);
    }
  }
  console.log(lines.join('\n'));
  mkdirSync(dirname(jsonOut), { recursive: true });
  // Steam IDs stay in logs/ (gitignored) only.
  writeFileSync(jsonOut, JSON.stringify({ demo, map, skipped, results }, null, 1) + '\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
