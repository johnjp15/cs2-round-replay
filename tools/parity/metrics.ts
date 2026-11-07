/**
 * V0 video parity: the comparisons (pure, no I/O). The video's ground truth (tools/parity/video_truth.py) against
 * the sim's state at the same moment, per timestamp and per player, plus the 60 fps events. docs/parity.md.
 */

export const TICKS_PER_SEC = 64;
export const VIDEO_FPS = 60;

/** Pass/fail thresholds (docs/parity.md "Thresholds"). */
export const THRESHOLDS = {
  /** Radar dot error for a player the video shows (T dots and spotted CTs), world units. */
  observedUnits: 40,
  /** Kill-feed, plant and round-end timing, ticks. */
  eventTicks: 2,
  /** Digit reads below this template score are reported as unread, not compared. */
  ocrScore: 0.8,
} as const;

export const T_IDS = ['barely', 'cart', 'donk', 'eradicate', 'snarlbot'] as const;
export const PLAYER_ORDER = ['barely', 'cart', 'donk', 'eradicate', 'incredibad', 'lokier', 'snakelore', 'snarlbot', 'sp4rtan', 'zwomp'] as const;
export const COLOUR: Record<string, string> = {
  barely: 'yellow', cart: 'orange', donk: 'purple', eradicate: 'blue', snarlbot: 'green',
  incredibad: 'red', lokier: 'red', snakelore: 'red', sp4rtan: 'red', zwomp: 'red',
};

// ---- inputs ------------------------------------------------------------------------------------------------------

export interface TruthDot {
  readonly colour: string;
  readonly x: number;
  readonly y: number;
  readonly area: number;
  readonly px: readonly number[];
  readonly id: string | null;
  readonly role: 'dot' | 'marker' | 'extra';
}

export interface TruthRead {
  readonly value: string | null;
  readonly score: number;
}

export interface TruthTime {
  readonly t: number;
  readonly frame: number;
  readonly frameT: number;
  readonly layout: 'pov' | 'deathcam' | 'spectator';
  readonly radar: { readonly dots: readonly TruthDot[]; readonly kind: string; readonly bomb?: { x: number; y: number } };
  readonly hud: {
    readonly hp: TruthRead;
    readonly armor: TruthRead;
    readonly clip: TruthRead;
    readonly reserve: TruthRead;
    readonly clock: TruthRead & { readonly bombIcon: boolean };
  };
}

export interface Truth {
  readonly specCc: number;
  readonly povZoom: number;
  readonly povRotOffsetDeg: number;
  readonly povCalDots: number;
  readonly events: {
    readonly killFeed: readonly { frame: number; t: number; victim: string }[];
    readonly bombIconT: number | null;
    readonly scoreChangeT: number | null;
  };
  readonly times: readonly TruthTime[];
}

/** The parts of data/round.json used here. */
export interface RoundLite {
  readonly players: readonly { id: string; team: 'T' | 'CT'; deathT: number | null }[];
  readonly kills: readonly { t: number; tick: number; killer: string; victim: string; postRound: boolean }[];
  readonly bomb: { plantT: number; plantTick: number; defuseStartT: number; defuseT: number; defuseTick: number };
  readonly pov: readonly { t0: number; t1: number; target: string; note: string }[];
  readonly shots: readonly { t: number | null }[];
  readonly tracks: Record<string, { samples: readonly { t: number; x: number; y: number; confidence: string; uncertainty?: number }[] }>;
  readonly meta: { clock0: number };
}

/** One pawn of the sim at a tick (from the session log's observe). */
export interface SimPawn {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly yaw: number;
  readonly hp: number;
  readonly armor: number;
  readonly alive: boolean;
  readonly weapon: string;
  readonly clip: number;
  readonly reserve: number;
}

export interface SimFrame {
  readonly tick: number;
  readonly pawns: readonly SimPawn[];
  /** The HUD clock the 2D app shows (hud-model clockView: m:ss, then the bomb timer). */
  readonly clockText: string;
  readonly bombState: string;
}

