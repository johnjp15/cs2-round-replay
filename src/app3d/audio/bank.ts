/**
 * A1: the packed CS2 sound bank, if this build has one (docs/cs2-sounds.md). `tools/pack-sounds.ts` writes
 * `local/cs2-sound-bank.json` (gitignored: Valve's files are never committed): `{ version: 1, codec, files: {
 * "<cs2 .vsnd path>": "<base64 mono Opus>" } }`. Vite inlines it into the page when it exists (dev, build and the
 * encrypted single page alike); without it the glob is empty and every sound is its placeholder.
 */
const found = import.meta.glob<string>('../../../local/cs2-sound-bank.json', { eager: true, query: '?raw', import: 'default' });

export interface SoundBank {
  readonly version: number;
  readonly codec: string;
  readonly files: Readonly<Record<string, string>>;
}

let parsed: SoundBank | null | undefined;

/** The bank's files (CS2 path → base64), or null when the build has none. */
export function bankFiles(): Readonly<Record<string, string>> | null {
  if (parsed === undefined) {
    const raw = Object.values(found)[0];
    parsed = raw === undefined ? null : (JSON.parse(raw) as SoundBank);
  }
  return parsed === null ? null : parsed.files;
}

/** True when this build carries the CS2 bank. */
export function hasBank(): boolean {
  return Object.keys(found).length > 0;
}
