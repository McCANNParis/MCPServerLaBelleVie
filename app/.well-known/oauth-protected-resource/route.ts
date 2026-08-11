import {
  generateProtectedResourceMetadata,
  getPublicOrigin,
  metadataCorsOptionsRequestHandler,
} from 'mcp-handler';
import { descopeIssuerUrl } from '../../../src/auth';

// RFC 9728 protected-resource metadata: tells OAuth clients (Claude) which
// authorization server protects /mcp. Empty list when OAuth is not configured —
// the static-token path needs no metadata.
//
// Built by hand rather than with protectedResourceHandler because the resource
// identifier must be the MCP endpoint URL (…/mcp): Claude echoes it as the
// RFC 8707 `resource` parameter, and Descope only authorizes values on its
// audience whitelist — the bare origin the stock handler emits gets rejected
// at the authorize endpoint (E063306) before any sign-in page shows.
// scopes_supported steers clients to request the one scope Descope grants.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

export function GET(req: Request): Response {
  const issuer = descopeIssuerUrl();
  const metadata = generateProtectedResourceMetadata({
    authServerUrls: issuer ? [issuer] : [],
    resourceUrl: `${getPublicOrigin(req)}/mcp`,
    additionalMetadata: { scopes_supported: ['groceries'] },
  });
  return new Response(JSON.stringify(metadata), {
    headers: { ...CORS_HEADERS, 'Cache-Control': 'max-age=3600', 'Content-Type': 'application/json' },
  });
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
