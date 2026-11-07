/** G4: the page's takeover UI, DOM-free (src/app/takeover.ts): who plays at load, the button, the status note. */
import { describe, expect, it } from 'vitest';
import { TAKEOVER_KEY, startHuman, takeoverButtonView, youNote } from '../src/app/takeover';

describe('takeover UI (G4)', () => {
  it('the page watches unless ?human= names a pawn', () => {
    expect(startHuman(null)).toBeNull();
    expect(startHuman('none')).toBeNull();
    expect(startHuman('spectate')).toBeNull();
    expect(startHuman('bob')).toBeNull();
    expect(startHuman('cart')).toBe('cart');
    expect(TAKEOVER_KEY).toBe('KeyE');
  });

  it('the button: take control while possible, why not otherwise, "You: cart" once taken', () => {
    expect(takeoverButtonView(null, 'cart', null, false, false)).toEqual({ label: 'Take control of cart', disabled: false, pressed: false, key: true, title: 'Play cart from this moment on (E).' });
    expect(takeoverButtonView(null, 'cart', 'cart is dead', false, false)).toMatchObject({ disabled: true, key: false, title: 'Not now: cart is dead.' });
    expect(takeoverButtonView(null, 'cart', null, false, true)).toMatchObject({ disabled: true, title: 'Not while seeking.' });
    expect(takeoverButtonView(null, 'cart', null, true, false)).toMatchObject({ label: 'Take control of cart', disabled: true, key: false });
    expect(takeoverButtonView('cart', 'cart', 'cart is already controlled', false, false)).toMatchObject({ label: 'You: cart', disabled: true, pressed: true });
    expect(takeoverButtonView(null, null, 'null is not the playable pawn (null)', false, false)).toMatchObject({ label: 'Watching', disabled: true });
  });

  it('the status note: you, or watching (with the E hint where E works)', () => {
    expect(youNote('cart', 'cart', 'cart', false, false)).toBe('you');
    expect(youNote(null, 'cart', 'cart', true, false)).toBe('watching · E: take control');
    expect(youNote(null, 'cart', 'cart', false, false)).toBe('watching');
    expect(youNote(null, 'cart', 'cart', true, true)).toBe('watching');
    expect(youNote('donk', 'cart', 'cart', false, false)).toBe('');
  });
});
