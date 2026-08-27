import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Redis } from '@upstash/redis';
import { hashIdentity } from './identity';
import { SESSION_TTL_SECONDS } from './lbv/config';

/**
 * Persists the serialized tough-cookie jar between (stateless) serverless
 * invocations. Uses Upstash/Vercel KV when configured; otherwise a JSON file
 * in local `next dev` (shared across route modules) or an in-memory map in
 * Vitest.
 */
export interface SessionStore {
  load(key: string): Promise<unknown | null>;
  save(key: string, jar: unknown, ttlSeconds?: number): Promise<void>;
  clear(key: string): Promise<void>;
}

/** Gitignored JSON file used when KV is unset and we are not in Vitest. */
export const DEV_STORE_FILENAME = '.lbv-dev-store.json';

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

/**
 * Process-shared JSON file. Next.js can load `/mcp` and `/connect` from
 * different module graphs, so an in-memory Map is invisible across routes.
 */
export class FileSessionStore implements SessionStore {
  constructor(private readonly filePath: string) {}

  private readMap(): Record<string, unknown> {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }

  private writeMap(map: Record<string, unknown>): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(map), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.filePath);
  }

  async load(key: string): Promise<unknown | null> {
    const map = this.readMap();
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key]! : null;
  }
  async save(key: string, jar: unknown): Promise<void> {
    const map = this.readMap();
    map[key] = jar;
    this.writeMap(map);
  }
  async clear(key: string): Promise<void> {
    const map = this.readMap();
    delete map[key];
    this.writeMap(map);
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

function runningUnderVitest(): boolean {
  return Boolean(process.env.VITEST);
}

/** Get the process-wide session store (memoized). */
export function getSessionStore(): SessionStore {
  if (cached) return cached;
  const env = readRedisEnv();
  if (env) {
    cached = new UpstashSessionStore(new Redis({ url: env.url, token: env.token }));
  } else if (runningUnderVitest()) {
    cached = new InMemorySessionStore();
  } else {
    cached = new FileSessionStore(join(process.cwd(), DEV_STORE_FILENAME));
  }
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
