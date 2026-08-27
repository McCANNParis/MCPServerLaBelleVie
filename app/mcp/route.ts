import { createMcpHandler, withMcpAuth } from 'mcp-handler';
import { verifyToken } from '../../src/auth';
import { registerTools } from '../../src/tools';

// Streamable-HTTP MCP endpoint, mounted at /mcp. mcp-handler v2 no longer routes
// by transport segment — the handler serves whatever route it is mounted on, so
// this is a fixed path rather than the old `[transport]` dynamic segment (the
// legacy `/sse` transport is gone with it).
const handler = createMcpHandler(
  (server) => {
    registerTools(server);
  },
  {
    serverInfo: { name: 'labellevie-mcp', version: '0.1.0' },
    capabilities: { tools: {} },
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

export const maxDuration = 60;

export { authHandler as GET, authHandler as POST, authHandler as DELETE };
