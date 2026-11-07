/**
 * G6: checks of 3D sight on the CS2 mesh (docs/vision.md "Validation").
 *
 *   npx tsx tools/sight-check.ts --log <log.jsonl[.gz]> [--log …]   # every `sees` entry of a session log, re-traced
 *   npx tsx tools/sight-check.ts --recorded [--log <golden log>]    # the recorded engagements at the snapped positions
 *
 * `--log`: every `sees` entry (viewer V → target T, enemies and teammates) on every line is re-traced here, with the aim
 * points computed independently of MeshSight (V's eye at pos.z + eye height, T's head, chest, left and right side at
 * chest height, legs), against the world triangles (`MapGeometry.traceSight`). An entry with every segment blocked is a
 * false sighting: there must be none. It also counts the entries the old eye-to-eye test (C4's mask era, and
 * /tmp/johncase/false-sight.ts) would call blocked, i.e. seen only through another aim point.
 *
 * `--recorded`: each recorded sighting window (`sightings[]`, each T named in `by` → the CT), damage and kill, at every
 * 64 Hz tick of its window (hits: the 4 ticks before the hit and the hit), at the snapped track positions (G3) and,
 * with `--log`, at the positions the engine had in that run: on how many ticks the observer's eye sees the target.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { parseTuning, type LogEntry, type PlayerId, type RoundData, type Tuning, type Vec3 } from '../src/contracts/index';
import { MapGeometry, combineMeshes, decodeGeometry } from '../src/sim2d/geometry';
import { ROOT, loadHarnessData } from './harness';

export function readLog(path: string): LogEntry[] {
  const buf = readFileSync(path);
  const text = path.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as LogEntry);
}

/** The movement mesh as the app builds it (world + player clips; `traceSight` uses the world part only). */
export function loadSightGeometry(root: string = ROOT): MapGeometry {
  const world = decodeGeometry(new Uint8Array(readFileSync(resolve(root, 'data/geometry/mirage-geometry.bin'))));
  const clips = decodeGeometry(new Uint8Array(readFileSync(resolve(root, 'data/geometry/mirage-clips.bin'))));
  return new MapGeometry(combineMeshes(world, clips));
}

interface Body {
  readonly pos: Vec3;
  readonly crouching: boolean;
}

/**
 * Independent re-implementation of the visibility rule (docs/vision.md "Aim points"): V's eye to any of T's head,
 * chest, left, right, legs. Returns the names of the clear points.
 */
export function clearAimPoints(g: MapGeometry, t: Tuning, v: Body, target: Body): string[] {
  const d = t.damage;
  const scale = target.crouching ? d.crouchEyeHeight / d.eyeHeight : 1;
  const ez = v.pos.z + (v.crouching ? d.crouchEyeHeight : d.eyeHeight);
  const dx = target.pos.x - v.pos.x;
  const dy = target.pos.y - v.pos.y;
  const len = Math.hypot(dx, dy);
  const sx = len > 0 ? (-dy / len) * t.ai.sightSideUnits : 0;
  const sy = len > 0 ? (dx / len) * t.ai.sightSideUnits : 0;
  const b = d.bandHeights;
  const chest = target.pos.z + (b['chest'] ?? 48) * scale;
  const pts: [string, number, number, number][] = [
    ['head', target.pos.x, target.pos.y, target.pos.z + (b['head'] ?? 64) * scale],
    ['chest', target.pos.x, target.pos.y, chest],
    ['left', target.pos.x + sx, target.pos.y + sy, chest],
    ['right', target.pos.x - sx, target.pos.y - sy, chest],
    ['leg', target.pos.x, target.pos.y, target.pos.z + (b['leg'] ?? 16) * scale],
  ];
  return pts.filter(([, x, y, z]) => g.traceSight(v.pos.x, v.pos.y, ez, x, y, z) >= 1).map(([n]) => n);
}

