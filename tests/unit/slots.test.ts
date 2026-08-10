import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildPostalInfoPath,
  buildSlotsPath,
  parsePostalCoverage,
  parseSlots,
} from '../../src/lbv/slots';

const slots = JSON.parse(readFileSync(new URL('../fixtures/slots.json', import.meta.url), 'utf8'));
const postal = JSON.parse(readFileSync(new URL('../fixtures/postal.json', import.meta.url), 'utf8'));

describe('buildSlotsPath', () => {
  it('builds the postal-code query', () => {
    expect(buildSlotsPath({ postalCode: '75011' })).toBe('/api/panier/slots?postal_code=75011');
  });
  it('includes address_id when provided', () => {
    expect(buildSlotsPath({ postalCode: '75011', addressId: 42 })).toBe(
      '/api/panier/slots?postal_code=75011&address_id=42',
    );
  });
});

describe('parseSlots', () => {
  it('parses the live { slots, delivery_warning, infos } fixture', () => {
    const result = parseSlots(slots);
    expect(result.slots.length).toBe(72);
    const first = result.slots[0];
    expect(first.key).toBe('dqp');
    expect(first.text).toContain('Dès que possible');
    expect(first.fee).toBe(3.9);
  });

  it('tolerates a bare array of slots', () => {
    const result = parseSlots([{ key: 'x', text: 'Slot X', fee: 0, is_offert: true }]);
    expect(result.slots).toHaveLength(1);
    expect(result.slots[0].isFree).toBe(true);
    expect(result.deliveryWarning).toBeNull();
  });

  it('returns an empty list for an unexpected shape', () => {
    expect(parseSlots(null).slots).toEqual([]);
    expect(parseSlots({}).slots).toEqual([]);
  });
});

describe('postal coverage', () => {
  it('builds the coverage path', () => {
    expect(buildPostalInfoPath('75011')).toBe('/api/postal-code/75011/infos');
  });

  it('reports coverage from the live fixture (id present ⇒ served)', () => {
    const cov = parsePostalCoverage(postal);
    expect(cov.covered).toBe(true);
    expect(cov.cityName).toBe('Paris');
    expect(cov.shippingFee).toBe(3.9);
    expect(cov.freeShippingFrom).toBe(50);
    expect(cov.paidShippingFrom).toBe(25);
  });

  it('reports not-covered when there is no id', () => {
    expect(parsePostalCoverage({}).covered).toBe(false);
  });
});
