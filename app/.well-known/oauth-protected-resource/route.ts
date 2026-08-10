import { metadataCorsOptionsRequestHandler, protectedResourceHandler } from 'mcp-handler';
import { descopeIssuerUrl } from '../../../src/auth';

// RFC 9728 protected-resource metadata: tells OAuth clients (Claude) which
// authorization server protects /mcp. Empty list when OAuth is not configured —
// the static-token path needs no metadata.
const issuer = descopeIssuerUrl();

export const GET = protectedResourceHandler({ authServerUrls: issuer ? [issuer] : [] });
export const OPTIONS = metadataCorsOptionsRequestHandler();
