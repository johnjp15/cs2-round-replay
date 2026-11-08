/**
 * H6: the 3D HUD's CS2 rules (team-correct bomb HUD, plant alert, win banner) and the money (economy.ts). Backlog
 * #65, #67. (The death fade, #85, is tests/app3d-spectate.test.ts.)
 */
import { describe, expect, it } from 'vitest';
import type { ObsEvent, Observe, PawnObs, PlayerId, RoundObs, Team } from '../src/contracts/index';
import { NO_BOMB, type BombState } from '../src/app/scene';
import { PLANT_ALERT_FADE_TICKS, PLANT_ALERT_TICKS, bombHud, plantAlert, winBanner } from '../src/app3d/hud3d';
import { AWARD_FLASH_TICKS, CASH, Economy, killAward, roundIncome, type PlayerCash } from '../src/app3d/economy';
import { liveRound } from './fakes';

function pawn(id: PlayerId, team: Team, extra: Partial<PawnObs> = {}): PawnObs {
  return {
    id,
    team,
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    hp: 100,
    armor: 100,
    alive: true,
    weapon: 'ak47',
    ammo: { clip: 30, reserve: 90 },
    crouching: false,
    onGround: true,
    sees: [],
    ...extra,
  };
}

const PAWNS = [pawn('cart', 'T'), pawn('barely', 'T'), pawn('sp4rtan', 'CT'), pawn('lokier', 'CT')];

function obs(tick: number, round: Partial<RoundObs> = {}, events: ObsEvent[] = [], pawns: PawnObs[] = PAWNS): Observe {
  return { tick, t: tick / 64, pawns, events, human: null, round: { ...liveRound(tick), ...round } };
}

/** The round during sp4rtan's defuse (ticks 3955 → 4275, a 5 s kit defuse). */
const defusing = (tick: number): Observe =>
  obs(tick, { phase: 'planted', timeLeftSec: 12, bomb: { state: 'planted', carrier: null, pos: { x: 0, y: 0, z: 0 }, plantTick: 1761, defuser: 'sp4rtan', defuseEndTick: 4275 } });
const SCENE_BOMB: BombState = { ...NO_BOMB, phase: 'defusing', plantTick: 1761, defuser: 'sp4rtan', defuseStartTick: 3955 };

describe('bomb HUD, team-correct (#65)', () => {
  it('before the plant: the round clock, no C4 icon, no defuse bar', () => {
    expect(bombHud(obs(100), NO_BOMB, 'cart', 'T')).toEqual({ icon: null, defuse: null });
  });

  it('planted: both teams get the pulsing C4 icon, no countdown; it pulses faster as the timer runs out', () => {
    const at = (left: number): Observe => obs(2000, { phase: 'planted', timeLeftSec: left, bomb: { state: 'planted', carrier: null, pos: null, plantTick: 1761, defuser: null, defuseEndTick: null } });
    expect(bombHud(at(30), NO_BOMB, 'cart', 'T').icon).toBe('pulse-slow');
    expect(bombHud(at(30), NO_BOMB, 'sp4rtan', 'CT').icon).toBe('pulse-slow');
    expect(bombHud(at(8), NO_BOMB, 'cart', 'T').icon).toBe('pulse-medium');
    expect(bombHud(at(3), NO_BOMB, 'cart', 'T').icon).toBe('pulse-fast');
  });

  it('the defuse bar is the defusing CT\'s alone: not a T, not another CT', () => {
    const o = defusing(4115);
    const me = bombHud(o, SCENE_BOMB, 'sp4rtan', 'CT');
    expect(me.defuse).not.toBeNull();
    expect(me.defuse?.kit).toBe(true);
    expect(me.defuse?.progress).toBeCloseTo(0.5, 5);
    expect(bombHud(o, SCENE_BOMB, 'cart', 'T').defuse).toBeNull();
    expect(bombHud(o, SCENE_BOMB, 'lokier', 'CT').defuse).toBeNull();
    // Keyed off the viewed pawn's team, not a constant: a T can't see it even as the "viewer" id.
    expect(bombHud(o, SCENE_BOMB, 'sp4rtan', 'T').defuse).toBeNull();
  });

  it('defused: the green icon; exploded: the red one', () => {
    expect(bombHud(obs(4300, { bomb: { state: 'defused', carrier: null, pos: null, plantTick: 1761, defuser: 'sp4rtan', defuseEndTick: 4275 } }), NO_BOMB, 'cart', 'T').icon).toBe('defused');
    expect(bombHud(obs(4400, { bomb: { state: 'exploded', carrier: null, pos: null, plantTick: 1761, defuser: null, defuseEndTick: null } }), NO_BOMB, 'cart', 'T').icon).toBe('exploded');
  });
});

