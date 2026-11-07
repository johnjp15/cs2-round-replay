/**
 * The 2D engine's LIVE AI (C4): what drives a pawn after the Core sends `set_mode {id, mode: 'LIVE', goal}`. In CS2
 * the native bot AI does this; here it is a small, deterministic bot that follows its goal, fights, plants and
 * defuses. Roles, combat, hearing and tuning keys: docs/ai.md.
 *
 * One call per tick per LIVE, alive pawn (id order), before movement: `stepAi(state, ctx)` reads only what the pawn
 * could know (its own state, its `sees`, last tick's sounds, the bomb as the round shows it), and returns the new
 * state, the pawn's input for this tick and an optional weapon switch. The state is plain data (snapshotted).
 * Randomness: each draw is `rng.fork('ai:' + id).fork('d' + n).next()` for the pawn's n-th draw, so a snapshot only
 * needs the draw count, and pawns never share a stream.
 */
import { Rng, compareOrdinal, roundNumber, type Button, type Goal, type ObsEvent, type PlayerId, type RoundPhase, type Team, type Tuning, type Vec3, type WeaponId } from '../contracts/index';
import { aimPitch } from './hitscan';
import { TICKS_PER_SEC } from './movement';
import type { NavMesh, NavPoint } from './nav';
import type { GuardSight } from './vision';
import { fallbackWeapon, gunStats, isGrenade } from './weapons';

/** The roles `goal.role` may name (any other string behaves as `hold`). docs/ai.md. G1 added `rejoin`. */
export const AI_ROLES = ['hold', 'take_site', 'plant', 'guard_bomb', 'retake', 'defuse', 'rotate', 'hunt', 'rejoin'] as const;
export type AiRole = (typeof AI_ROLES)[number];

/** What the pawn is doing (aiDebug). */
export type AiBehaviour = 'route' | 'moving' | 'holding' | 'planting' | 'guarding' | 'defusing' | 'hunting' | 'reacting' | 'fighting' | 'searching' | 'escaping' | 'rejoining';

const DEG = Math.PI / 180;

/** Per-pawn AI state: plain, JSON-serializable data. */
export interface AiState {
  readonly id: PlayerId;
  /** Tick the current LIVE goal began. */
  sinceTick: number;
  /** Random draws used so far. */
  draws: number;
  behaviour: AiBehaviour;
  /** Next `goal.route` waypoint; route.length once the route is walked. */
  routeIndex: number;
  /** Nav path to `dest` (first point = where it was computed), and the next point to steer at. */
  path: Vec3[];
  pathIndex: number;
  dest: Vec3 | null;
  /**
   * Stuck detection: the best remaining path length since `progressTick`; negative (or null, from an old state's JSON
   * copy of Infinity) = not measured since the last (re)plan. Kept finite so the state stays JSON (snapshots).
   */
  progressTick: number;
  progressDist: number;
  repaths: number;
  /** After a repath, strafe sideways (`unstickSide` −1 left / 1 right) until this tick. */
  unstickUntilTick: number;
  unstickSide: number;
  /** Combat. */
  target: PlayerId | null;
  targetSeenTick: number;
  /** Last seen position of the target. */
  targetPos: Vec3 | null;
  acquiredTick: number;
  reactTicks: number;
  /** Aim offset drawn at acquisition (degrees); it halves every `aimSettleSec` after the reaction. */
  aimYawErr: number;
  aimPitchErr: number;
  aimBand: 'head' | 'chest';
  /** ATTACK was pressed on the previous tick (semi-automatic guns need a release between shots). */
  attackHeld: boolean;
  /** Knowledge: the last place an enemy was seen or heard. */
  lastKnown: { pos: Vec3; tick: number; id: PlayerId } | null;
  /** Turn toward a sound until `untilTick`. */
  lookAt: { pos: Vec3; untilTick: number } | null;
  /** Where the planted bomb is, once known (Ts: the round shows it; CTs: its beeps). */
  bombPos: Vec3 | null;
  /** The spot a role picked (plant spot, guard spot, hold spot), and the yaw to hold there. */
  spot: Vec3 | null;
  holdYaw: number | null;
  /**
   * Out of the bomb's blast: the spot picked once the pawn has to leave it (the round is over with the bomb ticking,
   * or a CT gave up the defuse). Optional so that snapshots from before it restore (absent = null).
   */
  escape?: Vec3 | null;
  /** A CT that can't finish the defuse before the explosion gave it up (for the rest of this goal). */
  abandoned?: boolean;
}

/** What the AI may know about itself. */
export interface AiSelf {
  readonly id: PlayerId;
  readonly team: Team;
  readonly pos: Vec3;
  readonly vel: Vec3;
  readonly yaw: number;
  readonly pitch: number;
  readonly crouching: boolean;
  readonly weapon: WeaponId;
  readonly clip: number;
  readonly reserve: number;
  /** Items carried (ordinal). */
  readonly items: readonly string[];
  /** The held gun can fire on this tick (deployed, cycled, not reloading). */
  readonly ready: boolean;
  readonly reloading: boolean;
  /** This pawn's defuse in progress completes on this tick (its progress bar), or null if it isn't defusing. */
  readonly defuseEndTick: number | null;
  /**
   * B1: where the weapon will put this tick's bullet relative to the view (degrees, Source pitch + = down, yaw + =
   * left): the aim punch × recoilScale the host's weapon mechanics add (3D host; the 2D host has no recoil and leaves
   * it out). The bot compensates like a player pulling the mouse against the spray: it aims its view at the target
   * minus this offset, so the bullet (view + offset) goes at the target. Absent = zero.
   */
  readonly aimPunch?: { readonly pitch: number; readonly yaw: number };
}

