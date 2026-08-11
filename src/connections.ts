import { decrypt, type EncryptedPayload } from './crypto';
import { hashIdentity } from './identity';
import { CONNECTION_TTL_SECONDS } from './lbv/config';
import type { Credentials } from './lbv/http';
import { getSessionStore } from './session';

/**
 * A caller's connected La Belle Vie account: display email, AES-encrypted
 * credentials (for transparent re-login) and the authenticated cookie jar.
 * Stored in the session store under a rolling TTL refreshed on every use, so
 * an account connected once stays connected as long as it is being used.
 */
export interface ConnectionRecord {
  lbvEmail: string;
  creds: EncryptedPayload;
  jar: unknown;
  connectedAt: number;
  lastUsedAt: number;
}

function connKey(identity: string): string {
  return `lbv:conn:${hashIdentity(identity)}`;
}

export async function getConnection(identity: string): Promise<ConnectionRecord | null> {
  const value = await getSessionStore().load(connKey(identity));
  if (!value || typeof value !== 'object') return null;
  return value as ConnectionRecord;
}

export async function hasConnection(identity: string): Promise<boolean> {
  return (await getConnection(identity)) !== null;
}

export async function saveConnection(identity: string, record: ConnectionRecord): Promise<void> {
  await getSessionStore().save(connKey(identity), record, CONNECTION_TTL_SECONDS);
}

/** Remove a stored connection; returns whether one existed. */
export async function deleteConnection(identity: string): Promise<boolean> {
  const existed = await hasConnection(identity);
  await getSessionStore().clear(connKey(identity));
  return existed;
}

/**
 * Decrypt a connection's stored credentials. Returns undefined when the
 * payload cannot be decrypted (LBV_CRED_KEY missing or rotated) — callers
 * treat that as "reconnect needed", never as a crash.
 */
export function decryptCredentials(record: ConnectionRecord): Credentials | undefined {
  try {
    return decrypt<Credentials>(record.creds);
  } catch {
    return undefined;
  }
}
