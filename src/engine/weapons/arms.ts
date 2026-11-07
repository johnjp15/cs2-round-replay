/**
 * The per-player weapon state machine of the engine: deploy, fire rate (cycle time, semi / full auto, bursts, the
 * revolver's alt fire), magazine and shell-by-shell reloads, zoom levels, the accuracy penalty, the recoil index,
 * aim / view punch, and tagging (the victim's speed modifier). Plain data in, plain data out, one call per tick;
 * per-shot randomness from the caller's seeded RNG. docs/weapons.md, "Arms state machine".
 *
 * The host calls, per pawn and tick: `stepArms(ctx, state, input, rng)` → new state + the shot's pellet directions
 * (if it fired); it traces each pellet, applies `penetrate` + `damageAfterHitgroup`, and for every hit calls
 * `applyHit` on the victim's state. `maxSpeedOf` gives the movement code the speed cap.
 */
import { roundNumber, type DamageTuning, type Tuning, type Vec3, type WeaponModelTuning } from '../../contracts/index';
import { decayPenalty, drawSpread, inaccuracy, penaltyFloor, recoveryTime, shotDirection, type Motion, type UniformSource } from './accuracy';
import { applyKick, buildRecoilTables, decayPunch, punchOffset, recoilKick, ZERO_PUNCH, type Angle2, type PunchState, type RecoilTables } from './recoil';
import { shoots, weaponDef, type WeaponDef, type WeaponTable } from './table';

const TICK_EPS = 1e-9;
const NEVER = -1e9;

/** Everything the state machine needs besides the state: the table, the model constants and the recoil tables. */
export interface ArmsContext {
  readonly table: WeaponTable;
  readonly model: WeaponModelTuning;
  readonly damage: DamageTuning;
  readonly ticksPerSec: number;
  /** CS2 since March 2026: a reload throws away the rounds left in the magazine (`damage.reloadDiscardsMagazine`). */
  readonly discardMagazine: boolean;
  /** By weapon id. */
  readonly recoil: Readonly<Record<string, RecoilTables>>;
}

/** Build the context once per tuning. Throws if the tuning has no `weapons._engine` block. */
export function armsContext(table: WeaponTable, tuning: Pick<Tuning, 'weaponModel' | 'damage'>, ticksPerSec: number): ArmsContext {
  const model = tuning.weaponModel;
  if (model === undefined) throw new Error('tuning has no weapons._engine (the weapon model constants)');
  return { table, model, damage: tuning.damage, ticksPerSec, discardMagazine: tuning.damage.reloadDiscardsMagazine, recoil: buildRecoilTables(table, model) };
}

export type ReloadState = { readonly kind: 'magazine'; readonly endTick: number } | { readonly kind: 'shell'; readonly nextTick: number };

/** One player's arms. Ticks are fractional (rounded to 6 decimals), like sim2d's weapon timers. */
export interface ArmsState {
  /** Held weapon id (a key of the weapon table). */
  readonly weapon: string;
  readonly clip: number;
  /** Reserve rounds. */
  readonly reserve: number;
  /** Host-set alt mode for non-scoped weapons: burst on (Glock, FAMAS), silencer off (M4A1-S, USP-S). */
  readonly altMode: boolean;
  /** Zoom level, 0 = unscoped. Scoped weapons use their alt values when > 0. */
  readonly zoom: number;
  /** Zoom to restore once the bolt has cycled (AWP / SSG 08 unzoom after a shot). */
  readonly resumeZoom: number;
  readonly nextAttackTick: number;
  readonly nextAltTick: number;
  readonly deployEndTick: number;
  readonly reload: ReloadState | null;
  readonly shotThisPress: boolean;
  readonly altThisPress: boolean;
  /** Burst rounds still to fire, and when the next one is due. */
  readonly burstLeft: number;
  readonly burstNextTick: number;
  /** Accuracy penalty (CS `m_fAccuracyPenalty`). */
  readonly penalty: number;
  /** Bullets of the current spray (CS `m_flRecoilIndex`, decays when not firing). */
  readonly recoilIndex: number;
  readonly lastShotTick: number;
  readonly punch: PunchState;
  readonly wasOnGround: boolean;
  /** Tagging: 1 = full speed; set by applyHit, recovers over time. */
  readonly velocityModifier: number;
}

