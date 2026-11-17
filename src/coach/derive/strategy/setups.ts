/**
 * K8 table `strategy.setups`: per played round, where each CT stood `setupSec` after freeze end and at the first
 * contact (the first damage between enemies), as zone groups and a compact label ("2 A, 1 mid, 2 B"), against the site
 * the Ts hit: how many CTs defended it (zone on that side, in its area, or a zone that `defends` it) at setup time and
 * at the entry.
 */
import type { AnalysisContext, TableDef } from '../../analyze/context';
import type { Side } from '../../model/match';
import { HURTS } from '../hurts';
import { STRAT_GRID, Z_DEAD, Z_NONE, Z_UNKNOWN, sampleAt, type RoundGrid } from './grid';
import { STRAT_HITS } from './hits';
import type { PlaceLookup, SiteId, ZoneGroup } from './knowledge';
import { STRATEGY_TUNING } from './tuning';

/** A CT's position in a setup: zone id (or `dead` / `unknown`), its group, its place name. */
export interface SetupSpot {
  slot: number;
  zone: string;
  group: ZoneGroup | 'dead' | 'unknown';
  place: string;
}

export interface SetupRow {
  round: number;
  setupTick: number;
  setup: SetupSpot[];
  label: string;
  contactTick: number | null;
  contact: SetupSpot[];
  contactLabel: string;
  hitSite: SiteId | null;
  /** CTs defending the hit site at setup time and at the Ts' entry (null without a hit). */
  onHitSiteAtSetup: number | null;
  onHitSiteAtEntry: number | null;
  /** The CTs who defended the hit site at the entry (slots). */
  hitSiteDefenders: number[];
  /** CTs defending each site at setup time. */
  defendersAtSetup: Record<SiteId, number>;
  winnerSide: Side | null;
}

const ORDER: readonly string[] = ['A', 'mid', 'B', 'CT', 'T', 'unknown', 'dead'];

export function spotsAt(ctx: AnalysisContext, g: RoundGrid, lookup: PlaceLookup, k: number, slots: readonly number[]): SetupSpot[] {
  const P = ctx.P;
  return slots.map((p) => {
    const z = g.zone[k * P + p] ?? Z_DEAD;
    const row = g.rows[k] ?? 0;
    const place = ctx.raw.names.places[ctx.raw.ticks.place[row * P + p] ?? 0] ?? '';
    if (z === Z_DEAD) return { slot: p, zone: 'dead', group: 'dead', place: '' };
    if (z === Z_UNKNOWN || z === Z_NONE) return { slot: p, zone: 'unknown', group: 'unknown', place };
    const zone = lookup.zone(z);
    return { slot: p, zone: zone?.id ?? 'unknown', group: zone?.group ?? 'unknown', place };
  });
}

/** "2 A, 1 mid, 2 B" (groups in a fixed order; dead and unclassified players listed last). */
export function setupLabel(spots: readonly SetupSpot[]): string {
  const n = new Map<string, number>();
  for (const s of spots) n.set(s.group, (n.get(s.group) ?? 0) + 1);
  return ORDER.filter((g) => (n.get(g) ?? 0) > 0).map((g) => `${n.get(g) ?? 0} ${g === 'unknown' ? '?' : g}`).join(', ');
}

export function defendersAt(g: RoundGrid, lookup: PlaceLookup, k: number, P: number, site: SiteId): number[] {
  return g.CT.filter((q) => {
    const z = g.zone[k * P + q] ?? Z_DEAD;
    return z >= 0 && lookup.defends(z, site);
  });
}

export function buildSetups(ctx: AnalysisContext): SetupRow[] {
  const grid = ctx.table(STRAT_GRID);
  const lookup = grid.lookup;
  if (lookup === null) return [];
  const hits = new Map(ctx.table(STRAT_HITS).map((h) => [h.round, h]));
  const hurts = ctx.table(HURTS);
  const rate = ctx.raw.header.tickRate || 64;
  const P = ctx.P;
  return grid.rounds.map((g) => {
    const r = g.round;
    const setupTick = Math.min(g.end, g.t0 + Math.round(STRATEGY_TUNING.setup.setupSec * rate));
    const ks = sampleAt(g, setupTick);
    const setup = spotsAt(ctx, g, lookup, ks, g.CT);
    const contactHurt = hurts.find((h) => h.round === r.number && h.enemy && h.hurt.tick >= g.t0);
    const contactTick = contactHurt?.hurt.tick ?? null;
    // The sample just before the first damage: where everyone stood when it started.
    const kc = contactTick === null ? -1 : Math.max(0, sampleAt(g, contactTick) - 1);
    const contact = kc >= 0 ? spotsAt(ctx, g, lookup, kc, g.CT) : [];
    const hit = hits.get(r.number);
    const site = hit?.site ?? null;
    let atSetup: number | null = null;
    let atEntry: number | null = null;
    let defenders: number[] = [];
    if (site !== null) {
      atSetup = defendersAt(g, lookup, ks, P, site).length;
      if (hit?.entryTick !== null && hit?.entryTick !== undefined) {
        // Just before the entry: who was there to meet it.
        const ke = Math.max(0, sampleAt(g, hit.entryTick) - 1);
        defenders = defendersAt(g, lookup, ke, P, site);
        atEntry = defenders.length;
      }
    }
    return {
      round: r.number, setupTick: g.ticks[ks] ?? setupTick, setup, label: setupLabel(setup), contactTick, contact,
      contactLabel: contact.length > 0 ? setupLabel(contact) : '', hitSite: site, onHitSiteAtSetup: atSetup, onHitSiteAtEntry: atEntry,
      hitSiteDefenders: defenders, winnerSide: r.winnerSide,
      defendersAtSetup: { A: defendersAt(g, lookup, ks, P, 'A').length, B: defendersAt(g, lookup, ks, P, 'B').length },
    };
  });
}

export const STRAT_SETUPS: TableDef<SetupRow[]> = { id: 'strategy.setups', build: buildSetups };