export interface SeesCheck {
  /** `sees` entries checked (viewer → target), of them between enemies. */
  readonly entries: number;
  readonly enemyEntries: number;
  /** Entries with every aim point blocked (false sightings; must be 0), as "tick viewer->target". */
  readonly blocked: readonly string[];
  /** Enemy entries whose eye-to-head (= eye-to-eye) segment is blocked: seen through another aim point. */
  readonly enemyEyeBlocked: number;
}

/** Re-trace every `sees` entry of a log (every `stride`-th line). */
export function checkSees(entries: readonly LogEntry[], g: MapGeometry, t: Tuning, stride = 1): SeesCheck {
  let n = 0;
  let enemies = 0;
  let eyeBlocked = 0;
  const blocked: string[] = [];
  for (let k = 0; k < entries.length; k += stride) {
    const o = (entries[k] as LogEntry).observe;
    for (const p of o.pawns) {
      for (const id of p.sees) {
        const q = o.pawns.find((x) => x.id === id);
        if (q === undefined) continue;
        n++;
        const clear = clearAimPoints(g, t, p, q);
        const enemy = p.team !== q.team;
        if (enemy) {
          enemies++;
          if (!clear.includes('head')) eyeBlocked++;
        }
        if (clear.length === 0) blocked.push(`${o.tick} ${p.id}->${id}`);
      }
    }
  }
  return { entries: n, enemyEntries: enemies, blocked, enemyEyeBlocked: eyeBlocked };
}

/** The eye-to-eye rate of the old check (/tmp/johncase/false-sight.ts): enemy entries every 8th tick blocked eye to eye. */
export function eyeToEyeBlockedRate(entries: readonly LogEntry[], g: MapGeometry, t: Tuning): { enemy: number; blocked: number } {
  let enemy = 0;
  let blocked = 0;
  for (const e of entries) {
    const o = e.observe;
    if (o.tick % 8 !== 0) continue;
    for (const p of o.pawns) {
      for (const id of p.sees) {
        const q = o.pawns.find((x) => x.id === id);
        if (q === undefined || q.team === p.team) continue;
        enemy++;
        const eye = (b: Body): number => b.pos.z + (b.crouching ? t.damage.crouchEyeHeight : t.damage.eyeHeight);
        if (g.traceSight(p.pos.x, p.pos.y, eye(p), q.pos.x, q.pos.y, eye(q), true) < 1) blocked++;
      }
    }
  }
  return { enemy, blocked };
}

// ---- recorded engagements ------------------------------------------------------------------------------------------

export interface Engagement {
  readonly label: string;
  readonly from: PlayerId;
  readonly to: PlayerId;
  readonly tick0: number;
  readonly tick1: number;
}

/** The recorded engagements: each sighting (each named T → the CT), each damage entry with an attacker, each kill. */
export function recordedEngagements(round: RoundData): Engagement[] {
  const out: Engagement[] = [];
  const ids = new Set(round.players.map((p) => p.id as string));
  for (const s of round.sightings) {
    const by = s.by
      .split(/[^a-z0-9]+/i)
      .map((x) => x.toLowerCase())
      .filter((x) => ids.has(x));
    for (const b of by) out.push({ label: `sighting ${s.t0}–${s.t1}`, from: b as PlayerId, to: s.who as PlayerId, tick0: s.tick0, tick1: s.tick1 });
  }
  for (const d of round.damage) if (d.attacker !== null) out.push({ label: `damage ${d.t}`, from: d.attacker, to: d.victim, tick0: d.tick - 4, tick1: d.tick });
  for (const k of round.kills) out.push({ label: `kill ${k.t}`, from: k.killer, to: k.victim, tick0: k.tick - 4, tick1: k.tick });
  return out;
}

