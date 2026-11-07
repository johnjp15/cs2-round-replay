/**
 * A1: the sound-event table (docs/cs2-sounds.md). Every sound the 3D app plays has an id here, the CS2 sound
 * events it stands for (`game/csgo/pak01_dir/soundevents/*.vsndevts`, names exactly as in CS2), the mix bus it
 * goes through, whether it is positional, and a recipe for the procedurally generated placeholder (synth.ts) that
 * plays until John's extracted CS2 files are packed (tools/pack-sounds.ts).
 *
 * `tools/cs2-sound-events.ts` resolves the CS2 names into `data/audio/cs2-sound-events.json` (the manifest: the
 * `.vsnd` files of each event, its volume, pitch, distance curve and occlusion), from the public decompiled
 * sound events in SteamDatabase/GameTracking-CS2.
 *
 * Pure data, no DOM.
 */

/** Mix buses (CS2's mixgroups, simplified): every bus has its own gain under the master; `effects` = everything but music and UI. */
export const BUSES = ['weapons', 'foley', 'footsteps', 'impacts', 'grenades', 'bomb', 'ui', 'music'] as const;
export type Bus = (typeof BUSES)[number];

/**
 * A placeholder recipe (synth.ts renders it, deterministic per id).
 * - gun: noise burst with a low thump, `f` = body frequency, `bright` 0..1 = how much high crack, `dur` seconds;
 * - click: a short mechanical click (band-passed noise + tick), `f` = centre frequency;
 * - step: a soft thud (low-passed noise), `f` = cutoff;
 * - beep: a sine beep at `f`;
 * - whoosh: a noise sweep (throws, swings, whizzes), `f` = centre;
 * - boom: an explosion (noise + rumble), `f` = rumble frequency;
 * - hiss: long filtered noise (smoke), `f` = cutoff;
 * - crackle: fire crackle (a loop), `f` = cutoff;
 * - dink: metallic partials (helmet headshot), `f` = base;
 * - thump: flesh hit (low sine + noise), `f` = frequency;
 * - sting: a short chord (round start / end, music), `f` = root.
 */
export type SynthKind = 'gun' | 'click' | 'step' | 'beep' | 'whoosh' | 'boom' | 'hiss' | 'crackle' | 'dink' | 'thump' | 'sting';
export interface Synth {
  readonly kind: SynthKind;
  readonly dur: number;
  readonly f: number;
  readonly bright?: number;
  /** Peak gain of the rendered placeholder (0..1). */
  readonly gain?: number;
}

export interface SoundDef {
  /** CS2 sound events, in the order they are layered (child events such as `...SingleDistant` are added by the manifest). */
  readonly cs2: readonly string[];
  readonly bus: Bus;
  /** world: a PannerNode at the emitter with CS2's distance curve and occlusion; local: in the listener's head (own weapon, UI, feedback). */
  readonly space: 'world' | 'local';
  readonly synth: Synth;
  /** Loops until stopped (molotov burn). */
  readonly loop?: boolean;
  /**
   * Seconds of each CS2 file kept by tools/pack-sounds.ts (the page budget); default 2. Fire sounds keep their tail
   * (`...SingleDistant` is the far layer), music only its first seconds.
   */
  readonly keepSec?: number;
}

/** The guns with viewmodels and sounds (weapon table ids, docs/weapons.md). */
export const GUNS = ['ak47', 'm4a4', 'm4a1s', 'awp', 'ssg08', 'deagle', 'glock', 'usps', 'p2000'] as const;
export type Gun = (typeof GUNS)[number];
export const GRENADES = ['he', 'flash', 'smoke', 'molotov', 'incgrenade', 'decoy'] as const;
export type Grenade = (typeof GRENADES)[number];

/** Reload stages in the order they play; their times are fractions of the reload (RELOAD_STAGES). */
export const RELOAD_STAGE_IDS = ['clipout', 'clipin', 'bolt', 'bolt2'] as const;
export type ReloadStage = (typeof RELOAD_STAGE_IDS)[number];

/** Per gun: its CS2 sound-event prefix, the fire event, the reload stage events, draw, and the gun's placeholder voice. */
interface GunSounds {
  readonly fire: string;
  readonly draw: string;
  readonly stages: Partial<Record<ReloadStage, string>>;
  /** Bolt cycled after every shot (AWP, SSG 08): back, forward. */
  readonly boltAfterShot?: readonly [string, string];
  readonly zoom?: readonly [string, string];
  readonly pistol: boolean;
  readonly synth: Synth;
}