export interface SimEvents {
  readonly deaths: readonly { tick: number; victim: string; attacker: string | null }[];
  readonly plantTick: number | null;
  readonly roundEndTick: number | null;
  readonly roundEndText: string | null;
}

// ---- timestamps --------------------------------------------------------------------------------------------------

/** "every 0.5" or a comma list; plus (with `events`) every kill, the plant, the defuse start and end and every timed shot. */
export function buildTimes(spec: string, round: RoundLite, events: boolean, end = 70.0): number[] {
  const set = new Set<number>();
  const add = (t: number): void => {
    if (t >= 0 && t <= end) set.add(Math.round(t * 1000) / 1000);
  };
  const m = /^every\s+([0-9.]+)$/.exec(spec.trim());
  if (m !== null) {
    const step = Number(m[1]);
    if (!(step > 0)) throw new Error(`--times: bad step in "${spec}"`);
    for (let i = 0; i * step <= end + 1e-9; i++) add(i * step);
  } else {
    for (const s of spec.split(',')) {
      const v = Number(s.trim());
      if (!Number.isFinite(v)) throw new Error(`--times: "${s}" is not a number`);
      add(v);
    }
  }
  if (events) {
    for (const k of round.kills) add(k.t);
    add(round.bomb.plantT);
    add(round.bomb.defuseStartT);
    add(round.bomb.defuseT);
    for (const s of round.shots) if (s.t !== null) add(s.t);
  }
  return [...set].sort((a, b) => a - b);
}

export const tickOfT = (t: number): number => Math.round(t * TICKS_PER_SEC);

/** Who the video's camera shows at t (the breakdown's camera schedule = round.json pov), or null (death cam, next round). */
export function watchedAt(round: RoundLite, t: number): string | null {
  for (const s of round.pov) {
    if (t >= s.t0 && t < s.t1) return s.note === '' || s.note.startsWith('own') ? s.target : null;
  }
  return null;
}

function trackAt(round: RoundLite, id: string, t: number): { x: number; y: number; confidence: string; uncertainty: number | null } | null {
  const s = round.tracks[id]?.samples;
  if (s === undefined || s.length === 0) return null;
  const last = s[s.length - 1] as (typeof s)[number];
  if (t > last.t + 0.05) return null;
  let best = s[0] as (typeof s)[number];
  for (const q of s) if (Math.abs(q.t - t) < Math.abs(best.t - t)) best = q;
  return { x: best.x, y: best.y, confidence: best.confidence, uncertainty: best.uncertainty ?? null };
}

const deathT = (round: RoundLite, id: string): number | null => round.players.find((p) => p.id === id)?.deathT ?? null;
const teamOf = (round: RoundLite, id: string): 'T' | 'CT' => (round.players.find((p) => p.id === id)?.team ?? 'T');

// ---- per timestamp -----------------------------------------------------------------------------------------------

export type Verdict = 'pass' | 'fail' | 'n/a';

export interface PlayerCheck {
  readonly id: string;
  /** What the truth is: the video's radar dot, or (inferred CTs) the recorded route and its radius. */
  readonly source: 'video-dot' | 'recording-inferred' | 'none';
  readonly video: readonly [number, number] | null;
  readonly sim: readonly [number, number] | null;
  readonly error: number | null;
  readonly limit: number | null;
  readonly verdict: Verdict;
  readonly note: string;
  /** Video dot vs the recording's sample at t (round.json): how well this tool's reading agrees with the extraction. */
  readonly recError?: number | null;
}

export interface HudCheck {
  readonly field: 'hp' | 'armor' | 'clip' | 'clock' | 'bomb';
  readonly video: string | null;
  readonly sim: string | null;
  readonly verdict: Verdict;
  readonly note: string;
}

export interface FrameResult {
  readonly t: number;
  readonly tick: number;
  readonly frame: number;
  readonly watched: string | null;
  readonly layout: string;
  readonly players: readonly PlayerCheck[];
  readonly hud: readonly HudCheck[];
  readonly verdict: 'pass' | 'fail';
  readonly worstUnits: number | null;
}

const NON_AMMO = new Set(['knife', 'c4', 'he', 'flash', 'smoke', 'molotov', 'decoy', 'incendiary']);

