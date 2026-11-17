/**
 * K8 on the committed fixture (the public test demo, anonymized; every event, round 4's ticks in full): the Mirage
 * knowledge classifies every place name, the plant site ids map 184 → A and 185 → B, round 4 reads as the B rush
 * through Apartments it is, and the strategy detectors run through `analyze()` deterministically.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { analyze, createContext, reportJson } from '../../src/coach/analyze/index';
import { STRAT_GRID } from '../../src/coach/derive/strategy/grid';
import { STRAT_HITS } from '../../src/coach/derive/strategy/hits';
import { checkPlaces, KNOWLEDGE, type MapKnowledge } from '../../src/coach/derive/strategy/knowledge';
import { STRAT_LANES } from '../../src/coach/derive/strategy/lanes';
import { ingestMatch } from '../../src/coach/ingest/index';
import { decodeRawDemo } from '../../src/coach/model/raw-codec';

const raw = decodeRawDemo(gunzipSync(readFileSync(new URL('./fixtures/test-demo-r4.craw.gz', import.meta.url))));
const match = ingestMatch(raw);

describe('K8 on the test demo fixture', () => {
  it('classifies every place name of the demo', () => {
    const res = checkPlaces(KNOWLEDGE['de_mirage'] as MapKnowledge, raw.names.places);
    expect(res.unknown).toEqual([]);
    expect(res.classified).toBe(23);
  });

  it('reads round 4: B hit through Apartments, plant on B (site 185)', () => {
    const ctx = createContext(raw, match);
    const r4 = ctx.table(STRAT_GRID).rounds.find((g) => g.round.number === 4);
    expect(r4?.round.bomb.site).toBe(185);
    expect(r4?.plantSite).toBe('B');
    const hit = ctx.table(STRAT_HITS).find((h) => h.round === 4);
    expect(hit).toMatchObject({ site: 'B', timing: 'fast', plantSite: 'B', lanes: ['apartments'], behindUtil: false, winnerSide: 'T' });
    expect(hit?.committed.length).toBe(2);
    const apps = ctx.table(STRAT_LANES).find((l) => l.round === 4 && l.laneId === 'apartments');
    expect(apps).toMatchObject({ taken: true, contested: false });
  });

  it('runs every strategy detector through analyze() for every player, deterministically', () => {
    for (let p = 0; p < raw.players.length; p++) {
      const a = reportJson(analyze(raw, match, { user: p }));
      expect(a).toBe(reportJson(analyze(raw, match, { user: p })));
    }
  });
});