export const GUN_SOUNDS: { readonly [G in Gun]: GunSounds } = {
  ak47: {
    fire: 'Weapon_AK47.Single',
    draw: 'Weapon_AK47.Draw',
    stages: { clipout: 'Weapon_AK47.Clipout', clipin: 'Weapon_AK47.Clipin', bolt: 'Weapon_AK47.BoltPull' },
    pistol: false,
    synth: { kind: 'gun', dur: 0.42, f: 95, bright: 0.75 },
  },
  m4a4: {
    fire: 'Weapon_M4A4.Single',
    draw: 'Weapon_M4A1.Draw',
    stages: { clipout: 'Weapon_M4A1.Clipout', clipin: 'Weapon_M4A1.Clipin', bolt: 'Weapon_M4A1.BoltBack', bolt2: 'Weapon_M4A1.BoltForward' },
    pistol: false,
    synth: { kind: 'gun', dur: 0.38, f: 110, bright: 0.65 },
  },
  m4a1s: {
    fire: 'Weapon_M4A1.Silenced',
    draw: 'Weapon_M4A1.Draw',
    stages: { clipout: 'Weapon_M4A1.Clipout', clipin: 'Weapon_M4A1.Clipin', bolt: 'Weapon_M4A1.BoltBack', bolt2: 'Weapon_M4A1.BoltForward' },
    pistol: false,
    synth: { kind: 'gun', dur: 0.2, f: 160, bright: 0.15, gain: 0.5 },
  },
  awp: {
    fire: 'Weapon_AWP.Single',
    draw: 'Weapon_AWP.Draw',
    stages: { clipout: 'Weapon_AWP.Clipout', clipin: 'Weapon_AWP.Clipin', bolt: 'Weapon_AWP.BoltBack', bolt2: 'Weapon_AWP.BoltForward' },
    boltAfterShot: ['Weapon_AWP.BoltBack', 'Weapon_AWP.BoltForward'],
    zoom: ['Weapon_AWP.Zoom', 'Weapon_AWP.ZoomOut'],
    pistol: false,
    synth: { kind: 'gun', dur: 0.9, f: 60, bright: 0.9 },
  },
  ssg08: {
    fire: 'Weapon_SSG08.Single',
    draw: 'Weapon_SSG08.Draw',
    stages: { clipout: 'Weapon_SSG08.Clipout', clipin: 'Weapon_SSG08.Clipin', bolt: 'Weapon_SSG08.BoltBack', bolt2: 'Weapon_SSG08.BoltForward' },
    boltAfterShot: ['Weapon_SSG08.BoltBack', 'Weapon_SSG08.BoltForward'],
    zoom: ['Weapon_SSG08.Zoom', 'Weapon_SSG08.ZoomOut'],
    pistol: false,
    synth: { kind: 'gun', dur: 0.6, f: 80, bright: 0.85 },
  },
  deagle: {
    fire: 'Weapon_DEagle.Single',
    draw: 'Weapon_DEagle.Draw',
    stages: { clipout: 'Weapon_DEagle.Clipout', clipin: 'Weapon_DEagle.Clipin', bolt: 'Weapon_DEagle.Slideback', bolt2: 'Weapon_DEagle.Slideforward' },
    pistol: true,
    synth: { kind: 'gun', dur: 0.55, f: 75, bright: 0.8 },
  },
  glock: {
    fire: 'Weapon_Glock.Single',
    draw: 'Weapon_Glock.Draw',
    stages: { clipout: 'Weapon_Glock.Clipout', clipin: 'Weapon_Glock.Clipin', bolt: 'Weapon_Glock.Slideback', bolt2: 'Weapon_Glock.Sliderelease' },
    pistol: true,
    synth: { kind: 'gun', dur: 0.25, f: 170, bright: 0.5 },
  },
  usps: {
    fire: 'Weapon_USP.SilencedShot',
    draw: 'Weapon_USP.Draw',
    stages: { clipout: 'Weapon_USP.Clipout', clipin: 'Weapon_USP.Clipin', bolt: 'Weapon_USP.Slideback', bolt2: 'Weapon_USP.Sliderelease' },
    pistol: true,
    synth: { kind: 'gun', dur: 0.16, f: 200, bright: 0.1, gain: 0.45 },
  },
  p2000: {
    fire: 'Weapon_hkp2000.Single',
    draw: 'Weapon_hkp2000.Draw',
    stages: { clipout: 'Weapon_hkp2000.Clipout', clipin: 'Weapon_hkp2000.Clipin', bolt: 'Weapon_hkp2000.Slideback', bolt2: 'Weapon_hkp2000.Sliderelease' },
    pistol: true,
    synth: { kind: 'gun', dur: 0.26, f: 160, bright: 0.55 },
  },
};