/** A fresh state holding `weapon` with a full magazine and its purchase reserve, deployed at `tick`. */
export function freshArms(ctx: ArmsContext, weapon: string, tick: number): ArmsState {
  const w = weaponDef(ctx.table, weapon);
  const base: ArmsState = {
    weapon,
    clip: w.clip,
    reserve: w.reserve,
    altMode: false,
    zoom: 0,
    resumeZoom: 0,
    nextAttackTick: 0,
    nextAltTick: 0,
    deployEndTick: 0,
    reload: null,
    shotThisPress: false,
    altThisPress: false,
    burstLeft: 0,
    burstNextTick: 0,
    penalty: w.inaccuracy.stand[0],
    recoilIndex: 0,
    lastShotTick: NEVER,
    punch: ZERO_PUNCH,
    wasOnGround: true,
    velocityModifier: 1,
  };
  return deploy(ctx, base, weapon, base.clip, base.reserve, tick);
}

/**
 * Switch to `weapon` (with its own ammo) at `tick`: deploy timer started, reload, burst and zoom cancelled, the
 * recoil index and the penalty reset to the new weapon's standing value (CS2 keeps punch and tagging, which belong
 * to the player).
 */
export function deploy(ctx: ArmsContext, s: ArmsState, weapon: string, clip: number, reserve: number, tick: number): ArmsState {
  const w = weaponDef(ctx.table, weapon);
  const end = roundNumber(tick + w.deployTime * ctx.ticksPerSec);
  return {
    ...s,
    weapon,
    clip,
    reserve,
    altMode: false,
    zoom: 0,
    resumeZoom: 0,
    nextAttackTick: end,
    nextAltTick: end,
    deployEndTick: end,
    reload: null,
    shotThisPress: false,
    altThisPress: false,
    burstLeft: 0,
    penalty: w.inaccuracy.stand[0],
    recoilIndex: 0,
    lastShotTick: NEVER,
  };
}

/** Which value of each `Pair` applies: alt (1) when scoped, or in the host-set alt mode for unscoped weapons. */
export function modeOf(w: WeaponDef, s: Pick<ArmsState, 'zoom' | 'altMode'>): 0 | 1 {
  if (w.zoom.levels > 0) return s.zoom > 0 ? 1 : 0;
  return s.altMode ? 1 : 0;
}

/** The player's speed cap with this weapon now: maxSpeed[mode] × tagging modifier (× attackMovespeedFactor while firing). */
export function maxSpeedOf(ctx: ArmsContext, s: ArmsState, attacking: boolean): number {
  const w = weaponDef(ctx.table, s.weapon);
  return w.maxSpeed[modeOf(w, s)] * s.velocityModifier * (attacking ? w.attackMovespeedFactor : 1);
}

export interface ArmsInput {
  readonly tick: number;
  readonly attack: boolean;
  readonly attack2: boolean;
  readonly reload: boolean;
  /** View angles (degrees, Source pitch + = down, yaw counter-clockwise from +x). */
  readonly view: Angle2;
  readonly motion: Motion;
}

export interface Shot {
  /** Unit directions, one per pellet. */
  readonly pellets: readonly Vec3[];
  /** Inaccuracy and spread (tangent units) the shot was drawn with. */
  readonly inaccuracy: number;
  readonly spread: number;
  /** The punched view the shot left along (view + aim punch × recoilScale). */
  readonly aim: Angle2;
  /** Recoil index of this shot (0 = first bullet of a spray). */
  readonly recoilIndex: number;
}

export interface ArmsStep {
  readonly state: ArmsState;
  readonly shot: Shot | null;
  readonly reloadStarted: boolean;
  readonly reloadDone: boolean;
  /** The weapon tried to fire on an empty magazine (CS's dry-fire click). */
  readonly dryFire: boolean;
}

/**
 * Fire one shot now (no cadence or ammo checks: stepArms does those): the inaccuracy from the current penalty and
 * motion, the cone draw, the direction along view + punch × recoilScale; then the penalty += fire inaccuracy, the
 * recoil index + 1 and the recoil kick.
 */
export function fireShot(ctx: ArmsContext, s: ArmsState, rng: UniformSource, view: Angle2, motion: Motion, tick: number): { state: ArmsState; shot: Shot } {
  const w = weaponDef(ctx.table, s.weapon);
  const mode = modeOf(w, s);
  const m = ctx.model;
  const inacc = inaccuracy(w, mode, s.penalty, motion, m);
  const off = drawSpread(w, mode, inacc, s.recoilIndex, rng);
  const po = punchOffset(s.punch, m);
  const aim = { pitch: roundNumber(view.pitch + po.pitch), yaw: roundNumber(view.yaw + po.yaw) };
  const pellets = off.pellets.map((o) => shotDirection(aim, o));
  const tables = ctx.recoil[w.id];
  if (tables === undefined) throw new Error(`no recoil table for ${w.id}`);
  const punch = applyKick(s.punch, recoilKick(tables, mode, s.recoilIndex, m), m);
  const state: ArmsState = {
    ...s,
    penalty: roundNumber(Math.min(m.maxInaccuracy, s.penalty + w.inaccuracy.fire[mode])),
    recoilIndex: roundNumber(s.recoilIndex + 1),
    lastShotTick: tick,
    punch,
  };
  return { state, shot: { pellets, inaccuracy: roundNumber(inacc), spread: w.spread[mode], aim, recoilIndex: s.recoilIndex } };
}

