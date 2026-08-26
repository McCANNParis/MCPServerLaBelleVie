import { mkdir, readFile, chmod, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Redis } from '@upstash/redis';
import { hashIdentity } from './identity';
import { SESSION_TTL_SECONDS } from './lbv/config';

/**
 * Persists the serialized tough-cookie jar between (stateless) serverless
 * invocations. Uses Upstash/Vercel KV when configured, else a protected local
 * file store for local dev (fine for a single trusted machine).
 */
export interface SessionStore {
  load(key: string): Promise<unknown | null>;
  save(key: string, jar: unknown, ttlSeconds?: number): Promise<void>;
  clear(key: string): Promise<void>;
}

class InMemorySessionStore implements SessionStore {
  private map = new Map<string, unknown>();

  async load(key: string): Promise<unknown | null> {
    return this.map.get(key) ?? null;
  }
  async save(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }
  async clear(key: string): Promise<void> {
    this.map.delete(key);
  }
}

class LocalFileSessionStore implements SessionStore {
  private readonly file = process.env.LBV_LOCAL_STORE_PATH ?? join(homedir(), '.cache', 'labellevie-mcp', 'store.json');

  private async read(): Promise<Record<string, { value: unknown; expiresAt?: number }>> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, { value: unknown; expiresAt?: number }>;
      const now = Date.now();
      for (const [key, entry] of Object.entries(parsed)) {
        if (entry.expiresAt !== undefined && entry.expiresAt <= now) delete parsed[key];
      }
      return parsed;
    } catch {
      return {};
    }
  }

  private async write(data: Record<string, { value: unknown; expiresAt?: number }>): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
    await rename(temp, this.file);
    await chmod(this.file, 0o600);
  }

  async load(key: string): Promise<unknown | null> {
    const data = await this.read();
    return data[key]?.value ?? null;
  }

  async save(key: string, value: unknown, ttlSeconds = SESSION_TTL_SECONDS): Promise<void> {
    const data = await this.read();
    data[key] = { value, expiresAt: Date.now() + ttlSeconds * 1000 };
    await this.write(data);
  }

  async clear(key: string): Promise<void> {
    const data = await this.read();
    delete data[key];
    await this.write(data);
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
  cached = env
    ? new UpstashSessionStore(new Redis({ url: env.url, token: env.token }))
    : (process.env.NODE_ENV === 'test' ? new InMemorySessionStore() : new LocalFileSessionStore());
  return cached;
}

/** Test seam: force a specific store (or reset with null). */
export function setSessionStore(store: SessionStore | null): void {
  cached = store;
}

/** Namespaced cookie-jar key for a caller identity (raw value never embedded). */
export function sessionKeyFor(identity: string): string {
  return `lbv:session:${hashIdentity(identity)}`;
}
