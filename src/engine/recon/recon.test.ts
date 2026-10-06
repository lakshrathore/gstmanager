import { describe, expect, it } from 'vitest';
import { R_KA, R_MH, SUPPLIER } from '../../../scripts/sample-workbook';
import { gstinCheckDigit } from '../util';
import { docKey, normaliseDocNo, numericCore, reconcile, type PurchaseDoc } from './index';

const ME = SUPPLIER; // recipient (Karnataka)
const withCheck = (g: string) => g + gstinCheckDigit(g);
const MH_OTHER_STATE = withCheck('29AAACR5055K1Z'); // same PAN as R_MH, Karnataka registration

function doc(source: PurchaseDoc['source'], gstin: string, no: string, o: Partial<PurchaseDoc> = {}): PurchaseDoc {
  const type = o.docType ?? 'INV';
  return {
    key: docKey(source, gstin, type, no), source, docType: type, supplierGstin: gstin, docNo: no, docDate: '2025-06-10',
    taxable: 1000, igst: 180, cgst: 0, sgst: 0, cess: 0, period: '062025', ...o,
  };
}
const opts = { amountTolerance: 1, fuzzyDateDays: 30, recipientGstin: ME };

describe('document number normalisation', () => {
  it('ignores case, separators, leading zeros and financial-year tags', () => {
    expect(normaliseDocNo('INV/001/25-26')).toBe('INV1');
    expect(normaliseDocNo('inv-1')).toBe('INV1');
    expect(normaliseDocNo('INV 0001 (2025-26)')).toBe('INV1');
    expect(normaliseDocNo('FY 2025-2026/INV/1')).toBe('INV1');
  });
  it('keeps number ranges that are not financial years', () => {
    expect(normaliseDocNo('INV/123-45')).toBe('INV12345');
    expect(normaliseDocNo('INV/124-45')).not.toBe(normaliseDocNo('INV/123-45'));
    expect(numericCore('GST/25-26/00045')).toBe('45');
  });
});

