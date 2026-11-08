/**
 * H3: free play (docs/scenarios.md): a scenario without a recording. Every bot is LIVE from the first tick (after the
 * freeze time) with a role from the scenario or the default plan below; the human may take over any pawn; the round
 * ends by the engine's normal rules (elimination, bomb, defuse, time). No buying (scenario loadouts only).
 *
 * The Session (src/app/session.ts) is built around a recording, so free play hands it:
 * - `freePlayRound`: a synthetic `RoundData` (the ten pawns' start states as one-sample tracks, no events) for the
 *   session's RoundModel, the radar, the HUD and the round clock;
 * - `FreePlayCore`: a Core (a ReplayCore with its script switched off, so its type and the Session's driver logic stay)
 *   whose `step` only sets the round up and keeps the bots LIVE.
 *
 * Default plan (`freePlayPlan`): the Ts go for one bomb site (`rules.site`, else a seeded pick); the c4 carrier plants
 * (`plant`), the other Ts take the site (`take_site`: hold on a ring round the plant spot, then guard the bomb); the
 * CTs split over the sites (`retake`: hold there, go to the bomb when they hear it). docs/ai.md has the roles.
 */
import {
  PLAYER_IDS,
  Rng,
  TICKS_PER_SEC,
  bombsiteAt,
  roundNumber,
  toJsonValue,
  type Act,
  type Action,
  type Control,
  type CoreSnapshot,
  type Goal,
  type MapInfo,
  type Observe,
  type PawnStatus,
  type PlayerId,
  type RoundData,
  type Scenario,
  type ScenarioPlayer,
  type Team,
  type Tuning,
  type Vec3,
  type WeaponId,
} from '../contracts/index';
import type { GrenadeId } from '../contracts/round';
import { ReplayCore } from './replay-core';
import { RoundModel } from './round-model';
import { EventSchedule } from './schedule';

export interface FreePlayPawn {
  readonly id: PlayerId;
  readonly name: string;
  readonly team: Team;
  readonly pos: Vec3;
  readonly yaw: number;
  readonly hp: number;
  readonly armor: number;
  readonly helmet: boolean;
  readonly kit: boolean;
  readonly c4: boolean;
  readonly weapons: readonly { readonly weapon: WeaponId; readonly clip: number; readonly reserve: number }[];
  readonly grenades: readonly GrenadeId[];
  readonly money: number;
  readonly goal: Goal;
}

export interface FreePlayPlan {
  readonly pawns: readonly FreePlayPawn[];
  readonly freezeTicks: number;
  /** The bomb site the Ts go for. */
  readonly site: string;
  /** Every site's plant spot (the CTs head there once the bomb is planted: CS2 announces the plant). */
  readonly sites: readonly { readonly name: string; readonly plant: Vec3 }[];
}

/** How far round a plant spot the default roles hold (units), and the angle step between pawns. */
const HOLD_RING = 160;

function ring(c: Vec3, k: number, n: number, r: number, phase: number): Vec3 {
  const a = ((k / Math.max(1, n)) * 360 + phase) * (Math.PI / 180);
  return { x: roundNumber(c.x + Math.cos(a) * r), y: roundNumber(c.y + Math.sin(a) * r), z: c.z };
}

/** Where a scenario player starts: its `pos`, or its team's spawn number `spawn` from map.json. */
export function startOf(p: ScenarioPlayer, info: MapInfo): { pos: Vec3; yaw: number } {
  if (p.pos !== null) return { pos: p.pos, yaw: p.yaw ?? 0 };
  const list = info.spawns[p.team];
  const s = list[p.spawn ?? 0];
  if (s === undefined) throw new Error(`scenario: ${p.id}: ${info.name} has ${list.length} ${p.team} spawns, no spawn ${String(p.spawn)}`);
  return { pos: { x: s.x, y: s.y, z: s.z }, yaw: p.yaw ?? s.yaw };
}

