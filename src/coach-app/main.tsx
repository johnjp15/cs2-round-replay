/**
 * The demo coach page. Drop a demo (or a .craw), pick which player you are, get the match page with its 2D replay.
 * Everything runs in this tab: the pipeline in a worker (client.ts, worker.ts), the library in IndexedDB
 * (library.ts). Routes: router.ts. docs/coach/app.md.
 */
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { MatchReport } from '../coach/model/report';
import { CAN_PARSE_DEMOS, Pipeline } from './client';
import type { ReportMessage } from './client';
import { deleteMatch, getEntry, listMatches, loadReport, matchId, putReport, saveMatch } from './library';
import type { LibraryEntry } from './library';
import { MatchPage } from './MatchPage';
import { mapName } from './names';
import type { ParsedInfo, PickerPlayer, Stage } from './protocol';
import { rememberUser, rememberedUser } from './prefs';
import { matchHref, navigate, useRoute } from './router';
import './theme.css';

const ACCEPT = '.dem,.bz2,.zst,.gz,.craw';
const STAGES: { id: Stage; label: string }[] = [
  { id: 'reading', label: 'Reading' }, { id: 'parsing', label: 'Parsing' }, { id: 'rounds', label: 'Rounds' },
  { id: 'analysis', label: 'Analysis' }, { id: 'replay', label: 'Replay' },
];

/** Test and debug hooks (the browser check uses them; nothing here is needed by the page). */
const coach = (window.__coach ??= {});
Object.assign(coach, { library: { listMatches, loadReport, putReport, deleteMatch, getEntry } });

function DropZone(props: { onFile: (f: File) => void; busy: boolean }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const pick = (files: FileList | null | undefined): void => {
    const f = files?.[0];
    if (f) props.onFile(f);
  };
  return (
    <div
      class={`drop ${over ? 'over' : ''} ${props.busy ? 'busy' : ''}`}
      role="button"
      tabIndex={0}
      aria-label="Drop a CS2 demo here or choose a file"
      onClick={() => input.current?.click()}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click(); } }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer?.files); }}
    >
      <strong>Drop a demo here</strong>
      <span>
        {CAN_PARSE_DEMOS ? '.dem, .dem.bz2 (Valve), .dem.zst (FACEIT), .dem.gz or a .craw' : 'A .craw or .craw.gz (demo parsing comes with the browser parser)'}
        {' '}or click to choose
      </span>
      <input ref={input} type="file" accept={ACCEPT} hidden data-testid="file-input" onChange={(e) => pick((e.currentTarget as HTMLInputElement).files)} />
    </div>
  );
}

