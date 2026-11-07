// Structural checks on data/round.json (the round's facts are checked in tests/round-data.test.ts).
//
//   npx tsx tools/validate-round.ts [data/round.json] [--csv data/source/mirage-round-sp4rtan-1v3-shots.csv]
//
// Exits 1 and prints each problem if any check fails.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCsv } from './extract-round';
import { PLAYER_IDS, WEAPON_IDS, toTick, type RoundData } from '../src/contracts/index';

const CONFIDENCES = ['observed', 'estimated', 'inferred'];

/** Returns a list of problems; empty means valid. csvRows = data rows in the shots CSV, if known. */
export function validateRound(round: RoundData, csvRows?: number): string[] {
  const errs: string[] = [];
  const ids = round.players.map((p) => p.id);

  // players
  const sorted = [...ids].sort();
  if (ids.join() !== sorted.join()) errs.push('players not sorted by id');
  if (sorted.join() !== [...PLAYER_IDS].sort().join()) errs.push(`player ids ${ids.join()} != expected set`);
  const humans = round.players.filter((p) => p.isHumanDefault).map((p) => p.id);
  if (humans.join() !== 'cart') errs.push(`isHumanDefault set for [${humans.join()}], expected [cart]`);

  // tracks
  const trackIds = Object.keys(round.tracks);
  if (trackIds.join() !== [...trackIds].sort().join()) errs.push('tracks not keyed in id order');
  for (const id of ids) {
    const tr = round.tracks[id];
    if (tr === undefined) {
      errs.push(`${id}: no track`);
      continue;
    }
    if (tr.samples.length === 0) errs.push(`${id}: empty track`);
    tr.samples.forEach((s, i) => {
      if (Math.abs(s.t - i / 10) > 1e-9) errs.push(`${id}: sample ${i} at t=${s.t}, expected ${i / 10}`);
      if (!CONFIDENCES.includes(s.confidence)) errs.push(`${id}: bad confidence ${s.confidence} at t=${s.t}`);
      if (s.confidence === 'inferred' && s.uncertainty === undefined && round.players.find((p) => p.id === id)?.team === 'CT')
        errs.push(`${id}: inferred sample without uncertainty at t=${s.t}`);
    });
    for (let i = 1; i < tr.samples.length; i++) {
      const a = tr.samples[i - 1];
      const b = tr.samples[i];
      if (a !== undefined && b !== undefined && !(b.t > a.t)) errs.push(`${id}: samples not strictly increasing at ${b.t}`);
    }
    for (let i = 1; i < tr.yaw.length; i++) {
      const a = tr.yaw[i - 1];
      const b = tr.yaw[i];
      if (a !== undefined && b !== undefined && !(b.t > a.t)) errs.push(`${id}: yaw not strictly increasing at ${b.t}`);
    }
    // V2: fitted views (docs/viewfit.md): only while the camera watches this player, inside the track, by time.
    const pov = round.pov.filter((p) => p.target === id);
    const view = tr.view ?? [];
    view.forEach((v, i) => {
      if (v.tick !== toTick(v.t)) errs.push(`${id}: view ${i} tick ${v.tick} != round(${v.t} * 64)`);
      if (i > 0 && !(v.t > (view[i - 1] as typeof v).t)) errs.push(`${id}: view not strictly increasing at ${v.t}`);
      if (!Number.isFinite(v.yaw) || v.yaw <= -180 || v.yaw > 180) errs.push(`${id}: view yaw ${v.yaw} at ${v.t} outside (-180, 180]`);
      if (v.pitch !== null && (!Number.isFinite(v.pitch) || Math.abs(v.pitch) > 89)) errs.push(`${id}: view pitch ${v.pitch} at ${v.t} outside ±89`);
      if (v.source !== 'video' && v.source !== 'radar') errs.push(`${id}: view source ${String(v.source)} at ${v.t}`);
      if (v.source === 'radar' && v.pitch !== null) errs.push(`${id}: radar view with a pitch at ${v.t}`);
      if (!CONFIDENCES.includes(v.confidence)) errs.push(`${id}: bad view confidence ${v.confidence} at ${v.t}`);
      if (v.confidence === 'inferred' ? v.source !== 'video' : false) errs.push(`${id}: inferred view must be a held video view at ${v.t}`);
      if (v.t > tr.endT + 1e-9) errs.push(`${id}: view at ${v.t} after the track ends (${tr.endT})`);
      // Watched at t; a held (inferred) view may precede its segment by up to 0.6 s.
      const lead = v.confidence === 'inferred' ? 0.6 : 0;
      if (!pov.some((p) => v.t >= p.t0 - lead - 1e-9 && v.t <= p.t1 + 1e-9)) errs.push(`${id}: view at ${v.t} outside every camera segment of ${id}`);
    });
    tr.samples.forEach((s) => {
      if (s.refined !== undefined && s.refined !== 'viewfit') errs.push(`${id}: bad refined tag ${String(s.refined)} at t=${s.t}`);
    });
  }
  for (const id of trackIds) if (!ids.includes(id as (typeof ids)[number])) errs.push(`track ${id} has no player`);

  // shots
  if (csvRows !== undefined && round.shots.length !== csvRows) errs.push(`shots ${round.shots.length} != CSV rows ${csvRows}`);
  if (round.meta.sources.shotsCsv.rows !== round.shots.length) errs.push('meta.sources.shotsCsv.rows != shots.length');

  // ids and weapons everywhere
  const idSet = new Set<string>(PLAYER_IDS);
  const weaponSet = new Set<string>(WEAPON_IDS);
  walk(round, '', (path, key, value, parent) => {
    if (typeof value === 'number' && key === 'tick') {
      const t = parent['t'];
      if (typeof t !== 'number') errs.push(`${path}: tick without numeric t`);
      else if (value !== toTick(t)) errs.push(`${path}: tick ${value} != round(${t}*64)`);
    }
    for (const suffix of ['0', '1']) {
      if (key === `tick${suffix}`) {
        const t = parent[`t${suffix}`];
        if (typeof t !== 'number' || value !== toTick(t)) errs.push(`${path}: ${key} mismatch`);
      }
    }
    if (key === 'tick' && value === null && parent['t'] !== null) errs.push(`${path}: null tick with t`);
    if (/Tick$/.test(key) && typeof value === 'number') {
      const t = parent[key.replace(/Tick$/, 'T')] ?? (key === 'plantTick' ? parent['plantT'] : undefined);
      if (typeof t !== 'number' || value !== toTick(t)) errs.push(`${path}: ${key} mismatch`);
    }
    if (
      typeof value === 'string' &&
      ['killer', 'victim', 'attacker', 'shooter', 'thrower', 'who', 'carrier', 'target', 'assist'].includes(key) &&
      !idSet.has(value)
    )
      errs.push(`${path}: unknown player id ${value}`);
    if (typeof value === 'string' && ['weapon', 'primary', 'secondary'].includes(key) && !weaponSet.has(value))
      errs.push(`${path}: unknown weapon id ${value}`);
  });

  // Lokier's rifle is a scout.
  for (const k of round.kills) if (k.killer === 'lokier' && k.weapon !== 'ssg08') errs.push(`lokier kill with ${k.weapon}`);
  for (const d of round.damage) if (d.attacker === 'lokier' && d.weapon !== 'ssg08') errs.push(`lokier damage with ${d.weapon}`);
  for (const s of round.shots) if (s.shooter === 'lokier' && s.weapon !== 'ssg08') errs.push(`lokier shot with ${s.weapon}`);

  return errs;
}

