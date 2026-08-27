import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildCreateListPayload,
  buildFavoriteListPath,
  buildFavoriteListProductPath,
  buildFavoriteListProductsPath,
  buildFavoriteProductPayload,
  describeLists,
  findListByName,
  normalizeListName,
  parseFavoriteListProducts,
  parseFavoriteLists,
} from '../../src/lbv/favorites';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));

const listsJson = fixture('favorites-lists.json');
const listProductsJson = fixture('favorites-list-products.json');

describe('favorites paths and payloads', () => {
  it('builds the Backbone resource paths', () => {
    expect(buildFavoriteListPath(501)).toBe('/favorites-lists/501');
    expect(buildFavoriteListProductsPath('501')).toBe('/favorites-lists/501/products');
    expect(buildFavoriteListProductPath(501, 19967)).toBe('/favorites-lists/501/products/19967');
    expect(buildFavoriteListProductPath('a/b', 'c d')).toBe('/favorites-lists/a%2Fb/products/c%20d');
  });

  it('sends numeric ids as numbers, like the browser', () => {
    expect(buildFavoriteProductPayload('501', '19967')).toEqual({ id: 501, product_id: 19967 });
    expect(buildFavoriteProductPayload('abc', 5)).toEqual({ id: 'abc', product_id: 5 });
    expect(buildCreateListPayload('Courses', 2)).toEqual({ name: 'Courses', order: 2 });
  });
});

describe('parseFavoriteLists', () => {
  it('reads the captured /favorites-lists payload', () => {
    const lists = parseFavoriteLists(listsJson);
    expect(lists).toHaveLength(2);
    expect(lists[0]).toEqual({
      id: '501',
      name: 'Mes favoris',
      type: 'first',
      order: 0,
      productIds: ['19967', '81991', '97457', '39495'],
    });
    expect(lists[1].name).toBe('Courses de la semaine');
    expect(lists[1].productIds).toEqual(['19967', '81991']);
  });

  it('accepts a { lists: [...] } container and skips rows without an id', () => {
    expect(parseFavoriteLists({ lists: [{ id: 9, name: 'X' }, { name: 'no id' }] })).toEqual([
      { id: '9', name: 'X', type: null, order: null, productIds: [] },
    ]);
    expect(parseFavoriteLists('<html>')).toEqual([]);
  });
});

describe('parseFavoriteListProducts', () => {
  it('reads the captured /favorites-lists/{id}/products payload', () => {
    const products = parseFavoriteListProducts(listProductsJson);
    expect(products).toHaveLength(4);
    expect(products[0]).toEqual({
      productId: '19967',
      name: 'Comté râpé AOP au lait cru BIO, 34 % MG, Lait Plaisirs (140 g)',
      quantity: 1,
      price: 4.85,
      unit: null,
      available: true,
    });
  });

  it('accepts bare rows without an expanded product', () => {
    expect(parseFavoriteListProducts([{ list_id: 1, product_id: 42, quantity: 2 }])).toEqual([
      { productId: '42', name: null, quantity: 2, price: null, unit: null, available: null },
    ]);
  });

  it('flags a withdrawn product (product: null) as unavailable', () => {
    const [row] = parseFavoriteListProducts({
      products: [{ product_id: 7, selling_name: 'Ancien produit', product: null }],
    });
    expect(row).toEqual({
      productId: '7',
      name: 'Ancien produit',
      quantity: 1,
      price: null,
      unit: null,
      available: false,
    });
  });
});

describe('list name matching', () => {
  it('normalizes case, accents and whitespace', () => {
    expect(normalizeListName('  Mes   Favoris ')).toBe('mes favoris');
    expect(normalizeListName('Épicerie sucrée')).toBe('epicerie sucree');
  });

  it('finds a list by its normalized name', () => {
    const lists = parseFavoriteLists(listsJson);
    expect(findListByName(lists, 'mes favoris')?.id).toBe('501');
    expect(findListByName(lists, 'COURSES DE LA SEMAINE ')?.id).toBe('502');
    expect(findListByName(lists, 'Noël')).toBeUndefined();
  });

  it('describes lists for error messages', () => {
    expect(describeLists([])).toBe('none');
    expect(describeLists(parseFavoriteLists(listsJson))).toBe(
      'Mes favoris (id 501), Courses de la semaine (id 502)',
    );
  });
});
