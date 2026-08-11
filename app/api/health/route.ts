import { hasOAuthConfig } from '../../../src/auth';
import { hasCredKey } from '../../../src/crypto';

export const dynamic = 'force-dynamic';

/**
 * Liveness + configuration probe. No auth required — it never touches the
 * account or returns secrets, only whether the server is wired up correctly.
 */
export function GET(): Response {
  const sessionStore =
    process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL ? 'kv' : 'memory';
  const credKey = hasCredKey();
  const body = {
    status: 'ok',
    service: 'labellevie-mcp',
    version: '0.1.0',
    config: {
      apiToken: Boolean(process.env.LBV_API_TOKEN),
      oauth: hasOAuthConfig(),
      credKey,
      sessionStore,
      // The account-connect flow needs shared KV (link codes + connections
      // must cross serverless instances) and the credential encryption key.
      connectReady: sessionStore === 'kv' && credKey,
    },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
