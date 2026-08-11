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
const ENV_KEYS = [
  'LBV_API_TOKEN',
  'DESCOPE_PROJECT_ID',
  'DESCOPE_BASE_URL',
  'LBV_ALLOWED_EMAIL',
  'LBV_ALLOWED_SUBJECT',
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const req = new Request('http://localhost/mcp');

/** Email-allowlist baseline; individual tests unset or add keys as needed. */
function configureEnv(): void {
  process.env.LBV_API_TOKEN = STATIC_TOKEN;
  process.env.DESCOPE_PROJECT_ID = 'P2testProjectId';
  process.env.LBV_ALLOWED_EMAIL = 'allowed@example.com';
  delete process.env.LBV_ALLOWED_SUBJECT;
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
    grantSession({ sub: 'U2abc', azp: 'TPA2client', email: 'allowed@example.com', exp: 1900000000 });
    const auth = await verifyToken(req, 'descope-jwt');
    expect(auth).toMatchObject({
      token: 'descope-jwt',
      scopes: ['groceries'],
      clientId: 'TPA2client',
      expiresAt: 1900000000,
      extra: { sub: 'U2abc', email: 'allowed@example.com' },
    });
  });

  it('matches the allowlist case-insensitively (both sides)', async () => {
    process.env.LBV_ALLOWED_EMAIL = 'Allowed@Example.com';
    grantSession({ email: 'ALLOWED@EXAMPLE.COM' });
    expect(await verifyToken(req, 'descope-jwt')).toBeDefined();
  });

  it('synthesizes scopes regardless of the token scope claim', async () => {
    grantSession({ email: 'allowed@example.com', scope: 'openid profile admin' });
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

  it('fails closed when neither LBV_ALLOWED_EMAIL nor LBV_ALLOWED_SUBJECT is set — no network call', async () => {
    delete process.env.LBV_ALLOWED_EMAIL;
    grantSession({ email: 'allowed@example.com' });
    expect(await verifyToken(req, 'descope-jwt')).toBeUndefined();
    expect(validateSession).not.toHaveBeenCalled();
  });

  it('accepts a token whose sub matches LBV_ALLOWED_SUBJECT even without an email claim', async () => {
    process.env.LBV_ALLOWED_SUBJECT = 'U2allowedUser';
    grantSession({ sub: 'U2allowedUser', azp: 'TPA2client' });
    const auth = await verifyToken(req, 'descope-jwt');
    expect(auth).toMatchObject({ scopes: ['groceries'], extra: { sub: 'U2allowedUser' } });
  });

  it('accepts via subject alone when LBV_ALLOWED_EMAIL is unset', async () => {
    delete process.env.LBV_ALLOWED_EMAIL;
    process.env.LBV_ALLOWED_SUBJECT = 'U2allowedUser';
    grantSession({ sub: 'U2allowedUser' });
    expect(await verifyToken(req, 'descope-jwt')).toBeDefined();
  });

  it('rejects when the sub differs and no email claim matches', async () => {
    process.env.LBV_ALLOWED_SUBJECT = 'U2allowedUser';
    grantSession({ sub: 'U2someoneElse', email: 'intruder@example.com' });
    expect(await verifyToken(req, 'descope-jwt')).toBeUndefined();
  });

  it('still accepts by email when the sub does not match the configured subject', async () => {
    process.env.LBV_ALLOWED_SUBJECT = 'U2allowedUser';
    grantSession({ sub: 'U2rotatedId', email: 'allowed@example.com' });
    expect(await verifyToken(req, 'descope-jwt')).toBeDefined();
  });

  it('skips the Descope path entirely when DESCOPE_PROJECT_ID is unset', async () => {
    delete process.env.DESCOPE_PROJECT_ID;
    grantSession({ email: 'allowed@example.com' });
    expect(await verifyToken(req, 'descope-jwt')).toBeUndefined();
    expect(validateSession).not.toHaveBeenCalled();
    expect(descopeFactory).not.toHaveBeenCalled();
  });

  it('rejects when validateSession throws (invalid/expired token)', async () => {
    validateSession.mockRejectedValue(new Error('expired'));
    expect(await verifyToken(req, 'descope-jwt')).toBeUndefined();
  });

  it('reuses one client across calls and rebuilds it when the project changes', async () => {
    grantSession({ email: 'allowed@example.com' });
    await verifyToken(req, 'descope-jwt');
    await verifyToken(req, 'descope-jwt');
    expect(descopeFactory).toHaveBeenCalledTimes(1);
    process.env.DESCOPE_PROJECT_ID = 'P2otherProject';
    await verifyToken(req, 'descope-jwt');
    expect(descopeFactory).toHaveBeenCalledTimes(2);
  });
});

describe('hasOAuthConfig', () => {
  it('requires DESCOPE_PROJECT_ID plus at least one allowlist key', () => {
    expect(hasOAuthConfig()).toBe(true);
    delete process.env.LBV_ALLOWED_EMAIL;
    expect(hasOAuthConfig()).toBe(false);
    process.env.LBV_ALLOWED_SUBJECT = 'U2allowedUser';
    expect(hasOAuthConfig()).toBe(true);
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
