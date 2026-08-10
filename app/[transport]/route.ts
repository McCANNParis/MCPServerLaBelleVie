import { timingSafeEqual } from 'node:crypto';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { createMcpHandler, withMcpAuth } from 'mcp-handler';
import { registerTools } from '../../src/tools';

// Streamable-HTTP MCP endpoint. With basePath '' the transport segment lives at
// the app root, so the endpoint is `/mcp` (and legacy `/sse`).
const handler = createMcpHandler(
  (server) => {
    registerTools(server);
  },
  {
    serverInfo: { name: 'labellevie-mcp', version: '0.1.0' },
    capabilities: { tools: {} },
  },
  {
    basePath: '',
    maxDuration: 60,
    redisUrl: process.env.REDIS_URL,
    verboseLogs: process.env.NODE_ENV === 'development',
  },
);

/** Constant-time bearer-token comparison. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Verify the bearer token against LBV_API_TOKEN. Returning undefined makes
 * withMcpAuth reject the request (401) when `required: true`.
 */
const verifyToken = async (_req: Request, bearerToken?: string): Promise<AuthInfo | undefined> => {
  const expected = process.env.LBV_API_TOKEN;
  if (!expected || !bearerToken) return undefined;
  if (!tokenMatches(bearerToken, expected)) return undefined;
  return { token: bearerToken, scopes: ['groceries'], clientId: 'lbv-agent' };
};

const authHandler = withMcpAuth(handler, verifyToken, {
  required: true,
  requiredScopes: ['groceries'],
  resourceMetadataPath: '/.well-known/oauth-protected-resource',
});

export { authHandler as GET, authHandler as POST, authHandler as DELETE };
