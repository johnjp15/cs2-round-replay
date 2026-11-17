/**
 * The match page (K3's shell, K5's report): header (map, score, sides, the user, "Hide names"), the round strip,
 * "Your three fixes" (report/Cards.tsx), one or two strengths, the 2D replay with the duel view or spray plot beside it
 * when a duel or spray evidence is open (viewers/), and the skill areas with every metric, finding and chart
 * (report/Areas.tsx). docs/coach/report.md "The report page".
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ChartLink, MatchReport } from '../coach/model/report';
import type { Side, TeamId } from '../coach/model/match';
import { STUB_VERSION } from './stub-report';
import type { LibraryEntry } from './library';
import { displayReport, setHideNames, useHideNames } from './display';
import { loadFeedback, type MatchFeedback } from './feedback';
import { mapName, reasonLong, reasonShort } from './names';
import { Replay } from './replay/Replay';
import type { Marker } from './replay/engine';
import { SkillAreas } from './report/Areas';
import { clockAt, evidenceHref, FixCard, StrengthCard, type CardContext } from './report/Cards';
import { matchHref, navigate } from './router';
import { DuelView } from './viewers/DuelView';
import { SprayPlot } from './viewers/SprayPlot';

export interface MatchPageProps {
  id: string;
  report: MatchReport;
  entry: LibraryEntry | null;
  round: number | null;
  tick: number | null;
  evidence: [number, number] | null;
  note: string | null;
  /** Non-null when the demo is still loaded in the worker: re-run the analysis for another player. */
  onChangePlayer: (() => void) | null;
}

function sideOf(report: MatchReport, team: TeamId, roundIndex = 0): Side {
  const r = report.match.rounds[roundIndex];
  return r && r.sides.T === team ? 'T' : 'CT';
}

function Header(props: { report: MatchReport; onChangePlayer: (() => void) | null; hide: boolean }) {
  const { report } = props;
  const me = report.match.players[report.user];
  const team: TeamId = me?.team ?? 'A';
  const other: TeamId = team === 'A' ? 'B' : 'A';
  const meta = report.match.meta;
  const first = sideOf(report, team);
  const sides: Record<Side, { won: number; played: number }> = { T: { won: 0, played: 0 }, CT: { won: 0, played: 0 } };
  for (const r of report.match.rounds) {
    if (r.winner === null) continue;
    const s: Side = r.sides.T === team ? 'T' : 'CT';
    sides[s].played++;
    if (r.winner === team) sides[s].won++;
  }
  const result = meta.score[team] > meta.score[other] ? 'Win' : meta.score[team] < meta.score[other] ? 'Loss' : 'Draw';
  return (
    <header class="match-head">
      <div class="mh-map">
        <h1>{mapName(meta.map)}</h1>
        <span class="mh-result">{result}{meta.surrendered ? ` (${meta.surrendered === team ? 'your team' : 'they'} surrendered)` : ''}</span>
      </div>
      <div class="mh-score" aria-label="Score, your team first">
        <span class={first === 'T' ? 't' : 'ct'}>{meta.score[team]}</span>
        <span class="mh-dash">–</span>
        <span class={first === 'T' ? 'ct' : 't'}>{meta.score[other]}</span>
      </div>
      <dl class="mh-facts">
        <div><dt>Your team started</dt><dd class={first === 'T' ? 't' : 'ct'}>{first}</dd></div>
        <div><dt>T side</dt><dd>{sides.T.won} of {sides.T.played}</dd></div>
        <div><dt>CT side</dt><dd>{sides.CT.won} of {sides.CT.played}</dd></div>
        <div>
          <dt>You</dt>
          <dd class="mh-you">
            <span data-testid="user-name">{me?.name ?? '?'}</span>
            {props.onChangePlayer
              ? <button type="button" class="link" onClick={props.onChangePlayer}>Change player</button>
              : <span class="hint" title="The demo isn't loaded any more: drop it again to analyze another player">drop the demo again to switch</span>}
          </dd>
        </div>
      </dl>
      <label class="hide-names">
        <input type="checkbox" checked={props.hide} data-testid="hide-names" onChange={(e) => setHideNames((e.currentTarget as HTMLInputElement).checked)} />
        Hide names
      </label>
    </header>
  );
}

function RoundStrip(props: { id: string; report: MatchReport; current: number }) {
  const { report } = props;
  const team = report.match.players[report.user]?.team ?? 'A';
  return (
    <nav class="rounds" aria-label="Rounds">
      {report.match.rounds.map((r, i) => {
        const sum = report.rounds.find((s) => s.number === r.number);
        const winSide = r.winnerSide;
        const mine = r.winner === team;
        const half = i > 0 && report.match.rounds[i - 1]?.sides.T !== r.sides.T;
        return (
          <a
            key={r.number}
            href={matchHref(props.id, r.number)}
            class={`rchip ${winSide === 'T' ? 'w-t' : winSide === 'CT' ? 'w-ct' : 'w-none'} ${mine ? 'won' : 'lost'} ${r.number === props.current ? 'on' : ''} ${half ? 'half' : ''} ${r.played ? '' : 'unplayed'}`}
            title={`Round ${r.number}: ${reasonLong(r.reasonName)}${mine ? ', your team won' : ', your team lost'}`}
            aria-current={r.number === props.current ? 'true' : undefined}
          >
            <span class="rn">{r.number}</span>
            <span class="rr">{reasonShort(r.reasonName)}</span>
            <span class="ru" aria-label={`${sum?.user.kills ?? 0} kills${sum?.user.died ? ', died' : ''}`}>
              {Array.from({ length: sum?.user.kills ?? 0 }, (_, k) => <i key={k} class="kdot" />)}
              {sum?.user.died && <i class="kx">×</i>}
            </span>
          </a>
        );
      })}
    </nav>
  );
}

