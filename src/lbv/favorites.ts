/**
 * Favorites lists ("Mes listes et favoris"). The site exposes them as a small
 * JSON resource driven by Backbone models in its bundle:
 *
 *   GET    /favorites-lists                     → [{ id, name, type, order, products: [{ product_id, quantity }] }]
 *   GET    /favorites-lists/{l}/products        → the same list object, each row with `product` expanded
 *   POST   /favorites-lists                     { name, order }            create a list
 *   PUT    /favorites-lists/{l}/products/{p}    { id: l, product_id: p }   add a product
 *   DELETE /favorites-lists/{l}/products/{p}                               remove a product
 *   DELETE /favorites-lists/{l}                                            delete a list
 *
 * Bodies are JSON (Backbone emulateHTTP/emulateJSON are both off) and no CSRF
 * header is sent. Mutation responses are never parsed: the client confirms a
 * change by re-reading the list. Both GET payloads also embed the account's
 * `user` block, which the parsers ignore.
 */
import { parseProductDetail, type ProductDetail } from './product';

export const FAVORITES_API_PATH = '/favorites-lists';
/** Name given to the list created when the account has none. */
export const DEFAULT_FAVORITE_LIST_NAME = 'Mes favoris';
/** list_favorites expands at most this many lists per call. */
export const MAX_FAVORITE_LISTS_EXPANDED = 10;

function segment(v: string | number): string {
  return encodeURIComponent(String(v));
}

/** Ids travel as numbers in the browser's payloads; keep that when possible. */
function idValue(v: string | number): number | string {
  return /^\d+$/.test(String(v)) ? Number(v) : String(v);
}

export function buildFavoriteListPath(listId: string | number): string {
  return `${FAVORITES_API_PATH}/${segment(listId)}`;
}

export function buildFavoriteListProductsPath(listId: string | number): string {
  return `${buildFavoriteListPath(listId)}/products`;
}

export function buildFavoriteListProductPath(
  listId: string | number,
  productId: string | number,
): string {
  return `${buildFavoriteListProductsPath(listId)}/${segment(productId)}`;
}

export function buildFavoriteProductPayload(
  listId: string | number,
  productId: string | number,
): { id: number | string; product_id: number | string } {
  return { id: idValue(listId), product_id: idValue(productId) };
}

export function buildCreateListPayload(name: string, order: number): { name: string; order: number } {
  return { name, order };
}

export interface FavoriteList {
  id: string;
  name: string;
  /** "first" for the account's original list, "default" for user-created ones. */
  type: string | null;
  order: number | null;
  productIds: string[];
}

export interface FavoriteProduct extends ProductDetail {
  productId: string;
  name: string | null;
  quantity: number;
}

export interface FavoriteListWithProducts extends FavoriteList {
  products: FavoriteProduct[];
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function rows(json: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(json)) return json.filter((r) => asRecord(r) !== null) as Record<string, unknown>[];
  const obj = asRecord(json);
  if (obj) {
    for (const key of keys) {
      if (Array.isArray(obj[key])) return rows(obj[key], []);
    }
  }
  return [];
}

function parseList(raw: Record<string, unknown>): FavoriteList | null {
  if (raw.id === undefined || raw.id === null) return null;
  const productIds: string[] = [];
  for (const row of rows(raw.products, [])) {
    const product = asRecord(row.product);
    const id = row.product_id ?? product?.id ?? row.id;
    if (id !== undefined && id !== null) productIds.push(String(id));
  }
  return {
    id: String(raw.id),
    name: typeof raw.name === 'string' ? raw.name : '',
    type: typeof raw.type === 'string' ? raw.type : null,
    order: num(raw.order),
    productIds,
  };
}

/** `GET /favorites-lists`: a bare array, or a `{ lists | data | results }` container. */
export function parseFavoriteLists(json: unknown): FavoriteList[] {
  return rows(json, ['lists', 'data', 'results'])
    .map(parseList)
    .filter((l): l is FavoriteList => l !== null);
}

/** `GET /favorites-lists/{id}/products`: the list object with expanded rows. */
export function parseFavoriteListProducts(json: unknown): FavoriteProduct[] {
  const out: FavoriteProduct[] = [];
  for (const row of rows(json, ['products', 'data', 'results'])) {
    const product = asRecord(row.product);
    const id = row.product_id ?? product?.id ?? row.id;
    if (id === undefined || id === null) continue;
    out.push({
      productId: String(id),
      name:
        (product?.selling_name as string | undefined) ??
        (product?.name as string | undefined) ??
        (row.selling_name as string | undefined) ??
        null,
      quantity: num(row.quantity) ?? 1,
      ...parseProductDetail('product' in row ? row.product : undefined),
    });
  }
  return out;
}

/** Accent- and case-insensitive key for matching list names the user types. */
export function normalizeListName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function findListByName(lists: FavoriteList[], name: string): FavoriteList | undefined {
  const key = normalizeListName(name);
  return lists.find((l) => normalizeListName(l.name) === key);
}

export function describeLists(lists: FavoriteList[]): string {
  return lists.length === 0 ? 'none' : lists.map((l) => `${l.name} (id ${l.id})`).join(', ');
}