/** Another pawn as the AI can see it (only pawns in `sees` are read for position). */
export interface AiOther {
  readonly id: PlayerId;
  readonly team: Team;
  readonly pos: Vec3;
  readonly crouching: boolean;
  readonly alive: boolean;
}

export interface AiContext {
  readonly tick: number;
  readonly self: AiSelf;
  readonly goal: Goal;
  /** The other pawns (id order). Positions of those not in `sees` are not used. */
  readonly others: readonly AiOther[];
  /** This pawn's `sees`. */
  readonly sees: readonly PlayerId[];
  /** Last tick's events (what observe() reports). */
  readonly events: readonly ObsEvent[];
  /** The bomb: planted position (null if not planted), whether it is still ticking, and its explode tick (as the round shows: plant + timer). */
  readonly bomb: { readonly planted: Vec3 | null; readonly ticking: boolean; readonly explodeTick: number | null };
  /** The round as observe() reports it (`observe.round.phase`). */
  readonly round: { readonly phase: RoundPhase };
  readonly nav: NavMesh;
  /** The guard-spot sight test: the CS2 mesh (MeshSight, G6), or the 2D Sight without 3D geometry. */
  readonly sight: GuardSight;
  readonly tuning: Tuning;
  /** rng.fork('ai:' + id) of the host's AI seed. */
  readonly rng: Rng;
}

export interface AiStep {
  readonly state: AiState;
  readonly input: { forward: number; side: number; yaw: number; pitch: number; buttons: Button[] };
  /** Draw this item before the tick (like set_weapon), or null. */
  readonly weapon: WeaponId | null;
}

/** The state a pawn starts a LIVE goal with. `draws` carries over so a new goal doesn't repeat old random numbers. */
export function freshAiState(id: PlayerId, tick: number, draws: number): AiState {
  return {
    id,
    sinceTick: tick,
    draws,
    behaviour: 'route',
    routeIndex: 0,
    path: [],
    pathIndex: 0,
    dest: null,
    progressTick: tick,
    progressDist: -1,
    repaths: 0,
    unstickUntilTick: 0,
    unstickSide: 1,
    target: null,
    targetSeenTick: 0,
    targetPos: null,
    acquiredTick: 0,
    reactTicks: 0,
    aimYawErr: 0,
    aimPitchErr: 0,
    aimBand: 'chest',
    attackHeld: false,
    lastKnown: null,
    lookAt: null,
    bombPos: null,
    spot: null,
    holdYaw: null,
    escape: null,
    abandoned: false,
  };
}

/** Normalised role: one of AI_ROLES; anything else is `hold`. */
export function roleOf(goal: Goal): AiRole {
  return (AI_ROLES as readonly string[]).includes(goal.role) ? (goal.role as AiRole) : 'hold';
}

// ---- helpers -------------------------------------------------------------------------------------------

function sec(s: number): number {
  return Math.round(s * TICKS_PER_SEC);
}

function dist2d(a: NavPoint, b: NavPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function bearing(from: NavPoint, to: NavPoint): number {
  return Math.atan2(to.y - from.y, to.x - from.x) / DEG;
}

/** Signed smallest difference to − from, in (−180, 180]. */
function angleDiff(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d <= -180) d += 360;
  if (d > 180) d -= 360;
  return d;
}

/** Turn `cur` toward `want` by at most `rate` degrees. */
function turn(cur: number, want: number, rate: number): number {
  const d = angleDiff(cur, want);
  return Math.abs(d) <= rate ? cur + d : cur + Math.sign(d) * rate;
}

function copy(v: NavPoint & { z?: number }): Vec3 {
  return { x: v.x, y: v.y, z: v.z ?? 0 };
}

/** Next uniform [0, 1) draw of this pawn. */
function draw(s: AiState, rng: Rng): number {
  const u = rng.fork('d' + String(s.draws)).next();
  s.draws++;
  return u;
}

/** Standard normal (Box–Muller from two draws), 6 decimals. */
function gauss(s: AiState, rng: Rng): number {
  const u1 = Math.max(draw(s, rng), 1e-12);
  const u2 = draw(s, rng);
  return roundNumber(Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2));
}

function isEnemy(self: AiSelf, o: AiOther): boolean {
  return o.team !== self.team;
}

/** `p` if it is walkable, else its projection onto the nearest nav area (with that floor's z). */
export function snapToNav(nav: NavMesh, p: NavPoint & { z?: number }): Vec3 {
  if (nav.isWalkable(p)) return copy(p);
  const a = nav.nearestArea(p);
  const q = { x: Math.min(Math.max(p.x, a.x1), a.x2), y: Math.min(Math.max(p.y, a.y1), a.y2) };
  return { x: q.x, y: q.y, z: nav.zAt(q) };
}

/** Area-weighted centre of the nav areas of a place (e.g. "T Spawn"), or null. */
export function placeCentre(nav: NavMesh, place: string): Vec3 | null {
  let w = 0;
  let x = 0;
  let y = 0;
  for (const a of nav.areas) {
    if (nav.places[a.place] !== place) continue;
    const s = (a.x2 - a.x1) * (a.y2 - a.y1);
    w += s;
    x += s * (a.x1 + a.x2) / 2;
    y += s * (a.y1 + a.y2) / 2;
  }
  if (w === 0) return null;
  const p = { x: x / w, y: y / w };
  return { x: p.x, y: p.y, z: nav.zAt(p) };
}

