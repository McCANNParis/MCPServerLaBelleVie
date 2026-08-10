import { hasCredentials } from '../../../src/runtime';

export const dynamic = 'force-dynamic';

/**
 * Liveness + configuration probe. No auth required — it never touches the
 * account or returns secrets, only whether the server is wired up correctly.
 */
export function GET(): Response {
  const body = {
    status: 'ok',
    service: 'labellevie-mcp',
    version: '0.1.0',
    config: {
      credentials: hasCredentials(),
      apiToken: Boolean(process.env.LBV_API_TOKEN),
      sessionStore:
        process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
          ? 'kv'
          : 'memory',
    },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
