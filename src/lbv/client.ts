import { LbvHttp, type Credentials, type LbvHttpOptions } from './http';
import {
  buildSearchUrl,
  filterByCategoryIds,
  parseSearchResults,
  type SearchOptions,
  type SearchResult,
} from './search';
import {
  MAX_CATEGORY_LIST,
  MAX_CATEGORY_MATCHES,
  descendantIdSet,
  findByName,
  getCategoryTree as loadCategoryTree,
  getChildren,
  pathTo,
  peekCategoryTree,
  resolveNames,
  type CategoryNode,
  type CategoryTree,
} from './categories';
import { buildCartPayload, parseCart, type Cart } from './cart';
import {
  buildPostalInfoPath,
  buildSlotsPath,
  parsePostalCoverage,
  parseSlots,
  type DeliverySlot,
  type PostalCoverage,
  type SlotsResult,
} from './slots';
import { parsePromo, type PromoResult } from './promo';
import {
  RECENT_ORDERS_PATH,
  USUAL_PRODUCTS_PATH,
  buildOrderProductsPath,
  looksLikeJson,
  parseOrderDetail,
  parseOrderList,
  parseOrderListHtml,
  parseOrderProducts,
  parseUsualProductsHtml,
  type OrderDetail,
  type OrderProduct,
  type OrderSummary,
  type UsualProduct,
} from './orders';
import {
  DEFAULT_FAVORITE_LIST_NAME,
  FAVORITES_API_PATH,
  MAX_FAVORITE_LISTS_EXPANDED,
  buildCreateListPayload,
  buildFavoriteListPath,
  buildFavoriteListProductPath,
  buildFavoriteListProductsPath,
  buildFavoriteProductPayload,
  describeLists,
  findListByName,
  parseFavoriteListProducts,
  parseFavoriteLists,
  type FavoriteList,
  type FavoriteListWithProducts,
  type FavoriteProduct,
} from './favorites';
import {
  ADDRESSES_PATH,
  FULL_PROFILE_PATH,
  parseAddresses,
  parseProfile,
  type Address,
  type Profile,
} from './profile';

export interface CategorySummary {
  id: number;
  name: string;
  productCount: number;
  hasChildren: boolean;
  /** Root-first breadcrumb; present on search matches and browse parents. */
  path?: string[];
}

export interface BrowseCategoriesResult {
  mode: 'roots' | 'children' | 'search';
  parent: CategorySummary | null;
  items: CategorySummary[];
  /** True number of roots/children/matches, even when items is capped. */
  totalCount: number;
  truncated: boolean;
  hint: string;
}

export interface ReorderResult {
  orderId: string;
  requested: OrderProduct[];
  added: { productId: string; name: string | null; quantity: number }[];
  failed: { productId: string; name: string | null; reason: string }[];
  cart: Cart;
}

export interface ListFavoritesResult {
  lists: FavoriteListWithProducts[];
  /** True when more lists exist than MAX_FAVORITE_LISTS_EXPANDED. */
  truncated: boolean;
}

export interface AddToFavoritesResult {
  productId: string;
  list: FavoriteList;
  /** The list was created by this call (named list not found, or no list yet). */
  created: boolean;
  /** The product was already on the list; nothing was sent. */
  alreadyPresent: boolean;
  /** The list's products after the change, re-read from the site. */
  products: FavoriteProduct[];
}

export interface RemoveFromFavoritesResult {
  productId: string;
  /** Empty when the product was on none of the targeted lists. */
  removedFrom: FavoriteList[];
}

export interface CheckoutSlotChoice extends DeliverySlot {
  reachesFreeShipping: boolean;
}

export interface CheckoutSummary {
  cart: Cart;
  coverage: PostalCoverage;
  recommendedSlot: CheckoutSlotChoice | null;
  availableSlots: DeliverySlot[];
  stockWarnings: unknown;
  basketUrl: string;
  /** Always false — this tool never places or pays for an order. */
  paymentExecuted: false;
  notes: string[];
}

