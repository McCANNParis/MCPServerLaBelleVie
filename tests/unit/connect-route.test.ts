import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '../../app/connect/[code]/route';
import { getConnection } from '../../src/connections';
import { resetCredKeyCacheForTests } from '../../src/crypto';
import { createLinkCode, getLinkRecord } from '../../src/links';
import { setSessionStore } from '../../src/session';

const ENV_VARS = [
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'LBV_CRED_KEY',
];

const GOOD_PASSWORD = 'correct-horse';

/**
 * Fake labellevie.com: serves the CSRF login page and accepts POST /connexion
 * only with GOOD_PASSWORD (mirroring the real error-in-JSON contract).
 */
function fakeLbvFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST' && url.includes('/connexion')) {
      const body = new URLSearchParams(String(init?.body ?? ''));
      return body.get('password') === GOOD_PASSWORD
        ? new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({ error: 'Identifiants invalides' }), { status: 401 });
    }
    return new Response(
      '<input type="hidden" name="csrfname" value="n"><input type="hidden" name="csrfvalue" value="v">',
      { status: 200, headers: { 'content-type': 'text/html' } },
    );
  }) as typeof fetch;
}

function ctx(code: string): { params: Promise<{ code: string }> } {
  return { params: Promise.resolve({ code }) };
}

function getReq(code: string): Request {
  return new Request(`http://localhost/connect/${code}`);
}

function postReq(code: string, fields: Record<string, string>): Request {
  return new Request(`http://localhost/connect/${code}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

describe('/connect/[code] route', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_VARS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.LBV_CRED_KEY = 'a'.repeat(64);
    resetCredKeyCacheForTests();
    setSessionStore(null);
    vi.stubGlobal('fetch', fakeLbvFetch());
  });

  afterEach(() => {
    for (const k of ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetCredKeyCacheForTests();
    setSessionStore(null);
    vi.unstubAllGlobals();
  });

  it('GET serves the login form for a valid code, with hardening headers', async () => {
    const { code } = await createLinkCode('sub:a');
    const res = await GET(getReq(code), ctx(code));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await res.text();
    expect(html).toContain('name="email"');
    expect(html).toContain('name="password"');
    expect(html).toContain('noindex');
    expect(html).not.toContain('action=');
  });

  it('GET returns 410 for an unknown or malformed code', async () => {
    const res = await GET(getReq('nope'), ctx('nope'));
    expect(res.status).toBe(410);
    expect(await res.text()).toContain('expiré');
  });

  it('GET returns 503 when LBV_CRED_KEY is not configured', async () => {
    delete process.env.LBV_CRED_KEY;
    resetCredKeyCacheForTests();
    const { code } = await createLinkCode('sub:a');
    const res = await GET(getReq(code), ctx(code));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('LBV_CRED_KEY');
  });

  it('POST re-renders with 400 on an invalid form, without echoing anything', async () => {
    const { code } = await createLinkCode('sub:a');
    const res = await POST(postReq(code, { email: 'not-an-email', password: '' }), ctx(code));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('valides');
  });

  it('POST counts a wrong password and re-renders with the French error', async () => {
    const { code } = await createLinkCode('sub:a');
    const res = await POST(
      postReq(code, { email: 'shopper@example.com', password: 'wrong' }),
      ctx(code),
    );
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain('Email ou mot de passe incorrect');
    expect(html).not.toContain('wrong');
    expect((await getLinkRecord(code))?.attempts).toBe(1);
  });

  it('POST locks the link after too many wrong passwords', async () => {
    const { code } = await createLinkCode('sub:a');
    let last: Response | undefined;
    for (let i = 0; i < 5; i++) {
      last = await POST(postReq(code, { email: 'shopper@example.com', password: 'wrong' }), ctx(code));
    }
    expect(last?.status).toBe(429);
    expect(await last?.text()).toContain('tentatives');
    expect(await getLinkRecord(code)).toBeNull();
  });

  it('POST with the right password saves the connection for the link identity and consumes the code', async () => {
    const { code } = await createLinkCode('sub:oauth-user');
    const res = await POST(
      postReq(code, { email: 'Shopper@Example.com', password: GOOD_PASSWORD }),
      ctx(code),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('shopper@example.com');
    expect(html).not.toContain(GOOD_PASSWORD);

    const connection = await getConnection('sub:oauth-user');
    expect(connection?.lbvEmail).toBe('shopper@example.com');
    expect(connection?.jar).toBeTruthy();
    expect(JSON.stringify(connection)).not.toContain(GOOD_PASSWORD);

    // Single use: the code is gone, and replaying the POST hits the expired page.
    expect(await getLinkRecord(code)).toBeNull();
    const replay = await POST(
      postReq(code, { email: 'shopper@example.com', password: GOOD_PASSWORD }),
      ctx(code),
    );
    expect(replay.status).toBe(410);
  });
});