type Visitor = (path: string, key: string, value: unknown, parent: Record<string, unknown>) => void;

function walk(node: unknown, path: string, visit: Visitor): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, `${path}[${i}]`, visit));
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  // `raw` holds verbatim CSV strings; don't treat them as ids.
  for (const key of Object.keys(obj).sort()) {
    const value = obj[key];
    visit(`${path}.${key}`, key, value, obj);
    if (key !== 'raw') walk(value, `${path}.${key}`, visit);
  }
}

function main(argv: string[]): void {
  const args = argv.slice(2);
  let csvPath = 'data/source/mirage-round-sp4rtan-1v3-shots.csv';
  let roundPath = 'data/round.json';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--csv') csvPath = args[++i] ?? csvPath;
    else roundPath = args[i] as string;
  }
  const round = JSON.parse(readFileSync(roundPath, 'utf8')) as RoundData;
  const csvRows = parseCsv(readFileSync(csvPath, 'utf8')).length - 1;
  const errs = validateRound(round, csvRows);
  if (errs.length > 0) {
    for (const e of errs) console.error(e);
    console.error(`${errs.length} problem(s) in ${roundPath}`);
    process.exit(1);
  }
  console.log(`${roundPath}: OK (${round.players.length} players, ${round.shots.length} shots = CSV rows ${csvRows})`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv);
}
