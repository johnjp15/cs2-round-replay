/**
 * W3: CS2's team-damage notices (docs/combat.md "Friendly fire"), pure, from the observe's `damage` events:
 * - a feed line "<attacker> attacked a teammate" (`#Cstrike_TitlesTXT_Game_teammate_attack`), at most once per attacker
 *   every CS_WarnFriendlyDamageInterval (3 s), shown for FEED_SEC;
 * - the attacker's own hint "Try not to injure your teammates" (`#Cstrike_TitlesTXT_Hint_try_not_to_injure_teammates`)
 *   for HINT_SEC after it hurt a teammate.
 * As in CS (`CCSPlayer::OnTakeDamage`), fire damage (molotov / incendiary) gives neither, and neither does damage to
 * yourself. Strings: csgo_english.txt (GameTracking-CS2).
 */
import type { Observe, PlayerId } from '../contracts/index';

const TICKS = 64;
/** CS `CS_WarnFriendlyDamageInterval` 3 (s). */
export const WARN_INTERVAL_SEC = 3;
export const FEED_SEC = 5;
export const HINT_SEC = 3;
export const HINT_TEXT = 'Try not to injure your teammates';

export class TeamDamageNotes {
  private lines: { attacker: PlayerId; tick: number }[] = [];
  private lastWarn = new Map<PlayerId, number>();
  private lastHurt = new Map<PlayerId, number>();

  clear(): void {
    this.lines = [];
    this.lastWarn.clear();
    this.lastHurt.clear();
  }

  ingest(o: Observe): void {
    for (const e of o.events) {
      if (e.type !== 'damage' || e.attacker === null || e.attacker === e.victim) continue;
      if (e.weapon === 'molotov' || (e.weapon as string) === 'incendiary') continue;
      const a = o.pawns.find((p) => p.id === e.attacker);
      const v = o.pawns.find((p) => p.id === e.victim);
      if (a === undefined || v === undefined || a.team !== v.team) continue;
      this.lastHurt.set(a.id, o.tick);
      const w = this.lastWarn.get(a.id);
      if (w !== undefined && o.tick - w < WARN_INTERVAL_SEC * TICKS && o.tick >= w) continue;
      this.lastWarn.set(a.id, o.tick);
      this.lines.push({ attacker: a.id, tick: o.tick });
    }
  }

  /** Feed lines visible at `tick`, oldest first. */
  feed(tick: number): string[] {
    this.lines = this.lines.filter((l) => tick >= l.tick && tick - l.tick < FEED_SEC * TICKS);
    return this.lines.map((l) => `${l.attacker} attacked a teammate`);
  }

  /** The hint for `human` at `tick`, or null. */
  hint(human: PlayerId | null, tick: number): string | null {
    if (human === null) return null;
    const t = this.lastHurt.get(human);
    return t !== undefined && tick >= t && tick - t < HINT_SEC * TICKS ? HINT_TEXT : null;
  }
}
