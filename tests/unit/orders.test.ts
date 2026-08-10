import { describe, expect, it } from 'vitest';
import { buildOrderProductsPath, parseOrderList, parseOrderProducts } from '../../src/lbv/orders';

describe('buildOrderProductsPath', () => {
  it('builds the per-order products path', () => {
    expect(buildOrderProductsPath(12345)).toBe('/api/orders/12345/products');
  });
});

describe('parseOrderList', () => {
  it('reads an { orders: [...] } container', () => {
    const list = parseOrderList({
      orders: [{ id: 1, date: '2026-08-01', total: 42.5, products_count: 7 }],
    });
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({ id: '1', date: '2026-08-01', total: 42.5, itemCount: 7 });
  });

  it('tolerates a bare array and alternate field names', () => {
    const list = parseOrderList([{ order_id: 9, created_at: '2026-07-01', price: 10 }]);
    expect(list[0].id).toBe('9');
    expect(list[0].date).toBe('2026-07-01');
    expect(list[0].total).toBe(10);
  });
});

describe('parseOrderProducts', () => {
  it('extracts products wrapped under `product`', () => {
    const products = parseOrderProducts([
      { product: { id: 49135, selling_name: 'Banane' }, quantity: 3 },
    ]);
    expect(products).toEqual([{ productId: '49135', name: 'Banane', quantity: 3 }]);
  });

  it('extracts bare product entries and defaults quantity to 1', () => {
    const products = parseOrderProducts([{ id: 7, name: 'Lait' }]);
    expect(products).toEqual([{ productId: '7', name: 'Lait', quantity: 1 }]);
  });

  it('skips entries with no resolvable id', () => {
    const products = parseOrderProducts([{ quantity: 2 }, { product_id: 5, quantity: 1 }]);
    expect(products).toEqual([{ productId: '5', name: null, quantity: 1 }]);
  });
});