/**
 * The plant spot for a bomb carrier heading from `p`: the bombsite (a nav place whose name starts with "Bombsite")
 * with the area nearest to `p` (2D, ties by id), and that site's area-weighted centre, snapped onto walkable space.
 * null if the mesh has no bombsite.
 */
export function nearestBombsitePoint(nav: NavMesh, p: NavPoint): Vec3 | null {
  let place: string | null = null;
  let bestD = Infinity;
  for (const a of nav.areas) {
    const name = nav.places[a.place] ?? '';
    if (!name.startsWith('Bombsite')) continue;
    const d = Math.hypot(Math.max(a.x1 - p.x, 0, p.x - a.x2), Math.max(a.y1 - p.y, 0, p.y - a.y2));
    if (d < bestD - 1e-9) {
      bestD = d;
      place = name;
    }
  }
  if (place === null) return null;
  const c = placeCentre(nav, place);
  if (c === null) return null;
  if (nav.isWalkable(c)) return c;
  const a = nav.nearestArea(c);
  const q = { x: Math.min(Math.max(c.x, a.x1), a.x2), y: Math.min(Math.max(c.y, a.y1), a.y2) };
  return { x: q.x, y: q.y, z: nav.zAt(q) };
}

/**
 * The yaw to hold at `spot`: toward where enemies come from.
 * 1. A recent known enemy position: the first leg of the nav path from the spot toward it.
 * 2. The enemy side's spawn (`T Spawn` for a CT, `CT Spawn` for a T): the last leg of the nav path from there to
 *    the spot, reversed (the direction an enemy walking from its spawn arrives from).
 * 3. The goal's route: its last leg, reversed. 4. The current yaw.
 */
export function holdFacing(ctx: AiContext, s: AiState, spot: Vec3): number {
  const { nav, tick, tuning } = ctx;
  const facePath = (from: Vec3, to: Vec3, reverseLast: boolean): number | null => {
    const path = nav.path(from, to);
    if (path === null || path.length < 2) return null;
    if (reverseLast) {
      const end = path[path.length - 1] as Vec3;
      const prev = path[path.length - 2] as Vec3;
      return dist2d(end, prev) < 1 ? null : bearing(end, prev);
    }
    const first = path[1] as Vec3;
    return dist2d(from, first) < 1 ? null : bearing(from, first);
  };
  if (s.lastKnown !== null && tick - s.lastKnown.tick <= sec(tuning.ai.memorySec)) {
    const y = facePath(spot, s.lastKnown.pos, false);
    if (y !== null) return y;
  }
  const spawn = placeCentre(nav, ctx.self.team === 'CT' ? 'T Spawn' : 'CT Spawn');
  if (spawn !== null) {
    const y = facePath(spawn, spot, true);
    if (y !== null) return y;
  }
  const r = ctx.goal.route;
  if (r.length > 0) {
    const prev = r.length >= 2 ? (r[r.length - 2] as Vec3) : ctx.self.pos;
    const end = (ctx.goal.hold ?? r[r.length - 1]) as Vec3;
    if (dist2d(prev, end) >= 1) return bearing(end, prev);
  }
  return ctx.self.yaw;
}

/**
 * A spot from which a T guards the planted bomb: on rings of 300–guardMaxUnits around it (every 15°), walkable, with
 * eye-to-bomb sight (`sight.pointClear`: the CS2 mesh, G6; in 2D the mask with cover), nearest to the pawn (ties: ring
 * then angle order). The goal's `hold` wins when it qualifies. null if none qualifies.
 */
export function guardSpot(ctx: AiContext, bomb: Vec3): Vec3 | null {
  const { nav, sight, tuning } = ctx;
  const eye = tuning.damage.eyeHeight;
  const max = tuning.ai.guardMaxUnits;
  // The bomb is a point on the ground (leg height above it): a box between hides it unless the line passes over it.
  const ok = (p: Vec3): boolean => dist2d(p, bomb) <= max && nav.isWalkable(p) && sight.pointClear(p, eye, bomb, tuning.damage.bandHeights['leg'] ?? 16);
  const hold = ctx.goal.hold;
  if (hold !== null && ok(hold)) return copy(hold);
  let best: Vec3 | null = null;
  let bestD = Infinity;
  for (let r = 300; r <= max + 1e-9; r += 150) {
    for (let k = 0; k < 24; k++) {
      const a = k * 15 * DEG;
      const q = { x: bomb.x + Math.cos(a) * r, y: bomb.y + Math.sin(a) * r };
      const p = { x: roundNumber(q.x), y: roundNumber(q.y), z: nav.zAt({ ...q, z: bomb.z }) };
      if (!ok(p)) continue;
      const d = dist2d(p, ctx.self.pos);
      if (d < bestD - 1e-9) {
        bestD = d;
        best = p;
      }
    }
  }
  return best;
}

/** 3D distance. */
function dist3d(a: Vec3, b: Vec3): number {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}

/**
 * Where to go to be out of a bomb's blast: the nearest way out by the nav mesh. A Dijkstra over the nav areas from
 * the pawn's area (costs between portal midpoints, as `NavMesh.path`), popping areas in order of the walking
 * distance to where it enters them; the first area with a candidate point (its centre, or a corner 16 units in) at
 * least `clear` units (3D) from the bomb gives the destination: of its safe candidates, the one nearest to where the
 * walk enters it. Ties by area id. The pawn's own position if it is already clear; null if no area is.
 */
