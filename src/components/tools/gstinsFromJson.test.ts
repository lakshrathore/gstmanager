import { describe, expect, it } from 'vitest';
import { describeJsonGstins, gstinsFromJson } from './gstinsFromJson';

describe('gstinsFromJson', () => {
  it('collects supplier, recipient and e-commerce GSTINs without duplicates', () => {
    const g = gstinsFromJson({
      gstin: '33ABKCS2033B1ZW', fp: '062025',
      b2b: [{ ctin: '29aaacr5055k1z5', inv: [{ inum: '1', etin: '07AAACE1234F1ZC' }] }, { ctin: '29AAACR5055K1Z5', inv: [] }],
      cdnr: [{ ctin: '27AAACR5055K1Z7', nt: [] }],
      b2cs: [{ typ: 'E', etin: '07AAACE1234F1ZC' }],
    });
    expect(g).toEqual({
      supplier: ['33ABKCS2033B1ZW'], recipients: ['29AAACR5055K1Z5', '27AAACR5055K1Z7'], ecommerce: ['07AAACE1234F1ZC'],
      all: ['33ABKCS2033B1ZW', '29AAACR5055K1Z5', '27AAACR5055K1Z7', '07AAACE1234F1ZC'],
    });
    expect(describeJsonGstins(g)).toBe('1 supplier, 2 recipients, 1 e-commerce operator');
  });
});
