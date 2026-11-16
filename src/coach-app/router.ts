/**
 * Hash routes:
 *   #/                                 home: drop a demo, the library
 *   #/m/<id>                           a match
 *   #/m/<id>/r/<round>?t=<tick>        a round of the match in the replay, at a tick
 *   #/m/<id>/r/<round>?t=<tick>&ev=<f>.<e>   evidence e of finding f (indices into report.findings / .evidence)
 */
import { useEffect, useState } from 'preact/hooks';

export type Route =
  | { page: 'home' }
  | { page: 'match'; id: string; round: number | null; tick: number | null; evidence: [number, number] | null };

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, '');
  const [path = '', query = ''] = h.split('?');
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'm' || !parts[1]) return { page: 'home' };
  const q = new URLSearchParams(query);
  const round = parts[2] === 'r' && parts[3] ? Number.parseInt(parts[3], 10) : null;
  const t = q.get('t');
  const ev = q.get('ev')?.split('.').map((x) => Number.parseInt(x, 10));
  return {
    page: 'match',
    id: decodeURIComponent(parts[1]),
    round: round !== null && Number.isFinite(round) ? round : null,
    tick: t !== null && Number.isFinite(Number(t)) ? Number(t) : null,
    evidence: ev && ev.length === 2 && ev.every((x) => Number.isFinite(x)) ? [ev[0] ?? 0, ev[1] ?? 0] : null,
  };
}

export function matchHref(id: string, round?: number, tick?: number, evidence?: [number, number]): string {
  let h = `#/m/${encodeURIComponent(id)}`;
  if (round !== undefined) h += `/r/${round}`;
  const q: string[] = [];
  if (tick !== undefined) q.push(`t=${Math.round(tick)}`);
  if (evidence) q.push(`ev=${evidence[0]}.${evidence[1]}`);
  return q.length ? `${h}?${q.join('&')}` : h;
}

export function navigate(hash: string, replace = false): void {
  if (replace) {
    history.replaceState(null, '', hash);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    location.hash = hash;
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = (): void => setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
