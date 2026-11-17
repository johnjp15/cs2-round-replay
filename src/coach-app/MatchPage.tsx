/**
 * The match page: header (map, score, sides, the user), the round strip, the place for "Your three fixes" and the skill
 * areas (card K5 fills them; findings that already exist render as simple cards with a Watch button per evidence
 * moment), and the 2D replay.
 */
import type { FindingArea, Finding, MatchReport } from '../coach/model/report';
import type { Side, TeamId } from '../coach/model/match';
import { WATCH_LEAD_SEC } from './config';
import { STUB_VERSION } from './stub-report';
import type { LibraryEntry } from './library';
import { clock, mapName, reasonLong, reasonShort } from './names';
import { Replay } from './replay/Replay';
import type { Marker } from './replay/engine';
import { matchHref, navigate } from './router';

const AREAS: { id: FindingArea; label: string }[] = [
  { id: 'aim', label: 'Aim' }, { id: 'movement', label: 'Movement' }, { id: 'utility', label: 'Utility' },
  { id: 'positioning', label: 'Positioning' }, { id: 'trading', label: 'Trades' }, { id: 'decisions', label: 'Decisions' },
  { id: 'economy', label: 'Economy' }, { id: 'strategy', label: 'Strategy' },
];

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

const ordinal = (n: number): string => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};

function sideOf(report: MatchReport, team: TeamId, roundIndex = 0): Side {
  const r = report.match.rounds[roundIndex];
  return r && r.sides.T === team ? 'T' : 'CT';
}

function Header(props: { report: MatchReport; onChangePlayer: (() => void) | null }) {
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

function FindingCard(props: { id: string; report: MatchReport; f: Finding; index: number }) {
  const { f, report } = props;
  const m = f.metrics[0];
  const rate = report.match.meta.tickRate || 64;
  return (
    <article class={`finding ${f.polarity}`} data-testid="finding">
      <h3>{f.title}</h3>
      <p class="f-sum">{f.summary}</p>
      {m && (
        <p class="f-metric">
          <strong>{Number.isInteger(m.value) ? m.value : m.value.toFixed(1)}{m.unit === '%' ? '%' : ` ${m.unit}`}</strong>
          <span>{ordinal(m.lobbyRank)} of {m.lobby.filter((x) => Number.isFinite(x)).length || 10} in this lobby, n = {m.n}</span>
        </p>
      )}
      {f.advice[0] && <p class="f-advice">{f.advice[0].text}{f.advice[0].drill ? ` Drill: ${f.advice[0].drill}` : ''}</p>}
      <div class="f-watch">
        {f.evidence.map((ev, k) => {
          const round = report.match.rounds.find((r) => r.number === ev.round);
          const at = round ? (ev.focus - (round.freezeEndTick ?? round.startTick)) / rate : 0;
          return (
            <a key={k} class="watch" data-testid="watch" href={matchHref(props.id, ev.round, ev.focus - WATCH_LEAD_SEC * rate, [props.index, k])}>
              Watch round {ev.round} at {clock(at)}
            </a>
          );
        })}
      </div>
    </article>
  );
}

export function MatchPage(props: MatchPageProps) {
  const { report, id } = props;
  const rounds = report.replay.map((t) => t.round);
  const firstPlayed = report.match.rounds.find((r) => r.played)?.number ?? rounds[0] ?? 1;
  const round = props.round !== null && rounds.includes(props.round) ? props.round : firstPlayed;
  const evidence = props.evidence ? (report.findings[props.evidence[0]]?.evidence[props.evidence[1]] ?? null) : null;
  const markers: Marker[] = [];
  for (const f of report.findings) for (const ev of f.evidence) if (ev.round === round) markers.push({ tick: ev.focus, label: f.title });
  const top = report.topFixes.map((fid) => report.findings.findIndex((f) => f.id === fid)).filter((i) => i >= 0);
  const fixIdx = top.length ? top : report.findings.map((f, i) => (f.polarity === 'fix' ? i : -1)).filter((i) => i >= 0).slice(0, 3);
  const rest = report.findings.map((_, i) => i).filter((i) => !fixIdx.includes(i));

  return (
    <main class="match">
      <p class="crumbs"><a href="#/">Library</a></p>
      <Header report={report} onChangePlayer={props.onChangePlayer} />
      <RoundStrip id={id} report={report} current={round} />
      {props.note && <p class="notice" data-testid="note">{props.note}</p>}
      <section class="fixes" aria-labelledby="fixes-h" data-testid="fixes">
        <h2 id="fixes-h">Your three fixes</h2>
        {fixIdx.length === 0
          ? <p class="empty">{report.coachVersion === STUB_VERSION
            ? 'No fixes yet: this build doesn\'t analyze matches. The rounds and the replay below work already.'
            : 'No fixes found for you in this match. The replay below has every round.'}</p>
          : <div class="fix-list">{fixIdx.map((i) => { const f = report.findings[i]; return f ? <FindingCard key={i} id={id} report={report} f={f} index={i} /> : null; })}</div>}
      </section>
      <Replay
        report={report}
        round={round}
        tick={props.tick}
        evidence={evidence}
        markers={markers}
        onRound={(n) => navigate(matchHref(id, n))}
      />
      <section class="areas" aria-labelledby="areas-h">
        <h2 id="areas-h">Skill areas</h2>
        <ul class="area-list">
          {AREAS.map((a) => {
            const n = rest.filter((i) => report.findings[i]?.area === a.id);
            return (
              <li key={a.id}>
                <span class="area-name">{a.label}</span>
                <span class="area-n">{n.length ? `${n.length} finding${n.length > 1 ? 's' : ''}` : 'not analyzed yet'}</span>
                {n.length > 0 && <div class="fix-list">{n.map((i) => { const f = report.findings[i]; return f ? <FindingCard key={i} id={id} report={report} f={f} index={i} /> : null; })}</div>}
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}