/**
 * One tick, in this order:
 * 1. Take-off adds jumpInitial × airSpreadScale to the penalty; landing adds land[mode] × airSpreadScale.
 * 2. The penalty decays toward its floor (accuracy.ts); the recoil index decays (e^(−recoilIndexDecay·dt)) once no
 *    shot came for recoilIndexDelayCycles × the cycle time.
 * 3. Reloads progress: a magazine reload refills at its end (from reserve; a fresh magazine when discardMagazine);
 *    a shell reload loads one shell every shellReloadSec after reloadTime, until full or out of reserve.
 * 4. ATTACK2: scoped weapons step the zoom (0 → 1 → … → 0), burst weapons and detachable silencers toggle alt mode;
 *    the revolver's ATTACK2 fires (alt cycle time).
 * 5. Fire (ATTACK or a pending burst round): deployed, cycle ready, clip > 0, not in a magazine reload (a shell
 *    reload is interrupted), and for semi-automatic weapons the first tick of the press. Held fire keeps the
 *    fractional cadence like sim2d (AK-47: ticks 0, 7, 13, 20, …). Snipers that unzoom after a shot re-zoom once
 *    the bolt has cycled.
 * 6. Reload start: RELOAD with a magazine that is not full, or an empty magazine once the cycle is ready.
 * 7. Aim / view punch decay; tagging recovers.
 */
