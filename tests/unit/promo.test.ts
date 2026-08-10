import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePromo } from '../../src/lbv/promo';

const promo = JSON.parse(readFileSync(new URL('../fixtures/promo.json', import.meta.url), 'utf8'));

describe('parsePromo', () => {
  it('treats the "please log in" error fixture as invalid and surfaces the message', () => {
    const result = parsePromo('WELCOME10', promo);
    expect(result.valid).toBe(false);
    expect(result.message).toBe('Connectez-vous pour vérifier le code promo');
    expect(result.code).toBe('WELCOME10');
  });

  it('treats an explicit valid response with a discount as valid', () => {
    const result = parsePromo('WELCOME10', { valid: true, discount: 5 });
    expect(result.valid).toBe(true);
    expect(result.discount).toBe(5);
  });

  it('treats a false/valid flag as invalid', () => {
    expect(parsePromo('X', { valid: false, message: 'expired' }).valid).toBe(false);
  });
});
