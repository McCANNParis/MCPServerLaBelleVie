/**
 * One-off auth smoke test — run this yourself with your own credentials to
 * confirm the login handshake works before/after deploying. It performs the
 * real POST /connexion CSRF handshake and then GET /api/fullprofile (which is
 * 200 only when authenticated).
 *
 *   1. Put your login in .env.local:  LBV_EMAIL=…  LBV_PASSWORD=…
 *   2. npm run verify-auth
 *
 * Your password is read locally and sent only to labellevie.com. It is never
 * printed, committed, or sent anywhere else. .env.local is gitignored.
 */
import { readFileSync } from 'node:fs';
import { LbvClient } from '../src/lbv/client';

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

async function main(): Promise<void> {
  loadEnvLocal();
  const email = process.env.LBV_EMAIL;
  const password = process.env.LBV_PASSWORD;
  if (!email || !password) {
    console.error('✗ Missing LBV_EMAIL / LBV_PASSWORD. Add them to .env.local, then re-run.');
    process.exit(2);
  }

  const client = new LbvClient({ credentials: { email, password } });

  console.log(`→ Logging in as ${maskEmail(email)} …`);
  await client.http.login();
  console.log('✓ Login succeeded — the CSRF handshake was accepted and the credentials are valid.');

  const profile = await client.getProfile();
  console.log('✓ GET /api/fullprofile returned an authenticated profile.');
  if (profile.firstName || profile.lastName) {
    console.log(`  Signed in as: ${[profile.firstName, profile.lastName].filter(Boolean).join(' ')}`);
  }

  console.log('\nAuth works. Set LBV_EMAIL / LBV_PASSWORD as Vercel environment variables to deploy.');
}

main().catch((err: unknown) => {
  console.error('\n✗ Auth verification failed:');
  console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  console.error('\nIf this says the password is incorrect, double-check .env.local.');
  process.exit(1);
});
