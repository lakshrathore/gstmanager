import type { Section, SectionDataMap } from './types';

/**
 * Empty data for a manually added record, per section – the same shape the Excel parser produces,
 * so validation and JSON generation treat manual entries exactly like imported ones.
 */
export function blankRecordData<S extends Section>(section: S, supplierState = ''): SectionDataMap[S] {
  const item = () => ({ rt: null, txval: null, iamt: null, camt: null, samt: null, csamt: 0 });
  const blanks: { [K in Section]: SectionDataMap[K] } = {
    b2b: { ctin: '', receiverName: '', inum: '', idt: '', val: null, pos: '', rchrg: 'N', invTyp: 'R', etin: '', diffPercent: null, items: [item()] },
    b2cl: { inum: '', idt: '', val: null, pos: '', etin: '', diffPercent: null, items: [item()] },
    b2cs: { typ: 'OE', pos: supplierState, etin: '', diffPercent: null, ...item() },
    cdnr: { ctin: '', receiverName: '', ntNum: '', ntDt: '', ntty: 'C', pos: '', rchrg: 'N', invTyp: 'R', val: null, diffPercent: null, items: [item()] },
    cdnur: { urType: 'B2CL', ntNum: '', ntDt: '', ntty: 'C', pos: '', val: null, diffPercent: null, items: [item()] },
    exp: { expTyp: 'WPAY', inum: '', idt: '', val: null, portCode: '', sbNum: '', sbDt: '', items: [item()] },
    at: { pos: supplierState, diffPercent: null, items: [{ rt: null, adAmt: null, iamt: null, camt: null, samt: null, csamt: 0 }] },
    txpd: { pos: supplierState, diffPercent: null, items: [{ rt: null, adAmt: null, iamt: null, camt: null, samt: null, csamt: 0 }] },
    nil: { splyTy: 'INTRAB2C', nilAmt: 0, exptAmt: 0, ngsupAmt: 0 },
    hsn_b2b: { hsn: '', desc: '', uqc: 'NOS', qty: 0, rt: null, txval: null, iamt: 0, camt: 0, samt: 0, csamt: 0 },
    hsn_b2c: { hsn: '', desc: '', uqc: 'NOS', qty: 0, rt: null, txval: null, iamt: 0, camt: 0, samt: 0, csamt: 0 },
    docs: { docTyp: 'Invoices for outward supply', from: '', to: '', totnum: null, cancel: 0 },
    b2ba: { ctin: '', receiverName: '', oinum: '', oidt: '', inum: '', idt: '', val: null, pos: '', rchrg: 'N', invTyp: 'R', etin: '', diffPercent: null, items: [item()] },
    b2cla: { oinum: '', oidt: '', inum: '', idt: '', val: null, pos: '', etin: '', diffPercent: null, items: [item()] },
    expa: { expTyp: 'WPAY', oinum: '', oidt: '', inum: '', idt: '', val: null, portCode: '', sbNum: '', sbDt: '', items: [item()] },
    cdnra: { ctin: '', receiverName: '', ontNum: '', ontDt: '', ntNum: '', ntDt: '', ntty: 'C', pos: '', rchrg: 'N', invTyp: 'R', val: null, diffPercent: null, items: [item()] },
    cdnura: { urType: 'B2CL', ontNum: '', ontDt: '', ntNum: '', ntDt: '', ntty: 'C', pos: '', val: null, diffPercent: null, items: [item()] },
    b2csa: { omon: '', typ: 'OE', pos: supplierState, etin: '', diffPercent: null, ...item() },
    ata: { omon: '', pos: supplierState, diffPercent: null, items: [{ rt: null, adAmt: null, iamt: null, camt: null, samt: null, csamt: 0 }] },
    txpda: { omon: '', pos: supplierState, diffPercent: null, items: [{ rt: null, adAmt: null, iamt: null, camt: null, samt: null, csamt: 0 }] },
  };
  return structuredClone(blanks[section]);
}