function EvidenceViewer(props: { report: MatchReport; fi: number; k: number }) {
  const f = props.report.findings[props.fi];
  const ev = f?.evidence[props.k];
  if (!f || !ev || (ev.kind !== 'duel' && ev.kind !== 'spray')) return null;
  return (
    <section class="evidence-view" aria-label={ev.kind === 'duel' ? 'Duel view' : 'Spray plot'} data-testid="evidence-view">
      <h3>{ev.kind === 'duel' ? 'Duel view' : 'Spray plot'} <span class="dim">· {f.title} · round {ev.round}, {clockAt(props.report, ev.round, ev.focus)}</span></h3>
      <p class="ev-cap">{ev.caption}</p>
      {ev.kind === 'duel' ? <DuelView ev={ev} tickRate={props.report.match.meta.tickRate} /> : <SprayPlot ev={ev} />}
    </section>
  );
}

export function MatchPage(props: MatchPageProps) {
  const { id } = props;
  const hide = useHideNames();
  const report = useMemo(() => displayReport(props.report, hide), [props.report, hide]);
  const [feedback, setFeedback] = useState<MatchFeedback>(() => loadFeedback(id));
  useEffect(() => setFeedback(loadFeedback(id)), [id]);
  const replayRef = useRef<HTMLDivElement>(null);
  const rounds = report.replay.map((t) => t.round);
  const firstPlayed = report.match.rounds.find((r) => r.played)?.number ?? rounds[0] ?? 1;
  const round = props.round !== null && rounds.includes(props.round) ? props.round : firstPlayed;
  const evidence = props.evidence ? (report.findings[props.evidence[0]]?.evidence[props.evidence[1]] ?? null) : null;
  const evKey = props.evidence ? props.evidence.join('.') : '';
  useEffect(() => { if (evKey) replayRef.current?.scrollIntoView({ block: 'start' }); }, [evKey]);
  const markers: Marker[] = [];
  for (const f of report.findings) for (const ev of f.evidence) if (ev.round === round) markers.push({ tick: ev.focus, label: f.title });
  const idx = (fid: string): number => report.findings.findIndex((f) => f.id === fid);
  const fixIdx = report.topFixes.map(idx).filter((i) => i >= 0);
  const strIdx = report.strengths.map(idx).filter((i) => i >= 0);
  const first = report.match.rounds.find((r) => r.played) ?? report.match.rounds[0];
  const sides = report.match.players.map((p) => (first ? (first.sides.T === p.team ? 't' : 'ct') : ''));
  const ctx: CardContext = { id, report, names: report.match.players.map((p) => p.name), sides, feedback, setFeedback };
  const href = (l: ChartLink): string | null => {
    const fi = idx(l.finding);
    const ev = report.findings[fi]?.evidence[l.evidence];
    return ev ? evidenceHref(ctx, fi, l.evidence, ev) : null;
  };

  return (
    <main class="match">
      <p class="crumbs"><a href="#/">Library</a></p>
      <Header report={report} onChangePlayer={props.onChangePlayer} hide={hide} />
      <RoundStrip id={id} report={report} current={round} />
      {props.note && <p class="notice" data-testid="note">{props.note}</p>}
      <section class="fixes" aria-labelledby="fixes-h" data-testid="fixes">
        <h2 id="fixes-h">Your {fixIdx.length === 1 ? 'fix' : fixIdx.length === 2 ? 'two fixes' : 'three fixes'}</h2>
        {fixIdx.length === 0
          ? <p class="empty">{report.coachVersion === STUB_VERSION
            ? 'No fixes yet: this build doesn\'t analyze matches. The rounds and the replay below work already.'
            : 'Nothing in this match clears the bar for a fix. The skill areas below have every number; the replay has every round.'}</p>
          : <div class="fix-list">{fixIdx.map((i, n) => { const f = report.findings[i]; return f ? <FixCard key={f.id} ctx={ctx} f={f} fi={i} n={n + 1} /> : null; })}</div>}
      </section>
      {strIdx.length > 0 && (
        <section class="strengths" aria-labelledby="str-h" data-testid="strengths">
          <h2 id="str-h">What went well</h2>
          <div class="str-list">{strIdx.map((i) => { const f = report.findings[i]; return f ? <StrengthCard key={f.id} ctx={ctx} f={f} fi={i} /> : null; })}</div>
        </section>
      )}
      <div ref={replayRef} class="replay-wrap">
        {props.evidence && <EvidenceViewer report={report} fi={props.evidence[0]} k={props.evidence[1]} />}
        <Replay
          report={report}
          round={round}
          tick={props.tick}
          evidence={evidence}
          markers={markers}
          onRound={(n) => navigate(matchHref(id, n))}
        />
      </div>
      <SkillAreas ctx={ctx} report={report} topFixes={report.topFixes} href={href} />
    </main>
  );
}
