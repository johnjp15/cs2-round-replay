/**
 * The 2D replay: canvas + timeline (engine.ts) and the HUD around them (clock, kill feed, players, controls).
 * Keyboard: space play/pause · ←/→ 5 s back/forward (Shift: 1 s) · ↑/↓ faster/slower · [ / ] previous/next kill ·
 * , / . previous/next round.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Evidence, MatchReport } from '../../coach/model/report';
import { loadMap } from '../maps';
import type { MapView } from '../maps';
import { weaponName } from '../names';
import { ReplayEngine } from './engine';
import type { HudState, Marker } from './engine';

export const SPEEDS = [0.25, 0.5, 1, 2, 4] as const;

export interface ReplayProps {
  report: MatchReport;
  round: number;
  /** Open at this tick (else the freeze end). */
  tick: number | null;
  /** An evidence moment to play with its annotations and caption. */
  evidence: Evidence | null;
  /** Finding markers for this round's timeline. */
  markers: Marker[];
  onRound(n: number): void;
}

declare global {
  interface Window { __coach?: Record<string, unknown> }
}

export function Replay(props: ReplayProps) {
  const { report, round } = props;
  const canvas = useRef<HTMLCanvasElement>(null);
  const timeline = useRef<HTMLCanvasElement>(null);
  const engine = useRef<ReplayEngine | null>(null);
  const [hud, setHud] = useState<HudState | null>(null);
  const [map, setMap] = useState<MapView | null>(null);
  const [level, setLevel] = useState<'auto' | 'upper' | 'lower'>('auto');
  const names = report.match.players.map((p) => p.name);
  const track = report.replay.find((t) => t.round === round) ?? null;
  const rounds = report.replay.map((t) => t.round);

  useEffect(() => {
    if (!canvas.current || !timeline.current) return;
    const e = new ReplayEngine(canvas.current, timeline.current, names, report.user, setHud);
    engine.current = e;
    window.__coach = { ...(window.__coach ?? {}), replay: e };
    return () => { e.destroy(); engine.current = null; };
  }, [report]);

  useEffect(() => {
    let live = true;
    void loadMap(report.match.meta.map).then((m) => { if (live) { setMap(m); engine.current?.setMap(m); } });
    return () => { live = false; };
  }, [report.match.meta.map]);

  useEffect(() => {
    const e = engine.current;
    if (!e || !track) return;
    e.setTrack(track, props.tick ?? undefined);
    e.setMarkers(props.markers);
    e.setEvidence(props.evidence && props.evidence.round === round ? props.evidence : null, track.hz * track.step);
  }, [track, props.tick, props.evidence]);

  useEffect(() => {
    engine.current?.setMarkers(props.markers);
  }, [props.markers]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      const e = engine.current;
      if (!e || !track) return;
      const tag = (ev.target as HTMLElement | null)?.tagName ?? '';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const rate = track.hz * track.step;
      const idx = SPEEDS.indexOf(e.speed as (typeof SPEEDS)[number]);
      switch (ev.key) {
        case ' ': e.play(); break;
        case 'ArrowLeft': e.stopAt = null; e.seek(e.tick - (ev.shiftKey ? 1 : 5) * rate); break;
        case 'ArrowRight': e.stopAt = null; e.seek(e.tick + (ev.shiftKey ? 1 : 5) * rate); break;
        case 'ArrowUp': e.setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, idx + 1)] ?? 1); break;
        case 'ArrowDown': e.setSpeed(SPEEDS[Math.max(0, idx - 1)] ?? 1); break;
        case '[': e.jumpKill(-1); break;
        case ']': e.jumpKill(1); break;
        case ',': { const r = rounds[rounds.indexOf(round) - 1]; if (r !== undefined) props.onRound(r); break; }
        case '.': { const r = rounds[rounds.indexOf(round) + 1]; if (r !== undefined) props.onRound(r); break; }
        default: return;
      }
      ev.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [track, round, rounds.length]);

  const e = engine.current;
  const caption = props.evidence && props.evidence.round === round ? props.evidence.caption : null;
  const side = (s: number): string => (s === 2 ? 't' : 'ct');
  const twoLevel = map !== null && map.radar.lowerBelowZ !== null;
  const teamRows = (s: number) => (hud?.players ?? []).filter((p) => p.side === s);

  return (
    <section class="replay" aria-label="2D replay">
      <div class="replay-stage">
        <div class="replay-canvas">
          <canvas ref={canvas} data-testid="replay-canvas" />
          {caption && <div class="caption" data-testid="evidence-caption">{caption}</div>}
          {map?.error && <div class="map-missing">No radar for this map: {map.error}</div>}
        </div>
        <aside class="replay-side">
          <div class={`clock phase-${hud?.phase ?? 'live'}`} data-testid="replay-clock">
            <span class="clock-time">{hud?.clock ?? '–'}</span>
            <span class="clock-phase">{hud ? { freeze: 'Freeze time', live: 'Round time', planted: 'Bomb planted', over: 'Round over' }[hud.phase] : ''}</span>
          </div>
          <ol class="feed" data-testid="kill-feed" aria-label="Kill feed">
            {(hud?.feed ?? []).map((k) => (
              <li key={`${k.tick}-${k.victim}`} class={k.attacker === report.user || k.victim === report.user ? 'mine' : ''}>
                <span class={side(track?.side[k.attacker] ?? 0)}>{k.attacker >= 0 ? names[k.attacker] : 'World'}</span>
                <span class="feed-w">{weaponName(k.weapon)}{k.headshot ? ' HS' : ''}{k.wallbang ? ' wall' : ''}{k.smoke ? ' smoke' : ''}</span>
                <span class={side(track?.side[k.victim] ?? 0)}>{names[k.victim] ?? ''}</span>
              </li>
            ))}
          </ol>
          {[2, 3].map((s) => (
            <ul class="roster" key={s} aria-label={s === 2 ? 'T side' : 'CT side'}>
              {teamRows(s).map((p) => (
                <li key={p.slot} class={`${p.alive ? '' : 'dead'} ${p.slot === report.user ? 'me' : ''}`}>
                  <span class={`hp ${side(s)}`} style={`--hp:${p.health}%`} />
                  <span class="who">{names[p.slot]}</span>
                  <span class="num">{p.alive ? p.health : ''}</span>
                  <span class="wpn">{p.alive ? p.weapon : 'dead'}{p.bomb ? ' · C4' : ''}{p.kit && p.alive ? ' · kit' : ''}</span>
                  {p.slot === report.user && p.alive && p.place && <span class="place">{p.place}</span>}
                </li>
              ))}
            </ul>
          ))}
        </aside>
      </div>
      <canvas ref={timeline} class="timeline" data-testid="timeline" aria-label="Timeline: drag to scrub" />
      <div class="controls">
        <button type="button" class="primary" data-testid="play" onClick={() => e?.play()} aria-label={hud?.playing ? 'Pause' : 'Play'}>
          {hud?.playing ? 'Pause' : 'Play'}
        </button>
        <button type="button" onClick={() => e?.jumpKill(-1)} title="Previous kill ([)">Prev kill</button>
        <button type="button" onClick={() => e?.jumpKill(1)} title="Next kill (])">Next kill</button>
        <div class="speeds" role="group" aria-label="Speed">
          {SPEEDS.map((s) => (
            <button type="button" key={s} class={hud?.speed === s ? 'on' : ''} onClick={() => e?.setSpeed(s)}>{s}×</button>
          ))}
        </div>
        {twoLevel && (
          <div class="speeds" role="group" aria-label="Radar level">
            {(['auto', 'upper', 'lower'] as const).map((l) => (
              <button type="button" key={l} class={level === l ? 'on' : ''} onClick={() => { setLevel(l); e?.setLevel(l); }}>
                {l === 'auto' ? `Auto (${hud?.level ?? 'upper'})` : l === 'upper' ? 'Upper' : 'Lower'}
              </button>
            ))}
          </div>
        )}
        <label class="round-pick">
          Round
          <select value={round} onChange={(ev) => props.onRound(Number((ev.currentTarget as HTMLSelectElement).value))}>
            {rounds.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <span class="keys">Space play · ←→ 5 s · ↑↓ speed · [ ] kills · , . rounds</span>
      </div>
    </section>
  );
}
