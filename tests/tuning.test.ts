import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseTuning, TuningError } from '../src/contracts/tuning';

const raw = readFileSync(new URL('../data/tuning.json', import.meta.url), 'utf8');

function clone(): Record<string, unknown> {
  return JSON.parse(raw) as Record<string, unknown>;
}

describe('parseTuning', () => {
  it('loads data/tuning.json with the expected values', () => {
    const t = parseTuning(clone());
    expect(t.movement.svAccelerate).toBe(5.5);
    expect(t.movement.accelScaleFloor).toBe(1);
    expect(t.movement.runSpeedByWeapon['knife']).toBe(250);
    expect(t.replay.driftSnapUnits).toBe(96);
    expect(t.weapons['awp']?.damage).toBe(115);
    expect(t.bomb.timerSec).toBe(40);
    expect(t.grenades.smokeSec).toBe(18);
    expect(t.ai.fovDeg).toBe(106);
    expect(t.nav).toEqual({ stepHeight: 18, edgeEpsilon: 1, losMargin: 8 });
    expect(Object.keys(t.weapons)).toEqual(['ak47', 'awp', 'deagle', 'glock', 'm4a4', 'ssg08']);
  });

  it('loads the C2 combat sections: gun table, grenades, damage, sound', () => {
    const t = parseTuning(clone());
    expect(t.weapons['ak47']).toEqual({ damage: 36, rpm: 600, headshotMult: 4, armorPen: 0.775, rangeModifier: 0.98, clip: 30, reserve: 90, reloadSec: 2.5, deploySec: 1, automatic: true });
    expect(t.weapons['deagle']?.automatic).toBe(false);
    expect(t.grenades).toMatchObject({ fuseSec: 1.5, molotovFuseSec: 2, smokeRadius: 144, molotovRadius: 120, molotovDps: 40, heDamage: 98, heRadius: 350, smokeBlocksFlash: true });
    expect(t.damage.hitgroupMult).toEqual({ chest: 1, stomach: 1.25, arm: 1, leg: 0.75, neck: 1, generic: 1 });
    expect(t.damage.bandHeights).toEqual({ head: 64, chest: 48, stomach: 36, leg: 16 });
    expect(t.damage).toMatchObject({ eyeHeight: 64, hitToleranceDeg: 3, pawnRadius: 16, friendlyFire: false, reloadDiscardsMagazine: false });
    expect(t.sound).toEqual({ footstepSpeed: 135, footstepIntervalSec: 0.3 });
  });

  it('rejects a non-boolean flag and a missing hitgroup multiplier with their paths', () => {
    const j = clone();
    ((j['weapons'] as Record<string, Record<string, unknown>>)['awp'] ?? {})['automatic'] = 0;
    expect(() => parseTuning(j)).toThrow(/weapons\.awp\.automatic: expected true or false/);
    const k = clone();
    delete ((k['damage'] as Record<string, Record<string, unknown>>)['hitgroupMult'] ?? {})['leg'];
    expect(() => parseTuning(k)).toThrow(/damage\.hitgroupMult\.leg/);
    const m = clone();
    delete m['sound'];
    expect(() => parseTuning(m)).toThrow(/sound: expected an object/);
  });

  it('accepts a JSON string and ignores _note', () => {
    const t = parseTuning(raw);
    expect(t).toEqual(parseTuning(clone()));
    expect('_note' in t).toBe(false);
  });

  it('rejects a missing section', () => {
    const j = clone();
    delete j['bomb'];
    expect(() => parseTuning(j)).toThrow(/bomb: expected an object/);
  });

  it('rejects a missing or non-numeric key with its path', () => {
    const j = clone();
    (j['replay'] as Record<string, unknown>)['lookaheadSec'] = '0.15';
    expect(() => parseTuning(j)).toThrow(TuningError);
    expect(() => parseTuning(j)).toThrow(/replay\.lookaheadSec/);

    const k = clone();
    delete ((k['weapons'] as Record<string, Record<string, unknown>>)['ak47'] ?? {})['reloadSec'];
    expect(() => parseTuning(k)).toThrow(/weapons\.ak47\.reloadSec/);
  });

  it('rejects a missing or non-numeric nav key', () => {
    const j = clone();
    delete j['nav'];
    expect(() => parseTuning(j)).toThrow(/nav: expected an object/);
    const k = clone();
    (k['nav'] as Record<string, unknown>)['losMargin'] = null;
    expect(() => parseTuning(k)).toThrow(/nav\.losMargin/);
  });

  it('rejects invalid JSON text and non-objects', () => {
    expect(() => parseTuning('{nope')).toThrow(/invalid JSON/);
    expect(() => parseTuning(null)).toThrow(TuningError);
    expect(() => parseTuning([])).toThrow(TuningError);
  });
});
