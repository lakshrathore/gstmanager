import { describe, expect, it } from 'vitest';
import { toTaxpayerProfile } from './profile';

describe('toTaxpayerProfile', () => {
  it('reads the Sandbox Search GSTIN record', () => {
    const p = toTaxpayerProfile({
      ctb: 'Proprietorship', dty: 'Regular', gstin: '29AFSPB9500E1ZY', lgnm: 'Vicky Pvt Ltd', tradeNam: 'Vicky', sts: 'Active',
      rgdt: '18/10/2019', cxdt: '', nba: ['Supplier of Services'],
      pradr: { addr: { bno: '26666', bnm: 'Prestige', st: 'Whitefield Main Road', loc: 'Bangalore', dst: 'Bengaluru Urban', stcd: 'Karnataka', pncd: '560048' } },
    });
    expect(p).toMatchObject({ gstin: '29AFSPB9500E1ZY', legalName: 'Vicky Pvt Ltd', status: 'Active', cancellationDate: undefined, natureOfBusiness: ['Supplier of Services'] });
    expect(p?.address).toBe('26666, Prestige, Whitefield Main Road, Bangalore, Bengaluru Urban, Karnataka, 560048');
  });
  it('reads a one-line portal address and rejects non-records', () => {
    expect(toTaxpayerProfile({ lgnm: 'X', sts: 'Cancelled', pradr: { adr: 'Somewhere 1' } }, '33ABKCS2033B1ZW')).toMatchObject({ gstin: '33ABKCS2033B1ZW', address: 'Somewhere 1' });
    expect(toTaxpayerProfile({ errorCode: 'SWEB_9000' })).toBeNull();
  });
});
