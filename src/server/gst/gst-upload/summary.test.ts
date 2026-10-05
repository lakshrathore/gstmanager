import { describe, expect, it } from 'vitest';
import { compareSummary, hasDifferences } from './summary';

describe('GSTN summary vs app totals', () => {
  const gstn = [
    { sec_nm: 'B2B', ttl_rec: 4, ttl_val: 14568.4, ttl_tax: 12346.1, ttl_igst: 2222.3, ttl_cgst: 0, ttl_sgst: 0, ttl_cess: 0 },
    { sec_nm: 'B2CS', ttl_rec: 2, ttl_val: 1180, ttl_tax: 1000, ttl_igst: 0, ttl_cgst: 90, ttl_sgst: 90, ttl_cess: 0 },
    { sec_nm: 'B2BA', ttl_rec: 0, ttl_val: 0, ttl_tax: 0 },
  ];

  it('matches sections and uses ttl_tax as taxable value', () => {
    const rows = compareSummary({ b2b: { documents: 4, taxableValue: 12346.1, tax: 2222.3 }, b2cs: { documents: 2, taxableValue: 1000.4, tax: 180 } }, gstn);
    expect(rows.map((r) => r.section)).toEqual(['B2B', 'B2CS', 'B2BA']);
    expect(rows[0].gstn).toMatchObject({ records: 4, taxableValue: 12346.1, tax: 2222.3, value: 14568.4 });
    expect(hasDifferences(rows)).toBe(false); // ₹0.40 is within rounding tolerance
  });

  it('flags count, value and tax differences and sections missing on either side', () => {
    const rows = compareSummary({ b2b: { documents: 5, taxableValue: 12000, tax: 2222.3 }, exp: { documents: 1, taxableValue: 500, tax: 0 } }, gstn);
    const b2b = rows.find((r) => r.section === 'B2B')!;
    expect(b2b.diff).toEqual({ records: true, taxableValue: true, tax: false });
    expect(rows.find((r) => r.section === 'B2CS')!.diff.records).toBe(true); // GSTN has it, app does not
    expect(rows.find((r) => r.section === 'EXP')!.gstn).toBeUndefined(); // app has it, GSTN does not
    expect(rows.at(-1)!.section).toBe('EXP');
    expect(hasDifferences(rows)).toBe(true);
  });
});
