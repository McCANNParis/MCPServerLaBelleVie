/**
 * Reorder / "usual products" sources. These endpoints require a logged-in
 * session; their exact response shapes are not publicly documented, so the
 * parsers here are intentionally tolerant and walk several common shapes.
 * Integration tests (run with real credentials) validate them against live data.
 */

export const RECENT_ORDERS_PATH = '/commande-rapide/dernieres-commandes';
export const USUAL_PRODUCTS_PATH = '/commande-rapide/produits-les-plus-commandes';
export const FAVORITE_LISTS_PATH = '/commande-rapide/listes-favoris';

/** Products belonging to a specific past order. */
export function buildOrderProductsPath(orderId: string | number): string {
  return `/api/orders/${encodeURIComponent(String(orderId))}/products`;
}

export interface OrderSummary {
  id: string;
  date: string | null;
  total: number | null;
  itemCount: number | null;
}

export interface OrderProduct {
  productId: string;
  name: string | null;
  quantity: number;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Coerce whatever list-shaped container the API returns into an array. */
function toArray(json: unknown): Record<string, unknown>[] {
  if (Array.isArray(json)) return json as Record<string, unknown>[];
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    for (const key of ['orders', 'data', 'results', 'items', 'products', 'hits']) {
      if (Array.isArray(obj[key])) return obj[key] as Record<string, unknown>[];
    }
  }
  return [];
}

export function parseOrderList(json: unknown): OrderSummary[] {
  return toArray(json).map((o) => ({
    id: String(o.id ?? o.order_id ?? o.reference ?? ''),
    date: (o.date as string) ?? (o.created_at as string) ?? (o.delivery_date as string) ?? null,
    total: num(o.total) ?? num(o.price) ?? num(o.amount) ?? num(o.final_price_to_pay),
    itemCount: num(o.products_count) ?? num(o.item_count) ?? null,
  }));
}

/** Extract {productId, quantity, name} entries from an order/usuals payload. */
export function parseOrderProducts(json: unknown): OrderProduct[] {
  const out: OrderProduct[] = [];
  for (const entry of toArray(json)) {
    // Entries may be a bare product, or wrap it under `product`.
    const product = (entry.product ?? entry) as Record<string, unknown>;
    const id = product.id ?? entry.product_id ?? product.product_id;
    if (id === undefined || id === null) continue;
    out.push({
      productId: String(id),
      name: (product.selling_name as string) ?? (product.name as string) ?? null,
      quantity: num(entry.quantity) ?? num(product.quantity) ?? 1,
    });
  }
  return out;
}
