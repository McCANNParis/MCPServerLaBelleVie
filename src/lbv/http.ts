import { CookieJar } from 'tough-cookie';
import {
  BASE_URL,
  CSRF_NAME_SALT,
  CSRF_VALUE_SALT,
  USER_AGENT,
} from './config';
import { LbvApiError, LbvAuthError, LbvNotAuthenticatedError, extractApiError } from './errors';

export interface Credentials {
  email: string;
  password: string;
}

export interface LbvHttpOptions {
  /** Pre-existing cookie jar (e.g. hydrated from the session store). */
  jar?: CookieJar;
  /** Injectable fetch, for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Credentials used for the initial login and for auto re-login on 4xx. */
  credentials?: Credentials;
  /**
   * Trust a hydrated jar as already-authenticated: skips the eager login
   * handshake in ensureLoggedIn(). The reactive re-login-on-4xx still covers
   * the case where that trust turns out to be wrong.
   */
  assumeLoggedIn?: boolean;
  /** Override the base site URL (tests). */
  baseUrl?: string;
}

interface RequestOptions {
  /** Form fields; sets Content-Type to x-www-form-urlencoded. */
  form?: Record<string, string | number>;
  headers?: Record<string, string>;
  accept?: string;
  /** When false, do not send the XHR header / send a browser-like Accept. */
  xhr?: boolean;
  /** Internal: prevents infinite auto re-login loops. */
  _isRetry?: boolean;
}

