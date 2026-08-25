/**
 * Past orders and "usual products" sources. Both list pages are server-rendered
 * HTML — there is no JSON endpoint for the order list — so they are parsed with
 * a few anchored regexes behind a page-marker sentinel: unexpected markup throws
 * instead of silently yielding an empty list. Per-order line items come from a
 * JSON endpoint and share `parseProductDetail` with favorites. Every parser is
 * asserted against captured fixtures in tests/fixtures/ (`npm run
 * capture-fixtures` refreshes the raw captures).
 */
import { parseProductDetail, type ProductDetail } from './product';

export const RECENT_ORDERS_PATH = '/commande-rapide/dernieres-commandes';
export const USUAL_PRODUCTS_PATH = '/commande-rapide/produits-les-plus-commandes';

/** Container class of the order list (`div.list-contents.last-orders`). */
export const RECENT_ORDERS_MARKER = 'last-orders';
/** The usuals page flags its own entry of the quick-order menu as selected. */
export const USUAL_PRODUCTS_MARKER = 'produits-les-plus-commandes" class="selected"';

/** Products belonging to a specific past order. */
export function buildOrderProductsPath(orderId: string | number): string {
  return `/api/orders/${encodeURIComponent(String(orderId))}/products`;
}

export interface OrderSummary {
  id: string;
  /** ISO date (YYYY-MM-DD) when the page carries one. */
  date: string | null;
  /** The order list page does not show totals; see getOrder() for one. */
  total: number | null;
  itemCount: number | null;
}

export interface OrderProduct extends ProductDetail {
  productId: string;
  name: string | null;
  quantity: number;
}

export interface UsualProduct extends OrderProduct {
  /** Aisle heading the product is listed under on the usuals page. */
  category: string | null;
}

