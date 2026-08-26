import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// A fake LbvClient with just the methods the exercised tools call. Defined via
// vi.hoisted so the vi.mock factory below can close over it.
const { fakeClient } = vi.hoisted(() => {
  const cart = {
    itemCount: 1,
    lines: [{ productId: '49135', name: 'Banane BIO', quantity: 1, linePrice: 0.49, source: 'search' }],
    subtotal: 0.49,
    priceToPay: 0.49,
    finalPriceToPay: 0.49,
    credits: 0,
    creditsUsed: 0,
    selectedDay: null,
  };
  return {
    fakeClient: {
      searchProducts: async () => ({
        found: 119,
        page: 1,
        perPage: 10,
        totalPages: 12,
        products: [
          {
            id: '49135',
            name: 'Banane BIO',
            price: 0.49,
            packPrice: null,
            unitPrice: 0.49,
            unitNotation: 'kg',
            brand: null,
            bio: true,
            onSale: false,
            saleRate: null,
            inStock: true,
            stockQuantity: null,
            sellingMethod: null,
            maxQuantityByOrder: null,
            picture: null,
            categoryIds: [74, 547],
            categories: ['Fruits exotiques', 'Fruits BIO'],
          },
        ],
        categoryId: null,
        categoryName: null,
        filteredCount: null,
        scannedCount: null,
      }),
      browseCategories: async () => ({
        mode: 'roots',
        parent: null,
        items: [
          { id: 71, name: 'Primeur', productCount: 208, hasChildren: true },
          { id: 4441, name: 'Epicerie sucrée', productCount: 250, hasChildren: true },
        ],
        totalCount: 59,
        truncated: false,
        hint: 'Pass an id as parentId to see subcategories, or use it as categoryId in search_products.',
      }),
      getCart: async () => cart,
      prepareCheckout: async (postalCode: string) => ({
        cart,
        coverage: {
          covered: true,
          cityName: 'Paris',
          postalCode,
          shippingFee: 3.9,
          freeShippingFrom: 50,
          paidShippingFrom: 25,
        },
        recommendedSlot: {
          key: 'dqp',
          timestamp: null,
          text: 'Dès que possible',
          shortText: null,
          fee: 3.9,
          initialFee: 3.9,
          minFreeFee: 50,
          minPaidFee: 25,
          isSpeed: false,
          isFree: false,
          cashAllowed: false,
          maxDeliveryTime: 265,
          reachesFreeShipping: false,
        },
        availableSlots: [],
        stockWarnings: null,
        basketUrl: 'https://www.labellevie.com/panier',
        paymentExecuted: false,
        notes: ['Payment is not automated: review and pay for the order yourself on labellevie.com.'],
      }),
    },
  };
});

vi.mock('../../src/runtime', () => ({
  withClient: (_identity: string, fn: (c: unknown) => Promise<unknown>) => fn(fakeClient),
}));

// Imported after vi.mock so registerTools binds to the mocked runtime.
const { registerTools } = await import('../../src/tools');

const EXPECTED_TOOLS = [
  'search_products',
  'browse_categories',
  'view_cart',
  'add_to_cart',
  'remove_from_cart',
  'empty_cart',
  'check_postal_coverage',
  'get_delivery_slots',
  'verify_promo',
  'list_recent_orders',
  'get_order_products',
  'list_usual_products',
  'reorder',
  'prepare_checkout',
  'connect_account',
  'connection_status',
  'disconnect_account',
];

async function connect() {
  const server = new McpServer(
    { name: 'labellevie-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  registerTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'contract-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('MCP tool contract', () => {
  let client: Client;
  let tools: Awaited<ReturnType<Client['listTools']>>['tools'];

  beforeAll(async () => {
    client = await connect();
    tools = (await client.listTools()).tools;
  });

  it('exposes exactly the expected tool set', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it('exposes NO tool that places or pays for an order (guardrail)', () => {
    for (const t of tools) {
      expect(t.name).not.toMatch(/pay|place[_-]?order|submit[_-]?order|checkout[_-]?pay/i);
    }
  });

  it('documents that prepare_checkout does not pay', () => {
    const checkout = tools.find((t) => t.name === 'prepare_checkout');
    expect(checkout?.description ?? '').toMatch(/does NOT (place or )?pay/i);
  });

  it('gives every tool a JSON-Schema object input', () => {
    for (const t of tools) {
      expect(t.inputSchema.type).toBe('object');
    }
    const search = tools.find((t) => t.name === 'search_products');
    expect(search?.inputSchema.properties).toHaveProperty('query');
    expect(search?.inputSchema.properties).toHaveProperty('categoryId');
    expect(search?.inputSchema.required).toContain('query');
    expect(search?.inputSchema.required ?? []).not.toContain('categoryId');
    const browse = tools.find((t) => t.name === 'browse_categories');
    expect(browse?.inputSchema.properties).toHaveProperty('parentId');
    expect(browse?.inputSchema.properties).toHaveProperty('query');
    expect(browse?.inputSchema.required ?? []).not.toContain('parentId');
    expect(browse?.inputSchema.required ?? []).not.toContain('query');
    const add = tools.find((t) => t.name === 'add_to_cart');
    expect(add?.inputSchema.properties).toHaveProperty('productId');
  });

  it('search_products returns structured results', async () => {
    const res = await client.callTool({ name: 'search_products', arguments: { query: 'banane' } });
    expect(res.structuredContent).toMatchObject({ found: 119, perPage: 10 });
    expect(res.isError).toBeFalsy();
  });

  it('browse_categories returns the taxonomy listing', async () => {
    const res = await client.callTool({ name: 'browse_categories', arguments: {} });
    expect(res.structuredContent).toMatchObject({ mode: 'roots', totalCount: 59 });
    expect(JSON.stringify(res.content)).toContain('Primeur');
    expect(res.isError).toBeFalsy();
  });

  it('prepare_checkout returns paymentExecuted:false and a non-payment notice', async () => {
    const res = await client.callTool({ name: 'prepare_checkout', arguments: { postalCode: '75011' } });
    expect(res.structuredContent).toMatchObject({ paymentExecuted: false });
    expect(JSON.stringify(res.content)).toContain('Payment is not automated');
  });
});