export function escapeSpot(nav: NavMesh, from: Vec3, bomb: Vec3, clear: number): Vec3 | null {
  if (dist3d(from, bomb) >= clear) return copy(from);
  const areas = nav.areas;
  const n = areas.length;
  const g = new Float64Array(n).fill(Infinity);
  const ex = new Float64Array(n);
  const ey = new Float64Array(n);
  const done = new Uint8Array(n);
  const start = nav.areaAt(from) ?? nav.nearestArea(from);
  g[start.id] = 0;
  ex[start.id] = from.x;
  ey[start.id] = from.y;
  const inset = 16;
  for (;;) {
    let cur = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (done[i] === 0 && (g[i] as number) < best) {
        best = g[i] as number;
        cur = i;
      }
    }
    if (cur < 0) return null;
    done[cur] = 1;
    const a = areas[cur] as (typeof areas)[number];
    const ix = Math.min(inset, (a.x2 - a.x1) / 2);
    const iy = Math.min(inset, (a.y2 - a.y1) / 2);
    const cands = [
      { x: (a.x1 + a.x2) / 2, y: (a.y1 + a.y2) / 2 },
      { x: a.x1 + ix, y: a.y1 + iy },
      { x: a.x2 - ix, y: a.y1 + iy },
      { x: a.x1 + ix, y: a.y2 - iy },
      { x: a.x2 - ix, y: a.y2 - iy },
    ];
    let pick: Vec3 | null = null;
    let pickD = Infinity;
    for (const c of cands) {
      const p = { x: roundNumber(c.x), y: roundNumber(c.y), z: roundNumber(nav.zAt({ ...c, z: from.z })) };
      if (dist3d(p, bomb) < clear) continue;
      const d = Math.hypot(p.x - (ex[cur] as number), p.y - (ey[cur] as number));
      if (d < pickD - 1e-9) {
        pickD = d;
        pick = p;
      }
    }
    if (pick !== null) return pick;
    for (const q of nav.portals[cur] ?? []) {
      if (done[q.to] === 1) continue;
      const ng = (g[cur] as number) + Math.hypot(q.mx - (ex[cur] as number), q.my - (ey[cur] as number));
      if (ng < (g[q.to] as number) - 1e-9) {
        g[q.to] = ng;
        ex[q.to] = q.mx;
        ey[q.to] = q.my;
      }
    }
  }
}

/**
 * Can this CT still finish a defuse before the bomb explodes? Defusing now: only if its progress bar ends before
 * the explosion (the engine's rule). Otherwise: the time left must cover the walk to within the defuse range (nav
 * path at the held weapon's run speed), the defuse itself (bomb.defuseKitSec with a kit, else bomb.defuseSec) and
 * ai.defuseMarginSec. Unknown explode tick: yes.
 */
export function canFinishDefuse(ctx: AiContext, bomb: Vec3): boolean {
  const { self, tick, tuning } = ctx;
  const explode = ctx.bomb.explodeTick;
  if (explode === null) return true;
  if (self.defuseEndTick !== null) return self.defuseEndTick < explode;
  const left = (explode - tick) / TICKS_PER_SEC;
  const defuse = self.items.includes('defuser') ? tuning.bomb.defuseKitSec : tuning.bomb.defuseSec;
  const budget = left - defuse - tuning.ai.defuseMarginSec;
  if (budget < 0) return false;
  const range = tuning.bomb.defuseRange * tuning.ai.defuseRangeFactor;
  const speed = tuning.movement.runSpeedByWeapon[self.weapon] ?? tuning.movement.runSpeedByWeapon['knife'] ?? 250;
  const straight = Math.max(0, dist2d(self.pos, bomb) - range);
  if (straight / speed > budget) return false;
  // Only when the straight line leaves it in doubt: the walking distance.
  if ((3 * straight) / speed <= budget) return true;
  const path = ctx.nav.path(self.pos, snapToNav(ctx.nav, bomb));
  const walk = path === null ? straight : Math.max(0, pathLength2d(path) - range);
  return walk / speed <= budget;
}

