'use client';

import { profileForPeriod } from '@/engine/config/versions';
import { checkHsn } from '@/engine/hsn';
import { DOC_TYPES, STATE_CODES, UQC_CODES } from '@/engine/masters';

/** Allowed values for a JSON field, when it has a fixed list. `section` is the finding's section. */
function choices(field: string, section: string | undefined, fp: string | undefined): [string, string][] | null {
  switch (field) {
    case 'uqc': return Object.entries(UQC_CODES).map(([k, v]) => [k, `${k} – ${v}`]);
    case 'pos': return Object.entries(STATE_CODES).filter(([k]) => k !== '96').map(([k, v]) => [k, `${k} – ${v}`]);
    case 'rt': {
      const rates = (fp && /^\d{6}$/.test(fp) ? profileForPeriod(fp) : profileForPeriod('122099')).allowedRates;
      return rates.map((r) => [String(r), `${r}%`]);
    }
    case 'inv_typ': return [['R', 'R – Regular B2B'], ['SEWP', 'SEWP – SEZ with payment'], ['SEWOP', 'SEWOP – SEZ without payment'], ['DE', 'DE – Deemed export'], ['CBW', 'CBW – Intra-state attracting IGST']];
    case 'ntty': return [['C', 'C – Credit note'], ['D', 'D – Debit note']];
    case 'rchrg': return [['N', 'N – No'], ['Y', 'Y – Yes']];
    case 'exp_typ': return [['WPAY', 'WPAY – With payment'], ['WOPAY', 'WOPAY – Without payment']];
    case 'typ': return section === 'cdnur'
      ? [['B2CL', 'B2CL'], ['EXPWP', 'EXPWP – Export with payment'], ['EXPWOP', 'EXPWOP – Export without payment']]
      : [['OE', 'OE – Other than e-commerce'], ['E', 'E – Through e-commerce']];
    case 'sply_ty': return section === 'nil'
      ? [['INTRB2B', 'INTRB2B – Inter-state, registered'], ['INTRAB2B', 'INTRAB2B – Intra-state, registered'], ['INTRB2C', 'INTRB2C – Inter-state, unregistered'], ['INTRAB2C', 'INTRAB2C – Intra-state, unregistered']]
      : [['INTER', 'INTER'], ['INTRA', 'INTRA']];
    case 'doc_typ': return Object.keys(DOC_TYPES).map((k) => [k, k]);
    case 'doc_num': return Object.entries(DOC_TYPES).map(([k, v]) => [String(v), `${v} – ${k}`]);
    case 'diff_percent': return [['0.65', '0.65 (65% of the rate)']];
    default: return null;
  }
}

/** The input inside a finding's Fix box: a list for fields with fixed values, live checks for HSN. */
export function FixField({ field, section, fp, value, onChange }: {
  field: string; section?: string; fp?: string; value: string; onChange: (v: string) => void;
}) {
  const list = choices(field, section, fp);
  if (list) {
    const known = list.some(([k]) => k === value);
    return (
      <select autoFocus value={value} onChange={(e) => onChange(e.target.value)}>
        {!known && <option value={value}>{value === '' ? 'Choose…' : `${value} (current – not valid)`}</option>}
        {list.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
      </select>
    );
  }
  const hsn = field === 'hsn_sc' ? checkHsn(value, { aatoAbove5Cr: undefined }) : null;
  return (
    <>
      <input autoFocus value={value} onChange={(e) => onChange(e.target.value)} className="num" spellCheck={false} />
      {hsn && value.trim() && (
        <span className={hsn.ok ? 'text-ledger' : 'text-red-ink'}>
          {hsn.ok ? `${hsn.kind === 'service' ? 'SAC' : 'HSN'} ${hsn.heading ?? hsn.chapter} – ${hsn.headingName ?? hsn.chapterName}` : hsn.issues[0]?.message}
        </span>
      )}
    </>
  );
}