/** The free-play plan of a scenario on a map (see the module comment). */
export function freePlayPlan(s: Scenario, info: MapInfo): FreePlayPlan {
  if (s.recording !== null) throw new Error('freePlayPlan: the scenario has a recording');
  if (info.bombsites.length === 0) throw new Error(`freePlayPlan: ${info.name} has no bomb sites`);
  const pick = s.rules.site ?? ((info.bombsites[Math.floor(new Rng(s.seed).fork('site').next() * info.bombsites.length)] ?? info.bombsites[0]) as MapInfo['bombsites'][number]).name;
  const target = info.bombsites.find((b) => b.name === pick);
  if (target === undefined) throw new Error(`scenario ${s.name}: no bomb site "${pick}" on ${info.name}`);
  const ts = s.players.filter((p) => p.team === 'T' && !p.c4);
  const cts = s.players.filter((p) => p.team === 'CT');
  const pawns = s.players.map((p): FreePlayPawn => {
    const start = startOf(p, info);
    let goal: Goal;
    if (p.role !== null) goal = { route: [], role: p.role, hold: p.hold };
    else if (p.team === 'T' && p.c4) goal = { route: [], role: 'plant', hold: p.hold ?? target.plant };
    else if (p.team === 'T') goal = { route: [], role: 'take_site', hold: p.hold ?? ring(target.plant, ts.indexOf(p), ts.length, HOLD_RING, 30) };
    else {
      const k = cts.indexOf(p);
      const site = info.bombsites[k % info.bombsites.length] as MapInfo['bombsites'][number];
      const onSite = cts.filter((_, j) => j % info.bombsites.length === k % info.bombsites.length).length;
      goal = { route: [], role: 'retake', hold: p.hold ?? ring(site.plant, Math.floor(k / info.bombsites.length), onSite, HOLD_RING, 0) };
    }
    return { id: p.id, name: p.name, team: p.team, pos: start.pos, yaw: start.yaw, hp: p.hp, armor: p.armor, helmet: p.helmet, kit: p.kit, c4: p.c4, weapons: p.weapons, grenades: p.grenades, money: p.money, goal };
  });
  return { pawns, freezeTicks: Math.round(s.rules.freezeTimeSec * TICKS_PER_SEC), site: target.name, sites: info.bombsites.map((b) => ({ name: b.name, plant: b.plant })) };
}

/** Problems with a scenario on its map: starts or holds in a bomb site of the wrong kind, off the radar, … (validation). */
export function checkScenarioOnMap(s: Scenario, info: MapInfo): string[] {
  const out: string[] = [];
  if (s.recording !== null) return out;
  const plan = freePlayPlan(s, info);
  const half = (info.radar.size * info.radar.scale) / 2;
  const cx = info.radar.posX + half;
  const cy = info.radar.posY - half;
  for (const p of plan.pawns) {
    if (Math.abs(p.pos.x - cx) > half || Math.abs(p.pos.y - cy) > half) out.push(`${p.id}: start (${p.pos.x}, ${p.pos.y}) is off the radar`);
    if (p.team === 'CT' && p.c4) out.push(`${p.id}: a CT with the c4`);
    if (bombsiteAt(info, p.pos) !== null && p.team === 'T' && p.c4) out.push(`${p.id}: starts in a bomb site with the c4`);
  }
  if (s.human !== null && !plan.pawns.some((p) => p.id === s.human)) out.push(`human ${s.human} is not a pawn`);
  return out;
}

const TEAM_COLOR: Readonly<Record<Team, string>> = { T: '#e0a030', CT: '#5a8fd8' };

/** The synthetic recording the Session runs free play on (module comment). */
export function freePlayRound(s: Scenario, plan: FreePlayPlan, info: MapInfo): RoundData {
  const clock0 = s.rules.roundTimeSec + s.rules.freezeTimeSec;
  const players = plan.pawns.map((p) => {
    const guns = p.weapons.map((w) => w.weapon);
    const primary = guns.find((w) => w !== 'glock' && w !== 'deagle') ?? null;
    const secondary = guns.find((w) => w === 'glock' || w === 'deagle') ?? null;
    const drawn = p.weapons[0];
    return {
      id: p.id,
      name: p.name,
      team: p.team,
      color: TEAM_COLOR[p.team],
      chev: '',
      start: { pos: p.pos, yaw: p.yaw, confidence: 'observed' as const },
      startHp: p.hp,
      startArmor: p.armor,
      startHelmet: p.helmet,
      startMoney: p.money,
      kit: { primary, secondary, grenades: p.grenades, c4: p.c4, kit: p.kit, clip: drawn?.clip ?? 0, reserve: drawn?.reserve ?? 0, assumed: false },
      pickups: [],
      role: p.goal.role,
      roles: [p.goal.role],
      isHumanDefault: p.id === s.human,
      deathT: null,
      deathTick: null,
      note: 'free play',
    };
  });
  const tracks: Record<string, RoundData['tracks'][string]> = {};
  const weapon: Record<string, RoundData['timelines']['weapon'][string]> = {};
  const hp: Record<string, RoundData['timelines']['hp'][string]> = {};
  const money: Record<string, RoundData['timelines']['money'][string]> = {};
  for (const p of plan.pawns) {
    tracks[p.id] = { samples: [{ t: 0, tick: 0, x: p.pos.x, y: p.pos.y, z: p.pos.z, confidence: 'observed' }], offGridSamples: [], yaw: [{ t: 0, tick: 0, deg: p.yaw }], view: [], endT: 0, endTick: 0 };
    weapon[p.id] = [{ t: 0, tick: 0, weapon: p.weapons[0]?.weapon ?? 'knife', raw: '' }];
    hp[p.id] = [{ t: 0, tick: 0, value: p.hp }];
    money[p.id] = [{ t: 0, tick: 0, value: p.money }];
  }
  const carrier = plan.pawns.find((p) => p.c4)?.id ?? plan.pawns.find((p) => p.team === 'T')?.id ?? (PLAYER_IDS[0] as PlayerId);
  const end = Math.ceil(clock0 + s.rules.c4TimerSec + 15);
  return {
    meta: {
      clock0,
      bombTimerSec: s.rules.c4TimerSec,
      score: s.rules.score,
      scoreAfter: s.rules.score,
      teams: { CT: 'CT', T: 'T' },
      map: { posx: info.radar.posX, posy: info.radar.posY, scale: info.radar.scale, size: info.radar.size },
      video: '',
      durationSec: end,
      roundEndT: end,
      roundEndTick: end * TICKS_PER_SEC,
      hudRound: s.title,
      ticksPerSec: TICKS_PER_SEC,
      sources: { html: { file: `data/scenarios/${s.name}.json`, sha256: '' }, shotsCsv: { file: '', sha256: '', rows: 0 } },
    },
    players,
    tracks,
    shots: [],
    kills: [],
    damage: [],
    utility: [],
    radio: [],
    chat: [],
    sightings: [],
    lastKnown: [],
    pov: [],
    // No plant is recorded: a "never" plant (after the round) keeps the Core's bomb plan inert.
    bomb: { carrier, plantT: end, plantTick: end * TICKS_PER_SEC, pos: plan.pawns.find((p) => p.id === carrier)?.pos ?? { x: 0, y: 0, z: 0 }, defuseStartT: end, defuseStartTick: end * TICKS_PER_SEC, defuseT: end, defuseTick: end * TICKS_PER_SEC },
    timelines: { hp, money, weapon },
    // The schedule names the defuser from a narrative bomb event at the defuse ticks (also "never").
    events: [{ t: end, tick: end * TICKS_PER_SEC, kind: 'bomb', text: 'free play: nothing recorded', who: plan.pawns.find((p) => p.team === 'CT')?.id ?? carrier, victim: null, util: null }],
  };
}

