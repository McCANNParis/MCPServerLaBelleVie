import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildSearchUrl, parseProduct, parseSearchResults } from '../../src/lbv/search';

const search = JSON.parse(readFileSync(new URL('../fixtures/search.json', import.meta.url), 'utf8'));

describe('buildSearchUrl', () => {
  it('uses perPage (not hitsPerPage) and the required indexName + alternate params', () => {
    const url = buildSearchUrl('banane bio', { perPage: 10, page: 2 });
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://search.deleev.com');
    expect(parsed.searchParams.get('indexName')).toBe('prod_products_ecommerce');
    expect(parsed.searchParams.get('q')).toBe('banane bio');
    expect(parsed.searchParams.get('perPage')).toBe('10');
    expect(parsed.searchParams.get('page')).toBe('2');
    expect(parsed.searchParams.get('alternate')).toBe('1-9');
    // The backend silently ignores hitsPerPage — it must never be emitted.
    expect(url).not.toContain('hitsPerPage');
  });

  it('defaults page to 1 and applies the default perPage', () => {
    const parsed = new URL(buildSearchUrl('lait'));
    expect(parsed.searchParams.get('page')).toBe('1');
    expect(parsed.searchParams.get('perPage')).toBe('25');
  });
});

describe('parseSearchResults', () => {
  it('parses the live "banane" fixture', () => {
    const result = parseSearchResults(search);
    expect(result.found).toBe(119);
    expect(result.perPage).toBe(10);
    expect(result.page).toBe(1);
    expect(result.totalPages).toBeGreaterThan(1);
    expect(result.products).toHaveLength(10);

    const first = result.products[0];
    expect(first.id).toBe('49135');
    expect(first.name).toContain('Banane');
    expect(first.price).toBe(0.49);
    // stock_quantity is null for primeur/unlimited items → treated as in stock.
    expect(first.stockQuantity).toBeNull();
    expect(first.inStock).toBe(true);
  });

  it('every parsed product has a string id and a boolean inStock', () => {
    for (const p of parseSearchResults(search).products) {
      expect(typeof p.id).toBe('string');
      expect(p.id.length).toBeGreaterThan(0);
      expect(typeof p.inStock).toBe('boolean');
    }
  });
});

describe('parseProduct stock logic', () => {
  it('marks a positive finite stock as in stock', () => {
    expect(parseProduct({ id: 1, stock_quantity: 5 }).inStock).toBe(true);
  });
  it('marks a zero stock as out of stock', () => {
    expect(parseProduct({ id: 1, stock_quantity: 0 }).inStock).toBe(false);
  });
  it('treats unlimited_stocks=true as in stock even at zero count', () => {
    expect(parseProduct({ id: 1, stock_quantity: 0, unlimited_stocks: true }).inStock).toBe(true);
  });
  it('treats a null stock (primeur) as in stock', () => {
    expect(parseProduct({ id: 1, stock_quantity: null }).inStock).toBe(true);
  });
});
