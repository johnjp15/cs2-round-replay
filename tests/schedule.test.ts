import { describe, expect, it } from 'vitest';
import { parseRound, type PlayerId } from '../src/contracts/index';
import { EventSchedule, SCHEDULE_TYPE_ORDER, ScheduleError, compareEntries, involves, tickOf, typeRank, type ScheduledEvent } from '../src/core/index';
import { loadRound, roundJson } from './round-fixture';

const round = loadRound();
const schedule = new EventSchedule(round);

// Kill table (project docs), copied here on purpose.
const KILLS: { t: number; killer: PlayerId; victim: PlayerId; weapon: string; hs: boolean; postRound?: boolean }[] = [
  { t: 0.5, killer: 'snarlbot', victim: 'incredibad', weapon: 'ak47', hs: false },
  { t: 12.4, killer: 'snarlbot', victim: 'snakelore', weapon: 'ak47', hs: false },
  { t: 12.75, killer: 'lokier', victim: 'eradicate', weapon: 'ssg08', hs: true },
  { t: 17.85, killer: 'sp4rtan', victim: 'snarlbot', weapon: 'deagle', hs: false },
  { t: 18.8, killer: 'cart', victim: 'lokier', weapon: 'ak47', hs: true },
  { t: 44.2, killer: 'barely', victim: 'zwomp', weapon: 'ak47', hs: false },
  { t: 50.35, killer: 'sp4rtan', victim: 'donk', weapon: 'ak47', hs: false },
  { t: 58.85, killer: 'sp4rtan', victim: 'barely', weapon: 'ak47', hs: true },
  { t: 69.4, killer: 'sp4rtan', victim: 'cart', weapon: 'ak47', hs: false, postRound: true },
];

