/**
 * Feedback on findings: thumbs up or down with an optional note, per match and finding, kept in localStorage
 * (`cs2-coach.feedback.<match id>`) and exportable as one JSON file from the library. It feeds the detectors'
 * thresholds and K11's precision review (docs/coach-plan.md, "Validation" 6).
 */
export interface FeedbackEntry {
  vote: 'up' | 'down' | null;
  note: string;
  /** ms since 1970 of the last change. */
  at: number;
}

export type MatchFeedback = Record<string, FeedbackEntry>;

const PREFIX = 'cs2-coach.feedback.';

export function loadFeedback(matchId: string): MatchFeedback {
  try {
    const s = localStorage.getItem(PREFIX + matchId);
    return s ? (JSON.parse(s) as MatchFeedback) : {};
  } catch {
    return {};
  }
}

export function saveFeedback(matchId: string, findingId: string, e: Omit<FeedbackEntry, 'at'>): MatchFeedback {
  const old = loadFeedback(matchId);
  const all: MatchFeedback = {};
  for (const k of Object.keys(old)) if (k !== findingId) all[k] = old[k] as FeedbackEntry;
  if (e.vote !== null || e.note.trim() !== '') all[findingId] = { ...e, at: Date.now() };
  try {
    localStorage.setItem(PREFIX + matchId, JSON.stringify(all));
  } catch {
    // storage full or blocked: kept for this page only
  }
  return all;
}

export interface FeedbackExport {
  format: 'coach-feedback@1';
  exportedAt: number;
  matches: { id: string; map?: string; coachVersion?: string; user?: string; findings: (FeedbackEntry & { id: string; title?: string })[] }[];
}

/** Every match's feedback, with the finding titles where the library knows them. */
export function exportFeedback(meta: Record<string, { map: string; coachVersion: string; user: string; titles: Record<string, string> }>): FeedbackExport {
  const matches: FeedbackExport['matches'] = [];
  const ids: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(PREFIX)) ids.push(k.slice(PREFIX.length));
  }
  for (const id of ids.sort()) {
    const fb = loadFeedback(id);
    const m = meta[id];
    const findings = Object.keys(fb).sort().map((fid) => ({ id: fid, ...(m?.titles[fid] ? { title: m.titles[fid] } : {}), ...(fb[fid] as FeedbackEntry) }));
    if (findings.length) matches.push({ id, ...(m ? { map: m.map, coachVersion: m.coachVersion, user: m.user } : {}), findings });
  }
  return { format: 'coach-feedback@1', exportedAt: Date.now(), matches };
}

/** Offer a JSON value as a download. */
export function download(name: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
