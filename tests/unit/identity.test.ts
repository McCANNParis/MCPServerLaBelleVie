import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { describe, expect, it } from 'vitest';
import { STATIC_TOKEN_IDENTITY, hashIdentity, identityFor } from '../../src/identity';

function auth(extra?: Record<string, unknown>): AuthInfo {
  return { token: 't', clientId: 'test', scopes: ['groceries'], extra };
}

describe('identityFor', () => {
  it('prefers the OAuth sub claim', () => {
    expect(identityFor(auth({ sub: 'U2abc', email: 'a@b.c' }))).toBe('sub:U2abc');
  });

  it('falls back to the email claim, lowercased', () => {
    expect(identityFor(auth({ email: 'Shopper@Example.com' }))).toBe('email:shopper@example.com');
  });

  it('uses the shared static-token identity when there is no extra (static bearer path)', () => {
    expect(identityFor(auth())).toBe(STATIC_TOKEN_IDENTITY);
    expect(identityFor(undefined)).toBe(STATIC_TOKEN_IDENTITY);
  });

  it('ignores empty or non-string claims', () => {
    expect(identityFor(auth({ sub: '', email: 42 }))).toBe(STATIC_TOKEN_IDENTITY);
  });
});

describe('hashIdentity', () => {
  it('is a stable sha256 hex digest separating distinct identities', () => {
    expect(hashIdentity('sub:a')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashIdentity('sub:a')).toBe(hashIdentity('sub:a'));
    expect(hashIdentity('sub:a')).not.toBe(hashIdentity('sub:b'));
  });
});
