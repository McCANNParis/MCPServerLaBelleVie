import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  RECENT_ORDERS_MARKER,
  buildOrderProductsPath,
  decodeEntities,
  looksLikeJson,
  parseOrderDetail,
  parseOrderList,
  parseOrderListHtml,
  parseOrderProducts,
  parseUsualProductsHtml,
  stripTags,
} from '../../src/lbv/orders';

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

const recentOrdersHtml = fixture('recent-orders.html');
const usualProductsHtml = fixture('usual-products.html');
const orderProductsJson: unknown = JSON.parse(fixture('order-products.json'));

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
    expect(products).toEqual([
      { productId: '49135', name: 'Banane', quantity: 3, price: null, unit: null, available: null },
    ]);
  });

  it('extracts bare product entries and defaults quantity to 1', () => {
    const products = parseOrderProducts([{ id: 7, name: 'Lait' }]);
    expect(products).toEqual([
      { productId: '7', name: 'Lait', quantity: 1, price: null, unit: null, available: null },
    ]);
  });

  it('skips entries with no resolvable id', () => {
    const products = parseOrderProducts([{ quantity: 2 }, { product_id: 5, quantity: 1 }]);
    expect(products).toEqual([
      { productId: '5', name: null, quantity: 1, price: null, unit: null, available: null },
    ]);
  });

  it('reads the captured /api/orders/{id}/products payload', () => {
    const products = parseOrderProducts(orderProductsJson);
    expect(products.map((p) => p.productId)).toEqual(['45819', '70408', '34117', '424242']);
    expect(products[0]).toEqual({
      productId: '45819',
      name: 'Salade feuille de chêne BIO, France',
      quantity: 1,
      price: 1.99,
      unit: 'La pièce',
      available: true,
    });
    // An empty formatted_selling_unit is reported as "no unit".
    expect(products[1].unit).toBeNull();
    expect(products[1].available).toBe(true);
    // stock_quantity 0 without unlimited stocks → unavailable.
    expect(products[2].available).toBe(false);
    expect(products[2].price).toBe(4.18);
  });

  it('keeps a withdrawn product (product: null) as an unavailable row', () => {
    const withdrawn = parseOrderProducts(orderProductsJson)[3];
    expect(withdrawn).toEqual({
      productId: '424242',
      name: 'Produit retiré du catalogue',
      quantity: 2,
      price: null,
      unit: null,
      available: false,
    });
  });
});

describe('parseOrderDetail', () => {
  it('reads the order header alongside its products', () => {
    const order = parseOrderDetail(orderProductsJson);
    expect(order.id).toBe('1001');
    expect(order.status).toBe('received');
    expect(order.orderedAt).toBe('2025-03-03T09:12:41+01:00');
    expect(order.deliveredAt).toBe('2025-03-03T18:00:00+01:00');
    expect(order.total).toBe(15.74);
    expect(order.products).toHaveLength(4);
  });

  it('degrades to nulls on an unexpected payload', () => {
    expect(parseOrderDetail('nope')).toEqual({
      id: '',
      status: null,
      orderedAt: null,
      deliveredAt: null,
      total: null,
      products: [],
    });
  });
});

describe('parseOrderListHtml', () => {
  it('reads every order article from the captured page', () => {
    expect(parseOrderListHtml(recentOrdersHtml)).toEqual([
      { id: '1001', date: '2025-03-03', total: null, itemCount: 24 },
      { id: '1002', date: '2025-02-15', total: null, itemCount: 13 },
      { id: '1003', date: '2025-01-09', total: null, itemCount: 31 },
    ]);
  });

  it('throws instead of returning [] when the page marker is missing', () => {
    expect(() => parseOrderListHtml('<html><body>Connexion</body></html>')).toThrow(
      /expected markup/,
    );
    expect(() => parseOrderListHtml(recentOrdersHtml.replace(RECENT_ORDERS_MARKER, 'x'))).toThrow(
      /expected markup/,
    );
  });

  it('returns [] for an account with no orders', () => {
    expect(parseOrderListHtml('<div class="list-contents last-orders"></div>')).toEqual([]);
  });

  it('also understands <time datetime> and a euro total', () => {
    const html = `<div class="last-orders">
      <article data-order-id='42'><time datetime="2026-01-05T10:00:00">5 janvier</time>
        <b>3 articles</b> — 12,34&nbsp;€</article></div>`;
    expect(parseOrderListHtml(html)).toEqual([
      { id: '42', date: '2026-01-05', total: 12.34, itemCount: 3 },
    ]);
  });
});

describe('parseUsualProductsHtml', () => {
  it('reads the product cards of every aisle section', () => {
    const products = parseUsualProductsHtml(usualProductsHtml);
    expect(products.map((p) => p.productId)).toEqual(['99896', '76945', '31061', '54764']);
    expect(products[0]).toEqual({
      productId: '99896',
      name: 'Fruit de la passion BIO (petit calibre), Espagne',
      quantity: 1,
      price: 1.15,
      unit: 'La pièce',
      available: null,
      category: 'Le primeur',
    });
  });

  it('takes the sale price, not the struck-through origin price', () => {
    const banana = parseUsualProductsHtml(usualProductsHtml)[1];
    expect(banana.price).toBe(2.21);
    expect(banana.unit).toBeNull();
  });

  it('decodes entities in aisle names', () => {
    const oil = parseUsualProductsHtml(usualProductsHtml)[2];
    expect(oil.category).toBe("L'épicerie salée");
    expect(oil.name).toBe('Huile coco vierge BIO, Bio Planète (40 cl)');
  });

  it('throws instead of returning [] when the page marker is missing', () => {
    expect(() => parseUsualProductsHtml('<div class="section-container"></div>')).toThrow(
      /expected markup/,
    );
  });
});

describe('html helpers', () => {
  it('looksLikeJson sniffs the first non-space character', () => {
    expect(looksLikeJson('  [1]')).toBe(true);
    expect(looksLikeJson('{"a":1}')).toBe(true);
    expect(looksLikeJson('<div>')).toBe(false);
    expect(looksLikeJson('')).toBe(false);
  });

  it('decodes named, decimal and hex entities', () => {
    expect(decodeEntities('L&#039;&eacute;picerie &amp; co &#x41;&nbsp;&unknown;')).toBe(
      "L'épicerie & co A &unknown;",
    );
  });

  it('stripTags flattens markup to text', () => {
    expect(stripTags('<b>Voir les</b>\n   <i>24</i> produits')).toBe('Voir les 24 produits');
  });
});