function Progress(props: { stage: Stage; fraction: number; fileName: string }) {
  const at = STAGES.findIndex((s) => s.id === props.stage);
  return (
    <div class="progress" role="status" aria-live="polite" data-testid="progress">
      <div class="progress-file">{props.fileName}</div>
      <ol class="stages">
        {STAGES.map((s, i) => (
          <li key={s.id} class={i < at ? 'done' : i === at ? 'now' : ''}>
            {s.label}
            {i === at && <span class="bar"><span style={`width:${Math.round(props.fraction * 100)}%`} /></span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Picker(props: { info: ParsedInfo; current: number | null; onPick: (p: PickerPlayer) => void; onCancel?: () => void }) {
  const { info } = props;
  const remembered = rememberedUser();
  const team = (t: 'A' | 'B') => info.players.filter((p) => p.team === t).sort((a, b) => b.kills - a.kills || a.slot - b.slot);
  return (
    <section class="picker" aria-labelledby="picker-h" data-testid="picker">
      <h2 id="picker-h">Which player are you?</h2>
      <p class="dim">{mapName(info.map)}, {info.score.A}–{info.score.B}. Your choice is remembered for the next demo.</p>
      <div class="picker-teams">
        {(['A', 'B'] as const).map((t) => (
          <table key={t} class="picker-team">
            <caption class={info.firstSide[t] === 'T' ? 't' : 'ct'}>Started {info.firstSide[t]} · {info.score[t]} rounds</caption>
            <thead><tr><th scope="col">Player</th><th scope="col">K</th><th scope="col">D</th><th scope="col">A</th><th scope="col">ADR</th></tr></thead>
            <tbody>
              {team(t).map((p) => (
                <tr key={p.slot} class={`${p.slot === props.current ? 'on' : ''} ${p.steamId === remembered ? 'remembered' : ''}`}>
                  <td>
                    <button type="button" class="pick" data-testid="pick" data-slot={p.slot} onClick={() => props.onPick(p)}>
                      {p.name}{p.bot ? ' (bot)' : ''}
                    </button>
                  </td>
                  <td class="num">{p.kills}</td><td class="num">{p.deaths}</td><td class="num">{p.assists}</td><td class="num">{Math.round(p.adr)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </div>
      {props.onCancel && <button type="button" class="link" onClick={props.onCancel}>Keep the current player</button>}
    </section>
  );
}

function Library(props: { entries: LibraryEntry[]; onDelete: (id: string) => void }) {
  if (props.entries.length === 0) return <p class="empty">Analyzed matches appear here and stay in this browser.</p>;
  return (
    <table class="library" data-testid="library">
      <thead><tr><th scope="col">Map</th><th scope="col">Score</th><th scope="col">You</th><th scope="col">T side</th><th scope="col">CT side</th><th scope="col">Added</th><th /></tr></thead>
      <tbody>
        {props.entries.map((e) => (
          <tr key={e.id}>
            <td><a href={matchHref(e.id)} data-testid="open-match">{mapName(e.map)}</a></td>
            <td class={`num ${e.score[0] > e.score[1] ? 'win' : e.score[0] < e.score[1] ? 'loss' : ''}`}>{e.score[0]}–{e.score[1]}</td>
            <td>{e.user.name}</td>
            <td class="num">{e.sides.T.won}/{e.sides.T.played}</td>
            <td class="num">{e.sides.CT.won}/{e.sides.CT.played}</td>
            <td class="dim">{new Date(e.addedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
            <td><button type="button" class="link danger" onClick={() => props.onDelete(e.id)} aria-label={`Delete ${mapName(e.map)} ${e.score[0]}–${e.score[1]}`}>Delete</button></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface Current { id: string; report: MatchReport; entry: LibraryEntry | null; note: string | null }

function App() {
  const route = useRoute();
  const pipe = useRef<Pipeline | null>(null);
  const pipeId = useRef<string | null>(null);
  const dropAt = useRef(0);
  const [status, setStatus] = useState<{ stage: Stage; fraction: number; fileName: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState<ParsedInfo | null>(null);
  const [current, setCurrent] = useState<Current | null>(null);
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [opening, setOpening] = useState(false);

  const refresh = (): void => { void listMatches().then(setEntries).catch((e: unknown) => setError(String(e))); };
  useEffect(refresh, []);

  const onReport = (m: ReportMessage): void => {
    const info = pipe.current?.info;
    const steamId = info?.players.find((p) => p.slot === m.report.user)?.steamId ?? '';
    void saveMatch(m.report, info?.fileName ?? '', steamId).then((entry) => {
      const ms = performance.now() - dropAt.current;
      coach['lastLoad'] = { ms, timings: m.timings, replayBytes: m.replayBytes, storedBytes: entry.bytes, source: m.source };
      setCurrent({ id: entry.id, report: m.report, entry, note: m.note });
      setStatus(null);
      setPicker(null);
      refresh();
      navigate(matchHref(entry.id));
    }).catch((e: unknown) => setError(`Saving to the library failed: ${String(e)}`));
  };

  const analyze = (p: PickerPlayer): void => {
    rememberUser(p.steamId);
    setPicker(null);
    setStatus({ stage: 'analysis', fraction: 0, fileName: pipe.current?.info?.fileName ?? '' });
    pipe.current?.analyze(p.slot);
  };

  const onFile = (file: File): void => {
    pipe.current?.dispose();
    setError(null);
    setPicker(null);
    dropAt.current = performance.now();
    setStatus({ stage: 'reading', fraction: 0, fileName: file.name });
    if (location.hash !== '' && location.hash !== '#/') navigate('#/');
    const p = new Pipeline({
      onProgress: (stage, fraction) => setStatus({ stage, fraction, fileName: file.name }),
      onParsed: (info) => {
        pipeId.current = matchId(info.demoSha256);
        const remembered = rememberedUser();
        const me = info.players.find((x) => x.steamId === remembered);
        if (me) analyze(me);
        else { setStatus(null); setPicker(info); }
      },
      onReport,
      onError: (message) => { setStatus(null); setError(message); },
    });
    pipe.current = p;
    void p.load(file);
  };

  // Open a match from memory or the library.
  const wantId = route.page === 'match' ? route.id : null;
  useEffect(() => {
    if (!wantId || current?.id === wantId) return;
    let live = true;
    setOpening(true);
    const t0 = performance.now();
    void Promise.all([loadReport(wantId), getEntry(wantId)]).then(([report, entry]) => {
      if (!live) return;
      setOpening(false);
      coach['openMs'] = performance.now() - t0;
      if (report) setCurrent({ id: wantId, report, entry, note: null });
      else setError('That match is not in this browser\'s library.');
    }).catch((e: unknown) => { setOpening(false); setError(String(e)); });
    return () => { live = false; };
  }, [wantId, current?.id]);

  const onDelete = (id: string): void => {
    void deleteMatch(id).then(() => { if (current?.id === id) setCurrent(null); refresh(); });
  };

  if (route.page === 'match') {
    const canChange = pipeId.current === route.id && pipe.current?.info ? pipe.current.info : null;
    if (picker || status) {
      return (
        <main class="page">
          {status && <Progress {...status} />}
          {picker && <Picker info={picker} current={current?.report.user ?? null} onPick={analyze} onCancel={() => setPicker(null)} />}
        </main>
      );
    }
    if (current && current.id === route.id) {
      return (
        <MatchPage
          id={current.id}
          report={current.report}
          entry={current.entry}
          round={route.round}
          tick={route.tick}
          evidence={route.evidence}
          note={current.note}
          onChangePlayer={canChange ? () => setPicker(canChange) : null}
        />
      );
    }
    return <main class="page">{error ? <p class="error" role="alert">{error} <a href="#/">Back to the library</a></p> : <p class="dim">{opening ? 'Opening the match…' : ''}</p>}</main>;
  }

  return (
    <main class="page">
      <h1 class="title">CS2 Demo Coach</h1>
      <p class="lede">Drop a match, say which player you are, and watch the moments that decided your rounds.</p>
      <DropZone onFile={onFile} busy={status !== null} />
      {status && <Progress {...status} />}
      {error && <p class="error" role="alert" data-testid="error">{error}</p>}
      {picker && <Picker info={picker} current={null} onPick={analyze} />}
      <p class="note">Everything runs in this browser tab; the demo is never uploaded.</p>
      <section class="lib" aria-labelledby="lib-h">
        <h2 id="lib-h">Library</h2>
        <Library entries={entries} onDelete={onDelete} />
      </section>
    </main>
  );
}

const root = document.getElementById('app');
if (root) render(<App />, root);
