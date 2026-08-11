import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM encryption for per-user La Belle Vie credentials at rest in the
 * session store. The key comes from LBV_CRED_KEY (32 bytes, hex or base64 —
 * generate with `openssl rand -hex 32`). Rotating the key invalidates every
 * stored connection: decrypt failures surface as "reconnect needed", never as
 * crashes (see connections.ts).
 */

export interface EncryptedPayload {
  iv: string;
  tag: string;
  ciphertext: string;
}

const KEY_BYTES = 32;
const IV_BYTES = 12; // NIST-recommended nonce size for GCM.

// Memoized parsed key, keyed by the raw env value so tests that swap
// LBV_CRED_KEY see the change (same pattern as getDescopeClient in auth.ts).
let cachedKey: Buffer | undefined;
let cachedKeyRaw: string | undefined;

function parseKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');
  const b64 = Buffer.from(trimmed, 'base64');
  if (b64.length === KEY_BYTES) return b64;
  throw new Error(
    'LBV_CRED_KEY must be 32 bytes as hex (64 chars) or base64. Generate one with: openssl rand -hex 32',
  );
}

function getKey(): Buffer {
  const raw = process.env.LBV_CRED_KEY;
  if (!raw) {
    throw new Error('LBV_CRED_KEY is not set. Generate one with: openssl rand -hex 32');
  }
  if (!cachedKey || cachedKeyRaw !== raw) {
    cachedKey = parseKey(raw);
    cachedKeyRaw = raw;
  }
  return cachedKey;
}

/** True when LBV_CRED_KEY is present and well-formed. */
export function hasCredKey(): boolean {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}

export function resetCredKeyCacheForTests(): void {
  cachedKey = undefined;
  cachedKeyRaw = undefined;
}

/** Encrypt a JSON-serializable value. */
export function encrypt<T>(value: T): EncryptedPayload {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

/** Decrypt a payload produced by encrypt(). Throws on a wrong key or tampering. */
export function decrypt<T>(payload: EncryptedPayload): T {
  const decipher = createDecipheriv('aes-256-gcm', getKey(), Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8')) as T;
}
