/**
 * B1: recoil control for bots and puppets (docs/weapons.md, "Bots and puppets compensate recoil"). The bullet leaves
 * along view + aim punch × recoilScale (`fireShot`); a player keeps a spray on target by pulling the mouse against
 * the pattern, so at each shot the view is below (and beside) the target by exactly that offset. A bot does the same
 * perfectly: view = desired aim − the punch offset of the shot about to leave. The human's mechanics are unchanged.
 */
import { roundNumber } from '../../contracts/index';
import type { ArmsContext, ArmsState } from './arms';
import { decayPunch, punchOffset, type Angle2 } from './recoil';

/**
 * The punch offset `fireShot` will add to a shot fired on the next arms tick of `s` (the host's `trackArms` decays
 * the punch once before the shot of the same tick): punchOffset(decayPunch(punch, 1 / ticksPerSec)). With
 * `decayed` the state already had this tick's decay (after `trackArms`): punchOffset(punch).
 */
export function nextShotPunch(ctx: ArmsContext, s: ArmsState, decayed = false): Angle2 {
  const p = decayed ? s.punch : decayPunch(s.punch, 1 / ctx.ticksPerSec, ctx.model);
  return punchOffset(p, ctx.model);
}

/** The view that puts a bullet along `desired` despite the recoil: desired − punch (perfect recoil control). */
export function compensatedView(desired: Angle2, punch: Angle2): Angle2 {
  return { pitch: roundNumber(desired.pitch - punch.pitch), yaw: roundNumber(desired.yaw - punch.yaw) };
}
