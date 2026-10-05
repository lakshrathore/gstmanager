import { describe, expect, it } from 'vitest';
import { parsePortalErrorReport } from '@/engine';
import {
  ackNumber, describeGstnError, errorLines, fileBody, findGstr1Filing, flattenErrorReport, GstnError, GstnSessionError,
  maskPan, maskUsername, parseGstnDate, parseSummary, processingState, saveBody, splitPeriod, unwrap,
} from './sandbox-protocol';

/* Response samples are taken from the Sandbox API reference. */

describe('Sandbox response envelope', () => {
  it('returns data and the inner payload on success', () => {
    const r = unwrap(200, { code: 200, data: { status_cd: '1', data: { reference_id: 'ref-1' } }, transaction_id: 'tx-1' });
    expect(r.inner).toEqual({ reference_id: 'ref-1' });
    expect(r.transactionId).toBe('tx-1');
  });

  it("raises GSTN's own code and message for business errors", () => {
    const body = { code: 200, data: { status_cd: '0', error: { error_cd: 'AUTH117', message: 'GSTR1 is already filed for current period' } }, transaction_id: 'tx-2' };
    try {
      unwrap(200, body);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GstnError);
      expect((e as GstnError).code).toBe('AUTH117');
      expect(describeGstnError(e as GstnError)).toBe('GSTN AUTH117: GSTR1 is already filed for current period (Sandbox transaction tx-2)');
    }
  });

  it('treats an invalid taxpayer session as a session error', () => {
    expect(() => unwrap(200, { code: 200, data: { status_cd: '0', error: { error_cd: 'AUTH4033', message: 'Invalid Session' } } })).toThrow(GstnSessionError);
    expect(() => unwrap(401, { message: 'Unauthorized' })).toThrow(GstnSessionError);
  });

  it('surfaces Sandbox validation errors', () => {
    expect(() => unwrap(422, { code: 422, message: 'Invalid GSTIN pattern' })).toThrow('Invalid GSTIN pattern');
  });
});

describe('request shaping', () => {
  it('splits MMYYYY into year/month path params', () => {
    expect(splitPeriod('122023')).toEqual({ year: '2023', month: '12' });
    expect(() => splitPeriod('132023')).toThrow();
  });

  it('removes only the offline-tool envelope from the save body', () => {
    const body = saveBody(JSON.stringify({ gstin: '33ABKCS2033B1ZW', fp: '122023', version: 'GST3.2.1', hash: 'hash', b2b: [{ ctin: 'x' }] }));
    expect(body).toEqual({ gstin: '33ABKCS2033B1ZW', fp: '122023', b2b: [{ ctin: 'x' }] });
  });

  it('files exactly the summary GSTN returned', () => {
    const s = parseSummary({ chksum: 'abc', gstin: '33ABKCS2033B1ZW', ret_period: '122023', sec_sum: [{ sec_nm: 'B2B', ttl_rec: 4, chksum: 'c1' }] });
    expect(fileBody(s, '33ABKCS2033B1ZW', '122023')).toEqual({
      ret_period: '122023', gstin: '33ABKCS2033B1ZW', chksum: 'abc', sec_sum: [{ sec_nm: 'B2B', ttl_rec: 4, chksum: 'c1' }], newSumFlag: true,
    });
    expect(() => parseSummary({ sec_sum: [] })).toThrow();
  });
});

describe('return status', () => {
  it('maps GSTN status codes', () => {
    expect(processingState('P')).toBe('processed');
    expect(processingState('PE')).toBe('error');
    expect(processingState('ER')).toBe('error');
    expect(processingState('REC')).toBe('processing');
    expect(processingState('IP')).toBe('processing');
  });

  it('expands grouped GSTN errors so each invoice maps to its record', () => {
    const report = {
      b2b: [{
        ctin: '05CGDPP1321G1ZV', error_cd: 'RET191114', error_msg: 'Date is Invalid.',
        inv: [{ inum: 'S008400', idt: '24-11-2016', pos: '06', val: 729248.16 }, { inum: 'S008401', idt: '25-11-2016', pos: '06', val: 10 }],
      }],
    };
    const errors = parsePortalErrorReport({ error_report: flattenErrorReport(report) });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ section: 'b2b', ctin: '05CGDPP1321G1ZV', documentNo: 'S008400', errorCode: 'RET191114', message: 'Date is Invalid.' });
    expect(errors[1].documentNo).toBe('S008401');
  });

  it('keeps a whole-file error (ER) as one error', () => {
    const report = { error_cd: 'RET191106', error_msg: 'Error in Json structure validation.' };
    expect(parsePortalErrorReport({ error_report: flattenErrorReport(report) })).toMatchObject([{ errorCode: 'RET191106' }]);
    expect(errorLines(report)).toEqual(['RET191106: Error in Json structure validation.']);
  });
});

describe('filing', () => {
  it('reads an acknowledgement number only when GSTN sends one', () => {
    expect(ackNumber({}, { ack_num: 'AK123' })).toBe('AK123');
    expect(ackNumber({}, { chksum: 'x' })).toBeUndefined();
  });

  it('finds the filed GSTR-1 for the period in Track Returns', () => {
    const list = [
      { arn: 'AA010143556585B', ret_prd: '022017', rtntype: 'GSTR2', status: 'Filed' },
      { arn: 'AA331223000001X', ret_prd: '122023', rtntype: 'GSTR1', status: 'Filed', dof: '11-01-2024' },
    ];
    expect(findGstr1Filing(list, '122023')?.arn).toBe('AA331223000001X');
    expect(findGstr1Filing(list, '112023')).toBeUndefined();
    expect(findGstr1Filing([{ ret_prd: '122023', rtntype: 'GSTR1', status: 'Filed' }], '122023')).toBeUndefined();
    expect(parseGstnDate('11-01-2024')?.toISOString()).toBe('2024-01-11T00:00:00.000Z');
    expect(parseGstnDate('2024-01-11')).toBeNull();
  });

  it('masks PAN and username', () => {
    expect(maskPan('ABKCS2033B')).toBe('ABK****33B');
    expect(maskUsername('TN_NT2.2477')).not.toContain('NT2.24');
  });
});