/**
 * When each reload sound plays, as a fraction of the gun's reload time (the arms state machine's reload, docs/weapons.md).
 * CS2 places them by animation events in its viewmodel animations, which are not in the public dumps: these
 * fractions are measured by ear from CS2 reloads, **assumed**, and also time the viewmodel's mag-out / mag-in / bolt.
 */
export const RELOAD_STAGES: { readonly [G in Gun]: Partial<Record<ReloadStage, number>> } = {
  ak47: { clipout: 0.17, clipin: 0.52, bolt: 0.78 },
  m4a4: { clipout: 0.15, clipin: 0.48, bolt: 0.72, bolt2: 0.8 },
  m4a1s: { clipout: 0.15, clipin: 0.48, bolt: 0.72, bolt2: 0.8 },
  awp: { clipout: 0.18, clipin: 0.5, bolt: 0.72, bolt2: 0.8 },
  ssg08: { clipout: 0.18, clipin: 0.5, bolt: 0.72, bolt2: 0.8 },
  deagle: { clipout: 0.2, clipin: 0.55, bolt: 0.78, bolt2: 0.84 },
  glock: { clipout: 0.2, clipin: 0.55, bolt: 0.78, bolt2: 0.84 },
  usps: { clipout: 0.2, clipin: 0.55, bolt: 0.78, bolt2: 0.84 },
  p2000: { clipout: 0.2, clipin: 0.55, bolt: 0.78, bolt2: 0.84 },
};

/** Footstep surfaces (CS2's `<team>_<Surface>.StepLeft` / `Land_<Surface>.StepLeft`). */
export const SURFACES = ['concrete', 'tile', 'wood', 'sand', 'metal'] as const;
export type Surface = (typeof SURFACES)[number];
const SURFACE_CS2: { readonly [S in Surface]: string } = { concrete: 'Concrete', tile: 'Tile', wood: 'Wood', sand: 'Sand', metal: 'SolidMetal' };

const GRENADE_CS2: { readonly [G in Grenade]: string } = { he: 'HEGrenade', flash: 'Flashbang', smoke: 'SmokeGrenade', molotov: 'Molotov', incgrenade: 'IncGrenade', decoy: 'Decoy' };

