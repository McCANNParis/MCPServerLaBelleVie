export interface SlotsQuery {
  postalCode: string;
  addressId?: string | number;
}

/** Build the delivery-slots path: GET /api/panier/slots?postal_code=…[&address_id=…] */
export function buildSlotsPath(query: SlotsQuery): string {
  const params = new URLSearchParams({ postal_code: query.postalCode });
  if (query.addressId !== undefined) params.set('address_id', String(query.addressId));
  return `/api/panier/slots?${params.toString()}`;
}

export interface DeliverySlot {
  key: string;
  timestamp: number | null;
  text: string;
  shortText: string | null;
  fee: number | null;
  initialFee: number | null;
  minFreeFee: number | null;
  minPaidFee: number | null;
  isSpeed: boolean;
  isFree: boolean;
  cashAllowed: boolean;
  maxDeliveryTime: number | null;
}

export interface SlotsResult {
  slots: DeliverySlot[];
  deliveryWarning: string | null;
  infos: unknown;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Normalize one raw slot object. */
export function parseSlot(raw: Record<string, unknown>): DeliverySlot {
  return {
    key: String(raw.key ?? ''),
    timestamp: num(raw.value),
    text: String(raw.text ?? ''),
    shortText: (raw.short_text as string) ?? null,
    fee: num(raw.fee),
    initialFee: num(raw.initial_price),
    minFreeFee: num(raw.min_free_fee),
    minPaidFee: num(raw.min_paid_fee),
    isSpeed: raw.is_speed === true,
    isFree: raw.is_offert === true,
    cashAllowed: raw.cash_allowed === true,
    maxDeliveryTime: num(raw.max_delivery_time),
  };
}

/**
 * Normalize the slots response. The live shape is
 * `{ slots: [...], delivery_warning, infos }`, but we tolerate a bare array too.
 */
export function parseSlots(json: unknown): SlotsResult {
  const container = (json ?? {}) as Record<string, unknown>;
  const rawSlots = Array.isArray(json)
    ? json
    : Array.isArray(container.slots)
      ? (container.slots as unknown[])
      : [];
  return {
    slots: (rawSlots as Record<string, unknown>[]).map(parseSlot),
    deliveryWarning: (container.delivery_warning as string) ?? null,
    infos: container.infos ?? null,
  };
}

/** Build the postal-coverage path: GET /api/postal-code/<code>/infos */
export function buildPostalInfoPath(postalCode: string): string {
  return `/api/postal-code/${encodeURIComponent(postalCode)}/infos`;
}

export interface PostalCoverage {
  covered: boolean;
  cityName: string | null;
  postalCode: string;
  shippingFee: number | null;
  freeShippingFrom: number | null;
  paidShippingFrom: number | null;
}

/** Normalize the postal-coverage response. A 200 with an id means it's served. */
export function parsePostalCoverage(json: Record<string, unknown>): PostalCoverage {
  return {
    covered: json?.id !== undefined && json?.id !== null,
    cityName: (json?.city_name as string) ?? null,
    postalCode: String(json?.postal_code ?? ''),
    shippingFee: num(json?.shipping_fee),
    freeShippingFrom: num(json?.free_shipping_from),
    paidShippingFrom: num(json?.paid_shipping_from),
  };
}
