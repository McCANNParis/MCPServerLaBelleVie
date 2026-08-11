import { createHash } from 'node:crypto';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

/**
 * A stable per-caller identity string, used to key La Belle Vie connections
 * and cookie-jar sessions. Descope callers are keyed by their immutable user
 * id (`sub`, present on every validated token) with the email claim as a
 * defensive fallback; static-bearer callers (the CLI) all share one fixed
 * identity, consistent with LBV_API_TOKEN being a single shared secret.
 */

export const STATIC_TOKEN_IDENTITY = 'static-token';

export function identityFor(authInfo: AuthInfo | undefined): string {
  const extra = authInfo?.extra;
  const sub = extra?.sub;
  if (typeof sub === 'string' && sub.length > 0) return `sub:${sub}`;
  const email = extra?.email;
  if (typeof email === 'string' && email.length > 0) return `email:${email.toLowerCase()}`;
  return STATIC_TOKEN_IDENTITY;
}

/** sha256 hex of an identity — keeps raw user ids/emails out of store keys. */
export function hashIdentity(identity: string): string {
  return createHash('sha256').update(identity).digest('hex');
}