function pathLength2d(points: readonly Vec3[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += dist2d(points[i - 1] as Vec3, points[i] as Vec3);
  return len;
}

const NO_PUNCH = { pitch: 0, yaw: 0 } as const;

// ---- the step -------------------------------------------------------------------------------------------

/** One tick of LIVE AI for one pawn. Pure apart from the returned state (the input state is not mutated). */
export function stepAi(prev: AiState, ctx: AiContext): AiStep {
  const s: AiState = JSON.parse(JSON.stringify(prev)) as AiState;
  const { tick, self, tuning } = ctx;
  const ai = tuning.ai;
  const role = roleOf(ctx.goal);
  perceive(s, ctx, role);
  selectTarget(s, ctx);

  let yaw = self.yaw;
  let pitch: number;
  const buttons: Button[] = [];
  let move: { dirX: number; dirY: number; mag: number } | null = null;
  let weapon: WeaponId | null;
  const rate = ai.turnRateDegPerTick;

  const engaged = s.target !== null && tick >= s.acquiredTick + s.reactTicks;
  if (engaged && s.targetPos !== null) {
    s.behaviour = 'fighting';
    const tgt = ctx.others.find((o) => o.id === s.target) ?? null;
    const visible = tgt !== null && ctx.sees.includes(tgt.id);
    const aimAt = visible && tgt !== null ? tgt.pos : s.targetPos;
    const crouching = visible && tgt !== null ? tgt.crouching : false;
    const tau = (tick - s.acquiredTick - s.reactTicks) / TICKS_PER_SEC;
    const settle = Math.pow(0.5, tau / ai.aimSettleSec);
    // B1: recoil control. The bot's error (acquisition offset, settling, per-shot residual) stays centred on the
    // target; the view itself is pulled against the weapon's punch so the bullet (view + punch) lands there.
    const punch = self.aimPunch ?? NO_PUNCH;
    const wantYaw = bearing(self.pos, aimAt) + s.aimYawErr * settle - punch.yaw;
    const wantPitch = aimPitch({ pos: self.pos, crouching: self.crouching }, { pos: aimAt, crouching }, s.aimBand, tuning.damage) + s.aimPitchErr * settle - punch.pitch;
    yaw = turn(self.yaw, wantYaw, rate);
    pitch = turn(self.pitch, wantPitch, rate);
    // Counter-strafe: push against the current velocity until nearly stopped, then stand still.
    const speed = Math.hypot(self.vel.x, self.vel.y);
    if (speed > ai.counterStrafeSpeed) move = { dirX: -self.vel.x / speed, dirY: -self.vel.y / speed, mag: 1 };
    weapon = bestGun(self);
    const gun = gunStats(self.weapon, tuning);
    // Fire once the view has caught up with the aim point and the settling offset is within the target's angular
    // radius (automatic guns start spraying within sprayStartFactor of it). Misses come from the residual.
    const aligned = Math.abs(angleDiff(yaw, wantYaw)) <= ai.fireConeDeg && Math.abs(pitch - wantPitch) <= ai.fireConeDeg;
    const d = dist2d(self.pos, aimAt);
    const radius = d > tuning.damage.pawnRadius ? Math.asin(tuning.damage.pawnRadius / d) / DEG : 90;
    const spread = gun !== null && gun.automatic ? ai.sprayStartFactor : 1;
    const onTarget = Math.abs(s.aimYawErr * settle) <= radius * spread && Math.abs(s.aimPitchErr * settle) <= tuning.damage.hitToleranceDeg * spread;
    if (visible && gun !== null && weapon === null && self.clip > 0 && !self.reloading && aligned && onTarget) {
      if (gun.automatic) {
        buttons.push('ATTACK');
      } else if (!s.attackHeld && self.ready && tau >= ai.semiAutoSettleFactor * ai.aimSettleSec) {
        buttons.push('ATTACK');
      }
      if (buttons.includes('ATTACK') && self.ready) {
        // Residual per-shot error: the shot goes a little off where the bot thinks it aims.
        yaw = roundNumber(yaw + gauss(s, ctx.rng) * ai.aimResidualDeg);
        pitch = roundNumber(pitch + gauss(s, ctx.rng) * ai.aimResidualDeg);
      }
    }
    if (gun !== null && self.clip === 0 && self.reserve > 0 && !self.reloading) buttons.push('RELOAD');
  } else {
    if (s.target !== null) s.behaviour = 'reacting';
    const plan = rolePlan(s, ctx, role);
    if (s.target === null) s.behaviour = plan.behaviour;
    weapon = plan.weapon;
    if (plan.use) buttons.push('USE');
    let faceYaw: number | null = plan.faceYaw;
    // G7: a holder (role hold) reacting to an enemy in sight stops and turns to it instead of walking on to its hold
    // spot (a sniper holding an angle doesn't leave it the moment a T appears in it). Other roles keep moving (a
    // planter or a rotating player reacts on the move), as before.
    const reacting = role === 'hold' && s.target !== null && s.targetPos !== null && !plan.use && ctx.sees.includes(s.target);
    if (reacting && s.targetPos !== null) {
      const speed = Math.hypot(self.vel.x, self.vel.y);
      if (speed > ai.counterStrafeSpeed) move = { dirX: -self.vel.x / speed, dirY: -self.vel.y / speed, mag: 1 };
      faceYaw = bearing(self.pos, s.targetPos);
    } else if (plan.dest !== null) {
      const m = followPath(s, ctx, plan.dest, plan.arriveUnits);
      if (m !== null) {
        move = m;
        faceYaw ??= Math.atan2(m.dirY, m.dirX) / DEG;
      }
    }
    if (!reacting && s.lookAt !== null && tick < s.lookAt.untilTick && !plan.use) faceYaw = bearing(self.pos, s.lookAt.pos);
    if (faceYaw !== null) yaw = turn(self.yaw, faceYaw, rate);
    pitch = turn(self.pitch, 0, rate);
    // Reload when low and nothing is in sight.
    const gun = gunStats(self.weapon, tuning);
    if (gun !== null && s.target === null && !self.reloading && self.reserve > 0 && self.clip < gun.clip && self.clip <= gun.clip * ai.reloadClipFraction) buttons.push('RELOAD');
    if (plan.walk && move !== null && !reacting) buttons.push('WALK');
  }

  s.attackHeld = buttons.includes('ATTACK');
  yaw = roundNumber(yaw);
  pitch = roundNumber(Math.max(-89, Math.min(89, pitch)));
  let forward = 0;
  let side = 0;
  if (move !== null) {
    const th = Math.atan2(move.dirY, move.dirX) - yaw * DEG;
    forward = roundNumber(Math.cos(th) * move.mag);
    side = roundNumber(-Math.sin(th) * move.mag);
  }
  const order: readonly Button[] = ['ATTACK', 'ATTACK2', 'USE', 'DUCK', 'WALK', 'JUMP', 'RELOAD'];
  return { state: s, input: { forward, side, yaw, pitch, buttons: order.filter((b) => buttons.includes(b)) }, weapon: weapon === self.weapon ? null : weapon };
}

/**
 * The gun to hold when not planting (null if the held item is fine): keep a gun that has ammo; otherwise the first
 * primary, else secondary (fallbackWeapon) among the other items, else the knife.
 */
function bestGun(self: AiSelf): WeaponId | null {
  const held = self.weapon;
  const shoots = held !== 'knife' && held !== 'c4' && !isGrenade(held);
  if (shoots && (self.clip > 0 || self.reserve > 0)) return null;
  const want = fallbackWeapon(self.items.filter((i) => i !== held));
  return want === held ? null : want;
}

/** Sounds and the bomb: update what the pawn knows. */
function perceive(s: AiState, ctx: AiContext, role: AiRole): void {
  const { tick, self, tuning } = ctx;
  const range = tuning.replay.hearingRangeUnits;
  // Seen enemies: the nearest becomes the last known position.
  let nearest: AiOther | null = null;
  for (const o of ctx.others) {
    if (!o.alive || !isEnemy(self, o) || !ctx.sees.includes(o.id)) continue;
    if (nearest === null || dist2d(self.pos, o.pos) < dist2d(self.pos, nearest.pos) - 1e-9) nearest = o;
  }
  if (nearest !== null) s.lastKnown = { pos: copy(nearest.pos), tick, id: nearest.id };
  // Heard enemies (shots, footsteps) that are not in sight.
  let heard: { pos: Vec3; id: PlayerId; d: number } | null = null;
  for (const e of ctx.events) {
    if (e.type !== 'sound') continue;
    if (e.source === null) {
      if (e.kind === 'bomb' && self.team === 'CT' && (role === 'retake' || role === 'defuse')) s.bombPos = copy(e.pos);
      continue;
    }
    if (e.kind !== 'shot' && e.kind !== 'footstep') continue;
    const src = ctx.others.find((o) => o.id === e.source);
    if (src === undefined || !isEnemy(self, src) || ctx.sees.includes(src.id)) continue;
    const d = dist2d(self.pos, e.pos);
    if (d > range) continue;
    if (heard === null || d < heard.d - 1e-9) heard = { pos: copy(e.pos), id: src.id, d };
  }
  if (heard !== null) {
    if (nearest === null) s.lastKnown = { pos: heard.pos, tick, id: heard.id };
    if (s.target === null) s.lookAt = { pos: heard.pos, untilTick: tick + sec(tuning.ai.soundLookSec) };
  }
  if (s.lookAt !== null && tick >= s.lookAt.untilTick) s.lookAt = null;
  // Ts know where their bomb is (the round shows it).
  if (self.team === 'T' && ctx.bomb.planted !== null) s.bombPos = copy(ctx.bomb.planted);
  if (!ctx.bomb.ticking && ctx.bomb.planted !== null && s.bombPos !== null && self.team === 'CT') {
    // Defused or exploded: nothing to go to.
    s.bombPos = null;
  }
}

/** Keep the current target unless lost for more than targetLostSec; otherwise take the nearest visible enemy. */
function selectTarget(s: AiState, ctx: AiContext): void {
  const { tick, self, tuning } = ctx;
  const ai = tuning.ai;
  if (s.target !== null) {
    const t = ctx.others.find((o) => o.id === s.target) ?? null;
    if (t === null || !t.alive) {
      s.target = null;
    } else if (ctx.sees.includes(t.id)) {
      s.targetSeenTick = tick;
      s.targetPos = copy(t.pos);
    } else if (tick - s.targetSeenTick > sec(ai.targetLostSec)) {
      s.target = null;
    }
  }
  if (s.target !== null) return;
  let best: AiOther | null = null;
  for (const o of ctx.others) {
    if (!o.alive || !isEnemy(self, o) || !ctx.sees.includes(o.id)) continue;
    const d = dist2d(self.pos, o.pos);
    if (best === null || d < dist2d(self.pos, best.pos) - 1e-9 || (Math.abs(d - dist2d(self.pos, best.pos)) <= 1e-9 && compareOrdinal(o.id, best.id) < 0)) best = o;
  }
  if (best === null) return;
  s.target = best.id;
  s.targetSeenTick = tick;
  s.targetPos = copy(best.pos);
  s.acquiredTick = tick;
  const jitter = (2 * draw(s, ctx.rng) - 1) * ai.reactionJitter;
  s.reactTicks = Math.max(0, sec(ai.reactionSec * (1 + jitter)));
  s.aimYawErr = roundNumber(gauss(s, ctx.rng) * ai.aimErrorDeg);
  s.aimPitchErr = roundNumber(gauss(s, ctx.rng) * ai.aimErrorDeg);
  s.aimBand = draw(s, ctx.rng) < ai.headshotAimRatio ? 'head' : 'chest';
  s.lookAt = null;
}

interface RolePlan {
  readonly behaviour: AiBehaviour;
  /** Where to go (null = stay). */
  readonly dest: Vec3 | null;
  readonly arriveUnits: number;
  /** Yaw to hold when not moving (null = look where it goes). */
  readonly faceYaw: number | null;
  readonly use: boolean;
  readonly weapon: WeaponId | null;
  readonly walk: boolean;
}

/** The role's movement, facing and buttons when not fighting. */
function rolePlan(s: AiState, ctx: AiContext, role: AiRole): RolePlan {
  const { self, goal, tuning, tick } = ctx;
  const ai = tuning.ai;
  const arrive = ai.arriveUnits;
  const knownNear = s.lastKnown !== null && tick - s.lastKnown.tick <= sec(ai.memorySec) && dist2d(self.pos, s.lastKnown.pos) <= ai.walkNearEnemyUnits;
  const gun = bestGun(self);
  const plan = (behaviour: AiBehaviour, dest: Vec3 | null, faceYaw: number | null, use = false, weapon: WeaponId | null = gun, arriveUnits = arrive): RolePlan => ({
    behaviour,
    dest,
    arriveUnits,
    faceYaw,
    use,
    weapon,
    walk: knownNear && !use,
  });

  const nav = ctx.nav;
  const holdAt = (spot: Vec3, behaviour: AiBehaviour = 'holding'): RolePlan => {
    if (dist2d(self.pos, spot) > arrive) {
      s.holdYaw = null;
      return plan('moving', spot, null);
    }
    s.holdYaw ??= roundNumber(holdFacing(ctx, s, spot));
    return plan(behaviour, null, s.holdYaw);
  };
  // Out of the blast: once the round is over with the bomb still ticking (nothing left to win, everything to lose),
  // and for a CT who gave up the defuse, before anything else (the route too). Run, then hold there.
  const bombAt = ctx.bomb.planted;
  const escape = (): RolePlan => {
    if (s.escape === undefined || s.escape === null) {
      s.escape = bombAt === null ? copy(self.pos) : (escapeSpot(nav, self.pos, bombAt, tuning.bomb.radius + ai.blastMarginUnits) ?? copy(self.pos));
      s.holdYaw = null;
    }
    const spot = s.escape;
    if (dist2d(self.pos, spot) > arrive) {
      s.holdYaw = null;
      return { ...plan('escaping', spot, null), walk: false };
    }
    s.holdYaw ??= roundNumber(holdFacing(ctx, s, spot));
    return { ...plan('holding', null, s.holdYaw), walk: false };
  };
  const mustLeave = bombAt !== null && ctx.bomb.ticking && (ctx.round.phase === 'over' || s.abandoned === true);
  // After the explosion a pawn that got out keeps holding there: the round is over, there is nothing to go back to.
  const stayOut = ctx.round.phase === 'over' && s.escape !== undefined && s.escape !== null;
  if (mustLeave || stayOut) return escape();

  // The route first (every role); off-mesh points count at their projection onto the mesh.
  while (s.routeIndex < goal.route.length && dist2d(self.pos, snapToNav(nav, goal.route[s.routeIndex] as Vec3)) <= arrive) s.routeIndex++;
  if (s.routeIndex < goal.route.length) return plan('route', snapToNav(nav, goal.route[s.routeIndex] as Vec3), null);

  const defaultSpot = (): Vec3 => {
    s.spot ??= snapToNav(nav, goal.hold ?? (goal.route.length > 0 ? (goal.route[goal.route.length - 1] as Vec3) : self.pos));
    return s.spot;
  };

  switch (role) {
    case 'take_site':
    case 'plant': {
      const hasC4 = self.items.includes('c4');
      if (ctx.bomb.planted !== null) return guardPlan(s, ctx, plan, holdAt, defaultSpot);
      if (!hasC4) return holdAt(defaultSpot());
      if (s.spot === null) {
        const hold = goal.hold;
        const inSite = hold !== null && (ctx.nav.placeName(hold) ?? '').startsWith('Bombsite');
        s.spot = inSite && hold !== null ? snapToNav(nav, hold) : nearestBombsitePoint(nav, goal.route.length > 0 ? (goal.route[goal.route.length - 1] as Vec3) : self.pos);
      }
      const spot = s.spot ?? defaultSpot();
      const inSiteNow = ctx.nav.placeName(self.pos).startsWith('Bombsite');
      if (inSiteNow && dist2d(self.pos, spot) <= ai.plantSpotUnits) {
        // In the site: draw the c4 and hold USE (the engine locks movement while planting).
        return plan('planting', null, null, self.weapon === 'c4', 'c4');
      }
      return plan('moving', spot, null, false, gun, Math.min(arrive, ai.plantSpotUnits));
    }
    case 'guard_bomb':
      return guardPlan(s, ctx, plan, holdAt, defaultSpot);
    case 'retake':
    case 'defuse': {
      if (self.team === 'CT' && s.bombPos !== null && ctx.bomb.ticking && bombAt !== null && !canFinishDefuse(ctx, s.bombPos)) {
        // Too late: no defuse can finish before the explosion. Give it up and save yourself (CS players do).
        s.abandoned = true;
        return escape();
      }
      if (self.team === 'CT' && s.bombPos !== null && ctx.bomb.ticking) {
        const range = tuning.bomb.defuseRange * ai.defuseRangeFactor;
        if (dist2d(self.pos, s.bombPos) <= range) {
          // Check for visible Ts first: only defuse with none in sight.
          const enemyInSight = ctx.others.some((o) => o.alive && isEnemy(self, o) && ctx.sees.includes(o.id));
          if (!enemyInSight) return plan('defusing', null, bearing(self.pos, s.bombPos), true, gun);
          return plan('holding', null, bearing(self.pos, s.bombPos));
        }
        return plan('moving', snapToNav(nav, s.bombPos), null, false, gun, range);
      }
      return holdAt(defaultSpot());
    }
    case 'hunt': {
      if (s.lastKnown !== null && tick - s.lastKnown.tick <= sec(ai.memorySec)) {
        const there = snapToNav(nav, s.lastKnown.pos);
        if (dist2d(self.pos, there) > arrive) return plan('hunting', there, null);
        // Reached it without contact: forget it and look around from there.
        s.lastKnown = null;
        s.spot = copy(self.pos);
        s.holdYaw = null;
      }
      return holdAt(defaultSpot(), 'searching');
    }
    case 'rotate':
    case 'hold':
      return holdAt(defaultSpot());
    case 'rejoin': {
      // G1: heading back to its recorded track (the Core picked `goal.hold` so it arrives in time): run there, never
      // WALK (time matters more than noise here), and wait; the Core switches it to REPLAY on the way or there.
      // It keeps what it holds (the Core may have drawn the c4 for a planter going back into his plant window);
      // a fight draws the best gun as always.
      const spot = defaultSpot();
      if (dist2d(self.pos, spot) > arrive) {
        s.holdYaw = null;
        return { ...plan('rejoining', spot, null, false, null), walk: false };
      }
      s.holdYaw ??= roundNumber(holdFacing(ctx, s, spot));
      return { ...plan('rejoining', null, s.holdYaw, false, null), walk: false };
    }
  }
}

function guardPlan(
  s: AiState,
  ctx: AiContext,
  plan: (b: AiBehaviour, dest: Vec3 | null, faceYaw: number | null) => RolePlan,
  holdAt: (spot: Vec3, behaviour?: AiBehaviour) => RolePlan,
  defaultSpot: () => Vec3,
): RolePlan {
  const bomb = s.bombPos;
  if (bomb === null || !ctx.bomb.ticking) return holdAt(defaultSpot());
  if (s.spot === null || dist2d(s.spot, bomb) > ctx.tuning.ai.guardMaxUnits) {
    s.spot = guardSpot(ctx, bomb) ?? copy(ctx.self.pos);
    s.holdYaw = null;
  }
  if (dist2d(ctx.self.pos, s.spot) > ctx.tuning.ai.arriveUnits) return plan('moving', s.spot, null);
  return plan('guarding', null, roundNumber(bearing(ctx.self.pos, bomb)));
}

/**
 * Steer along the nav path to `dest`: (re)plan when the destination changes, skip ahead to the furthest later path
 * point reachable in a straight walkable line, re-plan from the current position when the next point isn't, ease
 * off within 48 units of the end, and repath with a sideways nudge when the remaining length hasn't dropped by
 * stuckProgressUnits in stuckSec. null once within arriveUnits.
 */
function followPath(s: AiState, ctx: AiContext, dest: Vec3, arriveUnits: number): { dirX: number; dirY: number; mag: number } | null {
  const { nav, self, tick, tuning } = ctx;
  const ai = tuning.ai;
  const pos = self.pos;
  if (dist2d(pos, dest) <= arriveUnits) {
    s.path = [];
    s.dest = copy(dest);
    return null;
  }
  const replan = (): void => {
    const p = nav.path(pos, dest);
    s.path = p === null ? [copy(pos), copy(dest)] : p.map((q) => ({ x: roundNumber(q.x), y: roundNumber(q.y), z: roundNumber(q.z) }));
    s.pathIndex = Math.min(1, s.path.length - 1);
    s.dest = copy(dest);
    s.progressTick = tick;
    s.progressDist = -1;
  };
  if (s.dest === null || dist2d(s.dest, dest) > 1 || s.path.length === 0) replan();
  const path = s.path;
  // Advance past reached points and skip ahead where a straight walkable line allows.
  while (s.pathIndex < path.length - 1 && dist2d(pos, path[s.pathIndex] as Vec3) <= ai.arriveUnits * 0.5) s.pathIndex++;
  for (let j = path.length - 1; j > s.pathIndex; j--) {
    if (nav.segmentWalkable(pos, path[j] as Vec3)) {
      s.pathIndex = j;
      break;
    }
  }
  // Off the corridor (a corner cut short): re-plan from here, so the first leg is walkable again.
  if (!nav.segmentWalkable(pos, path[s.pathIndex] as Vec3) && nav.isWalkable(pos)) {
    const keep = { progressTick: s.progressTick, progressDist: s.progressDist };
    replan();
    s.progressTick = keep.progressTick;
    s.progressDist = keep.progressDist;
  }
  const next = s.path[s.pathIndex] as Vec3;
  let remaining = dist2d(pos, next);
  for (let j = s.pathIndex; j < s.path.length - 1; j++) remaining += dist2d(s.path[j] as Vec3, s.path[j + 1] as Vec3);
  if (!(s.progressDist >= 0) || remaining < s.progressDist - ai.stuckProgressUnits) {
    s.progressDist = remaining;
    s.progressTick = tick;
  } else if (tick - s.progressTick > sec(ai.stuckSec)) {
    s.repaths++;
    s.unstickUntilTick = tick + sec(ai.unstickSec);
    s.unstickSide = draw(s, ctx.rng) < 0.5 ? -1 : 1;
    replan();
  }
  const d = Math.max(dist2d(pos, next), 1e-9);
  let dx = (next.x - pos.x) / d;
  let dy = (next.y - pos.y) / d;
  if (tick < s.unstickUntilTick) {
    // Sideways (right of the direction for +1): (dy, −dx).
    dx += s.unstickSide * dy;
    dy -= s.unstickSide * ((next.x - pos.x) / d);
    const l = Math.hypot(dx, dy);
    dx /= l;
    dy /= l;
  }
  const toEnd = dist2d(pos, dest);
  const mag = Math.min(1, Math.max(0.25, toEnd / 48));
  return { dirX: dx, dirY: dy, mag };
}
