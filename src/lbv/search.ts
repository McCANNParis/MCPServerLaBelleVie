import { DEFAULT_PER_PAGE, PRODUCTS_INDEX, SEARCH_ALTERNATE, SEARCH_URL } from './config';

export interface SearchOptions {
  page?: number;
  perPage?: number;
  index?: string;
  /**
   * Restrict results to a category (and its descendants). The gateway has no
   * category filter — it silently ignores filter params — so this is applied
   * on our side AFTER fetching the page (see LbvClient.searchProducts) and is
   * never sent in the URL.
   */
  categoryId?: number;
}

/**
 * Build the Deleev search URL. Both `indexName` and `alternate=1-9` are
 * required — the endpoint returns 400 without them. Pagination is `perPage`
 * (NOT `hitsPerPage`, which the backend ignores).
 */
export function buildSearchUrl(query: string, opts: SearchOptions = {}): string {
  const params = new URLSearchParams({
    indexName: opts.index ?? PRODUCTS_INDEX,
    q: query,
    perPage: String(opts.perPage ?? DEFAULT_PER_PAGE),
    page: String(opts.page ?? 1),
    alternate: SEARCH_ALTERNATE,
  });
  return `${SEARCH_URL}/?${params.toString()}`;
}

export interface Product {
  id: string;
  name: string;
  price: number | null;
  packPrice: number | null;
  unitPrice: number | null;
  unitNotation: string | null;
  brand: string | null;
  bio: boolean;
  onSale: boolean;
  saleRate: number | null;
  inStock: boolean;
  stockQuantity: number | null;
  sellingMethod: string | null;
  maxQuantityByOrder: number | null;
  picture: string | null;
  /** Direct category ids from the hit (no ancestors — see categories.ts). */
  categoryIds: number[];
  /** Category names resolved from the cached tree; [] when the cache is cold. */
  categories: string[];
}

export interface SearchResult {
  found: number;
  page: number;
  perPage: number;
  totalPages: number;
  products: Product[];
  /** Set when the caller filtered by category; null on plain searches. */
  categoryId: number | null;
  categoryName: string | null;
  /** Products kept after the category filter (null when unfiltered). */
  filteredCount: number | null;
  /** Products the gateway returned for this page before filtering. */
  scannedCount: number | null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Normalize a raw search hit into a stable Product shape. */
export function parseProduct(hit: Record<string, unknown>): Product {
  const stockQuantity = num(hit.stock_quantity);
  const unlimited = hit.unlimited_stocks === true;
  return {
    id: String(hit.id ?? ''),
    name: String(hit.selling_name ?? ''),
    price: num(hit.price),
    packPrice: num(hit.pack_price),
    unitPrice: num(hit.weight_price) ?? num(hit.price),
    unitNotation:
      (hit.unit_notation as string) ??
      (hit.label_unit_notation_listing as string) ??
      null,
    brand: (hit.brand as string) || null,
    bio: hit.bio === true,
    onSale: hit.is_on_sale === true,
    saleRate: num(hit.sale_rate),
    // stock_quantity is null for unlimited/primeur items; treat null as in-stock.
    stockQuantity,
    inStock: unlimited || stockQuantity === null || stockQuantity > 0,
    sellingMethod: (hit.selling_method as string) ?? null,
    maxQuantityByOrder: num(hit.max_quantity_by_order),
    picture:
      (hit.picture_thumbnail_url as string) ?? (hit.picture as string) ?? null,
    categoryIds: Array.isArray(hit.categories)
      ? hit.categories.filter((c): c is number => typeof c === 'number' && Number.isFinite(c))
      : [],
    // Name resolution needs the category tree; the client fills these in.
    categories: [],
  };
}

/** Keep only products whose direct categories intersect the allowed id set. */
export function filterByCategoryIds(products: Product[], allowed: Set<number>): Product[] {
  return products.filter((p) => p.categoryIds.some((id) => allowed.has(id)));
}

/** Normalize the full search response. */
export function parseSearchResults(json: Record<string, unknown>): SearchResult {
  const hits = Array.isArray(json?.hits) ? (json.hits as Record<string, unknown>[]) : [];
  return {
    found: num(json?.found) ?? hits.length,
    page: num(json?.page) ?? 1,
    perPage: num(json?.perPage) ?? hits.length,
    totalPages: num(json?.total_pages) ?? 1,
    products: hits.map(parseProduct),
    categoryId: null,
    categoryName: null,
    filteredCount: null,
    scannedCount: null,
  };
}
