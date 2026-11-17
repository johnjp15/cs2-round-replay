/**
 * Replay tracks (src/coach/report/replay.ts) on the committed fixture (the public test demo, anonymized; round 4 has
 * its full tick grid) and on small synthetic cases.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeRawDemo } from '../../src/coach/model/raw-codec';
import { ingestMatch } from '../../src/coach/ingest/index';
import { FLAG, rowAtOrAfter } from '../../src/coach/model/raw';
import { REPLAY_ABSENT, REPLAY_FLAG } from '../../src/coach/model/report';
import { buildReplay, buildRoundTrack, replayBytes, roundSummaries, trackRange } from '../../src/coach/report/replay';
import { COACH_TUNING } from '../../src/coach/tuning';

const raw = decodeRawDemo(gunzipSync(readFileSync(new URL('./fixtures/test-demo-r4.craw.gz', import.meta.url))));
const match = ingestMatch(raw);
const r4 = match.rounds.find((r) => r.number === 4);
if (!r4) throw new Error('fixture has no round 4');
const track = buildRoundTrack(raw, match, r4);
const P = raw.players.length;

interface PlaceBox { name: string; bounds: { minX: number; minY: number; maxX: number; maxY: number } }
const places = (JSON.parse(readFileSync(new URL('../../data/coach/maps/de_mirage/places.json', import.meta.url), 'utf8')) as { places: PlaceBox[] }).places;

describe('replay tracks', () => {
  it('cover round 4 from 3 s before the freeze end to the official end at 16 Hz', () => {
    const { tick0, tick1 } = trackRange(raw, r4);
    expect(track.hz).toBe(16);
    expect(track.step).toBe(4);
    expect(tick0).toBe((r4.freezeEndTick ?? 0) - 3 * 64);
    expect(tick1).toBe(r4.officialEndTick);
    expect(track.samples).toBe(Math.floor((tick1 - tick0) / 4) + 1);
    expect(track.xy.length).toBe(track.samples * P * 2);
    expect(track.phases).toEqual({ start: r4.startTick, freezeEnd: r4.freezeEndTick, plant: r4.bomb.plantTick, end: r4.endTick, officialEnd: r4.officialEndTick });
    expect([...track.side].filter((s) => s === 2).length).toBe(5);
    expect([...track.side].filter((s) => s === 3).length).toBe(5);
  });

  it('samples the grid: positions, yaw, health and the alive flag', () => {
    for (const k of [0, 100, 400, track.samples - 200]) {
      const tick = track.tick0 + k * track.step;
      const r = rowAtOrAfter(raw.ticks, tick);
      expect(raw.ticks.tick[r]).toBe(tick); // round 4's grid is dense
      for (let p = 0; p < P; p++) {
        const i = r * P + p;
        const o = k * P + p;
        if (raw.ticks.present[i] !== 1) { expect(track.xy[o * 2]).toBe(REPLAY_ABSENT); continue; }
        expect(track.xy[o * 2]).toBe(Math.round(raw.ticks.x[i] ?? 0));
        expect(track.xy[o * 2 + 1]).toBe(Math.round(raw.ticks.y[i] ?? 0));
        const alive = ((raw.ticks.flags[i] ?? 0) & FLAG.alive) !== 0;
        expect(((track.flags[o] ?? 0) & REPLAY_FLAG.alive) !== 0).toBe(alive);
        expect(track.health[o]).toBe(alive ? raw.ticks.health[i] : 0);
        const dy = Math.abs((((track.yaw[o] ?? 0) - (raw.ticks.yaw[i] ?? 0)) % 360 + 540) % 360 - 180);
        expect(dy).toBeLessThanOrEqual(0.5);
      }
    }
  });

  it('puts every living player inside the box of his place name (positions agree with callouts)', () => {
    let checked = 0;
    for (let k = 0; k < track.samples; k += 8) {
      for (let p = 0; p < P; p++) {
        const o = k * P + p;
        if (((track.flags[o] ?? 0) & REPLAY_FLAG.alive) === 0) continue;
        const name = track.places[track.place[o] ?? 0] ?? '';
        const box = places.find((b) => b.name === name);
        if (!box) continue;
        const x = track.xy[o * 2] ?? 0;
        const y = track.xy[o * 2 + 1] ?? 0;
        expect(x >= box.bounds.minX - 1 && x <= box.bounds.maxX + 1 && y >= box.bounds.minY - 1 && y <= box.bounds.maxY + 1, `${name} at ${x},${y}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('carries the round\'s kills with positions on their ticks, and hits with the health removed', () => {
    const kills = raw.events.kills.filter((k) => k.tick >= track.tick0 && k.tick <= r4.endTick);
    expect(track.events.kills.map((k) => k.tick)).toEqual(kills.map((k) => k.tick));
    expect(track.events.kills.length).toBe(5);
    for (const k of track.events.kills) {
      const r = rowAtOrAfter(raw.ticks, k.tick);
      expect(k.vx).toBe(Math.round(raw.ticks.x[r * P + k.victim] ?? 0));
      if (k.attacker >= 0) expect(k.ax).toBe(Math.round(raw.ticks.x[r * P + k.attacker] ?? 0));
    }
    for (const h of track.events.hurts) expect(h.damage).toBeGreaterThanOrEqual(0);
    expect(track.events.hurts.every((h) => h.damage <= 100)).toBe(true);
    const lethal = track.events.hurts.filter((h) => h.health === 0);
    expect(lethal.length).toBeGreaterThanOrEqual(5);
    expect(track.events.shots.some((s) => s.hit >= 0)).toBe(true);
  });

  it('gives smokes and fires their lifetimes and marks the bomb carrier until the plant', () => {
    const smokes = track.events.effects.filter((e) => e.kind === 'smoke');
    for (const s of smokes) {
      const end = raw.events.detonations.find((d) => d.kind === 'smoke_end' && d.tick >= s.tick0 && d.x === raw.events.detonations.find((x) => x.kind === 'smoke' && x.tick === s.tick0)?.x);
      if (end) expect(s.tick1).toBe(end.tick);
      expect(s.tick1).toBeGreaterThan(s.tick0);
    }
    const plant = track.events.bomb.find((b) => b.kind === 'planted');
    expect(plant).toBeDefined();
    if (!plant || r4.bomb.plantTick === null) return;
    const kBefore = Math.floor((r4.bomb.plantTick - 64 - track.tick0) / track.step);
    const kAfter = Math.ceil((r4.bomb.plantTick + 8 - track.tick0) / track.step);
    expect(((track.flags[kBefore * P + plant.p] ?? 0) & REPLAY_FLAG.bomb) !== 0).toBe(true);
    for (let p = 0; p < P; p++) expect(((track.flags[kAfter * P + p] ?? 0) & REPLAY_FLAG.bomb) !== 0).toBe(false);
    expect(plant.x).not.toBe(REPLAY_ABSENT);
  });

  it('is deterministic and inside the size budget', () => {
    const a = buildReplay(raw, match);
    const b = buildReplay(raw, match);
    expect(a.length).toBe(match.rounds.length);
    expect(JSON.stringify(a.map((t) => ({ ...t, xy: [...t.xy], events: t.events.kills })))).toBe(JSON.stringify(b.map((t) => ({ ...t, xy: [...t.xy], events: t.events.kills }))));
    // A full round at 16 Hz × 10 players at 12 bytes plus events: well under 250 KB.
    expect(replayBytes([track])).toBeLessThan(250_000);
  });

  it('summarizes rounds for a user', () => {
    const user = 0;
    const s = roundSummaries(raw, match, user);
    expect(s.length).toBe(match.rounds.length);
    const kills = s.reduce((a, r) => a + r.user.kills, 0);
    const deaths = s.filter((r) => r.user.died).length;
    const sb = raw.scoreboard.rows.find((r) => r.p === user);
    expect(kills).toBeLessThanOrEqual((sb?.kills ?? 0) + 1);
    expect(deaths).toBe(sb?.deaths);
    expect(s[0]?.tags).toContain('pistol');
  });

  it('reads its tunables', () => {
    expect(COACH_TUNING.replay.hz).toBe(16);
  });
});
