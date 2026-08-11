import { randomBytes } from 'node:crypto';
import { LINK_CODE_TTL_SECONDS, LINK_MAX_ATTEMPTS } from './lbv/config';
import { getSessionStore } from './session';

/**
 * One-time connect links: an unguessable code (192 bits, base64url) minted by
 * the connect_account tool, bound to the caller's identity, and redeemed on
 * the /connect/<code> page. Short-lived, single-use, and destroyed after too
 * many wrong-password attempts.
 */
export interface LinkRecord {
  identity: string;
  attempts: number;
  createdAt: number;
}

function linkKey(code: string): string {
  return `lbv:link:${code}`;
}

export async function createLinkCode(identity: string): Promise<{ code: string; expiresAt: number }> {
  const code = randomBytes(24).toString('base64url');
  const record: LinkRecord = { identity, attempts: 0, createdAt: Date.now() };
  await getSessionStore().save(linkKey(code), record, LINK_CODE_TTL_SECONDS);
  return { code, expiresAt: Date.now() + LINK_CODE_TTL_SECONDS * 1000 };
}

/** Load a link if it is still redeemable (exists, attempts not exhausted). */
export async function getLinkRecord(code: string): Promise<LinkRecord | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(code)) return null; // reject junk before hitting the store
  const value = await getSessionStore().load(linkKey(code));
  if (!value || typeof value !== 'object') return null;
  const record = value as LinkRecord;
  return record.attempts >= LINK_MAX_ATTEMPTS ? null : record;
}

/**
 * Count a failed login attempt. Returns the updated record, or null when the
 * cap is reached — in which case the code is destroyed.
 */
export async function recordFailedAttempt(code: string): Promise<LinkRecord | null> {
  const record = await getLinkRecord(code);
  if (!record) return null;
  const updated: LinkRecord = { ...record, attempts: record.attempts + 1 };
  if (updated.attempts >= LINK_MAX_ATTEMPTS) {
    await consumeLinkCode(code);
    return null;
  }
  await getSessionStore().save(linkKey(code), updated, LINK_CODE_TTL_SECONDS);
  return updated;
}

/** Destroy a code (on successful use, or when attempts are exhausted). */
export async function consumeLinkCode(code: string): Promise<void> {
  await getSessionStore().clear(linkKey(code));
}
