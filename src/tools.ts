import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { LbvApiError, LbvAuthError } from './lbv/errors';
import { hasCredentials, withClient } from './runtime';

/** Wrap a tool body with consistent error formatting. */
async function runTool(
  requiresAuth: boolean,
  body: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  if (requiresAuth && !hasCredentials()) {
    return fail(
      'This action requires a logged-in account, but LBV_EMAIL / LBV_PASSWORD are not configured on the server.',
    );
  }
  try {
    return await body();
  } catch (err) {
    if (err instanceof LbvAuthError) return fail(`Login failed: ${err.message}`);
    if (err instanceof LbvApiError) return fail(`La Belle Vie API error (${err.status}): ${err.message}`);
    return fail(err instanceof Error ? err.message : String(err));
  }
}

function ok(text: string, structuredContent?: Record<string, unknown>): CallToolResult {
  return structuredContent
    ? { content: [{ type: 'text', text }], structuredContent }
    : { content: [{ type: 'text', text }] };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

function euro(v: number | null): string {
  return v === null ? '—' : `€${v.toFixed(2)}`;
}

/**
 * Register every La Belle Vie tool on the MCP server. There is intentionally
 * no tool that places or pays for an order — automation stops at a ready cart.
 */
export function registerTools(server: McpServer): void {
  server.registerTool(
    'search_products',
    {
      title: 'Search products',
      description:
        'Search the La Belle Vie catalog by keyword. Returns matching products with id, name, price, unit, stock, sale info and category names. Use the returned product id with add_to_cart. Keyword search can conflate meanings (e.g. "banane" returns fresh bananas AND banana-flavored candy) — pass a categoryId from browse_categories to keep only products in that category (and its subcategories).',
      inputSchema: {
        query: z.string().min(1).describe('Search keywords, e.g. "banane bio"'),
        page: z.number().int().min(1).optional().describe('1-based page number'),
        perPage: z.number().int().min(1).max(100).optional().describe('Results per page (default 25)'),
        categoryId: z
          .number()
          .int()
          .optional()
          .describe('Category id from browse_categories; keeps only products in it or its subcategories'),
      },
    },
    async ({ query, page, perPage, categoryId }) =>
      runTool(false, async () => {
        const result = await withClient((c) => c.searchProducts(query, { page, perPage, categoryId }));
        const lines = result.products
          .slice(0, 25)
          .map(
            (p) =>
              `• [${p.id}] ${p.name} — ${euro(p.price)}${p.bio ? ' (bio)' : ''}${
                p.inStock ? '' : ' — OUT OF STOCK'
              }${p.categories.length ? ` — ${p.categories.join(', ')}` : ''}`,
          )
          .join('\n');
        let text = `Found ${result.found} product(s) for "${query}" (page ${result.page}/${result.totalPages}).`;
        if (result.categoryId !== null) {
          text += `\nFiltered to "${result.categoryName}" [${result.categoryId}]: ${result.filteredCount}/${result.scannedCount} scanned product(s) matched.`;
          if (result.filteredCount === 0) {
            text +=
              ' The gateway paginates before this filter — try a later page, drop categoryId, or pick another category via browse_categories.';
          }
        }
        text += '\n' + (lines || '(no products)');
        return ok(text, { ...result });
      }),
  );

  server.registerTool(
    'browse_categories',
    {
      title: 'Browse categories',
      description:
        "Explore the store's category taxonomy. No arguments → the top-level aisles (Primeur, Fromagerie, Épicerie…); parentId → that category's subcategories; query → find categories by name (accent-insensitive) with breadcrumb paths. Use a returned id as categoryId in search_products to filter results.",
      inputSchema: {
        parentId: z.number().int().optional().describe('Category id whose subcategories to list'),
        query: z.string().min(1).optional().describe('Find categories by name, e.g. "fromage"'),
      },
    },
    async ({ parentId, query }) =>
      runTool(false, async () => {
        const result = await withClient((c) => c.browseCategories({ parentId, query }));
        const title =
          result.mode === 'roots'
            ? `${result.totalCount} top-level categorie(s).`
            : result.mode === 'children'
              ? `${result.totalCount} subcategorie(s) of "${result.parent?.name}" [${result.parent?.id}].`
              : `${result.totalCount} categorie(s) matching "${query}".`;
        const lines = result.items
          .map((i) => {
            const path = i.path && i.path.length > 1 ? ` — ${i.path.join(' > ')}` : '';
            return `• [${i.id}] ${i.name} — ${i.productCount} product(s)${
              i.hasChildren ? ' (has subcategories)' : ''
            }${path}`;
          })
          .join('\n');
        const text =
          title +
          (result.truncated ? ` Showing the first ${result.items.length}.` : '') +
          '\n' +
          (lines || '(none)') +
          `\n${result.hint}`;
        return ok(text, { ...result });
      }),
  );

  server.registerTool(
    'view_cart',
    {
      title: 'View cart',
      description: 'Show the current basket: line items, quantities and totals.',
      inputSchema: {},
    },
    async () =>
      runTool(false, async () => {
        const cart = await withClient((c) => c.getCart());
        const lines = cart.lines.map((l) => `• ${l.quantity}× [${l.productId}] ${l.name} — ${euro(l.linePrice)}`).join('\n');
        const text =
          `Cart: ${cart.itemCount} item(s), subtotal ${euro(cart.subtotal)} (to pay ${euro(cart.finalPriceToPay ?? cart.priceToPay)}).\n` +
          (lines || '(empty)');
        return ok(text, { ...cart });
      }),
  );

  server.registerTool(
    'add_to_cart',
    {
      title: 'Add to cart',
      description: 'Add a product to the basket by product id. Quantity defaults to 1.',
      inputSchema: {
        productId: z.string().describe('Product id from search_products'),
        quantity: z.number().int().min(1).optional().describe('Quantity to add (default 1)'),
      },
    },
    async ({ productId, quantity }) =>
      runTool(false, async () => {
        const cart = await withClient((c) => c.addToCart(productId, quantity ?? 1));
        return ok(`Added ${quantity ?? 1}× [${productId}]. Cart now has ${cart.itemCount} item(s), subtotal ${euro(cart.subtotal)}.`, {
          ...cart,
        });
      }),
  );

  server.registerTool(
    'remove_from_cart',
    {
      title: 'Remove from cart',
      description: 'Remove a product (or reduce its quantity) from the basket by product id.',
      inputSchema: {
        productId: z.string().describe('Product id to remove'),
        quantity: z.number().int().min(1).optional().describe('Quantity to remove (default 1)'),
      },
    },
    async ({ productId, quantity }) =>
      runTool(false, async () => {
        const cart = await withClient((c) => c.removeFromCart(productId, quantity ?? 1));
        return ok(`Removed ${quantity ?? 1}× [${productId}]. Cart now has ${cart.itemCount} item(s).`, { ...cart });
      }),
  );

  server.registerTool(
    'empty_cart',
    {
      title: 'Empty cart',
      description: 'Remove all items from the basket.',
      inputSchema: {},
    },
    async () =>
      runTool(false, async () => {
        const cart = await withClient((c) => c.emptyCart());
        return ok(`Cart emptied. ${cart.itemCount} item(s) remain.`, { ...cart });
      }),
  );

  server.registerTool(
    'check_postal_coverage',
    {
      title: 'Check delivery coverage',
      description: 'Check whether a French postal code is served, with base shipping fee and free-shipping threshold.',
      inputSchema: { postalCode: z.string().describe('French postal code, e.g. "75011"') },
    },
    async ({ postalCode }) =>
      runTool(false, async () => {
        const coverage = await withClient((c) => c.getPostalCoverage(postalCode));
        const text = coverage.covered
          ? `${postalCode} (${coverage.cityName ?? '?'}) is served. Shipping ${euro(coverage.shippingFee)}, free from ${euro(coverage.freeShippingFrom)}.`
          : `${postalCode} does not appear to be served.`;
        return ok(text, { ...coverage });
      }),
  );

  server.registerTool(
    'get_delivery_slots',
    {
      title: 'Get delivery slots',
      description: 'List available delivery windows for a postal code, with times and fees.',
      inputSchema: {
        postalCode: z.string().describe('French postal code, e.g. "75011"'),
      },
    },
    async ({ postalCode }) =>
      runTool(false, async () => {
        const { slots, deliveryWarning } = await withClient((c) => c.getSlots(postalCode));
        const lines = slots
          .map((s) => `• [${s.key}] ${s.text} — fee ${euro(s.fee)}${s.isFree ? ' (free)' : ''}`)
          .join('\n');
        const text =
          `${slots.length} delivery slot(s) for ${postalCode}${deliveryWarning ? ` — ${deliveryWarning}` : ''}.\n` +
          (lines || '(none)');
        return ok(text, { slots, deliveryWarning });
      }),
  );

  server.registerTool(
    'verify_promo',
    {
      title: 'Verify promo code',
      description: 'Check whether a promo code is valid for the account (requires login).',
      inputSchema: { code: z.string().min(1).describe('Promo code to verify') },
    },
    async ({ code }) =>
      runTool(true, async () => {
        const result = await withClient((c) => c.verifyPromo(code));
        const text = result.valid
          ? `Promo "${code}" is valid${result.discount !== null ? ` (discount ${result.discount})` : ''}.`
          : `Promo "${code}" is not valid${result.message ? `: ${result.message}` : ''}.`;
        return ok(text, { ...result });
      }),
  );

  server.registerTool(
    'list_recent_orders',
    {
      title: 'List recent orders',
      description: 'List the account\'s recent orders (ids + dates + totals) to use as reorder sources (requires login).',
      inputSchema: {},
    },
    async () =>
      runTool(true, async () => {
        const orders = await withClient((c) => c.listRecentOrders());
        const lines = orders.map((o) => `• [${o.id}] ${o.date ?? '?'} — ${euro(o.total)}`).join('\n');
        return ok(`${orders.length} recent order(s).\n` + (lines || '(none)'), { orders });
      }),
  );

  server.registerTool(
    'list_usual_products',
    {
      title: 'List usual products',
      description: 'List the account\'s most frequently ordered products (requires login).',
      inputSchema: {},
    },
    async () =>
      runTool(true, async () => {
        const products = await withClient((c) => c.listUsualProducts());
        const lines = products.map((p) => `• [${p.productId}] ${p.name ?? ''} (usual qty ${p.quantity})`).join('\n');
        return ok(`${products.length} usual product(s).\n` + (lines || '(none)'), { products });
      }),
  );

  server.registerTool(
    'reorder',
    {
      title: 'Reorder a past order',
      description:
        'Add every product from a past order into the current basket (requires login). Use list_recent_orders to find an order id. Does not place or pay for the order.',
      inputSchema: { orderId: z.string().describe('Order id from list_recent_orders') },
    },
    async ({ orderId }) =>
      runTool(true, async () => {
        const result = await withClient((c) => c.reorder(orderId));
        const text =
          `Reordered order ${orderId}: added ${result.added.length}/${result.requested.length} product(s)` +
          (result.failed.length ? `, ${result.failed.length} failed` : '') +
          `. Cart subtotal ${euro(result.cart.subtotal)}.`;
        return ok(text, { ...result });
      }),
  );

  server.registerTool(
    'prepare_checkout',
    {
      title: 'Prepare checkout (ready-to-pay summary)',
      description:
        'Assemble a ready-to-pay summary for the current basket: totals, delivery coverage, a recommended delivery slot and a stock check, plus the basket URL. IMPORTANT: this does NOT place or pay for the order — the user completes payment themselves on labellevie.com.',
      inputSchema: {
        postalCode: z.string().describe('Delivery postal code, e.g. "75011"'),
        slotKey: z.string().optional().describe('Preferred delivery slot key from get_delivery_slots'),
      },
    },
    async ({ postalCode, slotKey }) =>
      runTool(false, async () => {
        const s = await withClient((c) => c.prepareCheckout(postalCode, slotKey));
        const slot = s.recommendedSlot
          ? `${s.recommendedSlot.text} (fee ${euro(s.recommendedSlot.fee)}${s.recommendedSlot.reachesFreeShipping ? ', qualifies for free delivery' : ''})`
          : 'none available';
        const text = [
          `Ready-to-pay summary:`,
          `• Items: ${s.cart.itemCount}, subtotal ${euro(s.cart.subtotal)} (to pay ${euro(s.cart.finalPriceToPay ?? s.cart.priceToPay)})`,
          `• Delivery to ${postalCode}: ${s.coverage.covered ? 'served' : 'NOT served'}`,
          `• Recommended slot: ${slot}`,
          `• Basket: ${s.basketUrl}`,
          ...s.notes.map((n) => `• ${n}`),
        ].join('\n');
        return ok(text, { ...s });
      }),
  );
}