function buildTable(): Record<string, SoundDef> {
  const t: Record<string, SoundDef> = {};
  const click = (f: number, dur = 0.08, gain = 0.6): Synth => ({ kind: 'click', dur, f, gain });
  for (const g of GUNS) {
    const s = GUN_SOUNDS[g];
    t[`fire.${g}`] = { cs2: [s.fire], bus: 'weapons', space: 'world', synth: s.synth, keepSec: 1.6 };
    t[`draw.${g}`] = { cs2: [s.draw], bus: 'foley', space: 'world', synth: click(2400, 0.12, 0.4) };
    for (const st of RELOAD_STAGE_IDS) {
      const ev = s.stages[st];
      if (ev !== undefined) t[`reload.${g}.${st}`] = { cs2: [ev], bus: 'foley', space: 'world', synth: click(st === 'clipout' ? 1300 : st === 'clipin' ? 1800 : 2600, 0.1, 0.55) };
    }
    if (s.boltAfterShot !== undefined) {
      t[`cycle.${g}.back`] = { cs2: [s.boltAfterShot[0]], bus: 'foley', space: 'world', synth: click(2200, 0.09, 0.45) };
      t[`cycle.${g}.forward`] = { cs2: [s.boltAfterShot[1]], bus: 'foley', space: 'world', synth: click(2900, 0.08, 0.45) };
    }
    if (s.zoom !== undefined) {
      t[`zoom.${g}.in`] = { cs2: [s.zoom[0]], bus: 'foley', space: 'local', synth: click(3500, 0.05, 0.3) };
      t[`zoom.${g}.out`] = { cs2: [s.zoom[1]], bus: 'foley', space: 'local', synth: click(3000, 0.05, 0.3) };
    }
  }
  t['dry.rifle'] = { cs2: ['Default.ClipEmpty_Rifle'], bus: 'foley', space: 'local', synth: click(3200, 0.05, 0.5) };
  t['dry.pistol'] = { cs2: ['Default.ClipEmpty_Pistol'], bus: 'foley', space: 'local', synth: click(3800, 0.04, 0.5) };
  // Knife, C4.
  t['draw.knife'] = { cs2: ['Weapon_Knife.Deploy'], bus: 'foley', space: 'world', synth: { kind: 'whoosh', dur: 0.25, f: 3000, gain: 0.35 } };
  t['knife.swing'] = { cs2: ['Weapon_Knife.Slash'], bus: 'foley', space: 'world', synth: { kind: 'whoosh', dur: 0.22, f: 1800, gain: 0.5 } };
  t['knife.hit'] = { cs2: ['Weapon_Knife.Hit'], bus: 'impacts', space: 'world', synth: { kind: 'thump', dur: 0.2, f: 140, gain: 0.7 } };
  t['knife.hitwall'] = { cs2: ['Weapon_Knife.HitWall'], bus: 'impacts', space: 'world', synth: click(1500, 0.12, 0.6) };
  t['draw.c4'] = { cs2: ['c4.draw'], bus: 'foley', space: 'world', synth: click(1600, 0.15, 0.4) };
  // Grenades: draw, pin, throw, bounce; then the pops.
  for (const g of GRENADES) {
    const n = GRENADE_CS2[g];
    t[`draw.${g}`] = { cs2: [`${n}.Draw`], bus: 'foley', space: 'world', synth: click(2000, 0.1, 0.35) };
    if (g !== 'molotov') t[`pin.${g}`] = { cs2: [`${n}.PullPin_Grenade`], bus: 'foley', space: 'world', synth: click(4200, 0.09, 0.45) };
    t[`throw.${g}`] = { cs2: [`${n}.Throw`], bus: 'grenades', space: 'world', synth: { kind: 'whoosh', dur: 0.3, f: 1200, gain: 0.5 } };
    if (g !== 'decoy') t[`bounce.${g}`] = { cs2: [`${n}.Bounce`], bus: 'grenades', space: 'world', synth: click(g === 'molotov' ? 900 : 1700, 0.09, 0.6) };
  }
  t['pin.molotov'] = { cs2: ['Molotov.PreThrow'], bus: 'foley', space: 'world', synth: { kind: 'crackle', dur: 0.3, f: 2500, gain: 0.3 } };
  t['pop.smoke'] = { cs2: ['BaseSmokeEffect.Sound'], bus: 'grenades', space: 'world', synth: { kind: 'hiss', dur: 2.2, f: 2200, gain: 0.55 }, keepSec: 2.5 };
  t['pop.flash'] = { cs2: ['Flashbang.Explode'], bus: 'grenades', space: 'world', synth: { kind: 'boom', dur: 0.6, f: 180, bright: 1, gain: 0.85 } };
  t['pop.he'] = { cs2: ['BaseGrenade.Explode'], bus: 'grenades', space: 'world', synth: { kind: 'boom', dur: 1.4, f: 55, bright: 0.6, gain: 1 }, keepSec: 2.5 };
  t['pop.molotov'] = { cs2: ['Inferno.Fire.Ignite'], bus: 'grenades', space: 'world', synth: { kind: 'boom', dur: 0.7, f: 90, bright: 0.3, gain: 0.7 } };
  t['burn.molotov'] = { cs2: ['Inferno.Loop'], bus: 'grenades', space: 'world', synth: { kind: 'crackle', dur: 2, f: 3000, gain: 0.45 }, loop: true, keepSec: 3 };
  t['out.molotov'] = { cs2: ['Molotov.Extinguish'], bus: 'grenades', space: 'world', synth: { kind: 'hiss', dur: 0.8, f: 4000, gain: 0.4 } };
  // Players: footsteps by team and surface, landings, jump.
  for (const team of ['T', 'CT'] as const) {
    for (const s of SURFACES) t[`step.${team}.${s}`] = { cs2: [`${team}_${SURFACE_CS2[s]}.StepLeft`], bus: 'footsteps', space: 'world', synth: { kind: 'step', dur: 0.12, f: s === 'metal' ? 2400 : s === 'wood' ? 900 : 1400, gain: 0.7 } };
  }
  for (const s of SURFACES) t[`land.${s}`] = { cs2: [`Land_${SURFACE_CS2[s]}.StepLeft`], bus: 'footsteps', space: 'world', synth: { kind: 'step', dur: 0.2, f: 900, gain: 0.85 } };
  t['jump'] = { cs2: ['Default.WalkJump'], bus: 'footsteps', space: 'world', synth: { kind: 'step', dur: 0.1, f: 1800, gain: 0.35 } };
  // Hits, kills, deaths. Onlooker = heard at the victim; feedback = the attacker hears it in the head; victim = the listener was hit.
  t['hit.flesh'] = { cs2: ['Flesh.BulletImpact'], bus: 'impacts', space: 'world', synth: { kind: 'thump', dur: 0.14, f: 120, gain: 0.7 } };
  t['hit.armor'] = { cs2: ['Player.DamageKevlar'], bus: 'impacts', space: 'world', synth: { kind: 'thump', dur: 0.12, f: 220, bright: 0.5, gain: 0.7 } };
  t['hit.head'] = { cs2: ['Player.DamageHeadShot.Onlooker'], bus: 'impacts', space: 'world', synth: { kind: 'thump', dur: 0.18, f: 170, bright: 0.6, gain: 0.85 } };
  t['hit.head.helmet'] = { cs2: ['Player.DamageHeadShotArmor.Onlooker'], bus: 'impacts', space: 'world', synth: { kind: 'dink', dur: 0.35, f: 2600, gain: 0.8 } };
  t['feedback.head'] = { cs2: ['Player.DamageHeadShot.AttackerFeedback'], bus: 'impacts', space: 'local', synth: { kind: 'thump', dur: 0.15, f: 180, bright: 0.5, gain: 0.6 } };
  t['feedback.head.helmet'] = { cs2: ['Player.DamageHeadShotArmor.AttackerFeedback'], bus: 'impacts', space: 'local', synth: { kind: 'dink', dur: 0.3, f: 2800, gain: 0.7 } };
  t['victim.body'] = { cs2: ['Player.DamageBody.VictimFlesh'], bus: 'impacts', space: 'local', synth: { kind: 'thump', dur: 0.16, f: 100, gain: 0.8 } };
  t['victim.head'] = { cs2: ['Player.DamageHeadShot.Victim'], bus: 'impacts', space: 'local', synth: { kind: 'thump', dur: 0.2, f: 150, bright: 0.6, gain: 0.9 } };
  t['victim.head.helmet'] = { cs2: ['Player.DamageHeadShotArmor.Victim'], bus: 'impacts', space: 'local', synth: { kind: 'dink', dur: 0.4, f: 2400, gain: 0.9 } };
  t['kill.feedback'] = { cs2: ['Player.DeathBody.AttackerFeedback'], bus: 'ui', space: 'local', synth: { kind: 'thump', dur: 0.25, f: 90, bright: 0.3, gain: 0.7 } };
  t['kill.feedback.head'] = { cs2: ['Player.DeathHeadShot.AttackerFeedback'], bus: 'ui', space: 'local', synth: { kind: 'dink', dur: 0.4, f: 2000, gain: 0.7 } };
  t['death'] = { cs2: ['Player.DeathBody.Onlooker'], bus: 'impacts', space: 'world', synth: { kind: 'thump', dur: 0.3, f: 80, gain: 0.8 } };
  t['death.head'] = { cs2: ['Player.DeathHeadShot.Onlooker'], bus: 'impacts', space: 'world', synth: { kind: 'thump', dur: 0.3, f: 110, bright: 0.5, gain: 0.85 } };
  t['death.self'] = { cs2: ['Player.DeathBody.Victim'], bus: 'impacts', space: 'local', synth: { kind: 'thump', dur: 0.5, f: 60, gain: 0.9 } };
  // Bullets in the world.
  t['impact.concrete'] = { cs2: ['Concrete.BulletImpact'], bus: 'impacts', space: 'world', synth: click(2100, 0.1, 0.55) };
  t['ricochet'] = { cs2: ['FX_RicochetSound.Ricochet'], bus: 'impacts', space: 'world', synth: { kind: 'whoosh', dur: 0.25, f: 4500, gain: 0.35 } };
  t['whiz'] = { cs2: ['BulletBy.Supersonic.Crack'], bus: 'impacts', space: 'world', synth: { kind: 'whoosh', dur: 0.12, f: 5000, bright: 1, gain: 0.55 } };
  // The bomb.
  t['c4.initiate'] = { cs2: ['c4.initiate'], bus: 'bomb', space: 'world', synth: click(1200, 0.15, 0.5) };
  t['c4.keypress'] = { cs2: ['c4.keypressquiet'], bus: 'bomb', space: 'world', synth: { kind: 'beep', dur: 0.06, f: 1900, gain: 0.35 } };
  t['c4.plant'] = { cs2: ['c4.plant'], bus: 'bomb', space: 'world', synth: click(900, 0.2, 0.6) };
  t['c4.beep'] = { cs2: ['C4.PlantSound'], bus: 'bomb', space: 'world', synth: { kind: 'beep', dur: 0.12, f: 2350, gain: 0.7 } };
  t['c4.defuse.start'] = { cs2: ['c4.disarmstart'], bus: 'bomb', space: 'world', synth: click(1400, 0.3, 0.55) };
  t['c4.defused'] = { cs2: ['c4.disarmfinish'], bus: 'bomb', space: 'world', synth: { kind: 'beep', dur: 0.4, f: 1200, gain: 0.6 } };
  t['c4.explode'] = { cs2: ['c4.explode'], bus: 'bomb', space: 'world', synth: { kind: 'boom', dur: 2.6, f: 40, bright: 0.7, gain: 1 }, keepSec: 3 };
  // Round and announcer (CS2's default music kit valve_cs2_01 and the CS2 classic announcer).
  t['round.start'] = { cs2: ['Music.StartRound.valve_cs2_01'], bus: 'music', space: 'local', synth: { kind: 'sting', dur: 1.6, f: 220, gain: 0.4 }, keepSec: 4 };
  t['round.won'] = { cs2: ['Music.WonRound.valve_cs2_01'], bus: 'music', space: 'local', synth: { kind: 'sting', dur: 2, f: 262, gain: 0.45 }, keepSec: 4 };
  t['round.lost'] = { cs2: ['Music.LostRound.valve_cs2_01'], bus: 'music', space: 'local', synth: { kind: 'sting', dur: 2, f: 196, gain: 0.45 }, keepSec: 4 };
  t['music.bomb'] = { cs2: ['Music.BombPlanted.valve_cs2_01'], bus: 'music', space: 'local', synth: { kind: 'sting', dur: 1.2, f: 147, gain: 0.3 }, keepSec: 4 };
  t['announce.ctwin'] = { cs2: ['Announcer.CTWin.CS2_Classic'], bus: 'ui', space: 'local', synth: { kind: 'sting', dur: 0.8, f: 330, gain: 0.35 }, keepSec: 2.5 };
  t['announce.twin'] = { cs2: ['Announcer.TWin.CS2_Classic'], bus: 'ui', space: 'local', synth: { kind: 'sting', dur: 0.8, f: 294, gain: 0.35 }, keepSec: 2.5 };
  t['announce.planted'] = { cs2: ['Announcer.BombPlanted.CS2_Classic'], bus: 'ui', space: 'local', synth: { kind: 'sting', dur: 0.8, f: 247, gain: 0.35 }, keepSec: 2.5 };
  t['announce.defused'] = { cs2: ['Announcer.BombDefused.CS2_Classic'], bus: 'ui', space: 'local', synth: { kind: 'sting', dur: 0.8, f: 392, gain: 0.35 }, keepSec: 2.5 };
  return t;
}

/** Every sound by id, sorted by id. */
export const SOUNDS: Readonly<Record<string, SoundDef>> = Object.fromEntries(Object.entries(buildTable()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
export const SOUND_IDS: readonly string[] = Object.keys(SOUNDS);

/** Every CS2 sound event the table names, sorted, unique. */
export function cs2EventNames(): string[] {
  return [...new Set(SOUND_IDS.flatMap((id) => (SOUNDS[id] as SoundDef).cs2))].sort();
}

/** Map a held item (WeaponId or weapon-table id) to the gun whose sounds it uses, or null. */
export function gunOf(item: string): Gun | null {
  return (GUNS as readonly string[]).includes(item) ? (item as Gun) : null;
}

export function grenadeOf(item: string): Grenade | null {
  return (GRENADES as readonly string[]).includes(item) ? (item as Grenade) : null;
}
