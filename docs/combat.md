# Combat in the 2D sim (`src/sim2d/weapons.ts`, `hitscan.ts`, `grenades.ts`, `bomb.ts`, `round.ts`, `collision.ts`, `host.ts`)

Weapons, bullets, damage, grenades, sounds, the bomb, the round rules and pawn collision for `Sim2DHost`, close
enough to CS2 that a Core written against the 2D engine works unchanged in CS2. Every number comes from
`data/tuning.json` (`weapons`, `grenades`, `damage`, `sound`, `bomb`, `round`, `collision`). The functions are
pure; the host owns the state. Movement is in `docs/movement.md`.

## Conventions

- **Pitch** is Source's: degrees, **positive = looking down**, 0 = level (`docs/cs2-adapter.md`, finding F1).
  Yaw as in `docs/movement.md` (0 = east, 90 = north).
- **Eye height** is 64 above `pos.z` standing and 46 crouched (`damage.eyeHeight`, `crouchEyeHeight`).
- **Aim bands** sit at fixed heights above `pos.z` on a standing target: head 64, chest 48, stomach 36, leg 16
  (`damage.bandHeights`). A crouched target's bands scale by 46 / 64.
- Times inside the engine are **fractional ticks** rounded to 6 decimals (`nextAttackTick` 6.4, 12.8, …). An
  action is due at the first integer tick ≥ its time.

## Weapon table (`tuning.weapons`)

| id | damage | rpm | headshotMult | armorPen | rangeModifier | clip | reserve | reloadSec | deploySec | automatic |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| ak47 | 36 | 600 | 4 | 0.775 | 0.98 | 30 | 90 | 2.5 | 1 *(assumed)* | yes |
| awp | 115 | 41 | 4 | 0.975 | 0.99 | **10** *(recording; CS2: 5)* | 30 | 3.67 | 1.25 *(assumed)* | no |
| ssg08 | 88 | 48 | 4 | 0.85 | 0.98 | 10 | 90 | 3.67 | 1.25 *(assumed)* | no |
| deagle | 53 | 267 | **3.9** | 0.932 | 0.85 | 7 | 35 | 2.17 | 1 *(assumed)* | no |
| m4a4 | 33 | 666.667 | 4 | 0.70 | 0.97 | 30 | 90 | 3.07 | 1 *(assumed)* | yes |
| glock | 30 | 400 | 4 | 0.47 | **0.85** | 20 | 120 | 2.17 | 1 *(assumed)* | **no** |

Sources (read 2026-11-05):

