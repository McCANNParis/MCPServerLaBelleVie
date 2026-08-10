import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCartPayload, parseCart } from '../../src/lbv/cart';

const cart = JSON.parse(readFileSync(new URL('../fixtures/cart.json', import.meta.url), 'utf8'));

describe('buildCartPayload', () => {
  it('coerces ids/quantities to strings and defaults source to "search"', () => {
    expect(buildCartPayload({ productId: 49135, quantity: 2 })).toEqual({
      product_id: '49135',
      quantity: '2',
      source: 'search',
    });
  });
  it('preserves an explicit source', () => {
    expect(buildCartPayload({ productId: '7', quantity: 1, source: 'usuals' }).source).toBe('usuals');
  });
});

describe('parseCart', () => {
  it('parses the live cart fixture into stable line items and totals', () => {
    const parsed = parseCart(cart);
    expect(parsed.itemCount).toBe(1);
    expect(parsed.subtotal).toBe(0.49);
    expect(parsed.priceToPay).toBe(0.49);
    expect(parsed.finalPriceToPay).toBe(0.49);
    expect(parsed.lines).toHaveLength(1);

    const line = parsed.lines[0];
    expect(line.productId).toBe('49135');
    expect(line.name).toContain('Banane');
    expect(line.quantity).toBe(1);
    expect(line.linePrice).toBe(0.49);
    expect(line.source).toBe('search');
  });

  it('returns an empty, zero-count cart for a payload with no products', () => {
    const empty = parseCart({ products: [], products_count: 0, price: 0 });
    expect(empty.itemCount).toBe(0);
    expect(empty.lines).toEqual([]);
  });
});