export function stepArms(ctx: ArmsContext, s0: ArmsState, inp: ArmsInput, rng: UniformSource): ArmsStep {
  const w = weaponDef(ctx.table, s0.weapon);
  const m = ctx.model;
  const tps = ctx.ticksPerSec;
  const dt = 1 / tps;
  const t = inp.tick;
  const mot = inp.motion;
  let s: ArmsState = s0;
  let mode = modeOf(w, s);

  // 1. take-off / landing
  let penalty = s.penalty;
  if (s.wasOnGround && !mot.onGround && !mot.onLadder) penalty += w.inaccuracy.jumpInitial * m.airSpreadScale;
  else if (!s.wasOnGround && mot.onGround) penalty += w.inaccuracy.land[mode] * m.airSpreadScale;
  // 2. penalty and recoil index decay
  const reloading = s.reload !== null;
  penalty = decayPenalty(penalty, penaltyFloor(w, mode, mot, reloading, m), recoveryTime(w, mot.crouched, s.recoilIndex), dt, m);
  let recoilIndex = s.recoilIndex;
  if (t > s.lastShotTick + m.recoilIndexDelayCycles * w.cycleTime[mode] * tps + TICK_EPS) recoilIndex = roundNumber(recoilIndex * Math.exp(-m.recoilIndexDecay * dt));
  s = { ...s, penalty, recoilIndex, wasOnGround: mot.onGround || mot.onLadder };

  let shot: Shot | null = null;
  let reloadStarted = false;
  let reloadDone = false;
  let dryFire = false;
  const deployed = reached(t, s.deployEndTick);

  if (shoots(w)) {
    // 3. reloads
    if (s.reload !== null && s.reload.kind === 'magazine' && reached(t, s.reload.endTick)) {
      const clip = ctx.discardMagazine ? 0 : s.clip;
      const moved = Math.max(0, Math.min(w.clip - clip, s.reserve));
      s = { ...s, clip: clip + moved, reserve: s.reserve - moved, reload: null };
      reloadDone = true;
    } else if (s.reload !== null && s.reload.kind === 'shell' && reached(t, s.reload.nextTick)) {
      const clip = s.clip + 1;
      const reserve = s.reserve - 1;
      const done = clip >= w.clip || reserve <= 0;
      s = { ...s, clip, reserve, reload: done ? null : { kind: 'shell', nextTick: roundNumber(s.reload.nextTick + m.shellReloadSec * tps) } };
      reloadDone = done;
    }
    // re-zoom after the bolt cycled
    if (s.resumeZoom > 0 && reached(t, s.nextAttackTick)) s = { ...s, zoom: s.resumeZoom, resumeZoom: 0 };
    // 4. ATTACK2
    let altFire = false;
    if (inp.attack2 && !s.altThisPress && deployed && reached(t, s.nextAltTick)) {
      if (w.zoom.levels > 0) {
        if (s.reload === null) s = { ...s, zoom: (s.zoom + 1) % (w.zoom.levels + 1), resumeZoom: 0, nextAltTick: roundNumber(t + w.zoom.times[1] * tps) };
      } else if (w.revolver) {
        altFire = true;
      } else if (w.burst !== null || w.silencer === 'detachable') {
        s = { ...s, altMode: !s.altMode };
      }
      s = { ...s, altThisPress: true };
    }
    mode = modeOf(w, s);
    // 5. fire
    const magReload = s.reload !== null && s.reload.kind === 'magazine';
    const burstDue = s.burstLeft > 0 && reached(t, s.burstNextTick);
    const pressFire = (inp.attack && (w.fullAuto || !s.shotThisPress)) || (altFire && w.revolver);
    const wantFire = deployed && !magReload && (burstDue || (pressFire && reached(t, s.nextAttackTick)));
    if (wantFire && s.clip <= 0) {
      dryFire = !burstDue && pressFire && !s.shotThisPress;
      s = { ...s, burstLeft: 0 };
    } else if (wantFire) {
      if (s.reload !== null) s = { ...s, reload: null };
      const fireMode: 0 | 1 = altFire ? 1 : mode;
      const res = fireShot(ctx, { ...s, ...(altFire ? { altMode: true } : {}) }, rng, inp.view, mot, t);
      s = { ...res.state, altMode: s.altMode, clip: s.clip - 1 };
      shot = res.shot;
      const cycle = (w.revolver ? w.cycleTime[fireMode] : w.cycleTime[mode]) * tps;
      if (burstDue) {
        const left = s.burstLeft - 1;
        s = { ...s, burstLeft: left, burstNextTick: roundNumber(s.burstNextTick + (w.burst?.timeBetweenShots ?? 0) * tps) };
      } else if (w.burst !== null && s.altMode) {
        const left = m.burstShots - 1;
        s = {
          ...s,
          burstLeft: left,
          burstNextTick: roundNumber(t + w.burst.timeBetweenShots * tps),
          nextAttackTick: roundNumber(t + w.burst.cycleTime * tps),
          shotThisPress: true,
        };
      } else {
        const base = s.nextAttackTick > t - 1 ? s.nextAttackTick : t;
        s = { ...s, nextAttackTick: roundNumber(base + cycle), shotThisPress: inp.attack };
      }
      if (w.zoom.unzoomsAfterShot && s.zoom > 0) s = { ...s, resumeZoom: s.zoom, zoom: 0 };
    }
    // 6. reload start
    if (shot === null && deployed && s.reload === null && s.burstLeft === 0 && s.reserve > 0 && s.clip < w.clip) {
      if (inp.reload || (s.clip === 0 && reached(t, s.nextAttackTick))) {
        const start = roundNumber(t + w.reloadTime * tps);
        s = { ...s, zoom: 0, resumeZoom: 0, reload: w.reloadsSingleShells ? { kind: 'shell', nextTick: start } : { kind: 'magazine', endTick: start } };
        reloadStarted = true;
      }
    }
  }
  if (!inp.attack) s = { ...s, shotThisPress: false };
  if (!inp.attack2) s = { ...s, altThisPress: false };
  // 7. punch decay, tagging recovery
  const vm = Math.min(1, s.velocityModifier + m.taggingRecoveryPerSec * dt);
  s = { ...s, punch: decayPunch(s.punch, dt, m), velocityModifier: roundNumber(vm) };
  return { state: s, shot, reloadStarted, reloadDone, dryFire };
}

/**
 * The victim side of a hit by `attacker`'s weapon: tagging (speed modifier = min(current, flinch × taggingScale):
 * flinchLarge for the first hit while at full speed, flinchSmall after), the view punch kick (hitViewPunchDeg ×
 * flinchPunchScale, up) and, when the hit area had no armor, an aim punch kick (hitAimPunchDeg, up).
 */
export function applyHit(ctx: ArmsContext, victim: ArmsState, attackerWeapon: string, armored: boolean): ArmsState {
  const w = weaponDef(ctx.table, attackerWeapon);
  const m = ctx.model;
  const flinch = victim.velocityModifier >= 1 ? w.flinchLarge : w.flinchSmall;
  const vm = Math.min(victim.velocityModifier, Math.max(0, Math.min(1, flinch * m.taggingScale)));
  const p = victim.punch;
  const aimKick = armored ? 0 : m.hitAimPunchDeg;
  return {
    ...victim,
    velocityModifier: roundNumber(vm),
    punch: {
      aim: { pitch: roundNumber(p.aim.pitch - aimKick), yaw: p.aim.yaw },
      aimVel: p.aimVel,
      view: { pitch: roundNumber(p.view.pitch - m.hitViewPunchDeg * m.flinchPunchScale), yaw: p.view.yaw },
    },
  };
}

function reached(tick: number, t: number): boolean {
  return tick + TICK_EPS >= t;
}
