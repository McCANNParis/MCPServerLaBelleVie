import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LINK_CODE_TTL_SECONDS, LINK_MAX_ATTEMPTS } from '../../src/lbv/config';
import {
  consumeLinkCode,
  createLinkCode,
  getLinkRecord,
  recordFailedAttempt,
} from '../../src/links';
import { setSessionStore } from '../../src/session';

const KV_VARS = [
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
];

describe('one-time connect links', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
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

  it('mints an unguessable, identity-bound, redeemable code', async () => {
    const { code, expiresAt } = await createLinkCode('sub:a');
    expect(code).toMatch(/^[A-Za-z0-9_-]{20,64}$/);
    expect(expiresAt).toBeGreaterThan(Date.now());

    const record = await getLinkRecord(code);
    expect(record?.identity).toBe('sub:a');
    expect(record?.attempts).toBe(0);
  });

  it('is single-use: consumed codes are gone', async () => {
    const { code } = await createLinkCode('sub:a');
    await consumeLinkCode(code);
    expect(await getLinkRecord(code)).toBeNull();
  });

  it('rejects malformed codes before touching the store', async () => {
    expect(await getLinkRecord('short')).toBeNull();
    expect(await getLinkRecord('../../etc/passwd')).toBeNull();
    expect(await getLinkRecord('')).toBeNull();
  });

  it('destroys the code once failed attempts reach the cap', async () => {
    const { code } = await createLinkCode('sub:a');
    for (let i = 1; i < LINK_MAX_ATTEMPTS; i++) {
      const updated = await recordFailedAttempt(code);
      expect(updated?.attempts).toBe(i);
    }
    // Final allowed attempt reaches the cap: code destroyed, null returned.
    expect(await recordFailedAttempt(code)).toBeNull();
    expect(await getLinkRecord(code)).toBeNull();
    expect(await recordFailedAttempt(code)).toBeNull();
  });

  describe('fixed expiry', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('stops redeeming at createdAt + TTL, even on a store that ignores TTLs', async () => {
      vi.useFakeTimers();
      const { code, expiresAt } = await createLinkCode('sub:a');
      vi.setSystemTime(expiresAt - 1000);
      expect(await getLinkRecord(code)).not.toBeNull();
      vi.setSystemTime(expiresAt + 1000);
      expect(await getLinkRecord(code)).toBeNull();
    });

    it('does not extend the expiry after a failed attempt', async () => {
      vi.useFakeTimers();
      const { code, expiresAt } = await createLinkCode('sub:a');
      vi.setSystemTime(expiresAt - 60_000);
      expect((await recordFailedAttempt(code))?.attempts).toBe(1);
      vi.setSystemTime(expiresAt + 1000);
      expect(await getLinkRecord(code)).toBeNull();
    });

    it('re-saves a failed attempt with only the remaining TTL', async () => {
      vi.useFakeTimers();
      const store = {
        load: vi.fn(),
        save: vi.fn(async (_key: string, _value: unknown, _ttlSeconds?: number) => {}),
        clear: vi.fn(async () => {}),
      };
      setSessionStore(store);
      const { code } = await createLinkCode('sub:a');
      store.load.mockResolvedValue(store.save.mock.calls[0]?.[1]);
      vi.advanceTimersByTime(4 * 60_000);
      await recordFailedAttempt(code);
      expect(store.save.mock.calls[1]?.[2]).toBe(LINK_CODE_TTL_SECONDS - 4 * 60);
    });
  });
});
