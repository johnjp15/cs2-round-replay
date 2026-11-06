import { describe, expect, it } from 'vitest';
import * as contracts from '../src/contracts/index';

describe('scaffold', () => {
  it('contracts barrel exports the PRNG and tuning loader', () => {
    expect(typeof contracts.Rng).toBe('function');
    expect(typeof contracts.parseTuning).toBe('function');
  });
});
