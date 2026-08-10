import { describe, expect, it } from 'vitest';
import { CSRF_NAME_SALT, CSRF_VALUE_SALT } from '../../src/lbv/config';
import { LbvApiError, LbvAuthError } from '../../src/lbv/errors';
import { LbvHttp, parseCsrf, saltCsrf } from '../../src/lbv/http';

/** Minimal login form as rendered on the homepage, exercising both attribute orders. */
function loginHtml(): string {
  return `<form name="user-login">
    <input type="hidden" name="csrfname" value="tokenName">
    <input type="hidden" value="tokenValue" name="csrfvalue">
  </form>`;
}

describe('parseCsrf', () => {
  it('extracts both tokens regardless of attribute order', () => {
    expect(parseCsrf(loginHtml())).toEqual({ csrfname: 'tokenName', csrfvalue: 'tokenValue' });
  });

  it('throws when the tokens are absent', () => {
    expect(() => parseCsrf('<form></form>')).toThrow(LbvAuthError);
  });
});

describe('saltCsrf', () => {
  it('appends the static bundle salts', () => {
    expect(saltCsrf({ csrfname: 'a', csrfvalue: 'b' })).toEqual({
      csrfname: 'a' + CSRF_NAME_SALT,
      csrfvalue: 'b' + CSRF_VALUE_SALT,
    });
  });
});

interface Call {
  method: string;
  url: string;
  body?: string;
}

/**
 * Build a fake fetch that simulates: an authenticated GET returning 401 once,
 * then a login handshake (GET homepage → POST /connexion), then the retried GET
 * succeeding. Records every call for sequencing assertions.
 */
function makeFakeFetch(calls: Call[]) {
  let profileHits = 0;
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url, body: init?.body ? String(init.body) : undefined });

    if (method === 'GET' && url.endsWith('/') && !url.includes('/api')) {
      return new Response(loginHtml(), { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (method === 'POST' && url.includes('/connexion')) {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/api/fullprofile')) {
      profileHits += 1;
      return profileHits === 1
        ? new Response(JSON.stringify({ error: 'auth' }), { status: 401 })
        : new Response(JSON.stringify({ ok: true, id: 42 }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
}

describe('LbvHttp auto re-login', () => {
  it('logs in and retries once when an authenticated call returns 401', async () => {
    const calls: Call[] = [];
    const http = new LbvHttp({
      fetchImpl: makeFakeFetch(calls) as typeof fetch,
      credentials: { email: 'shopper@example.com', password: 's3cret' },
    });

    const result = await http.getJson<{ ok: boolean; id: number }>('/api/fullprofile');
    expect(result).toEqual({ ok: true, id: 42 });

    // Sequence: profile(401) → homepage GET → POST /connexion → profile(200)
    const kinds = calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
    expect(kinds).toEqual([
      'GET /api/fullprofile',
      'GET /',
      'POST /connexion',
      'GET /api/fullprofile',
    ]);

    // The login POST must carry the SALTED CSRF tokens plus credentials.
    const login = calls.find((c) => c.url.includes('/connexion'));
    const body = new URLSearchParams(login?.body ?? '');
    expect(body.get('csrfname')).toBe('tokenName' + CSRF_NAME_SALT);
    expect(body.get('csrfvalue')).toBe('tokenValue' + CSRF_VALUE_SALT);
    expect(body.get('email')).toBe('shopper@example.com');
    expect(body.get('password')).toBe('s3cret');
    expect(body.get('show_cart_modal')).toBe('0');
  });

  it('does not attempt login (and surfaces the API error) when no credentials are set', async () => {
    const calls: Call[] = [];
    const http = new LbvHttp({ fetchImpl: makeFakeFetch(calls) as typeof fetch });
    await expect(http.getJson('/api/fullprofile')).rejects.toBeInstanceOf(LbvApiError);
    // Only the single failing call — no homepage/connexion handshake.
    expect(calls).toHaveLength(1);
  });
});
