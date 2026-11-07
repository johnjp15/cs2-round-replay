/**
 * H2: CS2 weapon mechanics as a pure, host-independent module (imports only src/contracts). docs/weapons.md.
 * - table.ts: the weapon table (`data/weapons.json`, from CS2's weapons.vdata) and its validation;
 * - accuracy.ts: accuracy penalty, inaccuracy, spread cones, shot direction;
 * - recoil.ts: recoil tables from the recoil seed, aim / view punch, spray patterns;
 * - damage.ts: falloff, hitgroups, armor (the sim2d math, data-driven);
 * - penetration.ts: wall penetration through host-provided solids;
 * - arms.ts: the per-player state machine (fire rate, reloads, zoom, bursts, tagging) and `fireShot`;
 * - aim.ts: recoil control for bots and puppets (the view that puts a bullet on the target despite the punch).
 */
export * from './table';
export * from './valve-random';
export * from './recoil';
export * from './accuracy';
export * from './damage';
export * from './penetration';
export * from './arms';
export * from './aim';
