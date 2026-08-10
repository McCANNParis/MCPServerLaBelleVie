import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  descopeIssuerUrl,
  hasOAuthConfig,
  resetDescopeClientForTests,
  verifyToken,
} from '../../src/auth';

// Mock the Descope SDK factory (default export). validateSession resolves with
// whatever claims each test configures, or throws for invalid tokens — exactly
// the SDK contract. Defined via vi.hoisted so the vi.mock factory can close
// over it.
const { validateSession, descopeFactory } = vi.hoisted(() => {
  const validateSession = vi.fn();
  const descopeFactory = vi.fn(() => ({ validateSession }));
  return { validateSession, descopeFactory };
});

vi.mock('@descope/node-sdk', () => ({ default: descopeFactory }));

const STATIC_TOKEN = 'a'.repeat(64);
const ENV_KEYS = ['LBV_API_TOKEN', 'DESCOPE_PROJECT_ID', 'DESCOPE_BASE_URL', 'LBV_ALLOWED_EMAIL'] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const req = new Request('http://localhost/mcp');

/** Fully configured dual-auth baseline; individual tests unset keys as needed. */
function configureEnv(): void {
  process.env.LBV_API_TOKEN = STATIC_TOKEN;
  process.env.DESCOPE_PROJECT_ID = 'P2testProjectId';
  process.env.LBV_ALLOWED_EMAIL = 'redacted@example.com';
  delete process.env.DESCOPE_BASE_URL;
}

function grantSession(claims: Record<string, unknown>): void {
  validateSession.mockResolvedValue({ jwt: 'header.payload.sig', token: claims });
}

beforeEach(() => {
  configureEnv();
  resetDescopeClientForTests();
  validateSession.mockReset();
  descopeFactory.mockClear();
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('verifyToken — static path', () => {
  it('rejects a missing bearer without touching the network', async () => {
    expect(await verifyToken(req, undefined)).toBeUndefined();
    expect(validateSession).not.toHaveBeenCalled();
  });

  it('accepts the static token with synthesized scopes and no Descope call', async () => {
    const auth = await verifyToken(req, STATIC_TOKEN);
    expect(auth).toEqual({ token: STATIC_TOKEN, scopes: ['groceries'], clientId: 'lbv-agent' });
    expect(validateSession).not.toHaveBeenCalled();
  });

  it('rejects when LBV_API_TOKEN is unset and OAuth is unconfigured', async () => {
    delete process.env.LBV_API_TOKEN;
    delete process.env.DESCOPE_PROJECT_ID;
    expect(await verifyToken(req, STATIC_TOKEN)).toBeUndefined();
  });

  it('falls through to the Descope path on a non-matching token', async () => {
    validateSession.mockRejectedValue(new Error('invalid token'));
    expect(await verifyToken(req, 'not-the-static-token')).toBeUndefined();
    expect(validateSession).toHaveBeenCalledWith('not-the-static-token');
  });
});

describe('verifyToken — Descope path', () => {
  it('accepts a valid token whose email claim matches the allowlist', async () => {
    grantSession({ sub: 'U2abc', azp: 'TPA2client', email: 'redacted@example.com', exp: 1900000000 });
    const auth = await verifyToken(req, 'descope-jwt');
    expect(auth).toMatchObject({
      token: 'descope-jwt',
      scopes: ['groceries'],
      clientId: 'TPA2client',
      expiresAt: 1900000000,
      extra: { sub: 'U2abc', email: 'redacted@example.com' },
    });
  });

  it('matches the allowlist case-insensitively (both sides)', async () => {
    process.env.LBV_ALLOWED_EMAIL = 'Redacted@Example.com';
    grantSession({ email: 'REDACTED@EXAMPLE.COM' });
    expect(await verifyToken(req, 'descope-jwt')).toBeDefined();
  });

  it('synthesizes scopes regardless of the token scope claim', async () => {
    grantSession({ email: 'redacted@example.com', scope: 'openid profile admin' });
    const auth = await verifyToken(req, 'descope-jwt');
    expect(auth?.scopes).toEqual(['groceries']);
  });

  it('rejects a valid token with a missing email claim', async () => {
    grantSession({ sub: 'U2abc' });
    expect(await verifyToken(req, 'descope-jwt')).toBeUndefined();
  });

  it('rejects a valid token with a non-allowlisted email', async () => {
    grantSession({ email: 'intruder@example.com' });
    expect(await verifyToken(req, 'descope-jwt')).toBeUndefined();
  });

  it('fails closed when LBV_ALLOWED_EMAIL is unset — no network call', async () => {
    delete process.env.LBV_ALLOWED_EMAIL;
    grantSession({ email: 'redacted@example.com' });
    expect(await verifyToken(req, 'descope-jwt')).toBeUndefined();
    expect(validateSession).not.toHaveBeenCalled();
  });

  it('skips the Descope path entirely when DESCOPE_PROJECT_ID is unset', async () => {
    delete process.env.DESCOPE_PROJECT_ID;
    grantSession({ email: 'redacted@example.com' });
    expect(await verifyToken(req, 'descope-jwt')).toBeUndefined();
    expect(validateSession).not.toHaveBeenCalled();
    expect(descopeFactory).not.toHaveBeenCalled();
  });

  it('rejects when validateSession throws (invalid/expired token)', async () => {
    validateSession.mockRejectedValue(new Error('expired'));
    expect(await verifyToken(req, 'descope-jwt')).toBeUndefined();
  });

  it('reuses one client across calls and rebuilds it when the project changes', async () => {
    grantSession({ email: 'redacted@example.com' });
    await verifyToken(req, 'descope-jwt');
    await verifyToken(req, 'descope-jwt');
    expect(descopeFactory).toHaveBeenCalledTimes(1);
    process.env.DESCOPE_PROJECT_ID = 'P2otherProject';
    await verifyToken(req, 'descope-jwt');
    expect(descopeFactory).toHaveBeenCalledTimes(2);
  });
});

describe('hasOAuthConfig', () => {
  it('is true only when both DESCOPE_PROJECT_ID and LBV_ALLOWED_EMAIL are set', () => {
    expect(hasOAuthConfig()).toBe(true);
    delete process.env.LBV_ALLOWED_EMAIL;
    expect(hasOAuthConfig()).toBe(false);
    configureEnv();
    delete process.env.DESCOPE_PROJECT_ID;
    expect(hasOAuthConfig()).toBe(false);
    delete process.env.LBV_ALLOWED_EMAIL;
    expect(hasOAuthConfig()).toBe(false);
  });
});

describe('descopeIssuerUrl', () => {
  it('builds the issuer from the project id', () => {
    expect(descopeIssuerUrl()).toBe('https://api.descope.com/v1/apps/P2testProjectId');
  });
  it('honors DESCOPE_BASE_URL', () => {
    process.env.DESCOPE_BASE_URL = 'https://api.euc1.descope.com';
    expect(descopeIssuerUrl()).toBe('https://api.euc1.descope.com/v1/apps/P2testProjectId');
  });
  it('is undefined without a project id', () => {
    delete process.env.DESCOPE_PROJECT_ID;
    expect(descopeIssuerUrl()).toBeUndefined();
  });
});
