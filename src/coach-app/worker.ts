/**
 * The pipeline worker: file → RawDemo → Match (`ingestMatch`) → report and replay. It keeps the RawDemo and the
 * Match after the first analysis, so choosing another player re-runs only the analysis. Results go back with their
 * typed arrays transferred, not copied. Protocol: protocol.ts; docs/coach/app.md.
 *
 * The analysis (`analyze` from src/coach/analyze, card K2) is found with `import.meta.glob`, so this file builds with
 * or without it: when the module is absent, or when it throws, the report is the stub (match facts, no findings).
 */
import { ingestMatch } from '../coach/ingest/index';
import { computeScoreboard } from '../coach/ingest/validate';
import type { Match, Side, TeamId } from '../coach/model/match';
import type { RawDemo } from '../coach/model/raw';
import { decodeRawDemo } from '../coach/model/raw-codec';
import type { MatchReport } from '../coach/model/report';
import { LosWorld } from '../coach/derive/los';
import { buildReplay, replayBytes, replayTransferables, roundSummaries } from '../coach/report/replay';
import { gunzipBlob } from './pack';
import type { ParsedInfo, PipelineMessage, PipelineRequest, Stage } from './protocol';
import { reportMatch, stubReport } from './stub-report';

interface AnalyzeModule {
  analyze(raw: RawDemo, match: Match, opts: { user: number; los?: LosWorld }): MatchReport;
}
const analyzeModules = import.meta.glob<AnalyzeModule>('../coach/analyze/index.ts');

interface Scope {
  postMessage(m: PipelineMessage, transfer?: Transferable[]): void;
  addEventListener(type: 'message', fn: (e: MessageEvent<PipelineRequest>) => void): void;
}
const scope = self as unknown as Scope;

let raw: RawDemo | null = null;
let match: Match | null = null;
let fileName = '';
let mapBase = '';
let los: LosWorld | null | undefined;

const post = (m: PipelineMessage, transfer: Transferable[] = []): void => scope.postMessage(m, transfer);
const progress = (stage: Stage, fraction: number): void => post({ type: 'progress', stage, fraction });

async function readCraw(file: Blob): Promise<RawDemo> {
  progress('reading', 0);
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const gz = head[0] === 0x1f && head[1] === 0x8b;
  const bytes = gz ? await gunzipBlob(file) : new Uint8Array(await file.arrayBuffer());
  progress('reading', 1);
  if (bytes[0] !== 0x43 || bytes[1] !== 0x52 || bytes[2] !== 0x41 || bytes[3] !== 0x57) {
    throw new Error(gz ? 'This gzip file holds a demo, not a .craw. Demo parsing isn\'t built into this build yet: drop a .craw or .craw.gz.' : 'Not a .craw file.');
  }
  progress('parsing', 0);
  const r = decodeRawDemo(bytes);
  progress('parsing', 1);
  return r;
}

function parsedInfo(r: RawDemo, m: Match): ParsedInfo {
  const sb = computeScoreboard(r, m);
  const played = m.rounds.filter((x) => x.played).length || 1;
  const first = m.rounds[0];
  const firstSide: Record<TeamId, Side> = first ? { A: first.sides.T === 'A' ? 'T' : 'CT', B: first.sides.T === 'B' ? 'T' : 'CT' } : { A: 'T', B: 'CT' };
  return {
    fileName,
    map: m.meta.map,
    demoSha256: m.meta.demoSha256,
    score: m.meta.score,
    firstSide,
    rounds: m.rounds.length,
    players: m.players.map((pl) => {
      const line = sb[pl.slot];
      return {
        slot: pl.slot, name: pl.name, steamId: r.players[pl.slot]?.steamId ?? '', bot: pl.bot, team: pl.team,
        kills: line?.kills ?? 0, deaths: line?.deaths ?? 0, assists: line?.assists ?? 0, damage: line?.damage ?? 0,
        adr: (line?.damage ?? 0) / played,
      };
    }),
  };
}

async function loadLos(map: string): Promise<LosWorld | null> {
  try {
    const res = await fetch(new URL(`${encodeURIComponent(map)}/los.bin.gz`, mapBase).href);
    if (!res.ok || !res.body) return null;
    const bytes = new Uint8Array(await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    return LosWorld.fromBytes(bytes);
  } catch {
    return null;
  }
}

async function ingest(r: RawDemo, t0: number, timings: Record<string, number>): Promise<void> {
  progress('rounds', 0);
  const t1 = performance.now();
  raw = r;
  match = ingestMatch(r);
  los = undefined;
  timings['rounds'] = performance.now() - t1;
  progress('rounds', 1);
  post({ type: 'parsed', info: parsedInfo(r, match), ms: performance.now() - t0 });
}

async function analyzeFor(user: number): Promise<void> {
  if (!raw || !match) throw new Error('No demo is loaded.');
  const timings: Record<string, number> = {};
  progress('analysis', 0);
  let t = performance.now();
  let report: MatchReport | null = null;
  let note: string | null = null;
  const loader = Object.values(analyzeModules)[0];
  if (loader) {
    try {
      const mod = await loader();
      if (los === undefined) los = await loadLos(match.meta.map);
      timings['los'] = performance.now() - t;
      t = performance.now();
      report = mod.analyze(raw, match, los ? { user, los } : { user });
    } catch (err) {
      note = `The analysis failed (${err instanceof Error ? err.message : String(err)}); showing the match without findings.`;
      report = null;
    }
  } else {
    note = 'This build has no analysis yet: the rounds and the replay are here, the fixes come later.';
  }
  timings['analysis'] = performance.now() - t;
  progress('analysis', 1);
  progress('replay', 0);
  t = performance.now();
  const replay = buildReplay(raw, match);
  timings['replay'] = performance.now() - t;
  if (report) {
    report.replay = replay;
    if (report.rounds.length === 0) report.rounds = roundSummaries(raw, match, user);
    if (!report.match) report.match = reportMatch(match);
  } else {
    report = stubReport(raw, match, user, replay);
  }
  progress('replay', 1);
  post({ type: 'report', report, source: note === null ? 'analyze' : 'stub', note, replayBytes: replayBytes(replay), timings }, replayTransferables(replay));
}

scope.addEventListener('message', (e) => {
  const req = e.data;
  void (async (): Promise<void> => {
    try {
      const t0 = performance.now();
      const timings: Record<string, number> = {};
      if (req.type === 'load') {
        fileName = req.fileName;
        mapBase = req.mapBase;
        const r = await readCraw(req.file);
        timings['read'] = performance.now() - t0;
        await ingest(r, t0, timings);
      } else if (req.type === 'raw') {
        fileName = req.fileName;
        mapBase = req.mapBase;
        await ingest(req.raw, t0, timings);
      } else {
        await analyzeFor(req.user);
      }
    } catch (err) {
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  })();
});