function requireList(lists: FavoriteList[], listId: string): FavoriteList {
  const list = lists.find((l) => l.id === String(listId));
  if (!list) {
    throw new Error(`Unknown favorites list ${listId}; existing lists: ${describeLists(lists)}`);
  }
  return list;
}

/**
 * High-level La Belle Vie client. Wraps the HTTP transport and the per-domain
 * parsers into agent-friendly operations. Everything stops at a ready-to-pay
 * cart; there is intentionally no method that places or pays for an order.
 */
export class LbvClient {
  readonly http: LbvHttp;

  constructor(opts: LbvHttpOptions = {}) {
    this.http = new LbvHttp(opts);
  }

  static withCredentials(credentials: Credentials, opts: LbvHttpOptions = {}): LbvClient {
    return new LbvClient({ ...opts, credentials });
  }

  // --- Search & catalog (public) ------------------------------------------
  async searchProducts(query: string, opts: SearchOptions = {}): Promise<SearchResult> {
    const url = buildSearchUrl(query, opts);
    const json = await this.http.getJson<Record<string, unknown>>(url, { xhr: false, accept: 'application/json' });
    const result = parseSearchResults(json);

    if (opts.categoryId === undefined) {
      // Plain search must stay fast: enrich names only if a tree is already
      // cached — never wait on the taxonomy fetch here.
      const tree = peekCategoryTree();
      if (tree) {
        for (const p of result.products) p.categories = resolveNames(tree, p.categoryIds);
      }
      return result;
    }

    const tree = await this.getCategoryTree();
    const node = tree.byId.get(opts.categoryId);
    if (!node) {
      throw new Error(
        `Unknown categoryId ${opts.categoryId}. Call browse_categories to find valid category ids.`,
      );
    }
    // The gateway paginates BEFORE our filter, so a page can legitimately
    // come back empty even when `found` is large.
    result.scannedCount = result.products.length;
    result.products = filterByCategoryIds(result.products, descendantIdSet(tree, node.id));
    result.filteredCount = result.products.length;
    result.categoryId = node.id;
    result.categoryName = node.name;
    for (const p of result.products) p.categories = resolveNames(tree, p.categoryIds);
    return result;
  }