describe('plant alert and win banner (#67)', () => {
  it('"The bomb has been planted" for 3.7 s, fading over 1 s', () => {
    expect(plantAlert(null, 100, 40)).toBeNull();
    expect(plantAlert(1761, 1760, 40)).toBeNull();
    expect(plantAlert(1761, 1761, 40)).toEqual({ sub: '40 seconds till detonation', opacity: 1 });
    expect(plantAlert(1761, 1761 + PLANT_ALERT_TICKS - 1, 40)?.opacity).toBe(1);
    expect(plantAlert(1761, 1761 + PLANT_ALERT_TICKS + PLANT_ALERT_FADE_TICKS / 2, 40)?.opacity).toBe(0.5);
    expect(plantAlert(1761, 1761 + PLANT_ALERT_TICKS + PLANT_ALERT_FADE_TICKS, 40)).toBeNull();
  });

  it("CS2's win banner with the reason", () => {
    expect(winBanner(null, null)).toBeNull();
    expect(winBanner('CT', 'bomb_defused')).toEqual({ team: 'CT', title: 'Counter-Terrorists Win', reason: 'The bomb has been defused' });
    expect(winBanner('T', 'bomb_exploded')).toEqual({ team: 'T', title: 'Terrorists Win', reason: 'Target successfully bombed' });
    expect(winBanner('CT', 'time')?.reason).toBe('Target has been saved');
    expect(winBanner('T', 'elimination')?.reason).toBe('');
  });
});

describe('money (#67)', () => {
  const players: PlayerCash[] = [
    { id: 'cart', team: 'T', startMoney: 5850 },
    { id: 'barely', team: 'T', startMoney: 2700 },
    { id: 'sp4rtan', team: 'CT', startMoney: null },
    { id: 'lokier', team: 'CT', startMoney: null },
  ];

  it("kill awards are the weapon's (weapons.vdata), the plant and defuse $300", () => {
    expect(killAward('ak47')).toBe(300);
    expect(killAward('awp')).toBe(100);
    expect(killAward('knife')).toBe(1500);
    expect(killAward(null)).toBe(0);
    const e = new Economy(players);
    e.ingest(obs(1204, {}, [{ type: 'death', victim: 'lokier', attacker: 'cart', weapon: 'ak47', headshot: true }]));
    expect(e.money('cart')).toBe(6150);
    expect(e.flashes('cart', 1203).map((a) => a.amount)).toEqual([300]);
    expect(e.flashes('cart', 1203 + AWARD_FLASH_TICKS)).toEqual([]);
    e.ingest(obs(1762, {}, [{ type: 'bomb', phase: 'planted', id: 'barely', pos: null }]));
    expect(e.money('barely')).toBe(3000);
    e.ingest(obs(4276, {}, [{ type: 'bomb', phase: 'defused', id: 'sp4rtan', pos: null }]));
    // sp4rtan's money isn't known (the video never shows it): no counter, but the flash.
    expect(e.money('sp4rtan')).toBeNull();
    expect(e.flashes('sp4rtan', 4275).map((a) => a.text)).toEqual([' +$300 for defusing the C4']);
  });

  it('round end: the winners $3500 for the defuse; the Ts the loss bonus + the plant bonus', () => {
    const e = new Economy(players);
    e.ingest(obs(1762, {}, [{ type: 'bomb', phase: 'planted', id: 'barely', pos: null }]));
    e.ingest(obs(4276, {}, [{ type: 'round_end', winner: 'CT', reason: 'bomb_defused' }]));
    expect(e.money('cart')).toBe(5850 + CASH.loserBonus + CASH.plantedButLost);
    expect(e.money('barely')).toBe(2700 + 300 + 1400 + 600);
    expect(e.flashes('cart', 4275).map((a) => a.amount)).toEqual([1400, 600]);
    expect(e.flashes('sp4rtan', 4275).map((a) => a.amount)).toEqual([3500]);
  });

  it('the other round ends', () => {
    expect(roundIncome('T', 'T', 'bomb_exploded', true, true)).toEqual([{ amount: 3500, text: ' +$3500 team income for detonating bomb' }]);
    expect(roundIncome('CT', 'CT', 'elimination', false, true)[0]?.amount).toBe(3250);
    expect(roundIncome('CT', 'CT', 'time', false, true)[0]?.amount).toBe(3250);
    // Ts alive when the time runs out get nothing; dead ones the loss bonus.
    expect(roundIncome('T', 'CT', 'time', false, true)).toEqual([{ amount: 0, text: ' +$0 penalty for running out of time' }]);
    expect(roundIncome('T', 'CT', 'time', false, false)[0]?.amount).toBe(1400);
    expect(roundIncome('CT', 'T', 'elimination', false, false)).toEqual([{ amount: 1400, text: ' +$1400 team income for losing' }]);
  });

  it('a teamkill costs $300; money stays within 0..16000', () => {
    const e = new Economy([{ id: 'cart', team: 'T', startMoney: 15900 }, { id: 'barely', team: 'T', startMoney: 100 }, { id: 'lokier', team: 'CT', startMoney: 0 }]);
    e.ingest(obs(10, {}, [{ type: 'death', victim: 'lokier', attacker: 'cart', weapon: 'knife', headshot: false }]));
    expect(e.money('cart')).toBe(16000);
    e.ingest(obs(11, {}, [{ type: 'death', victim: 'cart', attacker: 'barely', weapon: 'ak47', headshot: false }]));
    expect(e.money('barely')).toBe(0);
  });
});
