# Combat in the 2D sim (`src/sim2d/weapons.ts`, `hitscan.ts`, `grenades.ts`, `host.ts`)

Weapons, bullets, damage, grenades and sounds for `Sim2DHost`, close enough to CS2 that a Core written against
the 2D engine works unchanged in CS2. Every number comes from `data/tuning.json` (`weapons`, `grenades`,
`damage`, `sound`). The functions are pure; the host owns the state. Movement is in `docs/movement.md`.

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

Knife and c4 do nothing on ATTACK (no knife attacks; planting is task C3).

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

## Per-tick order (`Sim2DHost.tick`)

1. **Inputs → movement:** every alive pawn runs `stepMove` (id order). Footsteps are emitted per pawn.
2. **Weapon state, shots and hits:** each alive pawn in id order runs `stepWeapon`:
   - reload completion
   - the shot, with its hitscan, damage and death resolved at once
   - reload start (with its sound)
   - grenade release, which creates a flying grenade
3. **Grenade updates:** in throw order:
   - grenades whose pop tick has come pop (sound, then HE damage, flash blinds, smoke and fire creation)
   - fires deal their due steps
   - expired effects are dropped
4. **Scripted damage actions** queued by `apply()`, in Core order.
5. **Deaths** happen inline in steps 2–4, each right after the damage that causes it.
6. **Events:** the tick's events, in emission order, become `observe().events` (until the next tick). Then the
   tick counter advances.

`apply()` itself applies teleport, set_hp, give, set_weapon, set_mode and block/unblock at once, and queues
`damage`. So a `block_damage` sent on the same tick as a shot already covers it.

## Snapshot

Snapshot version 2 holds `{tick, human, humanInput, inputs, pawns, grenades, nextGrenadeSeq, blocked,
pendingDamage, events}`. Each pawn carries its weapon timers (`wpn`: `nextAttackTick`, `deployEndTick`,
`reloadEndTick`, `shotThisPress`, `grenadePrimed`), `blindUntilTick` and `nextFootstepTick`. All of it is
canonical (6 decimals), so restore is exact. Tests cover mid-spray and mid-grenade-flight snapshots, into the same
host and a fresh one.

## Known simplifications

- **No spread, recoil or movement inaccuracy:** every bullet goes exactly along yaw and pitch, so shots are
  deterministic. In CS2, running and spraying are inaccurate. A Core tuned here must still stop or counter-strafe
  in CS2.
- No wall penetration (wallbangs), no tagging (slowdown when hit), no aim punch, no scoped AWP state, no knife
  attacks, no Glock burst mode, and no damage to or from the bomb (C3).
- Hitgroups come from pitch bands on a 16-unit circle, so arms and neck are never hit. A head is as wide as a body.
- Smokes are instant full-size 2D circles (no bloom, no bullet or HE holes); fires are disks; flashes use a
  simple angle and distance curve; grenades don't bounce.
- Within a tick, pawns act in id order. CS2 has sub-tick ordering.

## Open questions for the CS2 probe

- AWP magazine 10 (recording) or 5 (CS2 since October 2022, csdb.gg): was the recording CS2? The HUD says
  "Round 12/30" and the score 11 – 15, which suggests MR15.
- Deploy times, footstep threshold and interval, the flash curve, and whether smoke blocks flashes.
- Reload rule (classic or March 2026) for the CS2 server the C# Core will run on.
