import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decrypt, encrypt, hasCredKey, resetCredKeyCacheForTests } from '../../src/crypto';

const HEX_KEY = 'a'.repeat(64);

describe('crypto (AES-256-GCM credential encryption)', () => {
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env.LBV_CRED_KEY;
    process.env.LBV_CRED_KEY = HEX_KEY;
    resetCredKeyCacheForTests();
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.LBV_CRED_KEY;
    else process.env.LBV_CRED_KEY = savedKey;
    resetCredKeyCacheForTests();
  });

  it('round-trips an object', () => {
    const payload = encrypt({ email: 'a@b.c', password: 'p@ss' });
    expect(decrypt(payload)).toEqual({ email: 'a@b.c', password: 'p@ss' });
  });

  it('uses a fresh IV per encryption', () => {
    const a = encrypt('x');
    const b = encrypt('x');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('accepts a base64-encoded 32-byte key too', () => {
    process.env.LBV_CRED_KEY = Buffer.alloc(32, 7).toString('base64');
    resetCredKeyCacheForTests();
    expect(decrypt(encrypt('ok'))).toBe('ok');
  });

  it('fails to decrypt after key rotation', () => {
    const payload = encrypt({ secret: true });
    process.env.LBV_CRED_KEY = 'b'.repeat(64);
    resetCredKeyCacheForTests();
    expect(() => decrypt(payload)).toThrow();
  });

  it('rejects a tampered ciphertext via the auth tag', () => {
    const payload = encrypt('payload');
    const corrupted = { ...payload, ciphertext: Buffer.from('corrupted!').toString('base64') };
    expect(() => decrypt(corrupted)).toThrow();
  });

  it('hasCredKey reflects a valid, missing, or malformed key', () => {
    expect(hasCredKey()).toBe(true);

    delete process.env.LBV_CRED_KEY;
    resetCredKeyCacheForTests();
    expect(hasCredKey()).toBe(false);
    expect(() => encrypt('x')).toThrow(/LBV_CRED_KEY/);

    process.env.LBV_CRED_KEY = 'way-too-short';
    resetCredKeyCacheForTests();
    expect(hasCredKey()).toBe(false);
  });
});