/** Parse the `csrfname`/`csrfvalue` hidden inputs from a rendered page. */
export function parseCsrf(html: string): { csrfname: string; csrfvalue: string } {
  const csrfname =
    /name=["']csrfname["'][^>]*\svalue=["']([^"']*)["']/i.exec(html)?.[1] ??
    /\svalue=["']([^"']*)["'][^>]*name=["']csrfname["']/i.exec(html)?.[1];
  const csrfvalue =
    /name=["']csrfvalue["'][^>]*\svalue=["']([^"']*)["']/i.exec(html)?.[1] ??
    /\svalue=["']([^"']*)["'][^>]*name=["']csrfvalue["']/i.exec(html)?.[1];
  if (!csrfname || !csrfvalue) {
    throw new LbvAuthError('Could not locate CSRF tokens on the login page.');
  }
  return { csrfname, csrfvalue };
}

/** Append the static bundle salts to the raw hidden-input CSRF values. */
export function saltCsrf(tokens: { csrfname: string; csrfvalue: string }): {
  csrfname: string;
  csrfvalue: string;
} {
  return {
    csrfname: tokens.csrfname + CSRF_NAME_SALT,
    csrfvalue: tokens.csrfvalue + CSRF_VALUE_SALT,
  };
}

/**
 * Thin transport around fetch that persists cookies in a tough-cookie jar,
 * performs the La Belle Vie login handshake, and transparently re-logs-in +
 * retries once when an authenticated call fails with a 4xx.
 */
export class LbvHttp {
  readonly jar: CookieJar;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private credentials?: Credentials;
  private loggedIn = false;

  constructor(opts: LbvHttpOptions = {}) {
    this.jar = opts.jar ?? new CookieJar();
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = opts.baseUrl ?? BASE_URL;
    this.credentials = opts.credentials;
    this.loggedIn = opts.assumeLoggedIn ?? false;
  }

  hasCredentials(): boolean {
    return !!this.credentials;
  }

  setCredentials(creds: Credentials): void {
    this.credentials = creds;
  }

  private resolveUrl(path: string): string {
    return path.startsWith('http') ? path : this.baseUrl + path;
  }

  private async applyCookies(url: string, headers: Headers): Promise<void> {
    const cookie = await this.jar.getCookieString(url);
    if (cookie) headers.set('cookie', cookie);
  }

  private async storeCookies(url: string, res: Response): Promise<void> {
    const setCookies =
      typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const sc of setCookies) {
      try {
        await this.jar.setCookie(sc, url);
      } catch {
        // Ignore cookies the jar rejects (e.g. wrong domain).
      }
    }
  }

  /** Perform a raw request, applying/storing cookies and auto re-login. */
  async request(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    const url = this.resolveUrl(path);
    const headers = new Headers(opts.headers);
    headers.set('user-agent', USER_AGENT);
    const xhr = opts.xhr ?? true;
    if (xhr) headers.set('x-requested-with', 'XMLHttpRequest');
    if (!headers.has('accept')) {
      headers.set(
        'accept',
        opts.accept ??
          (xhr
            ? 'application/json, text/javascript, */*; q=0.01'
            : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'),
      );
    }
    if (!headers.has('accept-language')) headers.set('accept-language', 'fr-FR,fr;q=0.9,en;q=0.8');
    if (!headers.has('referer')) headers.set('referer', this.baseUrl + '/');

    let body: string | undefined;
    if (opts.form) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.form)) params.set(k, String(v));
      body = params.toString();
      headers.set('content-type', 'application/x-www-form-urlencoded; charset=UTF-8');
    }

    await this.applyCookies(url, headers);
    const res = await this.fetchImpl(url, { method, headers, body, redirect: 'manual' });
    await this.storeCookies(url, res);

    const isAuthEndpoint = path.includes('/connexion');
    const looksUnauthenticated = res.status === 400 || res.status === 401 || res.status === 403;
    if (looksUnauthenticated && !opts._isRetry && !isAuthEndpoint && this.credentials) {
      const relogged = await this.login().then(
        () => true,
        () => false,
      );
      if (relogged) {
        return this.request(method, path, { ...opts, _isRetry: true });
      }
    }
    return res;
  }

  /** Log in via POST /connexion using the verified CSRF handshake. */
  async login(creds?: Credentials): Promise<void> {
    const c = creds ?? this.credentials;
    if (!c) throw new LbvAuthError('No credentials provided for login.');

    // 1. Fetch a page to obtain a PHPSESSID and the current CSRF hidden inputs.
    const pageRes = await this.request('GET', '/', { xhr: false, _isRetry: true });
    const html = await pageRes.text();
    const salted = saltCsrf(parseCsrf(html));

    // 2. POST the login form. Success = 2xx and no `error` in the JSON body.
    const res = await this.request('POST', '/connexion', {
      form: {
        email: c.email,
        password: c.password,
        csrfname: salted.csrfname,
        csrfvalue: salted.csrfvalue,
        show_cart_modal: 0,
      },
      _isRetry: true,
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = text;
    }
    const apiError = extractApiError(data);
    if (!res.ok || apiError) {
      this.loggedIn = false;
      throw new LbvAuthError(apiError ?? `Login failed (HTTP ${res.status}).`, res.status);
    }
    this.loggedIn = true;
  }

  /** Ensure a session exists; log in if we have credentials and aren't yet in. */
  async ensureLoggedIn(): Promise<void> {
    if (this.loggedIn) return;
    if (!this.credentials) throw new LbvNotAuthenticatedError();
    await this.login();
  }

  private async parseJson<T>(res: Response, path: string): Promise<T> {
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = text;
    }
    if (!res.ok) throw new LbvApiError(res.status, path, data);
    return data as T;
  }

  async getJson<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.request('GET', path, opts);
    return this.parseJson<T>(res, path);
  }

  async postJson<T = unknown>(
    path: string,
    form: Record<string, string | number>,
    opts: RequestOptions = {},
  ): Promise<T> {
    const res = await this.request('POST', path, { ...opts, form });
    return this.parseJson<T>(res, path);
  }

  async deleteJson<T = unknown>(
    path: string,
    form: Record<string, string | number>,
    opts: RequestOptions = {},
  ): Promise<T> {
    const res = await this.request('DELETE', path, { ...opts, form });
    return this.parseJson<T>(res, path);
  }

  /** Serialize the cookie jar for persistence in the session store. */
  serializeJar(): unknown {
    return this.jar.toJSON();
  }
}

/** Rebuild an LbvHttp from a serialized jar (from the session store). */
export function hydrateHttp(
  serializedJar: unknown | null,
  opts: Omit<LbvHttpOptions, 'jar'> = {},
): LbvHttp {
  let jar: CookieJar | undefined;
  if (serializedJar) {
    try {
      jar = CookieJar.fromJSON(serializedJar as never);
    } catch {
      jar = undefined;
    }
  }
  return new LbvHttp({ ...opts, jar });
}
