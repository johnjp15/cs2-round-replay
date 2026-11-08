/**
 * H6: the round's money, CS2 competitive (docs/app3d.md "HUD"): each player's cash from the round's starting money
 * (round.json `players[].startMoney`, read off the video's HUD; null for players whose money the video never shows)
 * plus this round's awards as they happen, and the award flashes ("+$300") the HUD shows.
 *
 * CS2's numbers (SteamDatabase/GameTracking-CS2, `game/csgo/cfg/gamemode_competitive.cfg`):
 * - a kill: the weapon's `m_nKillAward` (weapons.vdata, our data/weapons.json `killAward`: rifles and pistols $300,
 *   AWP $100, knife $1500, grenades $300) × `cash_player_killed_enemy_factor` 1; a teammate −$300
 *   (`cash_player_killed_teammate`);
 * - `cash_player_bomb_planted` $300 to the planter, `cash_player_bomb_defused` $300 to the defuser;
 * - round end, the winners: `cash_team_terrorist_win_bomb` / `cash_team_win_by_defusing_bomb` $3500,
 *   `cash_team_elimination_bomb_map` $3250, `cash_team_win_by_time_running_out_bomb` $3250;
 * - the losers: `cash_team_loser_bonus` $1400 (the first step of the loss streak; `cash_team_loser_bonus_consecutive_rounds`
 *   +$500 a step; the streak before this round isn't recorded, and the tape's +$2200 for the Ts = $1400 + CS:GO's $800
 *   plant bonus says it was the first step), plus `cash_team_planted_bomb_but_defused` $600 to the Ts when the bomb was
 *   planted (CS:GO 2020: $800, hence the video's +$2200; CS2 gives +$2000); Ts alive when the time runs out get
 *   nothing (CS2's "+$0 penalty for running out of time", `Team_Cash_Award_no_income`);
 * - `mp_maxmoney` $16000.
 * Not modelled: CS2's `cash_team_bonus_shorthanded` and the purchases (the round starts after the buy time).
 * The HUD flash lasts CS2's `AddMoneyTime: 2.9s` (`panorama/styles/hud/hudmoney.css`).
 */
import weaponsJson from '../../data/weapons.json';
import type { Observe, PlayerId, RoundEndReason, Team } from '../contracts/index';

export const CASH = {
  killedTeammate: -300,
  bombPlanted: 300,
  bombDefused: 300,
  winBomb: 3500,
  winDefuse: 3500,
  winElimination: 3250,
  winTime: 3250,
  loserBonus: 1400,
  plantedButLost: 600,
  max: 16000,
} as const;

/** CS2's money flash (hudmoney.css AddMoneyTime 2.9 s), in ticks. */
export const AWARD_FLASH_TICKS = Math.round(2.9 * 64);

const TABLE = (weaponsJson as { weapons: Record<string, { killAward?: number }> }).weapons;

/** A kill's award with `weapon` (weapons.vdata m_nKillAward; 0 for world damage). */
export function killAward(weapon: string | null): number {
  if (weapon === null) return 0;
  return TABLE[weapon]?.killAward ?? 300;
}

/**
 * The team's round-end income for `winner` winning by `reason` (the bomb planted this round or not; the player alive
 * at the end or not): CS2's award lines, amount and text (`Team_Cash_Award_*`).
 */
export function roundIncome(team: Team, winner: Team, reason: RoundEndReason, planted: boolean, alive: boolean): { amount: number; text: string }[] {
  const line = (amount: number, why: string): { amount: number; text: string } => ({ amount, text: ` +$${amount} ${why}` });
  if (team === winner) {
    if (reason === 'bomb_exploded') return [line(CASH.winBomb, 'team income for detonating bomb')];
    if (reason === 'bomb_defused') return [line(CASH.winDefuse, 'team income for defusing the C4')];
    return [reason === 'time' ? line(CASH.winTime, 'team income for running down the clock') : line(CASH.winElimination, 'team income for eliminating the enemy team')];
  }
  if (team === 'T' && reason === 'time' && alive) return [line(0, 'penalty for running out of time')];
  const out = [line(CASH.loserBonus, 'team income for losing')];
  if (team === 'T' && planted) out.push(line(CASH.plantedButLost, 'team income for planting the bomb'));
  return out;
}

export interface CashAward {
  readonly tick: number;
  readonly id: PlayerId;
  readonly amount: number;
  /** CS2's line for it (`Player_Cash_Award_*` / `Team_Cash_Award_*` in csgo_english.txt). */
  readonly text: string;
}

export interface PlayerCash {
  readonly id: PlayerId;
  readonly team: Team;
  /** Starting money, or null when the round doesn't know it. */
  readonly startMoney: number | null;
}

/** Money per player through the round, from the observes' events (death, bomb, round_end). */
export class Economy {
  private readonly players: readonly PlayerCash[];
  private readonly cash = new Map<PlayerId, number>();
  private awards: CashAward[] = [];
  private planted = false;

  constructor(players: readonly PlayerCash[]) {
    this.players = players;
    this.reset();
  }

  reset(): void {
    this.cash.clear();
    this.awards = [];
    this.planted = false;
    for (const p of this.players) if (p.startMoney !== null) this.cash.set(p.id, p.startMoney);
  }

  /** One observe's events (stamped `tick`, the host tick they happened in). */
  ingest(o: Observe, tick = o.tick - 1): void {
    const team = (id: PlayerId | null): Team | null => (id === null ? null : (this.players.find((p) => p.id === id)?.team ?? null));
    for (const e of o.events) {
      if (e.type === 'death') {
        if (e.attacker === null || e.attacker === e.victim) continue;
        const a = team(e.attacker);
        const v = team(e.victim);
        if (a === null || v === null) continue;
        if (a === v) this.award(tick, e.attacker, CASH.killedTeammate, ` -$${-CASH.killedTeammate} penalty for killing a friendly`);
        else {
          const amount = killAward(e.weapon);
          this.award(tick, e.attacker, amount, ` +$${amount} for neutralizing an enemy`);
        }
      } else if (e.type === 'bomb') {
        if (e.phase === 'planted') {
          this.planted = true;
          if (e.id !== null) this.award(tick, e.id, CASH.bombPlanted, ` +$${CASH.bombPlanted} for planting the C4`);
        } else if (e.phase === 'defused' && e.id !== null) this.award(tick, e.id, CASH.bombDefused, ` +$${CASH.bombDefused} for defusing the C4`);
      } else if (e.type === 'round_end') {
        for (const p of this.players) {
          const alive = o.pawns.find((q) => q.id === p.id)?.alive === true;
          for (const a of roundIncome(p.team, e.winner, e.reason, this.planted, alive)) this.award(tick, p.id, a.amount, a.text);
        }
      }
    }
  }

  /** Cash now, or null when the player's starting money isn't known. */
  money(id: PlayerId): number | null {
    return this.cash.get(id) ?? null;
  }

  /** The player's awards still flashing at `tick` (newest last). */
  flashes(id: PlayerId, tick: number): CashAward[] {
    return this.awards.filter((a) => a.id === id && a.tick <= tick && tick - a.tick < AWARD_FLASH_TICKS);
  }

  /** Every award so far (oldest first). */
  all(): readonly CashAward[] {
    return this.awards;
  }

  private award(tick: number, id: PlayerId, amount: number, text: string): void {
    this.awards.push({ tick, id, amount, text });
    if (this.awards.length > 64) this.awards = this.awards.slice(-64);
    const c = this.cash.get(id);
    if (c !== undefined) this.cash.set(id, Math.max(0, Math.min(CASH.max, c + amount)));
  }
}
