import { describe, expect, it } from 'vitest';
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
