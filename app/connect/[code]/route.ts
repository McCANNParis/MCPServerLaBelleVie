import { CookieJar } from 'tough-cookie';
import { z } from 'zod';
import {
  renderExpired,
  renderForm,
  renderLocked,
  renderMisconfigured,
  renderSuccess,
} from '../../../src/connectPage';
import { saveConnection } from '../../../src/connections';
import { encrypt, hasCredKey } from '../../../src/crypto';
import { LbvAuthError } from '../../../src/lbv/errors';
import { LbvHttp } from '../../../src/lbv/http';
import { consumeLinkCode, getLinkRecord, recordFailedAttempt } from '../../../src/links';

export const dynamic = 'force-dynamic';

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

function html(body: string, status: number): Response {
  return new Response(body, { status, headers: HTML_HEADERS });
}

type RouteContext = { params: Promise<{ code: string }> };

export async function GET(_req: Request, { params }: RouteContext): Promise<Response> {
  if (!hasCredKey()) return html(renderMisconfigured(), 503);
  const { code } = await params;
  if (!(await getLinkRecord(code))) return html(renderExpired(), 410);
  return html(renderForm(), 200);
}

const FormSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

export async function POST(req: Request, { params }: RouteContext): Promise<Response> {
  if (!hasCredKey()) return html(renderMisconfigured(), 503);
  const { code } = await params;
  const record = await getLinkRecord(code);
  if (!record) return html(renderExpired(), 410);

  const form = await req.formData().catch(() => null);
  const parsed = FormSchema.safeParse({
    email: form?.get('email'),
    password: form?.get('password'),
  });
  if (!parsed.success) {
    return html(renderForm({ error: 'Veuillez saisir un email et un mot de passe valides.' }), 400);
  }
  const { email, password } = parsed.data;

  // Verify the credentials against La Belle Vie with a fresh jar; only a
  // successful login is ever persisted.
  const http = new LbvHttp({ jar: new CookieJar(), credentials: { email, password } });
  try {
    await http.login();
  } catch (err) {
    if (err instanceof LbvAuthError && err.status !== undefined) {
      // The site rejected the credentials (vs. the handshake itself failing).
      const remaining = await recordFailedAttempt(code);
      if (!remaining) return html(renderLocked(), 429);
      return html(renderForm({ error: 'Email ou mot de passe incorrect.' }), 401);
    }
    return html(
      renderForm({ error: 'La connexion à La Belle Vie a échoué. Réessayez dans un instant.' }),
      502,
    );
  }

  const now = Date.now();
  await saveConnection(record.identity, {
    lbvEmail: email.toLowerCase(),
    creds: encrypt({ email, password }),
    jar: http.serializeJar(),
    connectedAt: now,
    lastUsedAt: now,
  });
  await consumeLinkCode(code);
  return html(renderSuccess(email.toLowerCase()), 200);
}
