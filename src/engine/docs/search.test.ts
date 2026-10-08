import { describe, expect, it } from 'vitest';
import { parseQuery } from './search';

const today = new Date(2026, 9, 8); // 8 Oct 2026

describe('search queries', () => {
  it('reads invoice numbers and GSTINs', () => {
    expect(parseQuery('INV-1023', today)).toMatchObject({ docNos: ['INV-1023'], words: [] });
    expect(parseQuery('08ABCDE1234F1Z5', today)).toMatchObject({ gstins: ['08ABCDE1234F1Z5'], docNos: [] });
  });
  it('reads Hindi / Hinglish amounts and comparisons', () => {
    expect(parseQuery('₹50,000 से ज्यादा के invoices', today)).toMatchObject({ minAmount: 50000, kind: 'invoice', words: [] });
    expect(parseQuery('5 lakh se kam ki purchases', today)).toMatchObject({ maxAmount: 500000, direction: 'purchase', words: [] });
    expect(parseQuery('purchase invoices above 1.5 cr', today)).toMatchObject({ minAmount: 15000000, direction: 'purchase' });
    expect(parseQuery('between 10k and 20k', today)).toMatchObject({ minAmount: 10000, maxAmount: 20000 });
  });
  it('reads months, with the year or the latest such month', () => {
    expect(parseQuery('September 2026 की purchases', today)).toMatchObject({ fp: '092026', direction: 'purchase', words: [] });
    expect(parseQuery('सितंबर की बिक्री', today)).toMatchObject({ fp: '092026', direction: 'sales' });
    expect(parseQuery('december sales', today)).toMatchObject({ fp: '122025' });
    expect(parseQuery('sales 09/2026', today)).toMatchObject({ fp: '092026' });
    expect(parseQuery('FY 2026-27 purchases', today)).toMatchObject({ fy: '2026-27' });
  });
  it('reads parties and bank questions', () => {
    expect(parseQuery('ABC Supplier की सारी invoices', today)).toMatchObject({ words: ['abc'], direction: 'purchase', kind: 'invoice' });
    expect(parseQuery('UPI receipts', today)).toMatchObject({ kind: 'bank', mode: 'UPI', flow: 'in' });
    expect(parseQuery('all cash deposits', today)).toMatchObject({ kind: 'bank', mode: 'CASH', flow: 'in' });
    expect(parseQuery('payments to Rao Industries above 50000', today)).toMatchObject({ kind: 'bank', flow: 'out', minAmount: 50000, words: ['rao', 'industries'] });
    expect(parseQuery('transactions above ₹50,000', today).understood).toEqual(['Bank transactions', '₹50,000 or more']);
  });
});