describe('EventSchedule', () => {
  it('is sorted by (tick, type order, actor) and immutable', () => {
    expect(SCHEDULE_TYPE_ORDER.map(typeRank)).toEqual(SCHEDULE_TYPE_ORDER.map((_, i) => i));
    const ev = schedule.events;
    for (let i = 1; i < ev.length; i++) expect(compareEntries(ev[i - 1] as ScheduledEvent, ev[i] as ScheduledEvent), `entry ${i}`).toBeLessThanOrEqual(0);
    expect(Object.isFrozen(ev)).toBe(true);
    expect(new EventSchedule(round).events).toEqual(ev);
  });

  it('has the opening kill as lethal damage at tick 32', () => {
    const d = schedule.ofType('damage').find((e) => e.attacker === 'snarlbot' && e.victim === 'incredibad');
    expect(d).toEqual({ type: 'damage', tick: 32, attacker: 'snarlbot', victim: 'incredibad', amount: 100, armor: null, weapon: 'ak47', hitgroup: 'chest', lethal: true });
    expect(schedule.at(32).map((e) => e.type)).toEqual(['damage', 'kill']);
  });

  it('has every kill, each with lethal damage on its tick', () => {
    const kills = schedule.ofType('kill');
    expect(kills).toHaveLength(KILLS.length);
    for (const k of KILLS) {
      const e = kills.find((x) => x.killer === k.killer && x.victim === k.victim);
      expect(e, `${k.t} ${k.killer}→${k.victim}`).toBeDefined();
      if (e === undefined) continue;
      expect(Math.abs(e.tick - tickOf(k.t))).toBeLessThanOrEqual(1);
      expect({ weapon: e.weapon, headshot: e.headshot, postRound: e.postRound }).toEqual({ weapon: k.weapon, headshot: k.hs, postRound: k.postRound === true });
      const lethal = schedule.ofType('damage').filter((d) => d.victim === k.victim && d.lethal);
      expect(lethal, k.victim).toHaveLength(1);
      expect(lethal[0]).toMatchObject({ tick: e.tick, attacker: k.killer, weapon: k.weapon, hitgroup: k.hs ? 'head' : 'chest' });
    }
    expect(schedule.ofType('damage').filter((d) => d.lethal)).toHaveLength(KILLS.length);
  });

  it('walks donk 100 → 73 → 39 → 13 → 0 without damaging him twice', () => {
    const dmg = schedule.ofType('damage').filter((d) => d.victim === 'donk');
    expect(dmg.map((d) => [d.tick, d.amount, d.lethal])).toEqual([
      [tickOf(49.9), 27, false],
      [tickOf(50.0), 34, false],
      [tickOf(50.1), 26, false],
      [tickOf(50.35), 13, true],
    ]);
    let hp = round.players.find((p) => p.id === 'donk')?.startHp ?? 0;
    const walk = [hp];
    for (const d of dmg) walk.push((hp -= d.amount));
    expect(walk).toEqual([100, 73, 39, 13, 0]);
    // The 50.30 s killing shot keeps its own tick; its damage moved to the kill-feed tick.
    expect(schedule.at(tickOf(50.3))).toEqual([{ type: 'shot', tick: 3219, shooter: 'sp4rtan', weapon: 'ak47', target: 'donk', kind: 'shot_kill' }]);
    expect(schedule.at(3222).map((e) => e.type)).toEqual(['damage', 'kill']);
  });

  it('keeps cart\'s 73 HP / 7 armor hit from lokier as normal damage, and his post-round death at 27 HP', () => {
    const cart = schedule.ofType('damage').filter((d) => d.victim === 'cart');
    expect(cart).toEqual([
      { type: 'damage', tick: 1184, attacker: 'lokier', victim: 'cart', amount: 73, armor: 7, weapon: 'ssg08', hitgroup: 'chest', lethal: false },
      { type: 'damage', tick: 4442, attacker: 'sp4rtan', victim: 'cart', amount: 27, armor: null, weapon: 'ak47', hitgroup: 'chest', lethal: true },
    ]);
    expect(schedule.ofType('damage').find((d) => d.victim === 'snarlbot')?.amount).toBe(44);
  });

  it('has the plant and the defuse', () => {
    expect(schedule.ofType('plant')).toEqual([{ type: 'plant', tick: 1761, id: 'barely', pos: { x: -1982, y: 311, z: -160 } }]);
    expect(schedule.ofType('defuse_start')).toEqual([{ type: 'defuse_start', tick: tickOf(61.8), id: 'sp4rtan' }]);
    expect(schedule.ofType('defuse_end')).toEqual([{ type: 'defuse_end', tick: tickOf(66.8), id: 'sp4rtan' }]);
  });

  it('turns the shots CSV into shots, bursts and switches', () => {
    const shots = schedule.ofType('shot');
    expect(shots).toHaveLength(round.shots.filter((s) => s.kind === 'shot' || s.kind === 'shot_kill' || s.kind === 'hit').length);
    expect(shots.find((s) => s.shooter === 'lokier' && s.target === 'eradicate')).toMatchObject({ tick: tickOf(12.73), kind: 'shot_kill', weapon: 'ssg08' });
    expect(schedule.ofType('burst').map((b) => [b.shooter, b.tick0, b.tick1, b.count, b.target])).toEqual([
      ['barely', tickOf(33.35), tickOf(48.85), 7, 'zwomp'],
      ['donk', tickOf(37.25), tickOf(49.4), 1, null],
      ['barely', tickOf(49.4), tickOf(50.83), 11, null],
    ]);
    expect(schedule.ofType('weapon_switch').map((w) => [w.tick, w.id, w.weapon])).toEqual([
      [1254, 'sp4rtan', 'ak47'],
      [tickOf(49.93), 'donk', 'glock'],
      // Only in the note of the shots CSV's switch row ("back to AWP at 50.083"); the extractor puts both into timelines.weapon.
      [tickOf(50.083), 'donk', 'awp'],
      [tickOf(57.6), 'barely', 'knife'],
      [tickOf(59.6), 'cart', 'knife'],
      [tickOf(63.5), 'cart', 'ak47'],
    ]);
    expect(schedule.at(1254).map((e) => e.type)).toEqual(['pickup', 'weapon_switch']);
  });

  it('has utility, radio and chat', () => {
    expect(schedule.ofType('utility')).toHaveLength(round.utility.length);
    expect(schedule.ofType('utility')[0]).toEqual({ type: 'utility', tick: tickOf(4.8), id: 'cart', kind: 'smoke', throwPos: { x: -468, y: 924, z: -80 }, aim: null });
    expect(schedule.ofType('radio')).toHaveLength(round.radio.length);
    expect(schedule.ofType('radio').find((r) => r.tick === tickOf(24.4))).toEqual({ type: 'radio', tick: 1562, id: 'barely', text: "I'm planting the bomb." });
    expect(schedule.ofType('chat')).toHaveLength(round.chat.length);
    // Same tick: utility before radio, kill before chat.
    expect(schedule.at(tickOf(4.8)).map((e) => e.type)).toEqual(['utility', 'radio']);
    expect(schedule.at(tickOf(44.2)).map((e) => e.type)).toEqual(['damage', 'kill', 'chat']);
  });

  it('answers at / between / forPlayer / ofType', () => {
    expect(schedule.at(33)).toEqual([]);
    const window = schedule.between(3194, 3222);
    expect(window[0]?.tick).toBe(3194);
    expect(window.at(-1)?.type).toBe('kill');
    expect(window.every((e) => e.tick >= 3194 && e.tick <= 3222)).toBe(true);
    expect(schedule.between(0, 1e9)).toEqual(schedule.events);
    expect(schedule.between(10, 5)).toEqual([]);

    const donk = schedule.forPlayer('donk');
    expect(donk.every((e) => involves(e, 'donk'))).toBe(true);
    expect(donk.filter((e) => e.type === 'damage')).toHaveLength(4);
    expect(donk.some((e) => e.type === 'shot' && e.shooter === 'donk')).toBe(true);
    expect(donk.some((e) => e.type === 'utility' && e.id === 'donk')).toBe(true);
    expect(schedule.forPlayer('incredibad').map((e) => e.type)).toEqual(['damage', 'kill', 'kill']); // incl. his assist at 17.85
    const counts = SCHEDULE_TYPE_ORDER.map((t) => schedule.ofType(t).length);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(schedule.length);
  });

  it('rejects inconsistent damage', () => {
    const noKill = roundJson();
    noKill['kills'] = (noKill['kills'] as { victim: string }[]).filter((k) => k.victim !== 'donk');
    expect(() => new EventSchedule(parseRound(noKill))).toThrow(ScheduleError);
    expect(() => new EventSchedule(parseRound(noKill))).toThrow(/killing hit on donk with no kill/);

    const wrongKiller = roundJson();
    const k = (wrongKiller['kills'] as { victim: string; killer: string }[]).find((x) => x.victim === 'donk');
    if (k) k.killer = 'zwomp';
    expect(() => new EventSchedule(parseRound(wrongKiller))).toThrow(/came from sp4rtan, kill feed says zwomp/);

    const twice = roundJson();
    const kills = twice['kills'] as unknown[];
    kills.push(kills[0]);
    expect(() => new EventSchedule(parseRound(twice))).toThrow(/incredibad is already dead/);
  });
});