/** The bots' AI tuning for a difficulty (docs/scenarios.md), and the scenario's c4 timer. `normal` changes nothing. */
export function scenarioTuning(t: Tuning, s: Scenario): Tuning {
  const k = { easy: { react: 1.6, aim: 1.6, hs: 0.2 }, normal: { react: 1, aim: 1, hs: -1 }, hard: { react: 0.8, aim: 0.7, hs: 0.45 }, expert: { react: 0.6, aim: 0.5, hs: 0.55 } }[s.rules.botDifficulty];
  const ai = { ...t.ai, reactionSec: roundNumber(t.ai.reactionSec * k.react), aimErrorDeg: roundNumber(t.ai.aimErrorDeg * k.aim), aimResidualDeg: roundNumber(t.ai.aimResidualDeg * k.aim), headshotAimRatio: k.hs < 0 ? t.ai.headshotAimRatio : k.hs };
  return { ...t, ai, bomb: { ...t.bomb, timerSec: s.rules.c4TimerSec } };
}

interface FreePlayState {
  started: boolean;
  /** The plant was announced (the CTs were sent to its site). */
  planted: boolean;
  startTick: number;
  human: PlayerId | null;
  /** Per pawn (PLAYER_IDS order): mode, trigger, since. */
  modes: { id: PlayerId; mode: PawnStatus['mode']; trigger: string | null; since: number }[];
  paused: boolean;
  speed: number;
}

/** The free-play Core (module comment). */
export class FreePlayCore extends ReplayCore {
  readonly plan: FreePlayPlan;
  private fp: FreePlayState;

  constructor(model: RoundModel, schedule: EventSchedule, tuning: Tuning, seed: number, plan: FreePlayPlan) {
    super(model, schedule, tuning, seed, null, { divergence: false, rejoin: false });
    this.plan = plan;
    this.fp = this.fresh();
  }

  private fresh(): FreePlayState {
    return { started: false, planted: false, startTick: 0, human: null, modes: this.plan.pawns.map((p) => ({ id: p.id, mode: 'REPLAY', trigger: null, since: 0 })), paused: false, speed: 1 };
  }

