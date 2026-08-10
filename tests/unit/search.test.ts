import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { descendantIdSet, parseCategoryTree } from '../../src/lbv/categories';
import { buildSearchUrl, filterByCategoryIds, parseProduct, parseSearchResults } from '../../src/lbv/search';

const search = JSON.parse(readFileSync(new URL('../fixtures/search.json', import.meta.url), 'utf8'));
const categories = JSON.parse(
  readFileSync(new URL('../fixtures/categories.json', import.meta.url), 'utf8'),
);

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
    // Direct category ids come from the hit; names are resolved later by the
    // client (the parser stays decoupled from the taxonomy).
    expect(first.categoryIds).toEqual([74, 547, 1938, 4075]);
    expect(first.categories).toEqual([]);
    // Unfiltered searches report no category-filter metadata.
    expect(result.categoryId).toBeNull();
    expect(result.categoryName).toBeNull();
    expect(result.filteredCount).toBeNull();
    expect(result.scannedCount).toBeNull();
  });

  it('every parsed product has a string id and a boolean inStock', () => {
    for (const p of parseSearchResults(search).products) {
      expect(typeof p.id).toBe('string');
      expect(p.id.length).toBeGreaterThan(0);
      expect(typeof p.inStock).toBe('boolean');
    }
  });
});

describe('filterByCategoryIds', () => {
  it('separates real bananas from banana-flavored candy (the disambiguation bug)', () => {
    // "banane" returns 9 fresh bananas plus candy 53365. Filtering by the
    // "Fruits" category (204) — whose descendant set is {204, 74, 547} —
    // must keep every banana (they all carry 74) and drop the candy.
    const tree = parseCategoryTree(categories);
    const products = parseSearchResults(search).products;
    const kept = filterByCategoryIds(products, descendantIdSet(tree, 204));
    expect(kept.map((p) => p.id)).toEqual([
      '49135',
      '65478',
      '4064',
      '99684',
      '16967',
      '99670',
      '66914',
      '50225',
      '48531',
    ]);
    expect(kept.map((p) => p.id)).not.toContain('53365');
  });

  it('keeps nothing when the allowed set does not intersect', () => {
    const products = parseSearchResults(search).products;
    expect(filterByCategoryIds(products, new Set([424242]))).toEqual([]);
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