describe('reconcile', () => {
  const books = [
    doc('books', R_MH, 'INV/001/25-26'), // matches portal "INV-1"
    doc('books', R_MH, 'INV-2', { taxable: 1000, igst: 180 }), // portal has 1500 → mismatch
    doc('books', R_MH, 'INV-3', { igst: 0, cgst: 90, sgst: 90 }), // portal IGST 180 → wrong tax head
    doc('books', R_MH, 'INV-4', { docDate: '2025-06-01' }), // date differs
    doc('books', R_KA, 'A-1077'), // portal "A-1071" same amounts → probable
    doc('books', MH_OTHER_STATE, 'X-9'), // portal has it under R_MH (same PAN) → probable
    doc('books', R_KA, 'NOT-UPLOADED'), // not in portal
    doc('books', R_KA, 'LATE-1'), // in next month's 2B → timing note
    doc('books', R_KA, 'IGN-1'), // ignored by user
    doc('books', R_MH, 'INV-1', { docType: 'CN', taxable: 100, igst: 18 }), // credit note matches portal CN
    doc('books', R_MH, 'INV-2'), // duplicate of INV-2
    doc('books', R_KA, 'ACC-1', { taxable: 990, igst: 178.2 }), // differences accepted by user
    doc('books', R_KA, 'LINK-B'), // manually linked to portal "REF-77"
  ];
  const portal = [
    doc('gstr2b', R_MH, 'INV-1'),
    doc('gstr2b', R_MH, 'INV-2', { taxable: 1500, igst: 270 }),
    doc('gstr2b', R_MH, 'INV-3'),
    doc('gstr2b', R_MH, 'INV-4'),
    doc('gstr2b', R_KA, 'A-1071'),
    doc('gstr2b', R_MH, 'X-9'),
    doc('gstr2b', R_KA, 'ONLY-PORTAL', { itcAvailable: false, itcReason: 'POS and supplier state are same but recipient state is different' }),
    doc('gstr2b', R_MH, 'INV-1', { docType: 'CN', taxable: 100, igst: 18 }),
    doc('gstr2b', R_KA, 'ACC-1'),
    doc('gstr2b', R_KA, 'REF-77', { taxable: 1000.5 }),
  ];
  const nextMonth = [doc('gstr2b', R_KA, 'LATE-1', { period: '072025' })];
  const decisions = [
    { action: 'ignore' as const, booksKey: docKey('books', R_KA, 'INV', 'IGN-1'), reason: 'Capital goods – claimed separately' },
    { action: 'accept' as const, booksKey: docKey('books', R_KA, 'INV', 'ACC-1'), portalKey: docKey('gstr2b', R_KA, 'INV', 'ACC-1') },
    { action: 'link' as const, booksKey: docKey('books', R_KA, 'INV', 'LINK-B'), portalKey: docKey('gstr2b', R_KA, 'INV', 'REF-77') },
  ];
  const { rows, summary } = reconcile(books, portal, opts, decisions, { period: '062025', otherPortal: nextMonth });
  const row = (no: string, type = 'INV') => rows.find((r) => (r.books?.docNo === no || (!r.books && r.portal?.docNo === no)) && (r.books ?? r.portal)!.docType === type)!;

  it('matches across spelling differences', () => {
    expect(row('INV/001/25-26')).toMatchObject({ status: 'matched', matchedBy: 'normalised' });
    expect(row('INV-1', 'CN')).toMatchObject({ status: 'matched', matchedBy: 'exact' });
  });
  it('reports amount, tax-head and date mismatches field by field', () => {
    const m2 = row('INV-2');
    expect(m2.status).toBe('mismatch');
    expect(m2.diffs.map((d) => d.field)).toEqual(expect.arrayContaining(['taxable', 'igst', 'totalTax']));
    expect(m2.diffs.find((d) => d.field === 'taxable')?.diff).toBe(-500);
    expect(row('INV-3').diffs.map((d) => d.field)).toEqual(['taxHead']);
    expect(row('INV-4')).toMatchObject({ status: 'mismatch', diffs: [{ field: 'docDate', books: '2025-06-01', portal: '2025-06-10' }] });
  });
  it('finds probable matches (typo in number, same PAN other GSTIN)', () => {
    expect(row('A-1077')).toMatchObject({ status: 'probable', matchedBy: 'fuzzy' });
    expect(row('X-9')).toMatchObject({ status: 'probable', matchedBy: 'pan' });
  });
  it('lists books-only and portal-only documents with notes', () => {
    expect(row('NOT-UPLOADED').status).toBe('not_in_portal');
    expect(row('LATE-1')).toMatchObject({ status: 'not_in_portal' });
    expect(row('LATE-1').notes[0]).toMatch(/GSTR-2B of 07\/2025/);
    const only = row('ONLY-PORTAL');
    expect(only.status).toBe('not_in_books');
    expect(only.notes[0]).toMatch(/ITC not available/);
  });
  it('applies ignore, accept and manual link decisions', () => {
    expect(row('IGN-1')).toMatchObject({ status: 'ignored', ignoredReason: 'Capital goods – claimed separately' });
    expect(row('ACC-1')).toMatchObject({ status: 'matched', accepted: true });
    expect(row('LINK-B')).toMatchObject({ status: 'matched', matchedBy: 'manual' });
  });
  it('flags duplicates in books', () => {
    const dups = rows.filter((r) => r.notes.some((n) => /Duplicate entry in books/.test(n)));
    expect(dups).toHaveLength(1);
  });
  it('summarises counts and ITC (credit notes reduce)', () => {
    expect(summary.byStatus.not_in_books.count).toBe(1);
    expect(summary.byStatus.ignored.count).toBe(1);
    expect(summary.byStatus.probable.count).toBe(2);
    expect(rows.length).toBe(summary.byStatus.matched.count + summary.byStatus.mismatch.count + summary.byStatus.probable.count
      + summary.byStatus.not_in_portal.count + summary.byStatus.not_in_books.count + summary.byStatus.ignored.count);
    // ITC per portal excludes the "ITC not available" document
    expect(summary.itc.portal).toBeLessThan(summary.portal.tax);
  });
});
