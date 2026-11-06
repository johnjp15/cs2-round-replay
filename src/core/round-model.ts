/**
 * RoundModel: read-only view of the recorded round for the Core (players sorted by
 * id, their start state, and their 10 Hz tracks). Built from parsed RoundData.
 * See docs/core.md "Round model".
 */
import {
  PLAYER_IDS,
  type Bomb,
  type Confidence,
  type Kit,
  type Pickup,
  type PlayerId,
  type RoundData,
  type RoundMeta,
  type Team,
  type TrackSample,
  type Vec3,
} from '../contracts/index';
import { tOf } from './clock';

export interface ModelPlayer {
  readonly id: PlayerId;
  readonly name: string;
  readonly team: Team;
  readonly startPos: Vec3;
  /** Recorded yaw at t = 0, or null (only eradicate has one). start-state.ts resolves the rest. */
  readonly startYaw: number | null;
  readonly startConfidence: Confidence;
  readonly hp: number;
  readonly armor: number;
  readonly helmet: boolean;
  readonly kit: Kit;
  /** First entry of `roles`. */
  readonly role: string;
  readonly roles: readonly string[];
  readonly pickups: readonly Pickup[];
  /** Kill-feed tick of the death, or null (survived). */
  readonly deathTick: number | null;
  readonly isHumanDefault: boolean;
}

/** A track position at some time, with how certain it is. */
export interface TrackPoint {
  readonly pos: Vec3;
  /** The less certain confidence of the two bracketing samples (the sample's own when t is on one). */
  readonly confidence: Confidence;
  /** The larger uncertainty radius of the bracketing samples that carry one, else null. */
  readonly uncertainty: number | null;
}

const CONFIDENCE_RANK: { readonly [K in Confidence]: number } = { observed: 0, estimated: 1, inferred: 2 };

export class RoundModel {
  readonly meta: RoundMeta;
  readonly bomb: Bomb;
  /** All ten players, sorted by id (PLAYER_IDS order). */
  readonly players: readonly ModelPlayer[];
  /** 10 Hz track samples, parallel to `players`. */
  private readonly samples: readonly (readonly TrackSample[])[];
  /** id -> index into players/samples. Lookup only; never iterated. */
  private readonly index: ReadonlyMap<PlayerId, number>;

  constructor(round: RoundData) {
    const players: ModelPlayer[] = [];
    const samples: (readonly TrackSample[])[] = [];
    const index = new Map<PlayerId, number>();
    for (const id of PLAYER_IDS) {
      const p = round.players.find((q) => q.id === id);
      const track = round.tracks[id];
      if (p === undefined) throw new Error(`RoundModel: no player ${id}`);
      if (track === undefined || track.samples.length === 0) throw new Error(`RoundModel: no track for ${id}`);
      index.set(id, players.length);
      players.push({
        id,
        name: p.name,
        team: p.team,
        startPos: p.start.pos,
        startYaw: p.start.yaw,
        startConfidence: p.start.confidence,
        hp: p.startHp,
        armor: p.startArmor,
        helmet: p.startHelmet,
        kit: p.kit,
        role: p.role,
        roles: p.roles,
        pickups: p.pickups,
        deathTick: p.deathTick,
        isHumanDefault: p.isHumanDefault,
      });
      samples.push(track.samples);
    }
    this.meta = round.meta;
    this.bomb = round.bomb;
    this.players = players;
    this.samples = samples;
    this.index = index;
  }

  player(id: PlayerId): ModelPlayer {
    return this.players[this.indexOf(id)] as ModelPlayer;
  }

  /** The player's 10 Hz samples (t = 0, 0.1, … to the last sample). */
  track(id: PlayerId): readonly TrackSample[] {
    return this.samples[this.indexOf(id)] as readonly TrackSample[];
  }

  /**
   * Position at video time `t`, linearly interpolated between the bracketing 10 Hz
   * samples; null before the first or after the last sample.
   */
  trackAt(id: PlayerId, t: number): TrackPoint | null {
    const s = this.track(id);
    const first = s[0] as TrackSample;
    const last = s[s.length - 1] as TrackSample;
    if (!(t >= first.t) || t > last.t) return null;
    // Largest i with s[i].t <= t (binary search; samples are strictly increasing).
    let lo = 0;
    let hi = s.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if ((s[mid] as TrackSample).t <= t) lo = mid;
      else hi = mid - 1;
    }
    const a = s[lo] as TrackSample;
    if (a.t === t || lo === s.length - 1) return { pos: { x: a.x, y: a.y, z: a.z }, confidence: a.confidence, uncertainty: a.uncertainty ?? null };
    const b = s[lo + 1] as TrackSample;
    const f = (t - a.t) / (b.t - a.t);
    return {
      pos: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f },
      confidence: CONFIDENCE_RANK[b.confidence] > CONFIDENCE_RANK[a.confidence] ? b.confidence : a.confidence,
      uncertainty: maxUncertainty(a, b),
    };
  }

  /** trackAt at a tick (t = tick / 64). */
  trackAtTick(id: PlayerId, tick: number): TrackPoint | null {
    return this.trackAt(id, tOf(tick));
  }

  /** Kill-feed tick of the player's death, or null if they survive the recording. */
  deathTick(id: PlayerId): number | null {
    return this.player(id).deathTick;
  }

  /** Alive at `tick` in the recording (dies on its death tick). */
  isAlive(id: PlayerId, tick: number): boolean {
    const d = this.deathTick(id);
    return d === null || tick < d;
  }

  /** True when the track at `t` is camera/radar-observed (both bracketing samples observed). */
  isObserved(id: PlayerId, t: number): boolean {
    const p = this.trackAt(id, t);
    return p !== null && p.confidence === 'observed';
  }

  private indexOf(id: PlayerId): number {
    const i = this.index.get(id);
    if (i === undefined) throw new Error(`RoundModel: unknown player ${id}`);
    return i;
  }
}

function maxUncertainty(a: TrackSample, b: TrackSample): number | null {
  const ua = a.uncertainty ?? null;
  const ub = b.uncertainty ?? null;
  if (ua === null) return ub;
  if (ub === null) return ua;
  return ua > ub ? ua : ub;
}
