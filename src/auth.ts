import { timingSafeEqual } from 'node:crypto';
import DescopeClient from '@descope/node-sdk';
import type { AuthInfo } from '@modelcontextprotocol/server';

/**
 * Dual authentication for the MCP endpoint.
 *
 * 1. Static bearer (`LBV_API_TOKEN`) — used by the `lbv` CLI. Constant-time
 *    comparison, no network call.
 * 2. Descope OAuth access token — used by Claude Desktop / claude.ai custom
 *    connectors. The real security boundary is the server-side, fail-closed
 *    single-user allowlist: whatever Descope's flows allow, only a token
 *    identifying the allow-listed user — by `email` claim (`LBV_ALLOWED_EMAIL`)
 *    or by `sub` user id (`LBV_ALLOWED_SUBJECT`) — is accepted. Scopes are
 *    synthesized post-allowlist, never read from the token, so
 *    `requiredScopes: ['groceries']` keeps working for both paths.
 */

const GROCERIES_SCOPE = 'groceries';
const DEFAULT_DESCOPE_BASE_URL = 'https://api.descope.com';

/** Issuer URL for RFC 9728 protected-resource metadata; undefined when OAuth is not configured. */
export function descopeIssuerUrl(): string | undefined {
  const projectId = process.env.DESCOPE_PROJECT_ID;
  const base = process.env.DESCOPE_BASE_URL || DEFAULT_DESCOPE_BASE_URL;
  return projectId ? `${base}/v1/apps/${projectId}` : undefined;
}

/** True when the OAuth path is fully configured (project + at least one allowlist key). */
export function hasOAuthConfig(): boolean {
  return Boolean(
    process.env.DESCOPE_PROJECT_ID &&
      (process.env.LBV_ALLOWED_EMAIL || process.env.LBV_ALLOWED_SUBJECT),
  );
}

/** Constant-time bearer-token comparison. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function verifyStaticToken(bearerToken: string): AuthInfo | undefined {
  const expected = process.env.LBV_API_TOKEN;
  if (!expected) return undefined;
  if (!tokenMatches(bearerToken, expected)) return undefined;
  return { token: bearerToken, scopes: [GROCERIES_SCOPE], clientId: 'lbv-agent' };
}

type Descope = ReturnType<typeof DescopeClient>;

// Module-level singleton so warm serverless invocations reuse the client (and
// its JWKS cache). Keyed by project id in case env changes between tests.
let descopeClient: Descope | undefined;
let descopeClientProjectId: string | undefined;

function getDescopeClient(): Descope | undefined {
  const projectId = process.env.DESCOPE_PROJECT_ID;
  if (!projectId) return undefined;
  if (!descopeClient || descopeClientProjectId !== projectId) {
    descopeClient = DescopeClient({
      projectId,
      baseUrl: process.env.DESCOPE_BASE_URL || DEFAULT_DESCOPE_BASE_URL,
    });
    descopeClientProjectId = projectId;
  }
  return descopeClient;
}

export function resetDescopeClientForTests(): void {
  descopeClient = undefined;
  descopeClientProjectId = undefined;
}

/**
 * The `email` claim is guaranteed by construction: the inbound app's attribute
 * scope maps token claim `email` ← user.email in the Descope console.
 */
function extractEmail(token: Record<string, unknown>): string | undefined {
  const email = token.email;
  if (typeof email !== 'string' || email.length === 0) return undefined;
  return email.toLowerCase();
}

async function verifyDescopeToken(bearerToken: string): Promise<AuthInfo | undefined> {
  const client = getDescopeClient();
  const allowedEmail = process.env.LBV_ALLOWED_EMAIL?.toLowerCase();
  const allowedSubject = process.env.LBV_ALLOWED_SUBJECT;
  if (!client || (!allowedEmail && !allowedSubject)) return undefined; // unconfigured ⇒ fail closed
  try {
    const authInfo = await client.validateSession(bearerToken); // throws on invalid/expired
    const token = authInfo.token as Record<string, unknown>;
    const email = extractEmail(token);
    // Either key independently identifies the single allowed user: the email
    // claim (when the attribute scope delivered it) or the immutable Descope
    // user id in `sub` (present on every token, so DCR clients whose grants
    // omit the email claim still pass).
    const emailAllowed = Boolean(allowedEmail && email === allowedEmail);
    const subjectAllowed = Boolean(allowedSubject && token.sub === allowedSubject);
    if (!emailAllowed && !subjectAllowed) return undefined; // wrong or unidentifiable user ⇒ reject
    return {
      token: bearerToken,
      scopes: [GROCERIES_SCOPE], // synthesized post-allowlist, NOT read from the token
      clientId: typeof token.azp === 'string' ? token.azp : 'descope-client',
      expiresAt: typeof token.exp === 'number' ? token.exp : undefined,
      extra: { sub: token.sub, email },
    };
  } catch (error) {
    console.error('Descope token validation failed:', error);
    return undefined;
  }
}

/**
 * Verify a bearer token via either path. Returning undefined makes withMcpAuth
 * reject the request (401) when `required: true`.
 */
export async function verifyToken(
  _req: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> {
  if (!bearerToken) return undefined;
  return verifyStaticToken(bearerToken) ?? (await verifyDescopeToken(bearerToken));
}
