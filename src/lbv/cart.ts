import { DEFAULT_CART_SOURCE } from './config';

export interface CartItemInput {
  productId: string | number;
  quantity: number;
  source?: string;
}

/**
 * Build the basket mutation payload. Verified against the live API:
 * `{product_id, quantity, source}`, form-url-encoded, on POST/DELETE /api/panier.
 */
export function buildCartPayload(input: CartItemInput): Record<string, string> {
  return {
    product_id: String(input.productId),
    quantity: String(input.quantity),
    source: input.source ?? DEFAULT_CART_SOURCE,
  };
}

export interface CartLine {
  productId: string;
  name: string;
  quantity: number;
  linePrice: number | null;
  source: string | null;
}

export interface Cart {
  itemCount: number;
  lines: CartLine[];
  subtotal: number | null;
  priceToPay: number | null;
  finalPriceToPay: number | null;
  credits: number | null;
  creditsUsed: number | null;
  selectedDay: unknown;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Normalize the /api/panier response into a stable Cart shape. */
export function parseCart(json: Record<string, unknown>): Cart {
  const products = Array.isArray(json?.products)
    ? (json.products as Record<string, unknown>[])
    : [];
  const lines: CartLine[] = products.map((entry) => {
    const product = (entry.product ?? {}) as Record<string, unknown>;
    return {
      productId: String(product.id ?? ''),
      name: String(product.selling_name ?? ''),
      quantity: num(entry.quantity) ?? 0,
      linePrice: num(entry.price),
      source: (entry.source as string) ?? null,
    };
  });
  return {
    itemCount: num(json?.products_count) ?? lines.length,
    lines,
    subtotal: num(json?.price),
    priceToPay: num(json?.price_to_pay),
    finalPriceToPay: num(json?.final_price_to_pay),
    credits: num(json?.credits),
    creditsUsed: num(json?.credits_used),
    selectedDay: json?.selected_day ?? null,
  };
}
