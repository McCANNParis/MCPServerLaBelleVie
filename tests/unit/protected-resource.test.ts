import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { GET } from '../../app/.well-known/oauth-protected-resource/route';

// Regression tests for the RFC 9728 metadata. Claude echoes `resource` as the
// RFC 8707 resource parameter; Descope's audience whitelist only contains the
// /mcp URL, so emitting the bare origin breaks the whole OAuth flow.

const ENV_KEYS = ['DESCOPE_PROJECT_ID', 'DESCOPE_BASE_URL'] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  process.env.DESCOPE_PROJECT_ID = 'P2testProjectId';
  delete process.env.DESCOPE_BASE_URL;
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function getMetadata(req: Request): Promise<Record<string, unknown>> {
  const res = GET(req);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe('GET /.well-known/oauth-protected-resource', () => {
  it('emits the /mcp endpoint URL as the resource, not the bare origin', async () => {
    const metadata = await getMetadata(
      new Request('https://mcp.example.com/.well-known/oauth-protected-resource'),
    );
    expect(metadata.resource).toBe('https://mcp.example.com/mcp');
  });

  it('derives the public origin from proxy headers (Vercel)', async () => {
    const metadata = await getMetadata(
      new Request('http://localhost:3000/.well-known/oauth-protected-resource', {
        headers: {
          'x-forwarded-host': 'mcp.example.com',
          'x-forwarded-proto': 'https',
        },
      }),
    );
    expect(metadata.resource).toBe('https://mcp.example.com/mcp');
  });

  it('advertises the Descope issuer and the groceries scope', async () => {
    const metadata = await getMetadata(
      new Request('https://mcp.example.com/.well-known/oauth-protected-resource'),
    );
    expect(metadata.authorization_servers).toEqual([
      'https://api.descope.com/v1/apps/P2testProjectId',
    ]);
    expect(metadata.scopes_supported).toEqual(['groceries']);
  });

  it('emits an empty authorization_servers list when OAuth is unconfigured', async () => {
    delete process.env.DESCOPE_PROJECT_ID;
    const metadata = await getMetadata(
      new Request('https://mcp.example.com/.well-known/oauth-protected-resource'),
    );
    expect(metadata.authorization_servers).toEqual([]);
  });

  it('allows cross-origin reads (Claude fetches this from the browser)', () => {
    const res = GET(
      new Request('https://mcp.example.com/.well-known/oauth-protected-resource'),
    );
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});
