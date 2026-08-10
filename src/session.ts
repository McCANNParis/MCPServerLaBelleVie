import { Redis } from '@upstash/redis';
import { SESSION_TTL_SECONDS } from './lbv/config';

/**
 * Persists the serialized tough-cookie jar between (stateless) serverless
 * invocations. Uses Upstash/Vercel KV when configured, else an in-memory map
 * (fine for local dev and tests; not shared across serverless instances).
 */
export interface SessionStore {
  load(key: string): Promise<unknown | null>;
  save(key: string, jar: unknown, ttlSeconds?: number): Promise<void>;
  clear(key: string): Promise<void>;
}

class InMemorySessionStore implements SessionStore {
  private map = new Map<string, unknown>();

  async load(key: string): Promise<unknown | null> {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  async save(key: string, jar: unknown): Promise<void> {
    this.map.set(key, jar);
  }
  async clear(key: string): Promise<void> {
    this.map.delete(key);
  }
}

class UpstashSessionStore implements SessionStore {
  constructor(private redis: Redis) {}

  async load(key: string): Promise<unknown | null> {
    return (await this.redis.get(key)) ?? null;
  }
  async save(key: string, jar: unknown, ttlSeconds = SESSION_TTL_SECONDS): Promise<void> {
    await this.redis.set(key, jar, { ex: ttlSeconds });
  }
  async clear(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

let cached: SessionStore | null = null;

/** Read Upstash/Vercel-KV REST credentials from the environment, if present. */
function readRedisEnv(): { url: string; token: string } | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return { url, token };
  return null;
}

/** Get the process-wide session store (memoized). */
export function getSessionStore(): SessionStore {
  if (cached) return cached;
  const env = readRedisEnv();
  cached = env ? new UpstashSessionStore(new Redis({ url: env.url, token: env.token })) : new InMemorySessionStore();
  return cached;
}

/** Test seam: force a specific store (or reset with null). */
export function setSessionStore(store: SessionStore | null): void {
  cached = store;
}

/** Namespaced session key for a given account email. */
export function sessionKeyForEmail(email: string): string {
  // Avoid putting the raw email in the key; a light hash is enough for namespacing.
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = (hash * 31 + email.charCodeAt(i)) | 0;
  }
  return `lbv:session:${(hash >>> 0).toString(16)}`;
}
