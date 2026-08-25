/**
 * Capture the authenticated, READ-ONLY responses behind the order / favorites
 * tools so their parsers can be written against real markup and payloads.
 *
 *   1. Put your login in .env.local:  LBV_EMAIL=…  LBV_PASSWORD=…
 *   2. npm run capture-fixtures
 *
 * Raw bodies are written to a fresh directory under the OS temp dir — never
 * into the repo — and the path is printed at the end. Scrub anything personal
 * (name, address, phone, real order ids) before copying a fragment into
 * tests/fixtures/. Nothing here mutates the account: every request is a GET.
 * Your password is read locally and sent only to labellevie.com; neither it
 * nor any cookie is printed.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LbvClient } from '../src/lbv/client';
import type { LbvHttp } from '../src/lbv/http';
import { RECENT_ORDERS_PATH, USUAL_PRODUCTS_PATH } from '../src/lbv/orders';

const TOP_USUAL_PRODUCTS_PATH = '/commande-rapide/top-produits-les-plus-commandes';
const FAVORITES_PATH = '/favorites-lists';

/** Minimal .env.local loader (no dotenv dependency for a throwaway script). */
function loadEnvLocal(): void {
  let content: string;
  try {
    content = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
  } catch {
    return; // no .env.local — fall back to the ambient environment
  }
  for (const line of content.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!domain) return '***';
  const shown = user.slice(0, 2);
  return `${shown}${'*'.repeat(Math.max(1, user.length - 2))}@${domain}`;
}

interface Captured {
  status: number;
  text: string;
}

/** GET one path, write the raw body to `dir/name`, and log status + size only. */
async function capture(
  http: LbvHttp,
  dir: string,
  name: string,
  path: string,
  xhr: boolean,
): Promise<Captured> {
  const res = await http.request('GET', path, { xhr });
  const text = await res.text();
  writeFileSync(join(dir, name), text);
  const type = res.headers.get('content-type') ?? '?';
  const redirect = res.status >= 300 && res.status < 400 ? ` → ${res.headers.get('location') ?? '?'}` : '';
  console.log(`  ${name.padEnd(30)} HTTP ${res.status} ${type.split(';')[0]} ${text.length} bytes${redirect}`);
  return { status: res.status, text };
}

function listIds(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    const arr = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object'
        ? ((parsed as Record<string, unknown>).lists ?? (parsed as Record<string, unknown>).data ?? [])
        : [];
    return (Array.isArray(arr) ? arr : [])
      .map((l) => (l && typeof l === 'object' ? (l as Record<string, unknown>).id : undefined))
      .filter((id): id is string | number => typeof id === 'string' || typeof id === 'number')
      .map(String);
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  loadEnvLocal();
  const email = process.env.LBV_EMAIL;
  const password = process.env.LBV_PASSWORD;
  if (!email || !password) {
    console.error('✗ Missing LBV_EMAIL / LBV_PASSWORD. Add them to .env.local, then re-run.');
    process.exit(2);
  }

  const dir = mkdtempSync(join(tmpdir(), 'lbv-captures-'));
  const client = new LbvClient({ credentials: { email, password } });
  const http = client.http;

  console.log(`→ Logging in as ${maskEmail(email)} …`);
  await http.login();
  console.log('✓ Logged in. Capturing (all GET, read-only):');

  const orders = await capture(http, dir, 'recent-orders.html', RECENT_ORDERS_PATH, false);
  await capture(http, dir, 'recent-orders.xhr.txt', RECENT_ORDERS_PATH, true);
  const usuals = await capture(http, dir, 'usual-products.html', USUAL_PRODUCTS_PATH, false);
  await capture(http, dir, 'usual-products.xhr.txt', USUAL_PRODUCTS_PATH, true);
  await capture(http, dir, 'top-usual-products.html', TOP_USUAL_PRODUCTS_PATH, false);

  const lists = await capture(http, dir, 'favorites-lists.json', FAVORITES_PATH, true);
  for (const id of listIds(lists.text)) {
    await capture(http, dir, `favorites-list-${id}.json`, `${FAVORITES_PATH}/${id}/products`, true);
  }

  const firstOrderId = /<article\b[^>]*data-order-id=["'](\d+)["']/.exec(orders.text)?.[1];
  if (firstOrderId) {
    await capture(http, dir, `order-products-${firstOrderId}.json`, `/api/orders/${firstOrderId}/products`, true);
  } else {
    console.log('  (no data-order-id found in recent-orders.html — order products not captured)');
  }

  const urls = new Set<string>();
  for (const html of [orders.text, usuals.text]) {
    for (const m of html.matchAll(/["'(](\/(?:api|favorites?)[^"'()\s<>]*)/g)) urls.add(m[1]);
  }
  writeFileSync(join(dir, 'api-urls.txt'), [...urls].sort().join('\n') + '\n');
  console.log(`  ${'api-urls.txt'.padEnd(30)} ${urls.size} distinct URL literal(s)`);

  console.log(`\n✓ Captures written to ${dir}`);
  console.log('  Scrub personal data before copying any fragment into tests/fixtures/.');
}

main().catch((err: unknown) => {
  console.error('\n✗ Capture failed:');
  console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
