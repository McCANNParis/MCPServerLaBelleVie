import { describe, expect, it } from 'vitest';
import { descendantIdSet } from '../../src/lbv/categories';
import { LbvClient } from '../../src/lbv/client';

/**
 * Opt-in live tests against the real La Belle Vie API. Skipped unless
 * LBV_LIVE=1. Everything here is read-only or self-reverting — the cart
 * round-trip restores the basket to exactly what it found, and NOTHING ever
 * touches /api/orders/pay. Auth-required cases additionally need
 * LBV_EMAIL / LBV_PASSWORD.
 */
const LIVE = process.env.LBV_LIVE === '1';
const email = process.env.LBV_EMAIL;
const password = process.env.LBV_PASSWORD;
const credentials = email && password ? { email, password } : undefined;

describe.skipIf(!LIVE)('live La Belle Vie API (read-only / self-reverting)', () => {
  const client = new LbvClient({ credentials });

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
});
