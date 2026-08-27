import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionRecord } from '../../src/connections';
import { saveConnection } from '../../src/connections';
import { resetCredKeyCacheForTests } from '../../src/crypto';
import { STATIC_TOKEN_IDENTITY } from '../../src/identity';
import { setSessionStore } from '../../src/session';

const { state } = vi.hoisted(() => ({
  state: { mode: 'ok' as 'ok' | 'not-authenticated' },
}));

// Real connections/links/session modules run against the in-memory store; only
// the LBV transport is replaced so no network is touched.
vi.mock('../../src/runtime', async () => {
  const { LbvNotAuthenticatedError } = await import('../../src/lbv/errors');
  const fakeClient = {
    listRecentOrders: async () => [],
    listFavorites: async () => ({ lists: [], truncated: false }),
    getCart: async () => ({
      itemCount: 0,
      lines: [],
      subtotal: 0,
      priceToPay: 0,
      finalPriceToPay: 0,
    }),
  };
  return {
    withClient: async (_identity: string, fn: (c: unknown) => Promise<unknown>) => {
      if (state.mode === 'not-authenticated') throw new LbvNotAuthenticatedError();
      return fn(fakeClient);
    },
  };
});

const { registerTools } = await import('../../src/tools');

const ENV_VARS = [
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'LBV_CRED_KEY',
];

const NUDGE = /not connected yet.*connect_account/i;

function dummyRecord(): ConnectionRecord {
  return {
    lbvEmail: 'shopper@example.com',
    creds: { iv: 'aa', tag: 'bb', ciphertext: 'cc' },
    jar: { cookies: [] },
    connectedAt: 1700000000000,
    lastUsedAt: 1700000000000,
  };
}

async function connect(): Promise<Client> {
  const server = new McpServer(
    { name: 'labellevie-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  registerTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'gate-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(res: Awaited<ReturnType<Client['callTool']>>): string {
  return JSON.stringify(res.content);
}

describe('per-identity connection gate', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_VARS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    resetCredKeyCacheForTests();
    setSessionStore(null);
    state.mode = 'ok';
  });

  afterEach(() => {
    for (const k of ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetCredKeyCacheForTests();
    setSessionStore(null);
  });

  it('auth-gated tool nudges toward connect_account when nothing is connected (not an error)', async () => {
    const client = await connect();
    const res = await client.callTool({ name: 'list_recent_orders', arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(NUDGE);
  });

  it('auth-gated tool proceeds once a connection exists for the caller identity', async () => {
    await saveConnection(STATIC_TOKEN_IDENTITY, dummyRecord());
    const client = await connect();
    const res = await client.callTool({ name: 'list_recent_orders', arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('0 recent order(s)');
  });

  it('non-auth tools work without any connection', async () => {
    const client = await connect();
    const res = await client.callTool({ name: 'view_cart', arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('Cart: 0 item(s)');
  });

  it('maps LbvNotAuthenticatedError from the body to the same friendly nudge', async () => {
    await saveConnection(STATIC_TOKEN_IDENTITY, dummyRecord());
    state.mode = 'not-authenticated';
    const client = await connect();
    const res = await client.callTool({ name: 'list_recent_orders', arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(NUDGE);
  });

  it('list_favorites is gated the same way: nudge without a connection, nudge on a stale session', async () => {
    let client = await connect();
    let res = await client.callTool({ name: 'list_favorites', arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(NUDGE);

    await saveConnection(STATIC_TOKEN_IDENTITY, dummyRecord());
    client = await connect();
    res = await client.callTool({ name: 'list_favorites', arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('0 favorites list(s)');

    state.mode = 'not-authenticated';
    client = await connect();
    res = await client.callTool({ name: 'list_favorites', arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(NUDGE);
  });

  it('connect_account explains the misconfiguration when LBV_CRED_KEY is missing', async () => {
    const client = await connect();
    const res = await client.callTool({ name: 'connect_account', arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('LBV_CRED_KEY');
  });

  it('connect_account returns a one-time link on this server', async () => {
    process.env.LBV_CRED_KEY = 'a'.repeat(64);
    resetCredKeyCacheForTests();
    const client = await connect();
    const res = await client.callTool({ name: 'connect_account', arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/http.*\/connect\/[A-Za-z0-9_-]{20,}/);
    expect(textOf(res)).toContain('10 minutes');
  });

  it('connection_status and disconnect_account follow the lifecycle', async () => {
    const client = await connect();

    let res = await client.callTool({ name: 'connection_status', arguments: {} });
    expect(textOf(res)).toContain('No La Belle Vie account is connected');

    await saveConnection(STATIC_TOKEN_IDENTITY, dummyRecord());
    res = await client.callTool({ name: 'connection_status', arguments: {} });
    expect(textOf(res)).toContain('Connected as shopper@example.com');

    res = await client.callTool({ name: 'disconnect_account', arguments: {} });
    expect(textOf(res)).toContain('disconnected');

    res = await client.callTool({ name: 'connection_status', arguments: {} });
    expect(textOf(res)).toContain('No La Belle Vie account is connected');
  });
});
