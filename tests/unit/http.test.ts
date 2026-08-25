import { describe, expect, it } from 'vitest';
import { CSRF_NAME_SALT, CSRF_VALUE_SALT } from '../../src/lbv/config';
import { LbvApiError, LbvAuthError, LbvNotAuthenticatedError } from '../../src/lbv/errors';
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

interface RecordedCall extends Call {
  headers: Headers;
}

/**
 * Fake fetch that records headers too and answers the login handshake itself;
 * every other request is delegated to `respond(method, path, hit)` where `hit`
 * counts how many times that method+path has been seen.
 */
function makeRecordingFetch(
  calls: RecordedCall[],
  respond: (method: string, path: string, hit: number) => Response,
) {
  const hits = new Map<string, number>();
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = new URL(url).pathname;
    calls.push({
      method,
      url,
      body: init?.body ? String(init.body) : undefined,
      headers: new Headers(init?.headers as HeadersInit),
    });
    if (method === 'GET' && path === '/') {
      return new Response(loginHtml(), { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (method === 'POST' && path === '/connexion') return new Response('{}', { status: 200 });
    const hit = (hits.get(`${method} ${path}`) ?? 0) + 1;
    hits.set(`${method} ${path}`, hit);
    return respond(method, path, hit);
  };
}

const CREDS = { email: 'shopper@example.com', password: 's3cret' };
const redirectHome = () =>
  new Response('', { status: 302, headers: { location: 'https://www.labellevie.com/' } });

describe('LbvHttp.sendJson', () => {
  it('sends a JSON body with the JSON content type and the XHR header', async () => {
    const calls: RecordedCall[] = [];
    const http = new LbvHttp({
      fetchImpl: makeRecordingFetch(calls, () => new Response('{"ok":true}', { status: 200 })) as typeof fetch,
    });
    const result = await http.sendJson('PUT', '/favorites-lists/1/products/2', { id: 1, product_id: 2 });
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].body).toBe('{"id":1,"product_id":2}');
    expect(calls[0].headers.get('content-type')).toBe('application/json; charset=UTF-8');
    expect(calls[0].headers.get('x-requested-with')).toBe('XMLHttpRequest');
  });

  it('sends no body or content type when none is given', async () => {
    const calls: RecordedCall[] = [];
    const http = new LbvHttp({
      fetchImpl: makeRecordingFetch(calls, () => new Response('', { status: 200 })) as typeof fetch,
    });
    await http.sendJson('DELETE', '/favorites-lists/1/products/2');
    expect(calls[0].body).toBeUndefined();
    expect(calls[0].headers.has('content-type')).toBe(false);
  });
});

describe('LbvHttp redirects mean "logged out"', () => {
  it('re-logs-in and retries once when a JSON call answers with a 302', async () => {
    const calls: RecordedCall[] = [];
    const http = new LbvHttp({
      fetchImpl: makeRecordingFetch(calls, (_m, path, hit) =>
        path === '/favorites-lists' && hit === 1 ? redirectHome() : new Response('[]', { status: 200 }),
      ) as typeof fetch,
      credentials: CREDS,
    });
    expect(await http.getJson('/favorites-lists')).toEqual([]);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /favorites-lists',
      'GET /',
      'POST /connexion',
      'GET /favorites-lists',
    ]);
  });

  it('surfaces LbvNotAuthenticatedError on a 302 when no credentials are set', async () => {
    const calls: RecordedCall[] = [];
    const http = new LbvHttp({
      fetchImpl: makeRecordingFetch(calls, () => redirectHome()) as typeof fetch,
    });
    await expect(http.getJson('/favorites-lists')).rejects.toBeInstanceOf(LbvNotAuthenticatedError);
    expect(calls).toHaveLength(1);
  });

  it('surfaces LbvNotAuthenticatedError when the retry still redirects', async () => {
    const calls: RecordedCall[] = [];
    const http = new LbvHttp({
      fetchImpl: makeRecordingFetch(calls, () => redirectHome()) as typeof fetch,
      credentials: CREDS,
    });
    await expect(http.getText('/commande-rapide/dernieres-commandes')).rejects.toBeInstanceOf(
      LbvNotAuthenticatedError,
    );
    // One handshake, then the retried page request — never a loop.
    expect(calls).toHaveLength(4);
  });
});

describe('LbvHttp.getText', () => {
  it('returns the page body verbatim with a browser-like Accept and no XHR header', async () => {
    const calls: RecordedCall[] = [];
    const page = '<div class="last-orders"></div>';
    const http = new LbvHttp({
      fetchImpl: makeRecordingFetch(
        calls,
        () => new Response(page, { status: 200, headers: { 'content-type': 'text/html' } }),
      ) as typeof fetch,
    });
    expect(await http.getText('/commande-rapide/dernieres-commandes')).toBe(page);
    expect(calls[0].headers.has('x-requested-with')).toBe(false);
    expect(calls[0].headers.get('accept')?.startsWith('text/html')).toBe(true);
  });

  it('sends the XHR header when asked to', async () => {
    const calls: RecordedCall[] = [];
    const http = new LbvHttp({
      fetchImpl: makeRecordingFetch(calls, () => new Response('<div/>', { status: 200 })) as typeof fetch,
    });
    await http.getText('/commande-rapide/dernieres-commandes', { xhr: true });
    expect(calls[0].headers.get('x-requested-with')).toBe('XMLHttpRequest');
  });

  it('throws LbvApiError with the body on a non-2xx page', async () => {
    const http = new LbvHttp({
      fetchImpl: makeRecordingFetch([], () => new Response('boom', { status: 500 })) as typeof fetch,
    });
    await expect(http.getText('/commande-rapide/dernieres-commandes')).rejects.toBeInstanceOf(
      LbvApiError,
    );
  });
});

describe('ensureLoggedIn', () => {
  it('throws LbvNotAuthenticatedError when no credentials are available', async () => {
    const http = new LbvHttp({ fetchImpl: makeFakeFetch([]) as typeof fetch });
    await expect(http.ensureLoggedIn()).rejects.toBeInstanceOf(LbvNotAuthenticatedError);
  });

  it('performs the login handshake once when credentials are present', async () => {
    const calls: Call[] = [];
    const http = new LbvHttp({
      fetchImpl: makeFakeFetch(calls) as typeof fetch,
      credentials: { email: 'shopper@example.com', password: 's3cret' },
    });
    await http.ensureLoggedIn();
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /',
      'POST /connexion',
    ]);
    await http.ensureLoggedIn(); // already in — no extra calls
    expect(calls).toHaveLength(2);
  });

  it('assumeLoggedIn trusts the hydrated jar and skips the eager handshake', async () => {
    const calls: Call[] = [];
    const http = new LbvHttp({
      fetchImpl: makeFakeFetch(calls) as typeof fetch,
      credentials: { email: 'shopper@example.com', password: 's3cret' },
      assumeLoggedIn: true,
    });
    await http.ensureLoggedIn();
    expect(calls).toHaveLength(0);
  });
});
