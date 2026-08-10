import { LbvHttp, type Credentials, type LbvHttpOptions } from './http';
import { buildSearchUrl, parseSearchResults, type SearchOptions, type SearchResult } from './search';
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
  parseOrderList,
  parseOrderProducts,
  type OrderProduct,
  type OrderSummary,
} from './orders';
import {
  ADDRESSES_PATH,
  FULL_PROFILE_PATH,
  parseAddresses,
  parseProfile,
  type Address,
  type Profile,
} from './profile';

export interface ReorderResult {
  orderId: string;
  requested: OrderProduct[];
  added: { productId: string; name: string | null; quantity: number }[];
  failed: { productId: string; name: string | null; reason: string }[];
  cart: Cart;
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

  // --- Search (public) ----------------------------------------------------
  async searchProducts(query: string, opts: SearchOptions = {}): Promise<SearchResult> {
    const url = buildSearchUrl(query, opts);
    const json = await this.http.getJson<Record<string, unknown>>(url, { xhr: false, accept: 'application/json' });
    return parseSearchResults(json);
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
  async listRecentOrders(): Promise<OrderSummary[]> {
    await this.http.ensureLoggedIn();
    return parseOrderList(await this.http.getJson<unknown>(RECENT_ORDERS_PATH));
  }

  async listUsualProducts(): Promise<OrderProduct[]> {
    await this.http.ensureLoggedIn();
    return parseOrderProducts(await this.http.getJson<unknown>(USUAL_PRODUCTS_PATH));
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