  /** Load (or reuse) the cached category taxonomy. */
  async getCategoryTree(forceRefresh = false): Promise<CategoryTree> {
    try {
      return await loadCategoryTree(this.http, { forceRefresh });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not load the category taxonomy (${detail}). You can still use search_products without categoryId.`,
        { cause: err },
      );
    }
  }

  /**
   * Browse the store's category taxonomy: no args → top-level aisles;
   * parentId → its subcategories; query → name search with breadcrumbs.
   */
  async browseCategories(
    opts: { parentId?: number; query?: string } = {},
  ): Promise<BrowseCategoriesResult> {
    const tree = await this.getCategoryTree();
    const summarize = (n: CategoryNode, withPath = false): CategorySummary => ({
      id: n.id,
      name: n.name,
      productCount: n.productCount,
      hasChildren: n.hasChildren,
      ...(withPath ? { path: pathTo(tree, n.id) } : {}),
    });

    if (opts.query !== undefined && opts.query.trim() !== '') {
      const matches = findByName(tree, opts.query);
      const items = matches
        .slice(0, MAX_CATEGORY_MATCHES)
        .map((m) => ({ ...summarize(m), path: m.path }));
      return {
        mode: 'search',
        parent: null,
        items,
        totalCount: matches.length,
        truncated: matches.length > items.length,
        hint: 'Use a match id as categoryId in search_products, or as parentId here to browse its subcategories.',
      };
    }

    if (opts.parentId !== undefined) {
      const parent = tree.byId.get(opts.parentId);
      if (!parent) {
        throw new Error(
          `Unknown category id ${opts.parentId}. Call browse_categories with no arguments to list top-level categories.`,
        );
      }
      const children = getChildren(tree, parent.id);
      const items = children.slice(0, MAX_CATEGORY_LIST).map((c) => summarize(c));
      return {
        mode: 'children',
        parent: summarize(parent, true),
        items,
        totalCount: children.length,
        truncated: children.length > items.length,
        hint:
          children.length === 0
            ? 'This category has no subcategories — use its id as categoryId in search_products.'
            : 'Use an id as categoryId in search_products, or as parentId here to go deeper.',
      };
    }

    const roots = getChildren(tree, null);
    const items = roots.slice(0, MAX_CATEGORY_LIST).map((c) => summarize(c));
    return {
      mode: 'roots',
      parent: null,
      items,
      totalCount: roots.length,
      truncated: roots.length > items.length,
      hint: 'Pass an id as parentId to see subcategories, or use it as categoryId in search_products.',
    };
  }

  // --- Cart (works anonymously; auto-logs-in if credentials are set) -------
  async getCart(): Promise<Cart> {
    const json = await this.http.getJson<Record<string, unknown>>('/api/panier?from_cache=0');
    return parseCart(json);
  }

  async addToCart(productId: string | number, quantity = 1, source?: string): Promise<Cart> {
    const json = await this.http.postJson<Record<string, unknown>>(
      '/api/panier',
      buildCartPayload({ productId, quantity, source }),
    );
    return parseCart(json);
  }

  async removeFromCart(productId: string | number, quantity = 1, source?: string): Promise<Cart> {
    const json = await this.http.deleteJson<Record<string, unknown>>(
      '/api/panier',
      buildCartPayload({ productId, quantity, source }),
    );
    return parseCart(json);
  }

  async emptyCart(): Promise<Cart> {
    await this.http.postJson('/api/panier/empty', {});
    return this.getCart();
  }

  async checkStocks(): Promise<unknown> {
    return this.http.getJson('/api/panier/check-stocks');
  }

  // --- Delivery / coverage ------------------------------------------------
  async getPostalCoverage(postalCode: string): Promise<PostalCoverage> {
    const json = await this.http.getJson<Record<string, unknown>>(buildPostalInfoPath(postalCode), {
      xhr: false,
    });
    return parsePostalCoverage(json);
  }

  async getSlots(postalCode: string, addressId?: string | number): Promise<SlotsResult> {
    const json = await this.http.getJson<unknown>(buildSlotsPath({ postalCode, addressId }));
    return parseSlots(json);
  }

  // --- Promo (auth-required) ----------------------------------------------
  async verifyPromo(code: string): Promise<PromoResult> {
    await this.http.ensureLoggedIn();
    const json = await this.http.postJson<unknown>('/api/code-promo/verify', { code });
    return parsePromo(code, json);
  }

  // --- Profile (auth-required) --------------------------------------------
  async getProfile(): Promise<Profile> {
    await this.http.ensureLoggedIn();
    return parseProfile(await this.http.getJson<unknown>(FULL_PROFILE_PATH));
  }

  async getAddresses(): Promise<Address[]> {
    await this.http.ensureLoggedIn();
    return parseAddresses(await this.http.getJson<unknown>(ADDRESSES_PATH));
  }

  // --- Reorder sources (auth-required) ------------------------------------
  /**
   * The order list only exists as a server-rendered page. Asked as an XHR the
   * site answers with the page fragment (~110 KB instead of ~700 KB) carrying
   * the same markup; a JSON body is accepted too should the site ever switch.
   */
  async listRecentOrders(): Promise<OrderSummary[]> {
    await this.http.ensureLoggedIn();
    const body = await this.http.getText(RECENT_ORDERS_PATH, { xhr: true });
    return looksLikeJson(body) ? parseOrderList(JSON.parse(body)) : parseOrderListHtml(body);
  }

  async listUsualProducts(): Promise<UsualProduct[]> {
    await this.http.ensureLoggedIn();
    const body = await this.http.getText(USUAL_PRODUCTS_PATH, { xhr: true });
    return looksLikeJson(body)
      ? parseOrderProducts(JSON.parse(body)).map((p) => ({ ...p, category: null }))
      : parseUsualProductsHtml(body);
  }

  /** One past order with its line items, current prices and availability. */
  async getOrder(orderId: string | number): Promise<OrderDetail> {
    await this.http.ensureLoggedIn();
    return parseOrderDetail(await this.http.getJson<unknown>(buildOrderProductsPath(orderId)));
  }

  async getOrderProducts(orderId: string | number): Promise<OrderProduct[]> {
    await this.http.ensureLoggedIn();
    return parseOrderProducts(await this.http.getJson<unknown>(buildOrderProductsPath(orderId)));
  }

  /** Add every product from a past order into the cart. */
  async reorder(orderId: string | number): Promise<ReorderResult> {
    const requested = await this.getOrderProducts(orderId);
    const added: ReorderResult['added'] = [];
    const failed: ReorderResult['failed'] = [];
    for (const item of requested) {
      try {
        await this.addToCart(item.productId, item.quantity);
        added.push({ productId: item.productId, name: item.name, quantity: item.quantity });
      } catch (err) {
        failed.push({
          productId: item.productId,
          name: item.name,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { orderId: String(orderId), requested, added, failed, cart: await this.getCart() };
  }

  // --- Favorites lists (auth-required) ------------------------------------
  async listFavoriteLists(): Promise<FavoriteList[]> {
    await this.http.ensureLoggedIn();
    return parseFavoriteLists(await this.http.getJson<unknown>(FAVORITES_API_PATH));
  }

  async getFavoriteListProducts(listId: string | number): Promise<FavoriteProduct[]> {
    await this.http.ensureLoggedIn();
    return parseFavoriteListProducts(
      await this.http.getJson<unknown>(buildFavoriteListProductsPath(listId)),
    );
  }

  /** Every list (or one) with its products expanded, capped for payload size. */
  async listFavorites(opts: { listId?: string } = {}): Promise<ListFavoritesResult> {
    const lists = await this.listFavoriteLists();
    const selected = opts.listId !== undefined ? [requireList(lists, opts.listId)] : lists;
    const expanded = selected.slice(0, MAX_FAVORITE_LISTS_EXPANDED);
    const out: FavoriteListWithProducts[] = [];
    for (const list of expanded) {
      out.push({ ...list, products: await this.getFavoriteListProducts(list.id) });
    }
    return { lists: out, truncated: selected.length > expanded.length };
  }

  async createFavoriteList(name: string): Promise<FavoriteList> {
    return this.createList(name, await this.listFavoriteLists());
  }

  /** Not exposed as a tool; exists so the live test can clean up after itself. */
  async deleteFavoriteList(listId: string | number): Promise<void> {
    await this.http.ensureLoggedIn();
    await this.http.sendJson('DELETE', buildFavoriteListPath(listId));
  }

  /**
   * Add a product to a favorites list. Resolution: `listId` → that list;
   * `listName` → the matching list, created if absent; neither → the account's
   * single list, a new default one when it has none, or an error listing the
   * candidates when it has several. Success is confirmed by re-reading the list.
   */
  async addToFavorites(
    productId: string | number,
    opts: { listId?: string; listName?: string } = {},
  ): Promise<AddToFavoritesResult> {
    const { list, created } = await this.resolveFavoriteList(opts);
    const id = String(productId);
    const alreadyPresent = list.productIds.includes(id);
    if (!alreadyPresent) {
      await this.http.sendJson(
        'PUT',
        buildFavoriteListProductPath(list.id, id),
        buildFavoriteProductPayload(list.id, id),
      );
    }
    const products = await this.getFavoriteListProducts(list.id);
    if (!products.some((p) => p.productId === id)) {
      throw new Error(
        `Product ${id} was not added to favorites list "${list.name}" (id ${list.id}); check the productId.`,
      );
    }
    return { productId: id, list, created, alreadyPresent, products };
  }

  /** Remove a product from one list, or from every list it is on. */
  async removeFromFavorites(
    productId: string | number,
    opts: { listId?: string } = {},
  ): Promise<RemoveFromFavoritesResult> {
    const lists = await this.listFavoriteLists();
    const id = String(productId);
    const targets =
      opts.listId !== undefined
        ? [requireList(lists, opts.listId)]
        : lists.filter((l) => l.productIds.includes(id));
    const removedFrom: FavoriteList[] = [];
    for (const list of targets) {
      if (!list.productIds.includes(id)) continue;
      await this.http.sendJson('DELETE', buildFavoriteListProductPath(list.id, id));
      removedFrom.push(list);
    }
    return { productId: id, removedFrom };
  }

  private async createList(name: string, existing: FavoriteList[]): Promise<FavoriteList> {
    await this.http.sendJson(
      'POST',
      FAVORITES_API_PATH,
      buildCreateListPayload(name, existing.length),
    );
    const created = findListByName(await this.listFavoriteLists(), name);
    if (!created) {
      throw new Error(`Favorites list "${name}" was not created; the site may have changed.`);
    }
    return created;
  }

  private async resolveFavoriteList(opts: {
    listId?: string;
    listName?: string;
  }): Promise<{ list: FavoriteList; created: boolean }> {
    const lists = await this.listFavoriteLists();
    if (opts.listId !== undefined) return { list: requireList(lists, opts.listId), created: false };
    if (opts.listName !== undefined) {
      const found = findListByName(lists, opts.listName);
      if (found) return { list: found, created: false };
      return { list: await this.createList(opts.listName, lists), created: true };
    }
    if (lists.length === 0) {
      return { list: await this.createList(DEFAULT_FAVORITE_LIST_NAME, lists), created: true };
    }
    if (lists.length === 1) return { list: lists[0], created: false };
    throw new Error(
      `Several favorites lists exist — pass listId or listName: ${describeLists(lists)}`,
    );
  }

  /**
   * Assemble a ready-to-pay summary: cart, coverage, a recommended delivery
   * slot, and a stock check. Does NOT place or pay for the order — the user
   * completes payment themselves on the site.
   */
  async prepareCheckout(postalCode: string, slotKey?: string): Promise<CheckoutSummary> {
    const notes: string[] = [];
    const cart = await this.getCart();
    if (cart.itemCount === 0) notes.push('The cart is empty — add products before checking out.');

    const coverage = await this.getPostalCoverage(postalCode).catch(() => ({
      covered: false,
      cityName: null,
      postalCode,
      shippingFee: null,
      freeShippingFrom: null,
      paidShippingFrom: null,
    }));
    if (!coverage.covered) notes.push(`Postal code ${postalCode} does not appear to be served.`);

    const slotsResult = await this.getSlots(postalCode).catch(() => ({
      slots: [],
      deliveryWarning: null,
      infos: null,
    }));
    if (slotsResult.deliveryWarning) notes.push(String(slotsResult.deliveryWarning));

    const chosen =
      (slotKey && slotsResult.slots.find((s) => s.key === slotKey)) || slotsResult.slots[0] || null;
    if (slotKey && chosen && chosen.key !== slotKey) {
      notes.push(`Requested slot "${slotKey}" not found; recommending the earliest available slot.`);
    }
    const subtotal = cart.subtotal ?? 0;
    const recommendedSlot: CheckoutSlotChoice | null = chosen
      ? {
          ...chosen,
          reachesFreeShipping:
            chosen.minFreeFee !== null ? subtotal >= chosen.minFreeFee : chosen.isFree,
        }
      : null;

    const stockWarnings = await this.checkStocks().catch(() => null);

    notes.push('Payment is not automated: review and pay for the order yourself on labellevie.com.');

    return {
      cart,
      coverage,
      recommendedSlot,
      availableSlots: slotsResult.slots,
      stockWarnings,
      basketUrl: 'https://www.labellevie.com/panier',
      paymentExecuted: false,
      notes,
    };
  }
}
