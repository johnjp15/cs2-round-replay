/**
 * G3: the recorded tracks snapped onto CS2 Mirage (data/geometry/mirage-tracks.json, built by tools/snap-tracks.ts;
 * docs/geometry.md "Track snapping"), and `applyTracks3d`, which puts them into the round data.
 *
 * The recording's positions come from a 2020 video and its heights from the 2020 nav: a fifth of them are inside
 * walls, props or the Truck on CS2's Mirage, and stairs are off by up to 27 units in z. An engine that moves pawns
 * in 3D (the 2D sim with geometry, CS2) needs positions a player can stand at, so the app applies the snapped
 * positions to the round before building the Core: puppets follow them, start there, and divergence and the summary
 * measure against them. The take-off samples of jumps get `TrackSample.jump`.
 *
 * Pure data, no I/O (portable style).
 */
import { PLAYER_IDS, isPlayerId, type PlayerId } from './types';
import type { RoundData, Track, TrackSample } from './round';

export const TRACKS3D_FORMAT = 'cs2-round-replay/tracks3d@1';

/** A jump take-off: the sample at `t` / `tick` of player `id`'s track; `crouch` = a crouch jump. */
export interface Tracks3dJump {
  readonly id: PlayerId;
  readonly t: number;
  readonly tick: number;
  readonly crouch: boolean;
}

export interface Tracks3d {
  readonly format: string;
  readonly note: string;
  readonly sources: readonly { readonly file: string; readonly sha256: string }[];
  readonly params: Readonly<Record<string, number>>;
  readonly stats: Readonly<Record<string, number>>;
  /** Per player, one [x, y, z] per sample of `round.tracks[id].samples`, in order. */
  readonly tracks: Readonly<Partial<Record<PlayerId, readonly (readonly number[])[]>>>;
  readonly jumps: readonly Tracks3dJump[];
}

export class Tracks3dError extends Error {
  constructor(message: string) {
    super(`tracks3d: ${message}`);
    this.name = 'Tracks3dError';
  }
}

/** Validate parsed data/geometry/mirage-tracks.json (or its text). */
export function parseTracks3d(json: unknown): Tracks3d {
  const v = typeof json === 'string' ? (JSON.parse(json) as unknown) : json;
  if (typeof v !== 'object' || v === null) throw new Tracks3dError('expected an object');
  const o = v as Record<string, unknown>;
  if (o['format'] !== TRACKS3D_FORMAT) throw new Tracks3dError(`format must be ${TRACKS3D_FORMAT}`);
  const tracks = o['tracks'];
  if (typeof tracks !== 'object' || tracks === null) throw new Tracks3dError('tracks: expected an object');
  for (const [id, rows] of Object.entries(tracks as Record<string, unknown>)) {
    if (!isPlayerId(id)) throw new Tracks3dError(`tracks: unknown player ${id}`);
    if (!Array.isArray(rows)) throw new Tracks3dError(`tracks.${id}: expected an array`);
    rows.forEach((r: unknown, i) => {
      if (!Array.isArray(r) || r.length !== 3 || !r.every((n) => typeof n === 'number' && Number.isFinite(n))) throw new Tracks3dError(`tracks.${id}[${i}]: expected [x, y, z]`);
    });
  }
  const jumps = o['jumps'];
  if (!Array.isArray(jumps)) throw new Tracks3dError('jumps: expected an array');
  jumps.forEach((j: unknown, i) => {
    const r = j as Record<string, unknown>;
    const id = typeof j === 'object' && j !== null ? r['id'] : null;
    if (typeof id !== 'string' || !isPlayerId(id) || typeof r['t'] !== 'number' || !Number.isInteger(r['tick']) || typeof r['crouch'] !== 'boolean') {
      throw new Tracks3dError(`jumps[${i}]: expected {id, t, tick, crouch}`);
    }
  });
  return o as unknown as Tracks3d;
}

/**
 * The round with every snapped track's sample positions replaced (t, tick, confidence and the rest kept), the jump
 * take-offs marked, and each player's start position moved with its track's first sample when it is that sample. Throws if a snapped track's length doesn't match the round's (the file is stale: rerun
 * tools/snap-tracks.ts) or a jump names no sample.
 */
export function applyTracks3d(round: RoundData, t: Tracks3d): RoundData {
  const out: Partial<Record<PlayerId, Track>> = {};
  for (const id of PLAYER_IDS) {
    const tr = round.tracks[id];
    if (tr === undefined) continue;
    const rows = t.tracks[id];
    if (rows === undefined) {
      out[id] = tr;
      continue;
    }
    if (rows.length !== tr.samples.length) throw new Tracks3dError(`tracks.${id}: ${rows.length} samples, the round has ${tr.samples.length}`);
    const samples: TrackSample[] = tr.samples.map((s, i) => {
      const r = rows[i] as readonly number[];
      const jump = t.jumps.find((j) => j.id === id && j.tick === s.tick);
      const next: TrackSample = { ...s, x: r[0] as number, y: r[1] as number, z: r[2] as number };
      return jump === undefined ? next : { ...next, jump: jump.crouch ? 'crouch' : 'plain' };
    });
    out[id] = { ...tr, samples };
  }
  for (const j of t.jumps) {
    if (!(round.tracks[j.id]?.samples.some((s) => s.tick === j.tick) ?? false)) throw new Tracks3dError(`jump ${j.id} @ ${j.tick}: no such sample`);
  }
  // A start position that is the track's first sample (all ten in this round) moves with it.
  const players = round.players.map((p) => {
    const raw = round.tracks[p.id]?.samples[0];
    const snapped = out[p.id]?.samples[0];
    if (raw === undefined || snapped === undefined || raw.t !== 0 || raw.x !== p.start.pos.x || raw.y !== p.start.pos.y || raw.z !== p.start.pos.z) return p;
    return { ...p, start: { ...p.start, pos: { x: snapped.x, y: snapped.y, z: snapped.z } } };
  });
  return { ...round, players, tracks: out as RoundData['tracks'] };
}
