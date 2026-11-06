// Shape of data/round.json (written by tools/extract-round.ts, documented in docs/round-data.md).
// Tool-side types only: the game-facing contract types belong to src/contracts (task A4).

export type PlayerId =
  | 'barely'
  | 'cart'
  | 'donk'
  | 'eradicate'
  | 'incredibad'
  | 'lokier'
  | 'snakelore'
  | 'snarlbot'
  | 'sp4rtan'
  | 'zwomp';

export type Team = 'T' | 'CT';

/** How a position (or shot) was obtained. Ordered from most to least certain. */
export type Confidence = 'observed' | 'estimated' | 'inferred';

export type WeaponId =
  | 'ak47'
  | 'awp'
  | 'ssg08'
  | 'deagle'
  | 'm4a4'
  | 'glock'
  | 'knife'
  | 'c4'
  | 'smoke'
  | 'flash'
  | 'he'
  | 'molotov';

export type GrenadeId = 'smoke' | 'flash' | 'he' | 'molotov';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface MapTransform {
  posx: number;
  posy: number;
  scale: number;
  size: number;
}

export interface RoundMeta {
  clock0: number;
  bombTimerSec: number;
  score: { ct: number; t: number };
  scoreAfter: { ct: number; t: number };
  teams: { CT: string; T: string };
  map: MapTransform;
  video: string;
  durationSec: number;
  roundEndT: number;
  roundEndTick: number;
  hudRound: string;
  ticksPerSec: number;
  sources: {
    html: { file: string; sha256: string };
    shotsCsv: { file: string; sha256: string; rows: number };
  };
}

export interface Kit {
  primary: WeaponId | null;
  secondary: WeaponId | null;
  grenades: GrenadeId[];
  c4: boolean;
  kit: boolean;
  /** Clip/reserve of the weapon drawn at t = 0 (primary if any, else secondary). */
  clip: number;
  reserve: number;
  /** True when the loadout is an assumption (not seen in the recording). */
  assumed: boolean;
}

export interface Pickup {
  t: number;
  tick: number;
  weapon: WeaponId;
}

export interface Player {
  id: PlayerId;
  name: string;
  team: Team;
  color: string;
  chev: string;
  start: { pos: Vec3; yaw: number | null; confidence: Confidence };
  startHp: number;
  startArmor: number;
  startHelmet: boolean;
  startMoney: number | null;
  kit: Kit;
  pickups: Pickup[];
  role: string;
  roles: string[];
  isHumanDefault: boolean;
  deathT: number | null;
  deathTick: number | null;
  note: string;
}

export interface TrackSample {
  t: number;
  tick: number;
  x: number;
  y: number;
  z: number;
  confidence: Confidence;
  /** Radius in world units; present only for non-observed samples whose source carries one (CTs). */
  uncertainty?: number;
  /** True when this 10 Hz grid sample was linearly interpolated from off-grid source samples. */
  resampled?: boolean;
}

export interface YawSample {
  t: number;
  tick: number;
  deg: number;
}

export interface Track {
  samples: TrackSample[];
  /** Source samples that were not on the 0.1 s grid, kept verbatim (event anchors). */
  offGridSamples: TrackSample[];
  yaw: YawSample[];
  endT: number;
  endTick: number;
}

export type ShotKind = 'shot' | 'shot_kill' | 'hit' | 'kill' | 'shot_count' | 'switch';

export interface Shot {
  /** null for count-only rows whose time is unknown (see window). */
  t: number | null;
  tick: number | null;
  window: { t0: number; tick0: number; t1: number; tick1: number } | null;
  count: number;
  shooter: PlayerId;
  weapon: WeaponId;
  kind: ShotKind;
  target: PlayerId | null;
  damage: number | null;
  armorDamage: number | null;
  headshot: boolean;
  confidence: Confidence;
  /** Every CSV column verbatim, keyed by its header. */
  raw: Record<string, string>;
}

export interface Kill {
  t: number;
  tick: number;
  killer: PlayerId;
  victim: PlayerId;
  weapon: WeaponId;
  hs: boolean;
  assist: PlayerId | null;
  postRound: boolean;
  kpos: Vec3;
  vpos: Vec3;
  kplace: string;
  vplace: string;
}

export interface Damage {
  t: number;
  tick: number;
  attacker: PlayerId;
  victim: PlayerId;
  amount: number;
  armor: number | null;
  weapon: WeaponId;
  note: string;
  apos: Vec3 | null;
  vpos: Vec3 | null;
  source: 'damage' | 'shots_csv';
}

export interface Utility {
  t: number;
  tick: number;
  thrower: PlayerId;
  kind: GrenadeId;
  place: string;
  /** Thrower's position at the throw (landing spot unknown). */
  throwPos: Vec3;
  radio: string;
}

export interface Radio {
  t: number;
  tick: number;
  who: PlayerId;
  place: string;
  text: string;
  kind: 'radio' | 'callout';
}

export interface Chat {
  t: number;
  tick: number;
  who: PlayerId;
  dead: boolean;
  text: string;
}

export interface Sighting {
  who: PlayerId;
  t0: number;
  tick0: number;
  t1: number;
  tick1: number;
  place: string;
  by: string;
}

export interface LastKnown {
  who: PlayerId;
  t0: number;
  tick0: number;
  t1: number;
  tick1: number;
  pos: Vec2;
}

export interface PovSegment {
  t0: number;
  tick0: number;
  t1: number;
  tick1: number;
  target: PlayerId;
  note: string;
}

export interface RoundEvent {
  t: number;
  tick: number;
  kind: string;
  text: string;
  who: PlayerId | null;
  victim: PlayerId | null;
  util: GrenadeId | null;
}

export interface Bomb {
  carrier: PlayerId;
  plantT: number;
  plantTick: number;
  pos: Vec3;
  defuseStartT: number;
  defuseStartTick: number;
  defuseT: number;
  defuseTick: number;
}

export interface TimelinePoint {
  t: number;
  tick: number;
  value: number;
}

export interface WeaponTimelinePoint {
  t: number;
  tick: number;
  weapon: WeaponId | null;
  raw: string;
}

export interface Round {
  meta: RoundMeta;
  players: Player[];
  tracks: Record<string, Track>;
  shots: Shot[];
  kills: Kill[];
  damage: Damage[];
  utility: Utility[];
  radio: Radio[];
  chat: Chat[];
  sightings: Sighting[];
  lastKnown: LastKnown[];
  pov: PovSegment[];
  bomb: Bomb;
  timelines: {
    hp: Record<string, TimelinePoint[]>;
    money: Record<string, TimelinePoint[]>;
    weapon: Record<string, WeaponTimelinePoint[]>;
  };
  events: RoundEvent[];
}

export const PLAYER_IDS: readonly PlayerId[] = [
  'barely',
  'cart',
  'donk',
  'eradicate',
  'incredibad',
  'lokier',
  'snakelore',
  'snarlbot',
  'sp4rtan',
  'zwomp',
];

export const WEAPON_IDS: readonly WeaponId[] = [
  'ak47',
  'awp',
  'ssg08',
  'deagle',
  'm4a4',
  'glock',
  'knife',
  'c4',
  'smoke',
  'flash',
  'he',
  'molotov',
];

export const TICKS_PER_SEC = 64;

export function toTick(t: number): number {
  return Math.round(t * TICKS_PER_SEC);
}