/** Track position at tick k (linear between 10 Hz samples, clamped at the ends). */
export function trackAt(round: RoundData, id: PlayerId, tick: number): Vec3 | null {
  const s = round.tracks[id]?.samples ?? [];
  if (s.length === 0) return null;
  const first = s[0] as (typeof s)[number];
  if (tick <= first.tick) return { x: first.x, y: first.y, z: first.z };
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1] as (typeof s)[number];
    const b = s[i] as (typeof s)[number];
    if (tick <= b.tick) {
      const f = (tick - a.tick) / (b.tick - a.tick);
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
    }
  }
  const last = s[s.length - 1] as (typeof s)[number];
  return { x: last.x, y: last.y, z: last.z };
}

export interface EngagementCheck {
  readonly e: Engagement;
  readonly ticks: number;
  /** Ticks on which `from`'s eye sees `to` at the snapped track positions (both standing). */
  readonly snapped: number;
  /** The same at the engine positions of a run (both alive), or null without a log. */
  readonly engine: number | null;
  /** First engine tick with sight, or null. */
  readonly firstEngine: number | null;
}

export function checkEngagements(round: RoundData, g: MapGeometry, t: Tuning, entries: readonly LogEntry[] | null): EngagementCheck[] {
  return recordedEngagements(round).map((e) => {
    let snapped = 0;
    let engine = 0;
    let first: number | null = null;
    for (let k = e.tick0; k <= e.tick1; k++) {
      const a = trackAt(round, e.from, k);
      const b = trackAt(round, e.to, k);
      if (a !== null && b !== null && clearAimPoints(g, t, { pos: a, crouching: false }, { pos: b, crouching: false }).length > 0) snapped++;
      const o = entries?.[k]?.observe;
      const pa = o?.pawns.find((p) => p.id === e.from);
      const pb = o?.pawns.find((p) => p.id === e.to);
      if (pa !== undefined && pb !== undefined && pa.alive && pb.alive && clearAimPoints(g, t, pa, pb).length > 0) {
        engine++;
        first ??= k;
      }
    }
    return { e, ticks: e.tick1 - e.tick0 + 1, snapped, engine: entries === null ? null : engine, firstEngine: first };
  });
}

function main(): void {
  const args = process.argv.slice(2);
  const logs: string[] = [];
  let recorded = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--log') logs.push(args[++i] as string);
    else if (args[i] === '--recorded') recorded = true;
    else throw new Error(`unknown option ${String(args[i])} (--log <path>, --recorded)`);
  }
  const g = loadSightGeometry();
  const tuning = parseTuning(readFileSync(resolve(ROOT, 'data/tuning.json'), 'utf8'));
  if (recorded) {
    const data = loadHarnessData();
    const entries = logs.length > 0 ? readLog(logs[0] as string) : null;
    console.log('| engagement | observer → target | ticks | sight at the snapped positions | sight in the run | first tick in the run |');
    console.log('| --- | --- | ---: | ---: | ---: | ---: |');
    for (const c of checkEngagements(data.round, g, tuning, entries)) {
      console.log(`| ${c.e.label} | ${c.e.from} → ${c.e.to} | ${c.ticks} | ${c.snapped} | ${c.engine ?? '–'} | ${c.firstEngine ?? '–'} |`);
    }
    return;
  }
  for (const path of logs) {
    const entries = readLog(path);
    const c = checkSees(entries, g, tuning);
    const old = eyeToEyeBlockedRate(entries, g, tuning);
    console.log(
      `${path}: ${entries.length} lines, ${c.entries} sees entries (${c.enemyEntries} enemy); every aim point blocked: ${c.blocked.length}` +
        `${c.blocked.length > 0 ? ` (${c.blocked.slice(0, 8).join(', ')}${c.blocked.length > 8 ? ', …' : ''})` : ''}; ` +
        `enemy entries seen only past the eye line: ${c.enemyEyeBlocked}; eye to eye, every 8th tick: ${old.blocked} of ${old.enemy} enemy entries blocked` +
        ` (${old.enemy === 0 ? '0.0' : ((100 * old.blocked) / old.enemy).toFixed(1)} %)`,
    );
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
