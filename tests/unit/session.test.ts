import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSessionStore, sessionKeyFor, setSessionStore } from '../../src/session';

const KV_VARS = [
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
];

describe('getSessionStore (in-memory fallback)', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Force the in-memory store: strip any KV/Upstash env and reset the memo.
    for (const k of KV_VARS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    setSessionStore(null);
  });

  afterEach(() => {
    for (const k of KV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    setSessionStore(null);
  });

  it('round-trips a serialized jar through load/save/clear', async () => {
    const store = getSessionStore();
    const key = 'lbv:session:test';
    expect(await store.load(key)).toBeNull();

    await store.save(key, { cookies: ['a=b'] });
    expect(await store.load(key)).toEqual({ cookies: ['a=b'] });

    await store.clear(key);
    expect(await store.load(key)).toBeNull();
  });

  it('memoizes the store instance', () => {
    expect(getSessionStore()).toBe(getSessionStore());
  });
});

describe('sessionKeyFor', () => {
  it('is deterministic and namespaced', () => {
    const key = sessionKeyFor('sub:U2abc123');
    expect(key).toBe(sessionKeyFor('sub:U2abc123'));
    expect(key.startsWith('lbv:session:')).toBe(true);
  });

  it('does not embed the raw identity', () => {
    expect(sessionKeyFor('email:shopper@example.com')).not.toContain('shopper@example.com');
  });

  it('separates distinct identities', () => {
    expect(sessionKeyFor('sub:a')).not.toBe(sessionKeyFor('sub:b'));
  });
});