/**
 * `sim` is the state at video time t (the observe after tick round(t × 64)); `near` are the states one video frame
 * (1/60 s) either side: the frame and the tick grids differ (60 vs 64 Hz), so a HUD number passes when any of them
 * shows it, and the note says which.
 */
export function compareFrame(round: RoundLite, truth: TruthTime, sim: SimFrame, near: readonly SimFrame[] = []): FrameResult {
  const t = truth.t;
  const players: PlayerCheck[] = [];
  const simOf = new Map(sim.pawns.map((p) => [p.id, p]));
  const dots = new Map<string, TruthDot>();
  for (const d of truth.radar.dots) if (d.role === 'dot' && d.id !== null) dots.set(d.id, d);
  const watched = watchedAt(round, t);
  for (const id of PLAYER_ORDER) {
    const p = simOf.get(id);
    const dt = deathT(round, id);
    const recAlive = dt === null || t < dt;
    const simPos = p !== undefined && p.alive ? ([p.x, p.y] as const) : null;
    const d = dots.get(id);
    if (truth.layout === 'deathcam') {
      players.push({ id, source: 'none', video: null, sim: simPos, error: null, limit: null, verdict: 'n/a', note: 'death cam: no radar' });
      continue;
    }
    if (!recAlive) {
      // Dead on the tape (kill feed). The sim must agree (a 0.05 s grace covers the kill-feed frame vs the tick).
      const simAlive = p !== undefined && p.alive;
      const late = dt !== null && t < dt + 0.05;
      players.push({ id, source: 'none', video: null, sim: simPos, error: null, limit: null,
        verdict: simAlive && !late ? 'fail' : 'n/a', note: simAlive && !late ? 'dead on the tape, alive in the sim' : 'dead' });
      continue;
    }
    if (d !== undefined) {
      const v = [d.x, d.y] as const;
      if (simPos === null) {
        players.push({ id, source: 'video-dot', video: v, sim: null, error: null, limit: THRESHOLDS.observedUnits, verdict: 'fail', note: 'on the radar in the video, dead in the sim' });
        continue;
      }
      const err = Math.hypot(v[0] - simPos[0], v[1] - simPos[1]);
      const rec = trackAt(round, id, t);
      players.push({ id, source: 'video-dot', video: v, sim: simPos, error: round1(err), limit: THRESHOLDS.observedUnits,
        verdict: err <= THRESHOLDS.observedUnits ? 'pass' : 'fail', note: teamOf(round, id) === 'CT' ? 'spotted CT' : '',
        recError: rec === null ? null : round1(Math.hypot(v[0] - rec.x, v[1] - rec.y)) });
      continue;
    }
    const rec = trackAt(round, id, t);
    if (teamOf(round, id) === 'CT' && rec !== null && rec.confidence === 'inferred' && rec.uncertainty !== null) {
      // Never seen: the recording's route is a reconstruction; the sim must stay inside its stated radius.
      if (simPos === null) {
        players.push({ id, source: 'recording-inferred', video: null, sim: null, error: null, limit: rec.uncertainty, verdict: 'fail', note: 'alive on the tape, dead in the sim' });
        continue;
      }
      const err = Math.hypot(rec.x - simPos[0], rec.y - simPos[1]);
      players.push({ id, source: 'recording-inferred', video: [rec.x, rec.y], sim: simPos, error: round1(err), limit: rec.uncertainty,
        verdict: err <= rec.uncertainty ? 'pass' : 'fail', note: 'inferred CT (not on the video radar)' });
      continue;
    }
    if (simPos === null) {
      players.push({ id, source: 'none', video: null, sim: null, error: null, limit: null, verdict: 'fail', note: 'alive on the tape, dead in the sim' });
      continue;
    }
    players.push({ id, source: 'none', video: null, sim: simPos, error: null, limit: null, verdict: 'n/a',
      note: teamOf(round, id) === 'T' ? 'no dot detected in the video (hidden under another icon or the HUD)' : 'CT not on the radar (not spotted)' });
  }

  const hud: HudCheck[] = [];
  const w = watched === null ? undefined : simOf.get(watched);
  const nearW = near.map((f) => f.pawns.find((p) => p.id === watched)).filter((p): p is SimPawn => p !== undefined);
  /** Exact at t, or within a frame (then noted). */
  const judge = (video: string, at: string | null, around: (string | null)[]): { verdict: Verdict; note: string } =>
    video === at ? { verdict: 'pass', note: '' } : around.includes(video) ? { verdict: 'pass', note: 'within one video frame' } : { verdict: 'fail', note: '' };
  const watchedAlive = watched !== null && (deathT(round, watched) === null || t < (deathT(round, watched) as number));
  if (w !== undefined && watchedAlive && truth.layout !== 'deathcam') {
    for (const field of ['hp', 'armor'] as const) {
      const r = truth.hud[field];
      const simV = String(field === 'hp' ? w.hp : w.armor);
      if (r.value === null || r.score < THRESHOLDS.ocrScore) hud.push({ field, video: r.value, sim: simV, verdict: 'n/a', note: `unread (score ${r.score})` });
      else hud.push({ field, video: r.value, sim: simV, ...judge(r.value, simV, nearW.map((q) => String(field === 'hp' ? q.hp : q.armor))) });
    }
    const r = truth.hud.clip;
    const simClip = NON_AMMO.has(w.weapon) ? null : String(w.clip);
    if (r.value === null || r.score < THRESHOLDS.ocrScore) {
      hud.push({ field: 'clip', video: null, sim: simClip, verdict: simClip === null ? 'pass' : 'n/a', note: simClip === null ? `no ammo counter (${w.weapon})` : `unread (score ${r.score}); sim holds ${w.weapon}` });
    } else {
      const j = judge(r.value, simClip, nearW.map((q) => (NON_AMMO.has(q.weapon) ? null : String(q.clip))));
      hud.push({ field: 'clip', video: r.value, sim: simClip, verdict: j.verdict, note: [j.note, simClip === null ? `sim holds ${w.weapon}` : `sim ${w.weapon}`].filter((x) => x !== '').join('; ') });
    }
  }
  if (truth.layout !== 'deathcam' && t < round.bomb.defuseT) {
    const planted = sim.bombState === 'planted' || sim.bombState === 'defusing';
    if (truth.hud.clock.bombIcon || planted) {
      hud.push({ field: 'bomb', video: truth.hud.clock.bombIcon ? 'icon' : 'clock', sim: planted ? `planted (${sim.clockText})` : sim.clockText,
        verdict: truth.hud.clock.bombIcon === planted ? 'pass' : 'fail', note: 'the HUD swaps the clock for the C4 icon once planted' });
    } else {
      const r = truth.hud.clock;
      if (r.value === null || r.score < THRESHOLDS.ocrScore) hud.push({ field: 'clock', video: r.value, sim: sim.clockText, verdict: 'n/a', note: `unread (score ${r.score})` });
      else hud.push({ field: 'clock', video: r.value, sim: sim.clockText, verdict: r.value === sim.clockText ? 'pass' : 'fail', note: '' });
    }
  }
  const fails = players.some((p) => p.verdict === 'fail') || hud.some((h) => h.verdict === 'fail');
  const errs = players.filter((p) => p.source === 'video-dot' && p.error !== null).map((p) => p.error as number);
  return {
    t, tick: sim.tick, frame: truth.frame, watched, layout: truth.layout, players, hud,
    verdict: fails ? 'fail' : 'pass', worstUnits: errs.length === 0 ? null : Math.max(...errs),
  };
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

// ---- events ------------------------------------------------------------------------------------------------------

export interface EventCheck {
  readonly what: string;
  /** Video time of the event (first kill-feed frame, the C4 icon, the score change), s. */
  readonly videoT: number | null;
  readonly videoTick: number | null;
  readonly simTick: number | null;
  readonly offsetTicks: number | null;
  readonly verdict: Verdict;
  readonly note: string;
}

export function compareEvents(round: RoundLite, truth: Truth, sim: SimEvents): EventCheck[] {
  const out: EventCheck[] = [];
  for (const k of round.kills) {
    // The kill-feed entry's first visible frame (60 fps scan, searched from 0.3 s before to 0.4 s after the
    // breakdown's kill time); the breakdown's time when the scan found none.
    const entry = truth.events.killFeed.find((e) => e.victim === k.victim);
    const videoT = entry?.t ?? k.t;
    const src = entry === undefined ? 'breakdown (kill-feed entry not detected)' : 'kill feed (60 fps scan)';
    const d = sim.deaths.find((x) => x.victim === k.victim);
    const vt = tickOfT(videoT);
    const off = d === undefined ? null : d.tick - vt;
    out.push({ what: `kill ${k.killer} → ${k.victim}`, videoT, videoTick: vt, simTick: d?.tick ?? null, offsetTicks: off,
      verdict: off === null ? 'fail' : Math.abs(off) <= THRESHOLDS.eventTicks ? 'pass' : 'fail',
      note: d === undefined ? `${src}; no death in the sim` : `${src}${d.attacker !== k.killer ? `; sim killer ${d.attacker ?? 'world'}` : ''}` });
  }
  const icon = truth.events.bombIconT;
  {
    const vt = icon === null ? tickOfT(round.bomb.plantT) : tickOfT(icon);
    const off = sim.plantTick === null ? null : sim.plantTick - vt;
    out.push({ what: 'bomb planted', videoT: icon ?? round.bomb.plantT, videoTick: vt, simTick: sim.plantTick, offsetTicks: off,
      verdict: off === null ? 'fail' : Math.abs(off) <= THRESHOLDS.eventTicks ? 'pass' : 'fail',
      note: icon === null ? 'breakdown (C4 icon not detected)' : 'C4 icon replaces the clock (60 fps scan)' });
  }
  const sc = truth.events.scoreChangeT;
  {
    const vt = sc === null ? tickOfT(round.bomb.defuseT) : tickOfT(sc);
    const off = sim.roundEndTick === null ? null : sim.roundEndTick - vt;
    out.push({ what: `round end (${sim.roundEndText ?? 'none'})`, videoT: sc ?? round.bomb.defuseT, videoTick: vt, simTick: sim.roundEndTick, offsetTicks: off,
      verdict: off === null ? 'fail' : Math.abs(off) <= THRESHOLDS.eventTicks ? 'pass' : 'fail',
      note: sc === null ? 'breakdown (score change not detected)' : 'CT score 11 → 12 on the scoreboard (60 fps scan)' });
  }
  return out;
}

// ---- summary and baseline ------------------------------------------------------------------------------------------

export interface RunReport {
  readonly app: string;
  readonly run: string;
  readonly frames: readonly FrameResult[];
  readonly events: readonly EventCheck[];
}

export interface RunSummary {
  readonly run: string;
  readonly timestamps: number;
  readonly pass: number;
  readonly fail: number;
  readonly radar: { readonly checks: number; readonly fail: number; readonly rms: number | null; readonly p95: number | null; readonly max: number | null; readonly maxAt: string | null };
  /** The video's dots against the recording (round.json): the ground truth's own agreement with the extraction. */
  readonly truthVsRecording: { readonly n: number; readonly rms: number | null; readonly p95: number | null };
  readonly inferred: { readonly checks: number; readonly fail: number };
  readonly status: { readonly fail: number };
  readonly hud: Record<string, { readonly checks: number; readonly fail: number; readonly unread: number }>;
  readonly events: { readonly checks: number; readonly fail: number; readonly worstOffset: number | null };
  readonly perPlayer: Record<string, { readonly n: number; readonly rms: number; readonly max: number; readonly fail: number }>;
}

export function summarize(r: RunReport): RunSummary {
  const radarErr: { e: number; at: string }[] = [];
  const recErr: number[] = [];
  let radarFail = 0;
  let infN = 0;
  let infFail = 0;
  let statusFail = 0;
  const hud: Record<string, { checks: number; fail: number; unread: number }> = {};
  const per: Record<string, number[]> = {};
  const perFail: Record<string, number> = {};
  for (const f of r.frames) {
    for (const p of f.players) {
      if (p.source === 'video-dot' && p.error !== null) {
        radarErr.push({ e: p.error, at: `${p.id} @ ${f.t}s` });
        if (p.recError !== undefined && p.recError !== null) recErr.push(p.recError);
        (per[p.id] ??= []).push(p.error);
        if (p.verdict === 'fail') {
          radarFail++;
          perFail[p.id] = (perFail[p.id] ?? 0) + 1;
        }
      } else if (p.source === 'recording-inferred') {
        infN++;
        if (p.verdict === 'fail') infFail++;
      } else if (p.verdict === 'fail') statusFail++;
    }
    for (const h of f.hud) {
      const s = (hud[h.field] ??= { checks: 0, fail: 0, unread: 0 });
      if (h.verdict === 'n/a') s.unread++;
      else {
        s.checks++;
        if (h.verdict === 'fail') s.fail++;
      }
    }
  }
  const es = radarErr.map((x) => x.e).sort((a, b) => a - b);
  const worst = radarErr.reduce<{ e: number; at: string } | null>((m, x) => (m === null || x.e > m.e ? x : m), null);
  const perPlayer: RunSummary['perPlayer'] = {};
  for (const [id, v] of Object.entries(per).sort()) {
    perPlayer[id] = { n: v.length, rms: round1(Math.sqrt(v.reduce((a, b) => a + b * b, 0) / v.length)), max: round1(Math.max(...v)), fail: perFail[id] ?? 0 };
  }
  const evOff = r.events.filter((e) => e.offsetTicks !== null).map((e) => Math.abs(e.offsetTicks as number));
  return {
    run: r.run,
    timestamps: r.frames.length,
    pass: r.frames.filter((f) => f.verdict === 'pass').length,
    fail: r.frames.filter((f) => f.verdict === 'fail').length,
    radar: {
      checks: es.length, fail: radarFail,
      rms: es.length === 0 ? null : round1(Math.sqrt(es.reduce((a, b) => a + b * b, 0) / es.length)),
      p95: es.length === 0 ? null : (es[Math.min(es.length - 1, Math.floor(es.length * 0.95))] as number),
      max: worst?.e ?? null, maxAt: worst?.at ?? null,
    },
    truthVsRecording: (() => {
      const r = [...recErr].sort((a, b) => a - b);
      return { n: r.length, rms: r.length === 0 ? null : round1(Math.sqrt(r.reduce((a, b) => a + b * b, 0) / r.length)), p95: r.length === 0 ? null : (r[Math.min(r.length - 1, Math.floor(r.length * 0.95))] as number) };
    })(),
    inferred: { checks: infN, fail: infFail },
    status: { fail: statusFail },
    hud,
    events: { checks: r.events.length, fail: r.events.filter((e) => e.verdict === 'fail').length, worstOffset: evOff.length === 0 ? null : Math.max(...evOff) },
    perPlayer,
  };
}

/** The committed baseline: per run, the verdict of every check, so a later run lists what got worse. */
export interface Baseline {
  readonly app: string;
  readonly runs: Record<string, { readonly summary: RunSummary; readonly checks: Record<string, Verdict> }>;
}

export function checkKeys(r: RunReport): Record<string, Verdict> {
  const out: Record<string, Verdict> = {};
  for (const f of r.frames) {
    for (const p of f.players) if (p.verdict !== 'n/a') out[`${f.t}|pos|${p.id}`] = p.verdict;
    for (const h of f.hud) if (h.verdict !== 'n/a') out[`${f.t}|hud|${h.field}`] = h.verdict;
  }
  for (const e of r.events) out[`event|${e.what.replace(/ \(.*\)$/, '')}`] = e.verdict;
  return out;
}

export interface Regression {
  readonly run: string;
  readonly key: string;
  readonly was: Verdict;
  readonly now: Verdict | 'missing';
}

export function regressions(base: Baseline, runs: readonly RunReport[]): { regressed: Regression[]; fixed: Regression[] } {
  const regressed: Regression[] = [];
  const fixed: Regression[] = [];
  for (const r of runs) {
    const b = base.runs[r.run];
    if (b === undefined) continue;
    const now = checkKeys(r);
    for (const [key, was] of Object.entries(b.checks)) {
      const v = now[key] ?? 'missing';
      if (was === 'pass' && v !== 'pass') regressed.push({ run: r.run, key, was, now: v });
      if (was === 'fail' && v === 'pass') fixed.push({ run: r.run, key, was, now: v });
    }
  }
  return { regressed, fixed };
}

// ---- markdown ----------------------------------------------------------------------------------------------------

const fmt = (v: number | null, d = 1): string => (v === null ? '–' : v.toFixed(d));

export function summaryMarkdown(app: string, date: string, summaries: readonly RunSummary[], reports: readonly RunReport[], onlyFails = false): string {
  const L: string[] = [];
  L.push(`Generated by \`npm run parity:${app}\` on ${date} (\`tools/video-parity.ts\`, thresholds in \`docs/parity.md\`).`, '');
  L.push('| run | timestamps | pass | fail | radar checks | radar fail | radar RMS (u) | p95 (u) | worst (u) | video vs recording RMS / p95 (u) | inferred-CT fail | alive/dead fail | HUD fail (hp/armor/clip/clock/bomb) | events fail | worst event offset (ticks) |');
  L.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- | ---: | ---: |');
  for (const s of summaries) {
    const h = (k: string): string => (s.hud[k] === undefined ? '–' : `${s.hud[k].fail}/${s.hud[k].checks}`);
    L.push(`| ${s.run} | ${s.timestamps} | ${s.pass} | ${s.fail} | ${s.radar.checks} | ${s.radar.fail} | ${fmt(s.radar.rms)} | ${fmt(s.radar.p95)} | ${fmt(s.radar.max)} (${s.radar.maxAt ?? '–'}) | ${fmt(s.truthVsRecording.rms)} / ${fmt(s.truthVsRecording.p95)} | ${s.inferred.fail}/${s.inferred.checks} | ${s.status.fail} | ${h('hp')} · ${h('armor')} · ${h('clip')} · ${h('clock')} · ${h('bomb')} | ${s.events.fail}/${s.events.checks} | ${s.events.worstOffset ?? '–'} |`);
  }
  for (const r of reports) {
    const s = summaries.find((x) => x.run === r.run);
    L.push('', `### ${r.run}: radar error per player (observed dots)`, '');
    L.push('| player | samples | RMS (u) | max (u) | > 40 u |', '| --- | ---: | ---: | ---: | ---: |');
    for (const [id, p] of Object.entries(s?.perPlayer ?? {})) L.push(`| ${id} | ${p.n} | ${p.rms} | ${p.max} | ${p.fail} |`);
    L.push('', `### ${r.run}: events`, '');
    L.push('| event | video t (s) | video tick | sim tick | offset (ticks) | verdict | source |', '| --- | ---: | ---: | ---: | ---: | --- | --- |');
    for (const e of r.events) L.push(`| ${e.what} | ${fmt(e.videoT, 3)} | ${e.videoTick ?? '–'} | ${e.simTick ?? '–'} | ${e.offsetTicks ?? '–'} | ${e.verdict} | ${e.note} |`);
    L.push('', `### ${r.run}: ${onlyFails ? 'failing timestamps' : 'per timestamp'}`, '');
    L.push('| t (s) | tick | camera | verdict | worst dot (u) | failing checks |', '| ---: | ---: | --- | --- | ---: | --- |');
    for (const f of r.frames) {
      if (onlyFails && f.verdict === 'pass') continue;
      const bad = [
        ...f.players.filter((p) => p.verdict === 'fail').map((p) => `${p.id} ${p.error === null ? p.note : `${p.error} u${p.source === 'recording-inferred' ? ` > r ${p.limit}` : ''}`}`),
        ...f.hud.filter((h) => h.verdict === 'fail').map((h) => `${h.field} video ${h.video ?? '–'} sim ${h.sim ?? '–'}`),
      ];
      L.push(`| ${f.t} | ${f.tick} | ${f.watched ?? f.layout} | ${f.verdict} | ${fmt(f.worstUnits)} | ${bad.join('; ')} |`);
    }
  }
  return L.join('\n') + '\n';
}
