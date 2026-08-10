import { CookieJar } from 'tough-cookie';
import { LbvClient } from './lbv/client';
import type { Credentials } from './lbv/http';
import { getSessionStore, sessionKeyForEmail } from './session';

export interface LbvConfig {
  email?: string;
  password?: string;
}

/** Read La Belle Vie credentials from the environment. */
export function getConfig(): LbvConfig {
  return { email: process.env.LBV_EMAIL, password: process.env.LBV_PASSWORD };
}

export function getCredentials(): Credentials | undefined {
  const { email, password } = getConfig();
  return email && password ? { email, password } : undefined;
}

export function hasCredentials(): boolean {
  return !!getCredentials();
}

function hydrateJar(serialized: unknown | null): CookieJar {
  if (serialized) {
    try {
      return CookieJar.fromJSON(serialized as never);
    } catch {
      // Corrupt/incompatible jar — start fresh.
    }
  }
  return new CookieJar();
}

/**
 * Run an operation against a session-backed LbvClient. The cookie jar is
 * loaded from the session store before the call and saved after, so a login
 * performed on one invocation is reused by the next.
 */
export async function withClient<T>(fn: (client: LbvClient) => Promise<T>): Promise<T> {
  const credentials = getCredentials();
  const store = getSessionStore();
  const key = credentials ? sessionKeyForEmail(credentials.email) : 'lbv:session:anon';

  const serialized = await store.load(key);
  const jar = hydrateJar(serialized);
  const client = new LbvClient({ credentials, jar });

  try {
    return await fn(client);
  } finally {
    try {
      await store.save(key, client.http.serializeJar());
    } catch {
      // Persisting the session is best-effort; never fail the operation on it.
    }
  }
}
