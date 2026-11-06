/**
 * The aim of a human who plays his own recording exactly (tools/follow-script.ts, the human-bot's followRecording).
 *
 * The shadow ReplayCore aims every recorded shot the way B3 aims a puppet's: at the target's position (its damage is
 * scripted, so where a puppet's bullet goes doesn't matter). For the human the engine decides, and the 2D sim has no
 * spread, so every such shot hits, including the ones the recording shows missing. Where the recording shows only
 * misses (an aim engagement with no damage or kill by the shooter on its target), a human playing it exactly looks
 * where the recording shows him looking instead: his recorded view yaw, wherever the camera follows him (the round's
 * `yaw` samples), with the stick re-expressed so he keeps moving the same way. The pitch stays B3's. Engagements with a
 * recorded hit keep B3's aim. docs/golden.md "Input scripts".
 *
 * For cart that is the defuse spray at sp4rtan (65.55–66.89 s: 11 shots, no damage; his recorded yaw tracks a fixed
 * point near (−2210, 275) within 0.8°, 17–22° off sp4rtan's spot) and the post-round spray (68.30–69.27 s).
 */
import { canonicalize, type PawnInput, type PlayerId, type RoundData, type Tuning } from '../src/contracts/index';
import { PuppetTrack, tOf, withLook, type Engagement, type EventSchedule, type RoundModel } from '../src/core/index';

/** Ticks after an engagement's last press in which a recorded hit still counts as its hit (the shot's latency). */
const HIT_SLACK_TICKS = 2;

/** The engagements of `id` in which the recording shows no hit on the target. */
export function missedEngagements(round: RoundData, plan: { engagementsOf(id: PlayerId): readonly Engagement[] }, id: PlayerId): Engagement[] {
  const hits = [...round.damage.map((d) => ({ a: d.attacker, v: d.victim, tick: d.tick })), ...round.kills.map((k) => ({ a: k.killer, v: k.victim, tick: k.tick }))];
  return plan.engagementsOf(id).filter((e) => !hits.some((h) => h.a === id && h.v === e.target && h.tick >= e.fromTick && h.tick <= e.toTick + HIT_SLACK_TICKS));
}

export class FollowAim {
  readonly id: PlayerId;
  /** Engagements the recording shows him missing. */
  readonly misses: readonly Engagement[];
  private readonly track: PuppetTrack;

  constructor(round: RoundData, model: RoundModel, schedule: EventSchedule, tuning: Tuning, plan: { engagementsOf(id: PlayerId): readonly Engagement[] }, id: PlayerId) {
    this.id = id;
    this.misses = missedEngagements(round, plan, id);
    this.track = PuppetTrack.fromModel(model, schedule, tuning, id);
  }

  /** The shadow's input for `tick`, with the recorded view yaw inside a missed engagement (where there is one). */
  adjust(tick: number, input: PawnInput): PawnInput {
    if (!this.misses.some((e) => tick >= e.fromTick && tick <= e.toTick)) return input;
    const rec = this.track.recordedYawAt(tOf(tick));
    return rec === null ? input : canonicalize(withLook(input, rec, input.pitch));
  }
}