export interface OrderDetail {
  id: string;
  status: string | null;
  orderedAt: string | null;
  deliveredAt: string | null;
  total: number | null;
  products: OrderProduct[];
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
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

// --- JSON ------------------------------------------------------------------

export function parseOrderList(json: unknown): OrderSummary[] {
  return toArray(json).map((o) => ({
    id: String(o.id ?? o.order_id ?? o.reference ?? ''),
    date: (o.date as string) ?? (o.created_at as string) ?? (o.delivery_date as string) ?? null,
    total: num(o.total) ?? num(o.price) ?? num(o.amount) ?? num(o.final_price_to_pay),
    itemCount: num(o.products_count) ?? num(o.item_count) ?? null,
  }));
}

/** Extract {productId, quantity, name, …} entries from an order/usuals payload. */
export function parseOrderProducts(json: unknown): OrderProduct[] {
  const out: OrderProduct[] = [];
  for (const entry of toArray(json)) {
    // Entries may be a bare product, or wrap it under `product` — which the
    // site sets to null for a product withdrawn from the catalogue.
    const product = (entry.product ?? entry) as Record<string, unknown>;
    const id = product.id ?? entry.product_id ?? product.product_id;
    if (id === undefined || id === null) continue;
    out.push({
      productId: String(id),
      name: (product.selling_name as string) ?? (product.name as string) ?? null,
      quantity: num(entry.quantity) ?? num(product.quantity) ?? 1,
      ...parseProductDetail('product' in entry ? entry.product : entry),
    });
  }
  return out;
}

/** The `/api/orders/{id}/products` payload is the whole order, products included. */
export function parseOrderDetail(json: unknown): OrderDetail {
  const o =
    json && typeof json === 'object' && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : {};
  return {
    id: String(o.id ?? ''),
    status: str(o.status),
    orderedAt: str(o.order_time),
    deliveredAt: str(o.shipping_time),
    total: num(o.total),
    products: parseOrderProducts(json),
  };
}

export function looksLikeJson(text: string): boolean {
  return /^\s*[[{]/.test(text);
}

// --- HTML ------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  euro: '€',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  ccedil: 'ç',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const cp =
        code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

/** Tags → spaces, entities decoded, whitespace collapsed. */
export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

const ORDER_ARTICLE_RE = /<article\b[^>]*data-order-id=["'](\d+)["'][^>]*>([\s\S]*?)<\/article>/g;
const PRODUCT_ARTICLE_RE =
  /<article\b[^>]*data-product-id=["'](\d+)["'][^>]*>([\s\S]*?)<\/article>/g;
const SECTION_SPLIT = '<div class="section-container">';

function parseDate(block: string, text: string): string | null {
  const iso = /<time\b[^>]*datetime=["']([^"']+)["']/i.exec(block)?.[1];
  if (iso) return iso.slice(0, 10);
  const m = /(\d{1,2})\/(\d{2})\/(\d{4})/.exec(text);
  return m ? `${m[3]}-${m[2]}-${m[1].padStart(2, '0')}` : null;
}

function parseEuro(text: string): number | null {
  const m = /(\d+)[,.](\d{2})\s*€/.exec(text);
  return m ? Number(`${m[1]}.${m[2]}`) : null;
}

function parseCount(text: string): number | null {
  const m = /(\d+)\s*(?:produits?|articles?)\b/i.exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * `/commande-rapide/dernieres-commandes`: one `<article data-order-id>` per
 * order with "Commande du <weekday> dd/mm/yyyy (N produits)". Throws when the
 * page container is missing so a markup change never reads as "no orders".
 */
export function parseOrderListHtml(html: string): OrderSummary[] {
  if (!html.includes(RECENT_ORDERS_MARKER)) {
    throw new Error(
      'Recent orders page did not contain the expected markup; the site may have changed.',
    );
  }
  const orders: OrderSummary[] = [];
  for (const m of html.matchAll(ORDER_ARTICLE_RE)) {
    const text = stripTags(m[2]);
    orders.push({
      id: m[1],
      date: parseDate(m[2], text),
      total: parseEuro(text),
      itemCount: parseCount(text),
    });
  }
  return orders;
}

function parseProductCard(id: string, block: string, category: string | null): UsualProduct {
  const name = /<h1\b[^>]*itemprop=["']name["'][^>]*>([\s\S]*?)<\/h1>/i.exec(block)?.[1];
  const price =
    /itemprop=["']price["'][^>]*content=["']([\d.]+)["']/i.exec(block)?.[1] ??
    /<product-addtocart\b[^>]*product_price=["']([\d.]+)["']/i.exec(block)?.[1];
  const unit = /<span class=["']quantity["']>([\s\S]*?)<\/span>/i.exec(block)?.[1];
  return {
    productId: id,
    name: name ? stripTags(name) || null : null,
    quantity: 1,
    price: price ? Number(price) : null,
    unit: unit ? stripTags(unit) || null : null,
    // The page only lists orderable cards and carries no stock marker.
    available: null,
    category,
  };
}

/**
 * `/commande-rapide/produits-les-plus-commandes`: product cards grouped under
 * one `div.section-container` per aisle (`<h2><span>Le primeur</span></h2>`).
 */
export function parseUsualProductsHtml(html: string): UsualProduct[] {
  if (!html.includes(USUAL_PRODUCTS_MARKER)) {
    throw new Error(
      'Usual products page did not contain the expected markup; the site may have changed.',
    );
  }
  const products: UsualProduct[] = [];
  html.split(SECTION_SPLIT).forEach((chunk, index) => {
    // Chunk 0 precedes the first section (menu + heading); if the page ever
    // drops the sections, its cards are still collected — without a category.
    const heading = index === 0 ? undefined : /<h2>\s*<span>([\s\S]*?)<\/span>/.exec(chunk)?.[1];
    const category = heading ? stripTags(heading) || null : null;
    for (const m of chunk.matchAll(PRODUCT_ARTICLE_RE)) {
      products.push(parseProductCard(m[1], m[2], category));
    }
  });
  return products;
}
