import { DEFAULT_PER_PAGE, PRODUCTS_INDEX, SEARCH_ALTERNATE, SEARCH_URL } from './config';

export interface SearchOptions {
  page?: number;
  perPage?: number;
  index?: string;
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
}

export interface SearchResult {
  found: number;
  page: number;
  perPage: number;
  totalPages: number;
  products: Product[];
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
  };
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
  };
}
