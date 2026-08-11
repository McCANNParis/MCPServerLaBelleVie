import { CookieJar } from 'tough-cookie';
import { decryptCredentials, getConnection, saveConnection } from './connections';
import { LbvClient } from './lbv/client';
import { getSessionStore, sessionKeyFor } from './session';

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
 * Run an operation against a session-backed LbvClient acting as `identity`.
 * With a connected account, the client gets the stored authenticated jar plus
 * decrypted credentials for transparent re-login; otherwise an anonymous
 * per-identity jar (guest cart). The jar is saved back after the call, so a
 * login performed on one invocation is reused by the next.
 */
export async function withClient<T>(
  identity: string,
  fn: (client: LbvClient) => Promise<T>,
): Promise<T> {
  const store = getSessionStore();
  const connection = await getConnection(identity);
  const anonKey = sessionKeyFor(identity);

  const serialized = connection ? connection.jar : await store.load(anonKey);
  const jar = hydrateJar(serialized);
  // undefined when LBV_CRED_KEY is missing/rotated — the client then behaves
  // as not-authenticated and auth-required tools ask the user to reconnect.
  const credentials = connection ? decryptCredentials(connection) : undefined;
  const client = new LbvClient({ credentials, jar, assumeLoggedIn: Boolean(credentials) });

  try {
    return await fn(client);
  } finally {
    try {
      const savedJar = client.http.serializeJar();
      if (connection) {
        await saveConnection(identity, { ...connection, jar: savedJar, lastUsedAt: Date.now() });
      } else {
        await store.save(anonKey, savedJar);
      }
    } catch {
      // Persisting the session is best-effort; never fail the operation on it.
    }
  }
}