- **AK-47:** [csdb.gg AK-47](https://csdb.gg/weapon/ak-47): 36 damage, 600 RPM, 77.5 % armor penetration, range
  modifier 0.98, ×4 head, 30/90, reload 2.5 s. The page says its stats come from CS2 game data files. Cross-checked
  with [metabot.gg AK-47](https://metabot.gg/en/cs2/weapon/ak47/overview) (same damage, multiplier, penetration,
  range modifier and RPM; "Automatic").
- **AWP:** [csdb.gg AK-47 vs AWP](https://csdb.gg/compare/ak-47-vs-awp/): 115, 41 RPM, 97.5 %, 0.99, ×4, reload 3.67 s.
  That page gives a 5-round magazine. The clip stays at **10** because the recording shows donk's AWP HUD going
  10 → 9 → 8 (shots CSV rows 14 and 17), and `data/round.json` (donk's kit, generated from this table) says 10/30.
  See "Open questions" below.
- **SSG 08, M4A4:** [csdb.gg M4A4 vs SSG 08](https://csdb.gg/compare/m4a4-vs-ssg-08/): SSG 88, 48 RPM, 85 %, 0.98, ×4,
  10/90, 3.67 s; M4A4 33, 667 RPM, 70 %, 0.97, ×4, 30/90, 3.07 s. The M4A4's 667 is 60 / 0.09 s, stored as 666.667.
- **Desert Eagle:** [csdb.gg Desert Eagle](https://csdb.gg/weapon/desert-eagle) and
  [metabot.gg Desert Eagle](https://metabot.gg/en/cs2/weapon/deagle/overview) agree: 53 damage, **×3.9 head**,
  93.2 %, 0.85, 267 RPM, 7 rounds. csdb gives 35 reserve and a 2.17 s reload. The
  [Counter-Strike wiki](https://counterstrike.fandom.com/wiki/Desert_Eagle) dates the 63 → 53 body-damage change
  to 21 September 2021. The brief assumed ×4; the sources say 3.9.
- **Glock-18:** [csdb.gg Glock-18](https://csdb.gg/weapon/glock-18): 30, 400 RPM, 47 %, **0.85**, ×4, 20/120, 2.17 s.
  The brief suggested a range modifier of 0.9; the source says 0.85. The recording confirms 20/120 (donk's HUD,
  shots CSV row 19). The Glock is semi-automatic in CS (its burst mode is not modelled), so `automatic: false`.
- **deploySec:** *assumed*. No source found for CS2 draw times; they are placeholders for the CS2 probe (P3).
- **Not used:** a per-weapon maximum range. All bullets use `damage.maxRange` 8192 (metabot lists 8192 for the
  AK-47 and 4096 for the Desert Eagle; the 2D map is smaller than either).

### The March 2026 reload change

Valve changed reloading in CS2 on 18–19 March 2026. Reserve ammo is now counted in magazines, and "when you
reload, you'll drop the used magazine and discard all of its remaining ammo"
([PC Gamer](https://www.pcgamer.com/games/fps/counter-strike-2-introduces-the-games-biggest-shake-up-in-years-now-when-reloading-you-lose-all-the-mags-remaining-ammo)).
The magazine is lost when the reload animation completes, so switching weapons first keeps it
([allthings.how](https://allthings.how/cs2s-new-magazine-system-means-every-reload-now-costs-you-bullets/): AK-47
30 + 3 magazines, M4A4 30 + 4, AWP 5 + 2). [Hawk Live](https://hawk.live/posts/how-many-bullets-each-weapon-has-in-counter-strike-2-after-the-reload-update)
lists total reserves after the update: AK 90, M4A4 120, AWP 15, SSG 08 20, Desert Eagle 21, Glock 60.

The recording predates this change (donk's Glock shows 20/120), so the table keeps the old reserves and
`damage.reloadDiscardsMagazine` is `false`. Set it to `true` (and change the reserves) to match today's CS2.
Both behaviours are tested.

## Fire rules (`stepWeapon`)

Each tick, for the held item, in this order:

1. **Reload completes** when its end tick has come. The magazine is topped up from reserve:
   `moved = min(clip max − clip, reserve)`. With `reloadDiscardsMagazine` the old rounds are dropped first.
2. **Fire.** All of these must hold:
   - ATTACK is held, the item is deployed, and no reload is in progress.
   - The cycle is ready and clip > 0.
   - For semi-automatic guns (awp, ssg08, deagle, glock), no shot has been fired yet in this ATTACK press. The
     press resets when ATTACK is released. Pressing before the bolt is ready and holding fires as soon as it is.
   A shot uses one round. The next shot is due at `due + 64 × 60 / rpm` when this shot was fired within one tick
   of being due, else at `tick + 64 × 60 / rpm`. So a held AK-47 fires at ticks ⌈0⌉, ⌈6.4⌉, ⌈12.8⌉ … =
   0, 7, 13, 20, 26, 32, 39, 45, 52, 58: **exactly 10 rounds in 1.0 s**, and the 11th at tick 64. Core should
   hold ATTACK through a spray and tap it for single shots (`docs/cs2-adapter.md`, F7).
3. **Reload starts** if nothing was fired this tick, the item is deployed, it is not already reloading, reserve
   > 0 and the magazine is not full, and either:
   - RELOAD is held, or
   - the magazine is empty and the cycle is ready (auto reload: the AK-47's 30th round at tick 186, the reload
     at 192, the next shot at 352).
4. **Grenades:** ATTACK while deployed pulls the pin; releasing ATTACK throws (see Grenades).

Knife and c4 do nothing on ATTACK (no knife attacks; the c4 is planted with USE, see "Bomb and round rules").

`set_weapon` to a different item cancels any reload or primed grenade and starts its deploy: it can fire after
`deploySec` (`grenades.deploySec` for grenades, `damage.defaultDeploySec` for knife and c4). **Exception:** a
`set_weapon` in the same act as a `teleport` of that pawn is state placement (setup, rewind), so the item is
ready at once. Otherwise the round-start setup would lock everyone's gun for a second, and snarlbot's kill at
0.5 s could not happen.

## Hitscan (`traceShot`)

A bullet is a 2D ray from the shooter's `pos` along `yaw`, up to `damage.maxRange`.

1. **Candidates** are alive pawns other than the shooter whose circle of radius `damage.pawnRadius` (16) the ray
   crosses ahead of the shooter. A pawn the shooter overlaps counts at distance 0. With `friendlyFire: false`,
   teammates are skipped: shots pass through them. They are taken in ray order, then by id.
2. **Walls:** if `nav.lineOfSight(shooter, impact)` fails for a candidate (impact = where the ray enters its
   circle), the bullet hit a wall first. No pawn further along is hit.
3. **Hitgroup from pitch:** for each band, the aim pitch is −atan2(band z − eye z, horizontal distance), using
   the target's centre. The closest band to the shooter's pitch is the hitgroup if it is within
   `damage.hitToleranceDeg` (3°). Otherwise the bullet passes over or under this pawn and the next candidate is
   tried. `aimPitch(from, to, band, tuning.damage)` gives Core the pitch to aim with.
4. Bullets ignore smoke.

The 2D engine produces `head`, `chest`, `stomach` and `leg`, never `arm` or `neck`.

## Damage (CS2 formula)

For a bullet hit at 3D distance `dist`, from the eye to the band's aim point:

1. `damage = base × rangeModifier^(dist / 500) × mult`.
   - `mult` is the weapon's `headshotMult` for the head.
   - Otherwise it comes from `damage.hitgroupMult`: chest 1, stomach 1.25, arm 1, leg 0.75, neck 1, generic 1.
2. **Armored** if armor > 0 and the area is armored: chest, stomach, arm, neck and generic (blast) always; the
   head only with a helmet; legs never. Then:
   - `toHealth = damage × armorPen`
   - `toArmor = (damage − toHealth) × armorBonus` (0.5)
   - If `toArmor > armor`: `toHealth = damage − armor / armorBonus` and `toArmor = armor` (the leftover goes to
     health).

### Rounding (exact rules)

- **HP removed** = `trunc(toHealth)` (or `trunc(damage)` unarmored). This is CS's `(int)` "round damage to
  integer" in `CCSPlayer::OnTakeDamage`.
- **New armor** = `trunc(armor − toArmor)` (CS: `int armorValue -= float`). **Armor removed** = old armor − new
  armor, which is ⌈toArmor⌉ for a fractional `toArmor`.
- Before each `trunc`, the value is rounded to 6 decimals, so a last-bit difference in `Math.pow` between JS
  engines can't move a result across an integer.
- The `damage` event reports what was actually removed: HP capped at the victim's HP (as the CS2 adapter does
  with `dmg_health`), and armor capped at the victim's armor.

### Checks

Tested in `tests/combat.test.ts`:

- **AK-47 chest at 10 units on 100/100 with a helmet:** 3D distance 18.9; 36 × 0.98^0.038 = 35.97;
  × 0.775 = 27.88 → **27 HP**; toArmor 4.05 → **armor 100 → 95**.
- **AK-47 head on 100/100 with a helmet:** 144 × 0.98^(d/500) × 0.775 ≈ 109–111 → **lethal**.
- **AK-47 chest at 2,000 units:** 36 × 0.98⁴ = 33.2 → **33** unarmored, **25** HP and 4 armor through armor.
- **AWP chest through armor:** 115 × 0.99 × 0.975 = **111 at 500 units → kills** from 100 HP, through armor.
  The AWP kills with any chest or stomach hit; a leg hit (86 at close range) does not.
- **The four recorded hits of the round** are reproduced exactly (positions from `round.json`; hitgroups
  inferred):

| t | attacker → victim | weapon | 3D distance | recorded | model |
| --- | --- | --- | ---: | --- | --- |
| 18.50 | lokier → cart | ssg08 | 514 | 73 HP / 7 armor | chest, armored: 73.26 → 73; toArmor 6.46 → **7** |
| 49.90 | sp4rtan → donk | ak47 | 527 | 27 | chest, armored: 27.31 → 27 |
| 50.00 | sp4rtan → donk | ak47 | 527 | 34 | stomach, armored: 34.14 → 34 |
| 50.10 | sp4rtan → donk | ak47 | 528 | 26 | leg: 26.43 → 26 |

The 7 armor needs the int subtraction: rounding would give 6. The HP values have fractions below .5, so they
fit both truncation and rounding.

Per weapon, against 100/100 with a helmet (HP / armor removed):

| weapon | head @10 | chest @10 | stomach @10 | leg @10 | chest @1000 | chest @1000, no armor |
| --- | --- | --- | --- | --- | --- | --- |
| ak47 | 111 / 17 | 27 / 5 | 34 / 6 | 26 / 0 | 26 / 4 | 34 |
| awp | 448 / 6 | 112 / 2 | 140 / 2 | 86 / 0 | 109 / 2 | 112 |
| ssg08 | 299 / 27 | 74 / 7 | 93 / 9 | 65 / 0 | 71 / 7 | 84 |
| deagle | 192 / 8 | 49 / 2 | 61 / 3 | 39 / 0 | 35 / 2 | 38 |
| m4a4 | 92 / 20 | 23 / 5 | 28 / 7 | 24 / 0 | 21 / 5 | 31 |
| glock | 56 / 32 | 14 / 8 | 17 / 10 | 22 / 0 | 10 / 6 | 21 |

## Damage actions and blocking

- **`block_damage {attacker, victim}`** blocks the engine's own damage for that ordered pair (bullets and the
  attacker's grenades) until `unblock_damage`. The shot still happens: `shot` and `sound` events, ammo, cadence.
  But no HP or armor changes and **no `damage` event** is emitted. Each blocked hit adds a line to
  `host.combatLog()` (debug only; not in observe or snapshots). Scripted damage ignores blocks.
  `blockedPairs()` lists the active blocks.
- **`damage {attacker, victim, amount, armor, hitgroup, weapon, lethal}`** (scripted) is queued by `apply()` and
  applied in the next `tick()`, after shots and grenades, in Core order. It removes `amount` HP and `armor` armor,
  each capped at what the victim has, and emits `damage` with `scripted: true` and the amounts actually removed.
  `lethal: true` takes all remaining HP. HP ≤ 0 → `death {victim, attacker, weapon, headshot: hitgroup === 'head'}`.
  Damage to a dead or unknown pawn is noted in `unhandled()` and not applied.
- **Engine damage** (bullets, HE, fire) emits `damage` with `scripted: false`.
- **Deaths** are applied at the damage that causes them: `death` follows its `damage` event. The pawn stops, any
  reload or primed grenade is cancelled, and it takes no further part in the tick. Pawns act in id order within a
  tick, so if two pawns shoot each other in the same tick and the first shot kills, the second is not fired.

## Sounds

`sound {source, pos, kind}` at the source pawn's position (the grenade's position for `grenade`):

| kind | when |
| --- | --- |
| `shot` | every shot, right after its `shot` event |
| `footstep` | horizontal speed after movement > `sound.footstepSpeed` (135), at most every `sound.footstepIntervalSec` (0.3 s) per pawn. Walking (knife 130, AK 112) and crouching are silent. *Assumed values.* |
| `reload` | when a reload starts (manual or automatic) |
| `grenade` | when a grenade pops or a molotov bursts, at the effect's position; `source` = thrower |
| `bomb` | the planted bomb's beep, at the bomb; `source` = **null** (C3; see "Bomb and round rules") |

## Grenades (`grenades.ts`)

With a grenade held and deployed, ATTACK pulls the pin and releasing ATTACK throws. The grenade leaves the
inventory. Each grenade is its own inventory entry: two `give smoke` = two smokes. If another of the same kind
is left, it is drawn (deploy); otherwise the first primary, else secondary, else knife.

**Flight.**

1. **Throw angle:** level aim throws 10° upward (Source remap). The pitch p becomes p' = −10 + p × 80/90 looking
   up, or −10 + p × 100/90 looking down, and the elevation is −p'.
2. **Speed and gravity:** 675 u/s (`throwSpeed`, Source's 750 × 0.9) and gravity 320 (`gravity`,
   0.4 × sv_gravity 800).
3. **Flight time:** from eye height until the grenade falls back to the thrower's floor (flat ground).
4. **Landing:** horizontal range capped at `throwRange` (1500); then the grenade stops at the first wall along the
   path (bisection on nav line of sight), pulled back `wallBackoff` (16).
5. A level throw lands 729 units away after 1.1 s (70 ticks). No bounces and no inherited player velocity.

**Fuse and effects.**

| kind | pops | effect |
| --- | --- | --- |
| smoke | 1.5 s after the throw, or on landing if later | 144-radius circle for `smokeSec` (18 s). Puts out any fire whose centre it covers. |
| flash | 1.5 s after the throw (mid-air if still flying) | blinds each alive pawn (both teams, thrower included) that has nav line of sight to it, has no active smoke in between (`smokeBlocksFlash`), and sees it within `ai.fovDeg` (106°) of its yaw. Blind time = `flashSec` (3 s) × (1 − distance / `flashRange` 1500) × (1 − (1 − `flashEdgeFactor` 0.5) × angle / 53°). |
| he | 1.5 s after the throw | radial damage to pawns in nav line of sight: 98 × (1 − d / 350), with d the 3D distance to the pawn's stomach height. Armor applies with `heArmorPen` 0.575 (98 point blank → 56 HP / 21 armor). Hitgroup `generic`. |
| molotov | on landing or 2 s after the throw, whichever is first | 120-radius fire on the floor for `molotovSec` (7 s): 8 HP (40 HP/s × 0.2 s) at burst + ⌈k × 12.8⌉ ticks, 35 steps, to pawns inside with a floor within `fireHeight` (64). Armor does not reduce fire. Hitgroup `generic`. A molotov that bursts inside an active smoke makes no fire. |

Grenade damage goes to enemies of the thrower and the thrower; teammates only with `friendlyFire`. It respects
`block_damage` (attacker = thrower). Effects are active from the pop tick; an effect with `untilTick` u is seen
by observes up to tick u − 1.

**Queries** (on `Sim2DHost`, pure functions underneath):

- `smokeBlocks(a, b)`: true if the 2D segment crosses an active smoke at the current tick.
- `blindUntilTick(id)`: the pawn is blind while the tick is below this (0 = never flashed).
- `activeEffects()`: flying grenades (interpolated position, ballistic z), smoke clouds and fires, each with
  `{seq, kind, phase, thrower, pos, radius, untilTick}`, by throw order. For the renderer.

**Grenade sources.** The HE values (98 damage, 57.5 % armor penetration) are from
[csdb.gg HE grenade](https://csdb.gg/weapon/he-grenade). The
[csdb.gg grenade guide](https://csdb.gg/guides/grenade-guide/) agrees: about 98 unarmored, about 57 armored,
about 350 radius, molotov about 7 s at about 40 HP/s, and a smoke landing on fire puts it out "instantly". The
smoke's 18 s and the molotov's 7.03 s come from [scope.gg](https://scope.gg/guides/grenades_en/) (a 2022 guide).

*Assumed* (brief or CS:GO code from memory, not verified for CS2): the 1.5 s and 2 s fuses, the 144 and 120
radii, the throw physics (750 × 0.9, gravity × 0.4, the 10° remap), `throwRange`, `wallBackoff`, `fireHeight`,
the flash curve (`flashRange`, `flashEdgeFactor`) and `smokeBlocksFlash`. Whether smoke blocks flashes in CS2 is
open (CS2 adapter: "probably not" for traces).

## Bomb and round rules (`bomb.ts`, `round.ts`; C3)

Numbers from `tuning.bomb` and `tuning.round`. A duration starting on tick `s` is over on the first whole tick at
or after `s + sec × 64` (`ticksAfter`): plant 3.2 s = 204.8 → **205 ticks**, timer 40 s = 2,560, kit defuse 5 s
= 320, defuse without a kit 10 s = 640. Bomb and round ticks are integers.

| key | value | meaning |
| --- | ---: | --- |
| `bomb.plantSec` | 3.2 | USE held this long plants |
| `bomb.timerSec` | 40 | plant → explosion |
| `bomb.defuseSec` / `defuseKitSec` | 10 / 5 | defuse time without / with a kit |
| `bomb.defuseRange` | 62 | a CT defuses within this 2D distance of the bomb |
| `bomb.pickupRange` | 32 | an alive T picks a dropped c4 up within this 2D distance |
| `bomb.damage` / `radius` | 500 / 1,750 | explosion damage at the bomb, falling linearly to 0 at the radius |
| `bomb.armorPen` | 0.5 | share of the explosion damage that armor lets through |
| `bomb.beepSec` / `beepFastSec` / `beepFastLastSec` | 1 / 0.5 / 10 | beep cadence (below) |
| `round.timeSec` | 115 | round clock when the host is given none (CS2 `mp_roundtime_defuse` 1.92 min, whole seconds) |
| `collision.pawnRadius` | 16 | pawn circle radius |
| `collision.solidTeammates` | false | teammates pass through each other (`mp_solid_teammates 0`) |

### Plant

- **USE plant.** A T plants by holding USE while alive, with the `c4` as the active item (no deploy wait), inside a
  bombsite: the nav place name at its position starts with `Bombsite` (`Bombsite A`, `Bombsite B`; `docs/nav.md`).
  The plant starts on the first tick all of this holds (the first such T in id order) and completes on tick
  start + 205, provided it still holds on **every** tick through the completion tick. Releasing USE, switching
  weapon, dying or leaving the site (a teleport) cancels it, with no event (the contract has no plant-abort phase).
- **Movement lock.** While planting, forward and side are ignored and the velocity is 0, so a running pawn stops
  dead. Yaw, pitch and DUCK still apply. The lock is decided before movement with the same rules the bomb step
  applies after it, so both see the same position.
- **On completion:** `bomb {phase: 'planted', id, pos}` at the pawn's position; the c4 leaves the inventory and the
  pawn draws its best gun (primary, else secondary, else knife; with its deploy time); the round phase becomes
  `planted`.
- **`plant {id, pos}` action** (scripted fallback): an alive T plants at `pos` at once, if the bomb is not planted
  yet. The c4 leaves whoever has it (or the ground), so the planter need not carry it. Otherwise the action is
  noted in `unhandled()` (`planter is dead`, `only a T can plant`, `bomb is planted`, …) and nothing happens.
- **Recording:** barely plants at 27.517 s = tick 1761. A puppet that holds USE from tick 1556 (24.31 s) to 1761
  plants exactly then (`tests/bomb.test.ts`, "the USE story").

### Timer and beeps

- The bomb explodes on tick plantTick + 2,560: 1761 + 2560 = **4321** = round(67.517 × 64).
- **Beeps** are `sound {source: null, pos: bomb, kind: 'bomb'}`. The first comes 1 s after the plant. After each
  beep the next is `beepSec` (1 s) later while more than `beepFastLastSec` (10 s) are left, else `beepFastSec`
  (0.5 s) later. With a 40 s timer that is 30 beeps at 39, 38, …, 10 s left, then 19 at 9.5, 9, …, 0.5 s left:
  49 in all, none on the explosion tick. They stop at the defuse or the explosion, and go on after a round end.
  This cadence is a choice for the 2D model, not a measurement. CS2 speeds up gradually. CS 1.6 beeps every 1.4 s
  and changes only the sound ([ReGameDLL `C4Think`][rg-grenade]). CS2's `bomb_beep` events (P7) can calibrate it.

### Explosion

On the explosion tick, if the bomb is still planted:

1. A defuse in progress ends with `defuse_stop`.
2. `bomb {phase: 'exploded', id: null, pos}`.
3. Damage to every alive pawn of both teams, in id order. Distance d is 3D, from the bomb to the pawn's body
   centre (pos.z + 36, the stomach band, as for HE). It goes **through walls**: there is no line-of-sight test.
   - damage = `bomb.damage` × (1 − d / `bomb.radius`) = 500 × (1 − d / 1750), 0 at d ≥ 1750, 6 decimals.
   - Armor applies with `armorDamage`, `bomb.armorPen` 0.5 and hitgroup `generic` (armored with any armor).
   - Events: `damage {attacker: null, weapon: null, hitgroup: 'generic', scripted: false}`, and a death with
     `attacker: null, weapon: null, headshot: false`. `block_damage` never applies, because there is no attacker.
4. `round_end {winner: 'T', reason: 'bomb_exploded'}`, unless the round already ended.

| distance | damage | 100 HP, no armor | 100 HP, 100 armor |
| ---: | ---: | --- | --- |
| 0 | 500 | dead | 300 → dead (armor absorbs at most 200) |
| 106 (100 across) | 469.6 | dead | dead |
| 875 | 250 | dead | 125 → dead, armor −63 |
| 1,500 | 71.3 | 71 HP | 35 HP, armor −18 |
| ≥ 1,750 | 0 | – | – |

**Falloff: linear, not Gaussian.** What CS does:

- **CS 1.6** ([ReGameDLL][rg-monster]): the bomb deals the map's `bombradius` as damage (default 500, [Valve
  wiki][vdc-bombradius]) over a radius of 3.5 × damage (1,750). The falloff is linear,
  `damage − distance × damage / radius`, measured to the player's origin. Walls don't count: the code collects
  entities in a sphere and traces nothing ([`RadiusDamage`][rg-combat]). Blast damage uses `ARMOR_RATIO` 0.5
  ([player.h][rg-player]), which is where `armorPen` 0.5 comes from.
- **CS:GO and early CS2**: guides give 500 damage, a 1,750 radius, height counted as distance, and walls ignored
  ([Dignitas][dignitas]). A Gaussian falloff (σ = radius / 3) is often quoted for CS:GO. I found no primary
  source for it, so it is not modelled.
- **CS2 since 8 July 2026:** "Re-designed effective range and extent of C4 explosion damage on all official
  defusal-mode maps. Damage is now applied according to precomputed simulation values, baked into the compiled
  map. Explosion shockwave damage now rapidly expands from the center of the explosion instead of being applied
  instantly" (patch notes, quoted by [dust2.us][dust2-c4]). The same article notes that walls now stifle the
  blast. So today's CS2 uses neither curve. Its damage is a per-map lookup that the 2D sim can't reproduce.

The 2D engine keeps the linear CS 1.6 model through walls, because it is simple, deterministic and tunable. The CS2
host doesn't need any of this, since the game applies its own blast. Nothing in the recorded round depends on
it, because the bomb is defused.

### Defuse

- **USE defuse.** A CT holding USE while alive within `bomb.defuseRange` (62 units, 2D) of the planted bomb starts
  defusing: the first such CT in id order, one defuser at a time. Facing the bomb is not required. With a
  `defuser` in the inventory it takes `defuseKitSec` (5 s, 320 ticks), otherwise `defuseSec` (10 s, 640 ticks).
- The plant's hold rule applies: USE must be held, in range, on every tick through the completion tick. Movement is
  locked. Releasing USE, leaving range (a teleport) or dying ends the defuse with `defuse_stop`. Holding USE in
  range again starts over from zero.
- **Only before the explosion.** A defuse whose end tick is at or after the explosion tick fails. On that tick the
  explosion comes first (as in ReGameDLL's `C4Think`, which checks the blow time before the defuse).
- **On completion:** `bomb {phase: 'defused', id, pos}`, then `round_end {winner: 'CT', reason: 'bomb_defused'}`
  unless the round already ended. The beeps stop.
- **`defuse_start {id}` action:** an alive CT starts a forced defuse of the planted bomb, needing neither USE nor
  range (the kit time still applies). A forced defuse ends only by completion, death, `defuse_stop {id}` or the
  explosion. If that CT is already defusing with USE, its defuse becomes forced and keeps its end tick. While
  another CT defuses, the action is noted (`<id> is defusing`).
- **`defuse_stop {id}` action:** stops that CT's defuse (`defuse_stop`); otherwise it is noted (`not defusing`). A
  CT still holding USE in range starts again on the same tick, so the Core should release USE too.
- Events: `defuse_start {id, pos}`, `defuse_stop {id, pos}` and `defused {id, pos}`, where `id` is the defuser
  and `pos` the bomb.
- **Recording:** sp4rtan (with a kit) starts at 61.8 s = tick 3955 and defuses on tick 3955 + 320 = **4275** =
  66.8 s. That is 46 ticks (0.72 s) before 4321. Without a kit the same start would end on 4595, and the bomb
  explodes first.

### Drop and pickup

- When a pawn that carries the c4 is dead while the bomb is unplanted (killed by damage, or by `set_hp 0`), the c4
  leaves its inventory and lies where it died: state `dropped`. A dead pawn keeps reporting the c4 as its last
  weapon if it held it. There is no event.
- The first alive T in id order within `bomb.pickupRange` (32 units, 2D) picks it up at once, also on the drop
  tick: state `carried`, the c4 goes into its inventory, and its active weapon doesn't change. CTs never pick it up.
- The carrier in `Observe.round.bomb` is the first pawn (id order) whose inventory has the c4. Before the setup
  gives anyone the c4, the state is `carried` with `carrier: null` and `pos: null`.

### Round rules (`round.ts`)

- **Phase:** `live` → `planted` (bomb planted and ticking) → `over` (from the `round_end` tick on).
- **Checks**, once per tick, after the bomb (so a bomb end on the same tick wins), first hit wins:
  1. All CTs dead → **T win, `elimination`**, also after the plant.
  2. All Ts dead and the bomb not ticking → **CT win, `elimination`**. After the plant the round goes on until the
     defuse or the explosion (CS rule).
  3. The bomb not ticking and tick ≥ the time-out tick → **CT win, `time`**. The time-out tick is
     `ticksAfter(0, roundTimeSec)`: 98.25 s → **6288**.
  A side missing from the roster never counts as eliminated. If the last T and the last CT die on the same tick,
  T win: CS's `TeamExterminationCheck` only gives CTs the win while a CT is alive ([ReGameDLL][rg-rules]).
- **`end_round {winner, reason}`** ends the round at once. Once it is over, the action is noted (`round already
  over`).
- **The first end wins:** `round_end` is emitted once, the winner's score goes up by 1 on that tick, and the phase
  becomes `over` with `winner`, `reason` and `endTick` set.
- **Post-round:** nothing stops. Pawns keep moving and shooting, damage and deaths still apply (sp4rtan's kill of
  cart at 69.4 s, tick 4442, is a normal `death`), and a planted bomb keeps ticking. It can still explode or be
  defused, without a second `round_end`. A T may even plant. **The 2D engine never starts the next round:** no
  freeze time, respawns, money or side switch. The round is over when the session stops.
- **Score and clock:** `new Sim2DHost(nav, tuning, roster, {score, roundTimeSec})`. The Session passes
  `round.meta.score` (CT 11 – T 15) and `round.meta.clock0` (98.25 s). Without options: 0 – 0 and `round.timeSec`.

### `Observe.round`

| field | 2D engine |
| --- | --- |
| `phase` | as above |
| `score` | `{ct, t}`; includes this round's win from the end tick on |
| `winner`, `reason`, `endTick` | null until the round ends |
| `timeLeftSec` | while the bomb ticks, the bomb timer (explodeTick − tick) / 64, even after a round end; after a defuse, the bomb timer at the defuse (0.71875 in the recording); after an explosion, 0; otherwise the round clock roundTimeSec − tick / 64, frozen at the end tick. Never negative, 6 decimals. |
| `bomb.state` | `carried`, `dropped`, `planted`, `defused`, `exploded` |
| `bomb.carrier` | the carrier while carried (null before the setup), else null |
| `bomb.pos` | the carrier's position (carried), where it lies (dropped), or the bomb (planted and after) |
| `bomb.plantTick` | the plant tick, null before |
| `bomb.defuser`, `bomb.defuseEndTick` | the defuse in progress (the CT and its completion tick); after `defused`, who defused it and on which tick; else null |

The plant in progress is not in the contract (CS2 has no field the Core needs for it). `host.bombState()` shows
it for tests and debugging, along with the explode and next-beep ticks.

### Differences from CS2

- Plant input: CS2 most likely plants with ATTACK while the c4 is drawn; one guide says USE (E) works too
  ([scope.gg][scope-bomb]; P7 tests both, `docs/cs2-adapter.md`). The 2D engine takes USE only, which is what the
  puppets press. The c4 needs no deploy time, and nothing checks being on the ground.
- Defusing needs neither facing nor aiming at the bomb. A defusing pawn can still fire, whereas CS2 lowers the gun
  and adds a 150 ms fire delay after a defuse (Oct 2025 beta, `docs/cs2-adapter.md`). There is no plant-abort or
  "defuse with kit" event.
- The bomb is checked every tick (CS 1.6 thinks every 0.12 s). The c4 has no physics: a drop lies exactly where
  the pawn died.
- Explosion damage: see "Falloff". Bomb damage has no shockwave delay.

## Collision (`collision.ts`)

- Pawns are circles of radius `collision.pawnRadius` (16), so two solid pawns stay at least 32 units apart (centre
  to centre). **Solid** means alive and an enemy, or a teammate too when `collision.solidTeammates` is true. The
  default false matches the replay server's `mp_solid_teammates 0`. **Dead pawns are never solid.**
- Pawns move one at a time in id order (`moveAll`), so a pawn collides with the new positions of the pawns before
  it and the old positions of those after it. That makes the result deterministic.
- `collideMove(from, to, obstacles, radius, nav)` takes the nav-clamped move from `stepMove` and returns the first
  valid end point of:
  1. `to`, if the segment touches no obstacle;
  2. the **slide**: move to the first contact (pulled back 0.01 units), then along the obstacle's tangent with the
     rest of the move, minus the part pointing into the obstacle. The slide is cut at the next contact (there is
     no second slide) and nav-clamped from `from`;
  3. the contact point;
  4. `from`.
  A pawn that overlaps an obstacle at the start (teleported into it) loses only the part of its move that points
  into it, so it can always move out. If the move was cut, the velocity becomes the actual displacement / dt, as
  for walls.
- Locked pawns (planting, defusing) don't move, but they are still obstacles.
- **Debug hint for body blocks** (B4): `host.blockedBy(id)` (and `pawnState(id).blockedBy`) is the solid pawn
  that cut the pawn's last move short, or null. It is not in the contract. The Core sees positions and
  velocities, and a CS2 host would have to infer the same from them.
- **Differences from CS2:** the CS player hull is a 32 × 32 box. Two boxes touch at 32 units along an axis and
  45 units on the diagonal; the circle uses 32 everywhere. There is no pushing, no standing on heads, and no
  hull-to-world collision beyond the nav mesh (`docs/movement.md`).
- In the B2 ghost round (nobody died yet), sp4rtan was held up for 6 ticks at about 50.7 s by eradicate, who
  should have been dead since 12.75 s. With B3's scripted deaths no puppet is body-blocked at any tick of the
  ghost round (`tests/golden-round.test.ts`).

[rg-grenade]: https://github.com/s1lentq/ReGameDLL_CS/blob/70307312cde05cec5d73a3d3a384b4bdac3d5fe2/regamedll/dlls/ggrenade.cpp
[rg-combat]: https://github.com/s1lentq/ReGameDLL_CS/blob/70307312cde05cec5d73a3d3a384b4bdac3d5fe2/regamedll/dlls/combat.cpp
[rg-monster]: https://github.com/s1lentq/ReGameDLL_CS/blob/70307312cde05cec5d73a3d3a384b4bdac3d5fe2/regamedll/dlls/basemonster.cpp
[rg-player]: https://github.com/s1lentq/ReGameDLL_CS/blob/70307312cde05cec5d73a3d3a384b4bdac3d5fe2/regamedll/dlls/player.h
[rg-rules]: https://github.com/s1lentq/ReGameDLL_CS/blob/70307312cde05cec5d73a3d3a384b4bdac3d5fe2/regamedll/dlls/multiplay_gamerules.cpp
[vdc-bombradius]: https://developer.valvesoftware.com/wiki/Info_map_parameters/Counter-Strike_series
[dignitas]: https://dignitas.gg/articles/bomb-survival-a-guide-to-surviving-the-blast-radius
[dust2-c4]: https://www.dust2.us/news/75797/cs2-july-8th-update-brings-bomb-explosion-re-design-new-armory-items
[scope-bomb]: https://scope.gg/guides/bomb_complete_guide_en/

Sources read 2026-11-05 (ReGameDLL pinned to the commit above).

## Per-tick order (`Sim2DHost.tick`)

1. **Movement locks:** the planter and the defuser whose plant / defuse goes on this tick, or the pawn that would
   start one (`lockedPawns`, same rules as step 7).
2. **Inputs → movement:** every alive pawn runs `stepMove` (id order); a locked pawn keeps its position with zero
   velocity; every other move is cut against the solid pawns (`collideMove`). Footsteps are emitted per pawn.
3. **Weapon state, shots and hits:** each alive pawn in id order runs `stepWeapon`:
   - reload completion
   - the shot, with its hitscan, damage and death resolved at once
   - reload start (with its sound)
   - grenade release, which creates a flying grenade
4. **Grenade updates:** in throw order:
   - grenades whose pop tick has come pop (sound, then HE damage, flash blinds, smoke and fire creation)
   - fires deal their due steps
   - expired effects are dropped
5. **Scripted damage actions** queued by `apply()`, in Core order.
6. **Bomb and round actions** queued by `apply()` (`plant`, `defuse_start`, `defuse_stop`, `end_round`), in Core
   order.
7. **Bomb** (`stepBomb`): plant progress; drop and pickup; then the explosion, or the defuse and the beep.
8. **Round rules** (`checkRoundEnd`): elimination and time-out.
9. **Deaths** happen inline in steps 3–7, each right after the damage that causes it.
10. **Events:** the tick's events, in emission order, become `observe().events` (until the next tick). Then the
    tick counter advances.

`apply()` itself applies teleport, set_hp, give, set_weapon, set_mode and block/unblock at once, and queues
`damage`, `plant`, `defuse_start`, `defuse_stop` and `end_round`. So a `block_damage` sent on the same tick as a
shot already covers it, and a `damage` and a `plant` in the same act always apply damage first.

## Snapshot

Snapshot version 3 (C3) holds `{tick, human, humanInput, inputs, pawns, grenades, nextGrenadeSeq, blocked,
pendingDamage, pendingRound, bomb, round, events}`. Each pawn carries its weapon timers (`wpn`: `nextAttackTick`,
`deployEndTick`, `reloadEndTick`, `shotThisPress`, `grenadePrimed`), `blindUntilTick`, `nextFootstepTick` and
`blockedBy`. `bomb` is `BombData` (state, position, planter, plant / explode / next-beep ticks, the plant and
defuse in progress, who defused it and when); `round` is `RoundState` (round clock, time-out tick, score, winner,
reason, end tick). All of it is canonical (6 decimals; bomb and round ticks are integers), so restore is exact,
including the score and the round clock (the snapshot wins over the constructor options). Tests cover mid-spray,
mid-grenade-flight, mid-plant, mid-defuse and post-round snapshots, into the same host and a fresh one.

## Known simplifications

- **No spread, recoil or movement inaccuracy:** every bullet goes exactly along yaw and pitch, so shots are
  deterministic. In CS2, running and spraying are inaccurate. A Core tuned here must still stop or counter-strafe
  in CS2.
- No wall penetration (wallbangs), no tagging (slowdown when hit), no aim punch, no scoped AWP state, no knife
  attacks, no Glock burst mode. Bullets and grenades don't hit the bomb.
- Bomb: see "Bomb and round rules", "Differences from CS2".
- Hitgroups come from pitch bands on a 16-unit circle, so arms and neck are never hit. A head is as wide as a body.
- Smokes are instant full-size 2D circles (no bloom, no bullet or HE holes); fires are disks; flashes use a
  simple angle and distance curve; grenades don't bounce.
- Within a tick, pawns act in id order. CS2 has sub-tick ordering.

## Open questions for the CS2 probe

- AWP magazine 10 (recording) or 5 (CS2 since October 2022, csdb.gg): was the recording CS2? The HUD says
  "Round 12/30" and the score 11 – 15, which suggests MR15.
- Deploy times, footstep threshold and interval, the flash curve, and whether smoke blocks flashes.
- Reload rule (classic or March 2026) for the CS2 server the C# Core will run on.
- Bomb (P7): plant and defuse input (USE or ATTACK, aim needed), the beep cadence, the explosion model on the
  current map build (July 2026 rework), the defuse range, and whether pawns can fire while defusing.
