import { afterAll, describe, expect, it } from 'vitest';
import { descendantIdSet } from '../../src/lbv/categories';
import { LbvClient } from '../../src/lbv/client';

/**
 * Opt-in live tests against the real La Belle Vie API. Skipped unless
 * LBV_LIVE=1. Everything here is read-only or self-reverting — the cart
 * round-trip restores the basket to exactly what it found, the favorites
 * round-trip only ever touches a throwaway list it creates itself, and NOTHING
 * ever touches /api/orders/pay. Auth-required cases additionally need
 * LBV_EMAIL / LBV_PASSWORD.
 */
const LIVE = process.env.LBV_LIVE === '1';
const email = process.env.LBV_EMAIL;
const password = process.env.LBV_PASSWORD;
const credentials = email && password ? { email, password } : undefined;

/** Favorites lists created by these tests carry this prefix so leftovers can be swept. */
const TEST_LIST_PREFIX = '__lbv_mcp_test_';

describe.skipIf(!LIVE)('live La Belle Vie API (read-only / self-reverting)', () => {
  const client = new LbvClient({ credentials });

  afterAll(async () => {
    // Sweep throwaway lists left behind by a run that died between add and delete.
    if (!credentials) return;
    try {
      for (const list of await client.listFavoriteLists()) {
        if (list.name.startsWith(TEST_LIST_PREFIX)) await client.deleteFavoriteList(list.id);
      }
    } catch (err) {
      console.warn('favorites sweep skipped:', err instanceof Error ? err.message : err);
    }
  });

  it('exposes no order-placing / payment method (guardrail)', () => {
    const surface = client as unknown as Record<string, unknown>;
    for (const forbidden of ['pay', 'payOrder', 'placeOrder', 'submitOrder', 'checkout']) {
      expect(surface[forbidden]).toBeUndefined();
    }
  });

  it('searches the public catalog', async () => {
    const result = await client.searchProducts('banane', { perPage: 5 });
    expect(result.products.length).toBeGreaterThan(0);
    expect(result.products[0].id).toBeTruthy();
  });

  it(
    'loads the category taxonomy and browses it',
    async () => {
      const tree = await client.getCategoryTree();
      expect(tree.roots.length).toBeGreaterThan(20);
      expect(tree.byId.size).toBeGreaterThan(1000);
      const primeur = [...tree.byId.values()].find((n) => n.name === 'Primeur');
      expect(primeur, 'the Primeur aisle should exist').toBeTruthy();

      const roots = await client.browseCategories();
      expect(roots.mode).toBe('roots');
      expect(roots.items.length).toBeGreaterThan(20);

      const matches = await client.browseCategories({ query: 'fromage' });
      expect(matches.mode).toBe('search');
      expect(matches.items.length).toBeGreaterThan(0);
      expect(matches.items[0].path?.length).toBeGreaterThan(0);
    },
    // The raw taxonomy payload is ~7 MB — the default 5 s timeout is too tight.
    30_000,
  );

  it(
    'category-filtered search excludes keyword false positives',
    async () => {
      const tree = await client.getCategoryTree();
      const primeur = [...tree.byId.values()].find((n) => n.name === 'Primeur');
      expect(primeur).toBeTruthy();
      const result = await client.searchProducts('banane', {
        perPage: 20,
        categoryId: primeur?.id,
      });
      expect(result.categoryName).toBe('Primeur');
      expect(result.scannedCount).toBeGreaterThan(0);
      expect(result.filteredCount).toBe(result.products.length);
      // Every surviving product must sit inside the Primeur subtree.
      const allowed = descendantIdSet(tree, primeur!.id);
      for (const p of result.products) {
        expect(p.categoryIds.some((id) => allowed.has(id))).toBe(true);
      }
    },
    30_000,
  );

  it('reports 75011 (Paris) as served', async () => {
    const coverage = await client.getPostalCoverage('75011');
    expect(coverage.covered).toBe(true);
    expect(coverage.cityName).toBeTruthy();
  });

  it('lists delivery slots for 75011', async () => {
    const { slots } = await client.getSlots('75011');
    expect(Array.isArray(slots)).toBe(true);
  });

  it('does an add → view → remove round-trip that leaves the basket unchanged', async () => {
    const search = await client.searchProducts('banane', { perPage: 10 });
    const product = search.products.find((p) => p.inStock) ?? search.products[0];
    expect(product, 'need at least one product to test the cart').toBeTruthy();

    const qtyOf = (lines: { productId: string; quantity: number }[]) =>
      lines.find((l) => l.productId === product.id)?.quantity ?? 0;

    const before = qtyOf((await client.getCart()).lines);
    await client.addToCart(product.id, 1);
    const mid = qtyOf((await client.getCart()).lines);
    expect(mid).toBe(before + 1);

    await client.removeFromCart(product.id, 1);
    const after = qtyOf((await client.getCart()).lines);
    expect(after).toBe(before);
  });

  it.skipIf(!credentials)(
    'reads the recent orders and usual products pages',
    async () => {
      const orders = await client.listRecentOrders();
      expect(Array.isArray(orders)).toBe(true);
      const usuals = await client.listUsualProducts();
      expect(Array.isArray(usuals)).toBe(true);
      if (orders.length === 0) {
        console.warn('account has no orders — order shape not exercised');
        return;
      }
      expect(orders[0].id).toMatch(/^\d+$/);
      expect(orders[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      const order = await client.getOrder(orders[0].id);
      expect(order.id).toBe(orders[0].id);
      expect(order.products.length).toBeGreaterThan(0);
      for (const p of order.products) {
        expect(p.productId).toBeTruthy();
        expect(p.quantity).toBeGreaterThan(0);
      }
      // An account with orders has usuals, and every card names its product.
      expect(usuals.length).toBeGreaterThan(0);
      expect(usuals[0].productId).toMatch(/^\d+$/);
      expect(usuals[0].name).toBeTruthy();
    },
    30_000,
  );

  it.skipIf(!credentials)(
    'does a favorites add → list → remove → delete round-trip on a throwaway list',
    async () => {
      const before = (await client.listFavoriteLists()).map((l) => l.id).sort();

      const search = await client.searchProducts('banane', { perPage: 10 });
      const product = search.products.find((p) => p.inStock) ?? search.products[0];
      expect(product, 'need at least one product to test favorites').toBeTruthy();

      const listName = TEST_LIST_PREFIX + Date.now();
      const added = await client.addToFavorites(product.id, { listName });
      expect(added.created).toBe(true);
      expect(added.alreadyPresent).toBe(false);
      expect(added.list.name).toBe(listName);
      expect(added.products.map((p) => p.productId)).toContain(product.id);
      const listId = added.list.id;

      // Adding again is a no-op reported as such.
      const again = await client.addToFavorites(product.id, { listId });
      expect(again.alreadyPresent).toBe(true);
      expect(again.created).toBe(false);

      // list_favorites expands the list with product details.
      const listed = await client.listFavorites({ listId });
      expect(listed.lists).toHaveLength(1);
      expect(listed.lists[0].products.map((p) => p.productId)).toContain(product.id);

      const removed = await client.removeFromFavorites(product.id, { listId });
      expect(removed.removedFrom.map((l) => l.id)).toEqual([listId]);
      const remaining = await client.getFavoriteListProducts(listId);
      expect(remaining.map((p) => p.productId)).not.toContain(product.id);

      await client.deleteFavoriteList(listId);
      const after = (await client.listFavoriteLists()).map((l) => l.id).sort();
      expect(after).toEqual(before);
    },
    60_000,
  );
});
