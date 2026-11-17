/**
 * The local library: analyzed matches in IndexedDB. Never the demo or the RawDemo: only the report (which holds the
 * replay tracks). Schema (docs/coach/app.md "Library"):
 *
 *   database `cs2-coach`, version 1
 *   store `entries`  keyPath `id`: LibraryEntry (small, for the list)
 *   store `reports`  keyPath `id`: { id, bytes } with bytes = packGzip(MatchReport)
 *
 * `id` is the first 16 hex digits of the demo's SHA-256, so dropping the same demo again replaces its entry.
 */
import type { Side, TeamId } from '../coach/model/match';
import type { MatchReport } from '../coach/model/report';
import { slotLabel } from './display';
import { packGzip, unpackGzip } from './pack';

const DB_NAME = 'cs2-coach';
const DB_VERSION = 1;

export interface LibraryEntry {
  id: string;
  /** ms since 1970 (Date.now()) when it was added or last re-analyzed. */
  addedAt: number;
  fileName: string;
  map: string;
  demoSha256: string;
  user: { slot: number; name: string; steamId: string; team: TeamId; label?: string };
  /** Final score, the user's team first. */
  score: [number, number];
  /** The user's team's rounds won and played on each side. */
  sides: Record<Side, { won: number; played: number }>;
  findings: number;
  coachVersion: string;
  /** Stored bytes of the report. */
  bytes: number;
}

export const matchId = (demoSha256: string): string => demoSha256.slice(0, 16);

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = (): void => resolve(r.result);
    r.onerror = (): void => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = (): void => {
      const d = open.result;
      if (!d.objectStoreNames.contains('entries')) d.createObjectStore('entries', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('reports')) d.createObjectStore('reports', { keyPath: 'id' });
    };
    open.onsuccess = (): void => resolve(open.result);
    open.onerror = (): void => reject(open.error ?? new Error('IndexedDB is not available'));
  });
  return dbp;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = (): void => resolve();
    tx.onerror = (): void => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = (): void => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** The list entry for a report (from the user's point of view). */
export function entryFor(report: MatchReport, fileName: string, steamId: string, addedAt: number, bytes: number): LibraryEntry {
  const meta = report.match.meta;
  const me = report.match.players[report.user];
  const team: TeamId = me?.team ?? 'A';
  const other: TeamId = team === 'A' ? 'B' : 'A';
  const sides: Record<Side, { won: number; played: number }> = { T: { won: 0, played: 0 }, CT: { won: 0, played: 0 } };
  for (const r of report.match.rounds) {
    if (r.winner === null) continue;
    const side: Side = r.sides.T === team ? 'T' : 'CT';
    sides[side].played++;
    if (r.winner === team) sides[side].won++;
  }
  return {
    id: matchId(meta.demoSha256), addedAt, fileName, map: meta.map, demoSha256: meta.demoSha256,
    user: { slot: report.user, name: me?.name ?? '', steamId, team, label: slotLabel(report.match.players, report.user) },
    score: [meta.score[team], meta.score[other]], sides,
    findings: report.findings.length, coachVersion: report.coachVersion, bytes,
  };
}

export async function saveMatch(report: MatchReport, fileName: string, steamId: string): Promise<LibraryEntry> {
  const bytes = await packGzip(report);
  const entry = entryFor(report, fileName, steamId, Date.now(), bytes.byteLength);
  const d = await db();
  const tx = d.transaction(['entries', 'reports'], 'readwrite');
  tx.objectStore('entries').put(entry);
  tx.objectStore('reports').put({ id: entry.id, bytes });
  await done(tx);
  return entry;
}

export async function listMatches(): Promise<LibraryEntry[]> {
  const d = await db();
  const all = await req(d.transaction('entries').objectStore('entries').getAll() as IDBRequest<LibraryEntry[]>);
  return all.sort((a, b) => b.addedAt - a.addedAt);
}

export async function getEntry(id: string): Promise<LibraryEntry | null> {
  const d = await db();
  return (await req(d.transaction('entries').objectStore('entries').get(id) as IDBRequest<LibraryEntry | undefined>)) ?? null;
}

export async function loadReport(id: string): Promise<MatchReport | null> {
  const d = await db();
  const row = await req(d.transaction('reports').objectStore('reports').get(id) as IDBRequest<{ id: string; bytes: Uint8Array } | undefined>);
  return row ? unpackGzip<MatchReport>(row.bytes) : null;
}

/** Replace a stored report (keeps the entry's date). Used by the browser check to add a synthetic finding. */
export async function putReport(id: string, report: MatchReport): Promise<void> {
  const old = await getEntry(id);
  const bytes = await packGzip(report);
  const d = await db();
  const tx = d.transaction(['entries', 'reports'], 'readwrite');
  if (old) tx.objectStore('entries').put({ ...old, findings: report.findings.length, bytes: bytes.byteLength });
  tx.objectStore('reports').put({ id, bytes });
  await done(tx);
}

export async function deleteMatch(id: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(['entries', 'reports'], 'readwrite');
  tx.objectStore('entries').delete(id);
  tx.objectStore('reports').delete(id);
  await done(tx);
}
