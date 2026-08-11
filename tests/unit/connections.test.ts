import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ConnectionRecord,
  decryptCredentials,
  deleteConnection,
  getConnection,
  hasConnection,
  saveConnection,
} from '../../src/connections';
import { encrypt, resetCredKeyCacheForTests } from '../../src/crypto';
import { setSessionStore } from '../../src/session';

const ENV_VARS = [
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'LBV_CRED_KEY',
];

describe('connections', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_VARS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.LBV_CRED_KEY = 'a'.repeat(64);
    resetCredKeyCacheForTests();
    setSessionStore(null);
  });

  afterEach(() => {
    for (const k of ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetCredKeyCacheForTests();
    setSessionStore(null);
  });

  function record(): ConnectionRecord {
    return {
      lbvEmail: 'shopper@example.com',
      creds: encrypt({ email: 'shopper@example.com', password: 's3cret' }),
      jar: { cookies: [] },
      connectedAt: 1700000000000,
      lastUsedAt: 1700000000000,
    };
  }

  it('round-trips a connection per identity', async () => {
    expect(await getConnection('sub:a')).toBeNull();
    expect(await hasConnection('sub:a')).toBe(false);

    await saveConnection('sub:a', record());
    expect(await hasConnection('sub:a')).toBe(true);
    expect((await getConnection('sub:a'))?.lbvEmail).toBe('shopper@example.com');
    // Identities are isolated from each other.
    expect(await hasConnection('sub:b')).toBe(false);
  });

  it('deleteConnection reports whether one existed', async () => {
    await saveConnection('sub:a', record());
    expect(await deleteConnection('sub:a')).toBe(true);
    expect(await deleteConnection('sub:a')).toBe(false);
    expect(await getConnection('sub:a')).toBeNull();
  });

  it('decryptCredentials round-trips with the current key', () => {
    expect(decryptCredentials(record())).toEqual({
      email: 'shopper@example.com',
      password: 's3cret',
    });
  });

  it('decryptCredentials degrades to undefined after key rotation (never throws)', () => {
    const r = record();
    process.env.LBV_CRED_KEY = 'b'.repeat(64);
    resetCredKeyCacheForTests();
    expect(decryptCredentials(r)).toBeUndefined();
  });
});
