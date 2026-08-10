export interface PromoResult {
  code: string;
  valid: boolean;
  message: string | null;
  discount: number | null;
  raw: unknown;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Normalize the POST /api/code-promo/verify response. Requires a logged-in
 * session (returns 400 "Connectez-vous…" otherwise). Success/error shapes vary,
 * so this parser is deliberately tolerant.
 */
export function parsePromo(code: string, json: unknown): PromoResult {
  const body = (json ?? {}) as Record<string, unknown>;
  const errorMessage =
    typeof body.error === 'string'
      ? body.error
      : typeof body.message === 'string' && body.valid === false
        ? body.message
        : null;
  const valid =
    body.valid === true ||
    body.success === true ||
    (!errorMessage && (body.discount !== undefined || body.amount !== undefined || body.code !== undefined));
  return {
    code,
    valid: !!valid,
    message: (body.message as string) ?? errorMessage,
    discount: num(body.discount) ?? num(body.amount) ?? num(body.value),
    raw: json,
  };
}
