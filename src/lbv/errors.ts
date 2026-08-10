/** Error types for the La Belle Vie client, so callers can distinguish causes. */

/** Thrown when login fails (bad credentials, CSRF rejection, blocked account). */
export class LbvAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LbvAuthError';
  }
}

/** Thrown when an API call returns a non-2xx status. Carries the parsed body. */
export class LbvApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: unknown,
  ) {
    super(`La Belle Vie API ${status} on ${path}: ${describeBody(body)}`);
    this.name = 'LbvApiError';
  }
}

/** Thrown when a required session (login) is missing and no credentials exist. */
export class LbvNotAuthenticatedError extends Error {
  constructor(message = 'This action requires a logged-in session but no credentials are configured.') {
    super(message);
    this.name = 'LbvNotAuthenticatedError';
  }
}

/** Best-effort extraction of a human-readable error string from an API body. */
export function extractApiError(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') {
    return typeof body === 'string' && body ? body : undefined;
  }
  const err = (body as Record<string, unknown>).error ?? (body as Record<string, unknown>).errors;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const first = Object.values(err as Record<string, unknown>).find((v) => typeof v === 'string');
    if (typeof first === 'string') return first;
  }
  return undefined;
}

function describeBody(body: unknown): string {
  const msg = extractApiError(body);
  if (msg) return msg;
  try {
    return typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200);
  } catch {
    return '<unparseable body>';
  }
}
