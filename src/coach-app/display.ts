/**
 * Display options of the match page. **Hide names**: every player name on the page (header, replay, kill feed,
 * picker, library) is replaced by his anonymous label A1…A5 / B1…B5 (team A started T; numbered by slot, the same
 * labels the finding texts use), so screenshots can be shared. Kept in localStorage.
 */
import { useEffect, useState } from 'preact/hooks';
import type { MatchReport } from '../coach/model/report';

const KEY = 'cs2-coach.hideNames';
const EVENT = 'cs2-coach-display';

export function hideNames(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setHideNames(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    // private mode: the option lasts for the page only
  }
  window.dispatchEvent(new Event(EVENT));
}

/** The current value, re-rendering when it changes. */
export function useHideNames(): boolean {
  const [on, setOn] = useState(hideNames);
  useEffect(() => {
    const f = (): void => setOn(hideNames());
    window.addEventListener(EVENT, f);
    window.addEventListener('storage', f);
    return () => { window.removeEventListener(EVENT, f); window.removeEventListener('storage', f); };
  }, []);
  return on;
}

/** Anonymous label of a slot among players with a team: A1…A5, B1…B5 (by slot within the team). */
export function slotLabel(players: readonly { slot: number; team: string }[], slot: number): string {
  const me = players.find((p) => p.slot === slot);
  if (!me) return `#${slot}`;
  return `${me.team}${players.filter((p) => p.team === me.team && p.slot <= slot).length}`;
}

/** The report as the page shows it: player names replaced by labels when names are hidden (a shallow copy). */
export function displayReport(report: MatchReport, hide: boolean): MatchReport {
  if (!hide) return report;
  const players = report.match.players.map((p) => ({ ...p, name: slotLabel(report.match.players, p.slot) }));
  return { ...report, match: { ...report.match, players } };
}

/** A player's name as shown. */
export function shownName(report: MatchReport, slot: number, hide: boolean): string {
  return hide ? slotLabel(report.match.players, slot) : (report.match.players[slot]?.name ?? `#${slot}`);
}
