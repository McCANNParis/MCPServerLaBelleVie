import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import { getPublicOrigin } from 'mcp-handler';
import { z } from 'zod';
import { deleteConnection, getConnection, hasConnection } from './connections';
import { hasCredKey } from './crypto';
import { identityFor } from './identity';
import { LINK_CODE_TTL_SECONDS } from './lbv/config';
import { LbvApiError, LbvAuthError, LbvNotAuthenticatedError } from './lbv/errors';
import { createLinkCode } from './links';
import { withClient } from './runtime';
import { getSessionStore, sessionKeyFor } from './session';

/** Friendly nudge when an account action is attempted before connecting. */
function notConnected(): CallToolResult {
  return ok(
    'Your La Belle Vie account is not connected yet. Call connect_account to get a one-time secure link — your password is never sent through this chat.',
  );
}

/** Wrap a tool body with the connection gate and consistent error formatting. */
async function runTool(
  requiresAuth: boolean,
  identity: string,
  body: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  if (requiresAuth && !(await hasConnection(identity))) return notConnected();
  try {
    return await body();
  } catch (err) {
    if (err instanceof LbvNotAuthenticatedError) return notConnected();
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

/** One line per order/favorites product: id, name, quantity, price, unit, availability. */
function productLine(p: {
  productId: string;
  name: string | null;
  quantity: number;
  price: number | null;
  unit: string | null;
  available: boolean | null;
}): string {
  const unit = p.unit ? ` / ${p.unit}` : '';
  const availability = p.available === false ? ' — UNAVAILABLE' : '';
  return `• [${p.productId}] ${p.name ?? '(unnamed)'} ×${p.quantity} — ${euro(p.price)}${unit}${availability}`;
}

/** Caller identity for this tool call; falls back to the static-token identity. */
function identityOf(ctx: ServerContext): string {
  return identityFor(ctx.http?.authInfo);
}

/**
 * Public origin of the server as the client actually reached it (localhost in
 * dev, the deployment URL behind Vercel's proxy), so connect links point back
 * at this server. `ctx.http.req` is absent on non-HTTP transports (the
 * in-process tests), where local dev is the only sensible guess.
 */
function originOf(ctx: ServerContext): string {
  const req = ctx.http?.req;
  return req ? getPublicOrigin(req) : 'http://localhost:3000';
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
      inputSchema: z.object({
        query: z.string().min(1).describe('Search keywords, e.g. "banane bio"'),
        page: z.number().int().min(1).optional().describe('1-based page number'),
        perPage: z.number().int().min(1).max(100).optional().describe('Results per page (default 25)'),
        categoryId: z
          .number()
          .int()
          .optional()
          .describe('Category id from browse_categories; keeps only products in it or its subcategories'),
      }),
    },
    async ({ query, page, perPage, categoryId }, ctx) => {
      const identity = identityOf(ctx);
      return runTool(false, identity, async () => {
        const result = await withClient(identity, (c) => c.searchProducts(query, { page, perPage, categoryId }));
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
      });
    },
  );

  server.registerTool(
    'browse_categories',
    {
      title: 'Browse categories',
      description:
        "Explore the store's category taxonomy. No arguments → the top-level aisles (Primeur, Fromagerie, Épicerie…); parentId → that category's subcategories; query → find categories by name (accent-insensitive) with breadcrumb paths. Use a returned id as categoryId in search_products to filter results.",
      inputSchema: z.object({
        parentId: z.number().int().optional().describe('Category id whose subcategories to list'),
        query: z.string().min(1).optional().describe('Find categories by name, e.g. "fromage"'),
      }),
    },
    async ({ parentId, query }, ctx) => {
      const identity = identityOf(ctx);
      return runTool(false, identity, async () => {
        const result = await withClient(identity, (c) => c.browseCategories({ parentId, query }));
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
      });
    },
  );

  server.registerTool(
    'view_cart',
    {
      title: 'View cart',
      description: 'Show the current basket: line items, quantities and totals.',
      inputSchema: z.object({}),
    },
    async (_args, ctx) => {
      const identity = identityOf(ctx);
      return runTool(false, identity, async () => {
        const cart = await withClient(identity, (c) => c.getCart());
        const lines = cart.lines.map((l) => `• ${l.quantity}× [${l.productId}] ${l.name} — ${euro(l.linePrice)}`).join('\n');
        const text =
          `Cart: ${cart.itemCount} item(s), subtotal ${euro(cart.subtotal)} (to pay ${euro(cart.finalPriceToPay ?? cart.priceToPay)}).\n` +
          (lines || '(empty)');
        return ok(text, { ...cart });
      });
    },
  );

  server.registerTool(
    'add_to_cart',
    {
      title: 'Add to cart',
      description: 'Add a product to the basket by product id. Quantity defaults to 1.',
      inputSchema: z.object({
        productId: z.string().describe('Product id from search_products'),
        quantity: z.number().int().min(1).optional().describe('Quantity to add (default 1)'),
      }),
    },
    async ({ productId, quantity }, ctx) => {
      const identity = identityOf(ctx);
      return runTool(false, identity, async () => {
        const cart = await withClient(identity, (c) => c.addToCart(productId, quantity ?? 1));
        return ok(`Added ${quantity ?? 1}× [${productId}]. Cart now has ${cart.itemCount} item(s), subtotal ${euro(cart.subtotal)}.`, {
          ...cart,
        });
      });
    },
  );

  server.registerTool(
    'remove_from_cart',
    {
      title: 'Remove from cart',
      description: 'Remove a product (or reduce its quantity) from the basket by product id.',
      inputSchema: z.object({
        productId: z.string().describe('Product id to remove'),
        quantity: z.number().int().min(1).optional().describe('Quantity to remove (default 1)'),
      }),
    },
    async ({ productId, quantity }, ctx) => {
      const identity = identityOf(ctx);
      return runTool(false, identity, async () => {
        const cart = await withClient(identity, (c) => c.removeFromCart(productId, quantity ?? 1));
        return ok(`Removed ${quantity ?? 1}× [${productId}]. Cart now has ${cart.itemCount} item(s).`, { ...cart });
      });
    },
  );

  server.registerTool(
    'empty_cart',
    {
      title: 'Empty cart',
      description: 'Remove all items from the basket.',
      inputSchema: z.object({}),
    },
    async (_args, ctx) => {
      const identity = identityOf(ctx);
      return runTool(false, identity, async () => {
        const cart = await withClient(identity, (c) => c.emptyCart());
        return ok(`Cart emptied. ${cart.itemCount} item(s) remain.`, { ...cart });
      });
    },
  );

  server.registerTool(
    'check_postal_coverage',
    {
      title: 'Check delivery coverage',
      description: 'Check whether a French postal code is served, with base shipping fee and free-shipping threshold.',
      inputSchema: z.object({ postalCode: z.string().describe('French postal code, e.g. "75011"') }),
    },
    async ({ postalCode }, ctx) => {
      const identity = identityOf(ctx);
      return runTool(false, identity, async () => {
        const coverage = await withClient(identity, (c) => c.getPostalCoverage(postalCode));
        const text = coverage.covered
          ? `${postalCode} (${coverage.cityName ?? '?'}) is served. Shipping ${euro(coverage.shippingFee)}, free from ${euro(coverage.freeShippingFrom)}.`
          : `${postalCode} does not appear to be served.`;
        return ok(text, { ...coverage });
      });
    },
  );

  server.registerTool(
    'get_delivery_slots',
    {
      title: 'Get delivery slots',
      description: 'List available delivery windows for a postal code, with times and fees.',
      inputSchema: z.object({
        postalCode: z.string().describe('French postal code, e.g. "75011"'),
      }),
    },
    async ({ postalCode }, ctx) => {
      const identity = identityOf(ctx);
      return runTool(false, identity, async () => {
        const { slots, deliveryWarning } = await withClient(identity, (c) => c.getSlots(postalCode));
        const lines = slots
          .map((s) => `• [${s.key}] ${s.text} — fee ${euro(s.fee)}${s.isFree ? ' (free)' : ''}`)
          .join('\n');
        const text =
          `${slots.length} delivery slot(s) for ${postalCode}${deliveryWarning ? ` — ${deliveryWarning}` : ''}.\n` +
          (lines || '(none)');
        return ok(text, { slots, deliveryWarning });
      });
    },
  );

  server.registerTool(
    'verify_promo',
    {
      title: 'Verify promo code',
      description: 'Check whether a promo code is valid for the account (requires a connected account).',
      inputSchema: z.object({ code: z.string().min(1).describe('Promo code to verify') }),
    },
    async ({ code }, ctx) => {
      const identity = identityOf(ctx);
      return runTool(true, identity, async () => {
        const result = await withClient(identity, (c) => c.verifyPromo(code));
        const text = result.valid
          ? `Promo "${code}" is valid${result.discount !== null ? ` (discount ${result.discount})` : ''}.`
          : `Promo "${code}" is not valid${result.message ? `: ${result.message}` : ''}.`;
        return ok(text, { ...result });
      });
    },
  );

  server.registerTool(
    'list_recent_orders',
    {
      title: 'List recent orders',
      description:
        "List the account's recent orders (id, date, number of products) — the starting point for rebuilding a basket from past purchases (requires a connected account). Pass an id to get_order_products to see what it contained, or to reorder to add all of it to the basket.",
      inputSchema: z.object({}),
    },
    async (_args, ctx) => {
      const identity = identityOf(ctx);
      return runTool(true, identity, async () => {
        const orders = await withClient(identity, (c) => c.listRecentOrders());
        const lines = orders
          .map((o) => {
            const count = o.itemCount === null ? '' : ` — ${o.itemCount} product(s)`;
            const total = o.total === null ? '' : ` — ${euro(o.total)}`;
            return `• [${o.id}] ${o.date ?? '?'}${count}${total}`;
          })
          .join('\n');
        const hint = orders.length
          ? '\nUse get_order_products <id> to list the items, or reorder <id> to add them all to the basket.'
          : '';
        return ok(`${orders.length} recent order(s).\n` + (lines || '(none)') + hint, { orders });
      });
    },
  );

  server.registerTool(
    'list_usual_products',
    {
      title: 'List usual products',
      description:
        "List the account's most frequently ordered products with id, price, unit and aisle (requires a connected account). Recurring-purchase shortcut: pick ids from here and pass them to add_to_cart or add_to_favorites.",
      inputSchema: z.object({}),
    },
    async (_args, ctx) => {
      const identity = identityOf(ctx);
      return runTool(true, identity, async () => {
        const products = await withClient(identity, (c) => c.listUsualProducts());
        const lines = products
          .map((p) => {
            const unit = p.unit ? ` / ${p.unit}` : '';
            const category = p.category ? ` (${p.category})` : '';
            return `• [${p.productId}] ${p.name ?? '(unnamed)'} — ${euro(p.price)}${unit}${category}`;
          })
          .join('\n');
        return ok(`${products.length} usual product(s).\n` + (lines || '(none)'), { products });
      });
    },
  );

  server.registerTool(
    'reorder',
    {
      title: 'Reorder a past order',
      description:
        'Add every product from a past order into the current basket (requires a connected account). Use list_recent_orders to find an order id, and get_order_products to preview its items first. Does not place or pay for the order.',
      inputSchema: z.object({ orderId: z.string().describe('Order id from list_recent_orders') }),
    },
    async ({ orderId }, ctx) => {
      const identity = identityOf(ctx);
      return runTool(true, identity, async () => {
        const result = await withClient(identity, (c) => c.reorder(orderId));
        const text =
          `Reordered order ${orderId}: added ${result.added.length}/${result.requested.length} product(s)` +
          (result.failed.length ? `, ${result.failed.length} failed` : '') +
          `. Cart subtotal ${euro(result.cart.subtotal)}.`;
        return ok(text, { ...result });
      });
    },
  );

  server.registerTool(
    'get_order_products',
    {
      title: 'Get the products of a past order',
      description:
        'List every product of one past order with quantity, current price, unit and whether it can still be ordered (requires a connected account). Use list_recent_orders to find the order id, then add_to_cart for the products you want — or reorder to take the whole order.',
      inputSchema: z.object({
        orderId: z.string().min(1).describe('Order id from list_recent_orders'),
      }),
    },
    async ({ orderId }, ctx) => {
      const identity = identityOf(ctx);
      return runTool(true, identity, async () => {
        const order = await withClient(identity, (c) => c.getOrder(orderId));
        const unavailableCount = order.products.filter((p) => p.available === false).length;
        const header =
          `Order ${order.id || orderId}` +
          (order.status ? ` (${order.status})` : '') +
          (order.orderedAt ? `, ordered ${order.orderedAt}` : '') +
          ` — ${order.products.length} product(s)` +
          (unavailableCount ? `, ${unavailableCount} currently unavailable` : '') +
          `, total ${euro(order.total)}.`;
        const lines = order.products.map(productLine).join('\n');
        return ok(`${header}\n` + (lines || '(no products)'), {
          orderId: order.id || orderId,
          status: order.status,
          orderedAt: order.orderedAt,
          deliveredAt: order.deliveredAt,
          total: order.total,
          count: order.products.length,
          unavailableCount,
          products: order.products,
        });
      });
    },
  );

  server.registerTool(
    'list_favorites',
    {
      title: 'List favorites lists',
      description:
        "List the account's favorites lists (the site's \"listes favoris\") with their products: id, name, price, unit and availability (requires a connected account). Recurring-purchase shortcut: pass product ids to add_to_cart. Pass listId to expand a single list.",
      inputSchema: z.object({
        listId: z.string().min(1).optional().describe('Only this favorites list (id from a previous call)'),
      }),
    },
    async ({ listId }, ctx) => {
      const identity = identityOf(ctx);
      return runTool(true, identity, async () => {
        const result = await withClient(identity, (c) => c.listFavorites({ listId }));
        const sections = result.lists.map((l) => {
          const lines = l.products.map(productLine).join('\n');
          return `## ${l.name} (id ${l.id}) — ${l.products.length} product(s)\n` + (lines || '(empty)');
        });
        const text =
          `${result.lists.length} favorites list(s).\n` +
          (sections.join('\n\n') || '(none) — add_to_favorites creates one.') +
          (result.truncated ? '\n(More lists exist; pass listId to expand a specific one.)' : '');
        return ok(text, {
          lists: result.lists.map((l) => ({
            id: l.id,
            name: l.name,
            type: l.type,
            productCount: l.products.length,
            products: l.products,
          })),
          truncated: result.truncated,
        });
      });
    },
  );

  server.registerTool(
    'add_to_favorites',
    {
      title: 'Add a product to favorites',
      description:
        "Add a product to one of the account's favorites lists (requires a connected account). With neither listId nor listName the account's only list is used (created as \"Mes favoris\" if there is none); listName finds or creates a list by name. Adding a product that is already on the list is a no-op. Does not touch the basket.",
      inputSchema: z.object({
        productId: z.string().min(1).describe('Product id from search_products, list_usual_products or get_order_products'),
        listId: z.string().min(1).optional().describe('Favorites list id from list_favorites'),
        listName: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe('Favorites list name; created when no list with that name exists'),
      }),
    },
    async ({ productId, listId, listName }, ctx) => {
      const identity = identityOf(ctx);
      return runTool(true, identity, async () => {
        const result = await withClient(identity, (c) => c.addToFavorites(productId, { listId, listName }));
        const target = `favorites list "${result.list.name}" (id ${result.list.id})`;
        const text =
          (result.alreadyPresent
            ? `Product ${result.productId} was already on ${target}; nothing changed.`
            : `Added product ${result.productId} to ${target}${result.created ? ' (list created)' : ''}.`) +
          ` The list now has ${result.products.length} product(s).`;
        return ok(text, {
          productId: result.productId,
          list: { id: result.list.id, name: result.list.name },
          created: result.created,
          alreadyPresent: result.alreadyPresent,
          productCount: result.products.length,
          products: result.products,
        });
      });
    },
  );

  server.registerTool(
    'remove_from_favorites',
    {
      title: 'Remove a product from favorites',
      description:
        'Remove a product from a favorites list (requires a connected account). Without listId the product is removed from every list it is on. Removing a product that is on no list is a no-op. Does not touch the basket.',
      inputSchema: z.object({
        productId: z.string().min(1).describe('Product id to remove'),
        listId: z.string().min(1).optional().describe('Favorites list id from list_favorites; omit for all lists'),
      }),
    },
    async ({ productId, listId }, ctx) => {
      const identity = identityOf(ctx);
      return runTool(true, identity, async () => {
        const result = await withClient(identity, (c) => c.removeFromFavorites(productId, { listId }));
        const names = result.removedFrom.map((l) => `"${l.name}" (id ${l.id})`).join(', ');
        const text = result.removedFrom.length
          ? `Removed product ${result.productId} from ${names}.`
          : `Product ${result.productId} was not on ${listId ? `favorites list ${listId}` : 'any favorites list'}; nothing changed.`;
        return ok(text, {
          productId: result.productId,
          removedFrom: result.removedFrom.map((l) => ({ id: l.id, name: l.name })),
        });
      });
    },
  );

  server.registerTool(
    'prepare_checkout',
    {
      title: 'Prepare checkout (ready-to-pay summary)',
      description:
        'Assemble a ready-to-pay summary for the current basket: totals, delivery coverage, a recommended delivery slot and a stock check, plus the basket URL. IMPORTANT: this does NOT place or pay for the order — the user completes payment themselves on labellevie.com.',
      inputSchema: z.object({
        postalCode: z.string().describe('Delivery postal code, e.g. "75011"'),
        slotKey: z.string().optional().describe('Preferred delivery slot key from get_delivery_slots'),
      }),
    },
    async ({ postalCode, slotKey }, ctx) => {
      const identity = identityOf(ctx);
      return runTool(false, identity, async () => {
        const s = await withClient(identity, (c) => c.prepareCheckout(postalCode, slotKey));
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
      });
    },
  );

  server.registerTool(
    'connect_account',
    {
      title: 'Connect your La Belle Vie account',
      description:
        'Get a one-time secure link to a login page where you enter your La Belle Vie email and password yourself — credentials never pass through this chat. The link is short-lived and single-use. Completing it replaces any previously connected account.',
      inputSchema: z.object({}),
    },
    async (_args, ctx) => {
      const identity = identityOf(ctx);
      return runTool(false, identity, async () => {
        if (!hasCredKey()) {
          return fail(
            'The server cannot store account connections: LBV_CRED_KEY is not configured. Ask the server operator to set it (generate with: openssl rand -hex 32) and redeploy.',
          );
        }
        const existing = await getConnection(identity);
        const { code, expiresAt } = await createLinkCode(identity);
        const url = `${originOf(ctx)}/connect/${code}`;
        const lines = [
          'Open this link to connect your La Belle Vie account:',
          '',
          url,
          '',
          `It expires in ${Math.round(LINK_CODE_TTL_SECONDS / 60)} minutes and works once. Your password is entered on that page directly — it is never sent through this chat.`,
        ];
        if (existing) {
          lines.push(`Note: completing it will replace the currently connected account (${existing.lbvEmail}).`);
        }
        return ok(lines.join('\n'), { url, expiresAt });
      });
    },
  );

  server.registerTool(
    'connection_status',
    {
      title: 'Connection status',
      description: 'Show whether a La Belle Vie account is connected for this caller, and which one.',
      inputSchema: z.object({}),
    },
    async (_args, ctx) => {
      const identity = identityOf(ctx);
      return runTool(false, identity, async () => {
        const connection = await getConnection(identity);
        if (!connection) {
          return ok(
            'No La Belle Vie account is connected. Call connect_account to get a one-time secure link.',
            { connected: false },
          );
        }
        const since = new Date(connection.connectedAt).toISOString().slice(0, 10);
        return ok(`Connected as ${connection.lbvEmail} since ${since}.`, {
          connected: true,
          lbvEmail: connection.lbvEmail,
          connectedAt: connection.connectedAt,
          lastUsedAt: connection.lastUsedAt,
        });
      });
    },
  );

  server.registerTool(
    'disconnect_account',
    {
      title: 'Disconnect account',
      description:
        'Disconnect the La Belle Vie account for this caller and delete its stored (encrypted) credentials and session.',
      inputSchema: z.object({}),
    },
    async (_args, ctx) => {
      const identity = identityOf(ctx);
      return runTool(false, identity, async () => {
        const existed = await deleteConnection(identity);
        await getSessionStore().clear(sessionKeyFor(identity));
        return ok(
          existed
            ? 'Your La Belle Vie account has been disconnected and its stored credentials deleted.'
            : 'No La Belle Vie account was connected.',
          { disconnected: existed },
        );
      });
    },
  );
}
