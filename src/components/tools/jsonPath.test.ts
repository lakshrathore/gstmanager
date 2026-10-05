import { describe, expect, it } from 'vitest';
import { coerce, isEditable, locate, parsePath } from './jsonPath';

const doc = { gstin: 'X', b2b: [{ ctin: 'Y', inv: [{ inum: 'A1', itms: [{ num: 1801, itm_det: { rt: 18, txval: 100 } }] }] }] };

describe('jsonPath', () => {
  it('parses validator paths', () => {
    expect(parsePath('b2b[0].inv[0].itms[0].itm_det.rt')).toEqual(['b2b', 0, 'inv', 0, 'itms', 0, 'itm_det', 'rt']);
  });
  it('locates values and missing fields', () => {
    expect(locate(doc, 'b2b[0].inv[0].itms[0].itm_det.rt')?.value).toBe(18);
    expect(locate(doc, 'b2b[0].inv[0].pos')).toMatchObject({ key: 'pos', value: undefined });
    expect(locate(doc, 'b2b[5].inv[0].pos')).toBeNull();
  });
  it('allows editing scalars only', () => {
    expect(isEditable(doc, 'b2b[0].inv[0].inum')).toBe(true);
    expect(isEditable(doc, 'b2b[0].inv[0].pos')).toBe(true);
    expect(isEditable(doc, 'b2b[0].inv')).toBe(false);
    expect(isEditable(doc, 'b2b[0].inv[0].itms[0]')).toBe(false);
  });
  it('keeps numbers numeric and text as text', () => {
    expect(coerce('rt', 18, '12')).toBe(12);
    expect(coerce('txval', undefined, '250.5')).toBe(250.5);
    expect(coerce('inum', 'A1', '0047')).toBe('0047');
    expect(coerce('pos', undefined, '07')).toBe('07');
  });
});
