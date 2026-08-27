import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FileSessionStore,
  getSessionStore,
  sessionKeyFor,
  setSessionStore,
} from '../../src/session';

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

  it('uses the in-memory store under Vitest (not the local JSON file)', () => {
    expect(getSessionStore().constructor.name).toBe('InMemorySessionStore');
  });
});

describe('FileSessionStore', () => {
  let dir: string;
  let store: FileSessionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lbv-session-'));
    store = new FileSessionStore(join(dir, '.lbv-dev-store.json'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a value across a second instance on the same file', async () => {
    const key = 'lbv:link:abc';
    await store.save(key, { email: 'shopper@example.com', attempts: 0 });

    const other = new FileSessionStore(join(dir, '.lbv-dev-store.json'));
    expect(await other.load(key)).toEqual({ email: 'shopper@example.com', attempts: 0 });

    await other.clear(key);
    expect(await store.load(key)).toBeNull();
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
