import { createMcpHandler, withMcpAuth } from 'mcp-handler';
import { verifyToken } from '../../src/auth';
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

// Dual auth (static LBV_API_TOKEN + Descope OAuth with email allowlist) lives
// in src/auth.ts. Both paths surface scopes: ['groceries'].
const authHandler = withMcpAuth(handler, verifyToken, {
  required: true,
  requiredScopes: ['groceries'],
  resourceMetadataPath: '/.well-known/oauth-protected-resource',
});

export { authHandler as GET, authHandler as POST, authHandler as DELETE };
