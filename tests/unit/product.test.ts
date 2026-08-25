import { describe, expect, it } from 'vitest';
import { parseProductDetail } from '../../src/lbv/product';

const base = {
  price: 4.85,
  disponibility: 'order',
  unlimited_stocks: false,
  stock_quantity: 12,
  label_unit_notation_listing: { formatted_selling_unit: 'La pièce', formatted_weight_price: '' },
};

describe('parseProductDetail', () => {
  it('reads price, unit and availability from an in-stock product', () => {
    expect(parseProductDetail(base)).toEqual({ price: 4.85, unit: 'La pièce', available: true });
  });

  it('is unavailable when the stock is exhausted', () => {
    expect(parseProductDetail({ ...base, stock_quantity: 0 }).available).toBe(false);
  });

  it('ignores stock_quantity when stocks are unlimited', () => {
    expect(parseProductDetail({ ...base, stock_quantity: 0, unlimited_stocks: true }).available).toBe(true);
  });

  it('is unavailable when disponibility is not "order"', () => {
    expect(parseProductDetail({ ...base, disponibility: 'unavailable' }).available).toBe(false);
  });

  it('is unavailable when the client may not add it to an order', () => {
    expect(
      parseProductDetail({ ...base, can_not_be_added_to_an_order_by_the_client: true }).available,
    ).toBe(false);
  });

  it('turns an empty selling unit into null', () => {
    expect(
      parseProductDetail({ ...base, label_unit_notation_listing: { formatted_selling_unit: '' } }).unit,
    ).toBeNull();
  });

  it('treats a null product as withdrawn from the catalogue', () => {
    expect(parseProductDetail(null)).toEqual({ price: null, unit: null, available: false });
  });

  it('reports unknown availability for rows without stock information', () => {
    expect(parseProductDetail(undefined)).toEqual({ price: null, unit: null, available: null });
    expect(parseProductDetail({ id: 7, name: 'Lait', price: 1.2 })).toEqual({
      price: 1.2,
      unit: null,
      available: null,
    });
  });
});