  override step(o: Observe): Act {
    const s = this.fp;
    const actions: Action[] = [];
    if (!s.started) {
      s.started = true;
      s.startTick = o.tick;
      for (const p of this.plan.pawns) {
        actions.push({ type: 'teleport', id: p.id, pos: p.pos, yaw: p.yaw });
        actions.push({ type: 'set_hp', id: p.id, hp: p.hp, armor: p.armor, helmet: p.helmet });
        for (const w of p.weapons) actions.push({ type: 'give', id: p.id, item: w.weapon, clip: w.clip, reserve: w.reserve });
        for (const g of p.grenades) actions.push({ type: 'give', id: p.id, item: g, clip: 0, reserve: 0 });
        if (p.c4) actions.push({ type: 'give', id: p.id, item: 'c4', clip: 0, reserve: 0 });
        if (p.kit) actions.push({ type: 'give', id: p.id, item: 'defuser', clip: 0, reserve: 0 });
        actions.push({ type: 'set_weapon', id: p.id, weapon: p.weapons[0]?.weapon ?? 'knife' });
      }
      actions.push({ type: 'log', level: 'info', text: `free play: ${this.plan.pawns.length} pawns, Ts go for ${this.plan.site}${this.plan.freezeTicks > 0 ? `, freeze ${this.plan.freezeTicks / TICKS_PER_SEC} s` : ''}` });
    }
    const live = o.tick >= s.startTick + this.plan.freezeTicks;
    const humanChanged = o.human !== s.human;
    for (const m of s.modes) {
      const obs = o.pawns.find((q) => q.id === m.id);
      const pawn = this.plan.pawns.find((q) => q.id === m.id) as FreePlayPawn;
      if (obs === undefined) continue;
      let want: PawnStatus['mode'];
      if (!obs.alive) want = 'DEAD';
      else if (m.id === o.human) want = 'HUMAN';
      else want = live ? 'LIVE' : 'REPLAY';
      if (want === m.mode) {
        // Freeze time: the human can look around but not move.
        if (want === 'HUMAN' && !live && Math.hypot(obs.pos.x - pawn.pos.x, obs.pos.y - pawn.pos.y) > 0.5) actions.push({ type: 'teleport', id: m.id, pos: pawn.pos, yaw: obs.yaw });
        continue;
      }
      if (want === 'LIVE') {
        actions.push({ type: 'set_mode', id: m.id, mode: 'LIVE', goal: pawn.goal });
        m.trigger = m.mode === 'HUMAN' ? 'released' : 'free_play';
      } else if (want === 'HUMAN' || (want === 'REPLAY' && m.mode === 'LIVE')) {
        // The AI lets go of the pawn the human takes (its input drives it from now on).
        actions.push({ type: 'set_mode', id: m.id, mode: 'REPLAY', goal: null });
        m.trigger = null;
      } else m.trigger = null;
      m.mode = want;
      m.since = o.tick;
    }
    if (humanChanged) s.human = o.human;
    // CS2 announces the plant and its site: every LIVE CT retakes there (the beeps then lead it to the bomb).
    const bomb = o.round.bomb;
    if (!s.planted && bomb.state === 'planted' && bomb.pos !== null) {
      s.planted = true;
      const at = bomb.pos;
      let site = this.plan.sites[0];
      for (const q of this.plan.sites) if (site === undefined || Math.hypot(q.plant.x - at.x, q.plant.y - at.y) < Math.hypot(site.plant.x - at.x, site.plant.y - at.y)) site = q;
      if (site !== undefined) {
        for (const m of s.modes) {
          const pawn = this.plan.pawns.find((q) => q.id === m.id) as FreePlayPawn;
          if (m.mode !== 'LIVE' || pawn.team !== 'CT') continue;
          actions.push({ type: 'set_mode', id: m.id, mode: 'LIVE', goal: { route: [], role: 'retake', hold: site.plant } });
          m.trigger = 'bomb_planted';
          m.since = o.tick;
        }
      }
    }
    const status: PawnStatus[] = s.modes.map((m) => ({ id: m.id, mode: m.mode, trigger: m.trigger, sinceTick: m.since }));
    return { inputs: [], actions, status };
  }

  override control(c: Control): void {
    if (c.type === 'start') this.fp = this.fresh();
    else if (c.type === 'pause') this.fp.paused = c.paused;
    else if (c.type === 'speed') this.fp.speed = c.x;
  }

  override checkpointHazards(): string[] {
    return [];
  }

  override snapshot(): CoreSnapshot {
    return { kind: 'core', data: toJsonValue({ freePlay: 1, state: this.fp }) };
  }

  override restore(snap: CoreSnapshot): void {
    if (snap.kind !== 'core') throw new Error('FreePlayCore.restore: not a core snapshot');
    const d = snap.data as unknown as { freePlay?: number; state?: FreePlayState };
    if (d.freePlay !== 1 || d.state === undefined) throw new Error('FreePlayCore.restore: not a free-play snapshot');
    this.fp = JSON.parse(JSON.stringify(d.state)) as FreePlayState;
  }
}

/** Build the free-play Core for a session (the Session's CoreFactory). */
export function freePlayCoreFactory(plan: FreePlayPlan): (p: { model: RoundModel; schedule: EventSchedule; tuning: Tuning; seed: number }) => FreePlayCore {
  return (p) => new FreePlayCore(p.model, p.schedule, p.tuning, p.seed, plan);
}
