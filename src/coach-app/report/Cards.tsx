/**
 * The report's cards: "Your three fixes" (FixCard), strengths (StrengthCard), the compact finding rows of the skill
 * areas (FindingRow), their Watch buttons and the thumbs-up / thumbs-down feedback. Numbers go through
 * src/coach/report/format.ts (`metricValue`, `rankPhrase`), the same as the CLI.
 */
import { useState } from 'preact/hooks';
import type { Evidence, Finding, MatchReport } from '../../coach/model/report';
import { confidenceWord, lobbyRankInfo, metricValue, rankPhrase } from '../../coach/report/format';
import { BOMB_SEC, ROUND_SEC, WATCH_LEAD_SEC } from '../config';
import { saveFeedback, type FeedbackEntry, type MatchFeedback } from '../feedback';
import { matchHref } from '../router';
import { RankStrip } from './RankStrip';

export interface CardContext {
  id: string;
  report: MatchReport;
  /** Display names per slot (labels when names are hidden). */
  names: string[];
  /** Side class of each slot in the user's first round (`t` / `ct`). */
  sides: string[];
  feedback: MatchFeedback;
  setFeedback(f: MatchFeedback): void;
}

/** The round clock at a tick, as the player saw it: "1:12" left, "bomb 0:28" after the plant, "freeze" before. */
export function clockAt(report: MatchReport, round: number, tick: number): string {
  const r = report.match.rounds.find((x) => x.number === round);
  if (!r) return '';
  const rate = report.match.meta.tickRate || 64;
  const mmss = (s: number): string => { const v = Math.max(0, Math.floor(s)); return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`; };
  if (r.freezeEndTick === null || tick < r.freezeEndTick) return 'freeze time';
  if (r.bomb.plantTick !== null && tick >= r.bomb.plantTick) return `bomb ${mmss(BOMB_SEC - (tick - r.bomb.plantTick) / rate)}`;
  return mmss(ROUND_SEC - (tick - r.freezeEndTick) / rate);
}

export function evidenceHref(ctx: CardContext, fi: number, k: number, ev: Evidence): string {
  const rate = ctx.report.match.meta.tickRate || 64;
  return matchHref(ctx.id, ev.round, ev.focus - WATCH_LEAD_SEC * rate, [fi, k]);
}

const KIND: Record<Evidence['kind'], string> = { replay: 'Replay', duel: 'Duel', spray: 'Spray', map: 'Map', board: 'Board' };

function WatchButtons(props: { ctx: CardContext; f: Finding; fi: number }) {
  return (
    <div class="f-watch">
      {props.f.evidence.map((ev, k) => (
        <a key={k} class="watch" data-testid="watch" data-kind={ev.kind} href={evidenceHref(props.ctx, props.fi, k, ev)} title={ev.caption}>
          <span class="w-kind">{KIND[ev.kind]}</span> R{ev.round} · {clockAt(props.ctx.report, ev.round, ev.focus)}
        </a>
      ))}
    </div>
  );
}

function Feedback(props: { ctx: CardContext; f: Finding }) {
  const cur: FeedbackEntry | undefined = props.ctx.feedback[props.f.id];
  const [note, setNote] = useState(cur?.note ?? '');
  const [open, setOpen] = useState(false);
  const save = (vote: FeedbackEntry['vote'], n = note): void => props.ctx.setFeedback(saveFeedback(props.ctx.id, props.f.id, { vote, note: n }));
  return (
    <div class="fb" data-testid="feedback">
      <span class="fb-q">Right?</span>
      <button type="button" class={`fb-b ${cur?.vote === 'up' ? 'on' : ''}`} aria-pressed={cur?.vote === 'up'} aria-label="Yes, this is right" data-testid="fb-up"
        onClick={() => { save(cur?.vote === 'up' ? null : 'up'); setOpen(true); }}>▲</button>
      <button type="button" class={`fb-b ${cur?.vote === 'down' ? 'on' : ''}`} aria-pressed={cur?.vote === 'down'} aria-label="No, this is wrong" data-testid="fb-down"
        onClick={() => { save(cur?.vote === 'down' ? null : 'down'); setOpen(true); }}>▼</button>
      {(open || cur?.note) && (
        <input class="fb-note" type="text" placeholder="Note (optional)" value={note} data-testid="fb-note" aria-label="Feedback note"
          onInput={(e) => setNote((e.currentTarget as HTMLInputElement).value)}
          onChange={(e) => save(cur?.vote ?? null, (e.currentTarget as HTMLInputElement).value)} />
      )}
    </div>
  );
}

function instancesLine(f: Finding): string {
  const s = f.stats;
  const rounds = s.rounds.length;
  const conf = f.scoring?.confidence ?? f.confidence;
  const parts = [`${s.instances} of ${s.opportunities}`, `${rounds} round${rounds === 1 ? '' : 's'}`];
  if (s.roundsLost > 0) parts.push(`${s.roundsLost} lost`);
  parts.push(`${confidenceWord(conf)} confidence`);
  return parts.join(' · ');
}

function KeyNumber(props: { ctx: CardContext; f: Finding; strip?: boolean }) {
  const m = props.f.metrics[0];
  if (!m) return null;
  const info = lobbyRankInfo(m);
  return (
    <div class="f-key">
      <p class="f-metric">
        <strong data-testid="key-number">{metricValue(m.value, m.unit)}</strong>
        <span>{m.label ?? m.id} · n {m.n}</span>
      </p>
      {props.strip !== false && <RankStrip mv={m} user={props.ctx.report.user} names={props.ctx.names} sides={props.ctx.sides} />}
      {props.strip === false && info && <p class="f-rank">{rankPhrase(info)}</p>}
    </div>
  );
}

export function FixCard(props: { ctx: CardContext; f: Finding; fi: number; n: number }) {
  const { f } = props;
  return (
    <article class={`finding fix-card ${f.polarity}`} data-testid="fix-card" data-id={f.id}>
      <header class="fc-head">
        <span class="fc-n">{props.n}</span>
        <h3>{f.title}</h3>
        <span class="tag">{f.scope}</span>
      </header>
      <p class="f-sum">{f.summary}</p>
      <KeyNumber ctx={props.ctx} f={f} />
      <p class="f-stats">{instancesLine(f)}</p>
      <WatchButtons ctx={props.ctx} f={f} fi={props.fi} />
      {f.advice.length > 0 && (
        <div class="f-advice">
          <h4>Do instead</h4>
          <ul>{f.advice.map((a, k) => <li key={k}>{a.text}</li>)}</ul>
          {f.advice.filter((a) => a.drill).map((a, k) => <p key={k} class="drill"><b>Drill</b> {a.drill}</p>)}
        </div>
      )}
      {f.why && <p class="f-why">{f.why}</p>}
      <Feedback ctx={props.ctx} f={f} />
    </article>
  );
}

export function StrengthCard(props: { ctx: CardContext; f: Finding; fi: number }) {
  const { f } = props;
  return (
    <article class="finding strength-card strength" data-testid="strength-card" data-id={f.id}>
      <h3>{f.title}</h3>
      <p class="f-sum">{f.summary}</p>
      <KeyNumber ctx={props.ctx} f={f} strip={false} />
      <WatchButtons ctx={props.ctx} f={f} fi={props.fi} />
      <Feedback ctx={props.ctx} f={f} />
    </article>
  );
}

const POL: Record<Finding['polarity'], string> = { fix: 'fix', strength: 'strength', observation: 'observation' };

export function FindingRow(props: { ctx: CardContext; f: Finding; fi: number; top: boolean }) {
  const { f } = props;
  const m = f.metrics[0];
  return (
    <article class={`finding row ${f.polarity}`} data-testid="area-finding" data-id={f.id}>
      <header class="fr-head">
        <h4>{f.title}</h4>
        <span class={`tag ${f.polarity}`}>{props.top ? 'in your fixes' : POL[f.polarity]}</span>
        {m && <span class="fr-num">{metricValue(m.value, m.unit)} · {rankPhrase(lobbyRankInfo(m))}</span>}
      </header>
      <p class="f-sum">{f.summary}</p>
      <p class="f-stats">{instancesLine(f)}{f.scoring && !f.scoring.bar && f.polarity === 'fix' ? ' · below the bar for a top fix' : ''}{f.scoring?.gated ? ' · detector below the precision gate' : ''}</p>
      <WatchButtons ctx={props.ctx} f={f} fi={props.fi} />
      <Feedback ctx={props.ctx} f={f} />
    </article>
  );
}
