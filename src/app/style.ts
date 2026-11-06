/**
 * Palette and type for the canvas renderer and the HUD. The colours follow the existing replay page
 * ("Mirage after dusk": web-apps/cs2/mirage-round-replay): night background, sand text, Ts warm gold,
 * CTs cool blue, bomb red, defuse green. index.html mirrors them as CSS custom properties; keep the two
 * in step. Everything is drawn by the app; no game UI assets.
 */
import type { GrenadeId, Team } from '../contracts/index';

export const PALETTE = {
  /** Page and canvas background (matches the radar's black surround). */
  night: '#05080c',
  slab: '#121a23',
  rule: '#263342',
  sand: '#ece2cc',
  sandDim: '#9f988a',
  /** Ts (warm) and CTs (cool), as on the replay page. */
  T: '#ebc75e',
  CT: '#8bbcf3',
  bomb: '#ff5450',
  defuse: '#4cc982',
  /** LIVE pawns: the one alarm colour, used for nothing else. */
  live: '#ff4fd8',
  /** Outline under every mark so it reads on the light radar floors. */
  ink: 'rgba(3, 5, 8, 0.92)',
  dead: 'rgba(236, 226, 204, 0.62)',
  human: '#ffffff',
} as const;

/** Grenade colours (replay page: smoke grey, flash white, HE salmon, molotov orange). */
export const GRENADE_COLORS: { readonly [K in GrenadeId]: string } = {
  smoke: '#cfd6de',
  flash: '#fffbe0',
  he: '#ff8a5b',
  molotov: '#ff9b2f',
};

export function teamColor(team: Team): string {
  return team === 'T' ? PALETTE.T : PALETTE.CT;
}

/**
 * Condensed display face for names, numbers and badges. Avenir Next Condensed ships with macOS and
 * iOS; the rest are fallbacks (TeX Gyre Heros Cn / DejaVu Sans Condensed on the Linux test VM).
 * No web fonts: the page makes no requests outside its origin.
 */
export const DISPLAY_FONT =
  '"Avenir Next Condensed", "DIN Condensed", "Saira Condensed", "Roboto Condensed", "Arial Narrow", "TeX Gyre Heros Cn", "DejaVu Sans Condensed", sans-serif';

/** Text face for the status panel's log lines. */
export const TEXT_FONT = 'system-ui, -apple-system, "Segoe UI", Inter, sans-serif';
