/**
 * G8: **Fate gone → LIVE for good** (docs/core.md "Fate gone: LIVE for good"). A pawn whose recorded death can no
 * longer happen has no recorded future to go back to: it plays the rest of the round as a normal player (LIVE, never
 * rejoined), with a role from the round state and its team instead of a goal cut from a tape that has it dead.
 *
 * - `fateGone`: alive after its recorded death. Killed by a REPLAY puppet on the tape: the scripted lethal hit lands on
 *   the kill-feed tick (B3), so alive one tick after it means it was dropped (the killer LIVE or dead, the victim LIVE):
 *   trigger `fate` at once. Killed by the human on the tape: his kill is a recorded duel that may land late (G5's
 *   shift), so as before only `outliveGraceSec` after it (trigger `outlived`, B4's trigger 4).
 * - `survivorGoal`: T → `execute` (docs/ai.md: on to the site the team takes, the recorded plant spot; the c4 carrier
 *   plants there, the others cover the plant and then guard the bomb); CT → `retake` (hold where its tape ended, go to
 *   the planted bomb and defuse once it hears it). The engine's AI fights whatever it sees on the way.
 *
 * Portable style (docs/port-notes.md): pure functions over the Observe and the round model, integer ticks, ids only in
 * the log texts.
 */
import type { Goal, Observe, PlayerId, Tuning } from '../contracts/index';
import { TICK_RATE } from './clock';
import { secTicks } from './scripted';
import type { RoundModel } from './round-model';

/** `status.trigger` of a pawn whose recorded death was dropped (its killer a puppet). */
export const FATE_TRIGGER = 'fate';
/** The LIVE role of a surviving T (docs/ai.md). */
export const EXECUTE_ROLE = 'execute';
/** The LIVE role of a surviving CT (docs/ai.md). */
export const RETAKE_ROLE = 'retake';

export interface FateGone {
  readonly id: PlayerId;
  /** `fate` (a puppet's kill of it was dropped) or `outlived` (the human's kill of it didn't come). */
  readonly trigger: 'fate' | 'outlived';
  /** For the log line: integers, tenths and ids only. */
  readonly reason: string;
}

/** Signed seconds with one decimal from integer ticks (as divergence.ts `tenthsText(ticks, true)`: 192 → "+3.0"). */
function tenths(ticks: number): string {
  const t = Math.floor((Math.abs(ticks) * 10) / TICK_RATE + 0.5);
  const body = `${String(Math.floor(t / 10))}.${String(t % 10)}`;
  return ticks < 0 && t !== 0 ? `-${body}` : `+${body}`;
}

/**
 * Whether `id`'s recorded death can no longer happen at observe `o`: alive, its recorded kill (the kill feed) by a
 * player other than the human is on a tick before `o.tick`, or the human's recorded kill of it is `outliveGraceSec` or
 * more ago. null otherwise (no recorded death, dead, the human, or still in time).
 */
export function fateGone(o: Observe, model: RoundModel, id: PlayerId, tuning: Tuning): FateGone | null {
  if (id === o.human) return null;
  const me = o.pawns.find((p) => p.id === id);
  if (me === undefined || !me.alive) return null;
  const death = model.deathTick(id);
  if (death === null) return null;
  const kill = model.kills.find((k) => k.victim === id && k.tick === death) ?? model.kills.find((k) => k.victim === id) ?? null;
  const killer = kill?.killer ?? null;
  if (killer !== null && killer === o.human) {
    if (o.tick < death + secTicks(tuning.replay.outliveGraceSec)) return null;
    return { id, trigger: 'outlived', reason: `outlived recording (${tenths(o.tick - death)} s)` };
  }
  if (o.tick <= death) return null;
  return { id, trigger: 'fate', reason: `alive after its recorded death (${killer ?? 'world'} at tick ${String(death)}): fate gone, LIVE for good` };
}

/**
 * The goal of a pawn LIVE for good (`fateGone`): its team's job from here, not its tape. T: `execute` toward the
 * recorded plant spot (the site the team takes; the AI plants with the c4, else covers the plant, and guards the bomb
 * once planted). CT: `retake`, holding where its recorded track ends until it knows where the planted bomb is.
 * No route: the AI walks the nav mesh.
 */
export function survivorGoal(model: RoundModel, id: PlayerId): Goal {
  const p = model.player(id);
  if (p.team === 'T') return { route: [], role: EXECUTE_ROLE, hold: { x: model.bomb.pos.x, y: model.bomb.pos.y, z: model.bomb.pos.z } };
  const track = model.track(id);
  const last = track[track.length - 1];
  return { route: [], role: RETAKE_ROLE, hold: last === undefined ? null : { x: last.x, y: last.y, z: last.z } };
}
