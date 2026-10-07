'use client';

import { useMemo, useState } from 'react';
import { Button, Notice } from '@/components/ui';
import { inr } from '@/lib/client';
import {
  itcAvailable, MAJOR_HEAD, MAJOR_LABEL, MAJORS, planOffset, suggestItcUse,
  type Head, type ItcUse, type LedgerBalance, type LiabilityRow, type Major,
} from '@/server/gst/gstr3b/protocol';

/**
 * Payment of tax: GSTN's tax payable, the cash and credit ledger, and the ITC set-off (pre-filled with
 * the set-off that needs the least cash under sections 49/49A and rule 88A, editable). The server
 * re-checks everything against GSTN's current figures before it sends the set-off.
 */

/** Which credit may pay which tax: [credit, tax paid, GSTN field]. */
const CELLS: [Major, Major, keyof ItcUse][] = [
  ['igst', 'igst', 'i_pdi'], ['igst', 'cgst', 'i_pdc'], ['igst', 'sgst', 'i_pds'],
  ['cgst', 'igst', 'c_pdi'], ['cgst', 'cgst', 'c_pdc'],
  ['sgst', 'igst', 's_pdi'], ['sgst', 'sgst', 's_pds'],
  ['cess', 'cess', 'cs_pdcs'],
];

interface Props {
  rows: LiabilityRow[];
  ledger: LedgerBalance | null;
  ledgerFetchedAt?: string | null;
  currentItc: Record<Head, number> | null;
  canOffset: boolean;
  disabled: boolean;
  busy: string | null;
  onRefresh: () => void;
  onOffset: (body: { itcUse: ItcUse; includeCurrentItc: boolean; confirmed: boolean }) => void;
}

export function OffsetPanel({ rows, ledger, ledgerFetchedAt, currentItc, canOffset, disabled, busy, onRefresh, onOffset }: Props) {
  const [includeCurrent, setIncludeCurrent] = useState(true);
  const [edits, setEdits] = useState<Partial<ItcUse>>({});
  const [confirmed, setConfirmed] = useState(false);

  const itc = useMemo(() => (ledger ? itcAvailable(ledger, includeCurrent ? currentItc ?? undefined : undefined) : null), [ledger, includeCurrent, currentItc]);
  const suggested = useMemo(() => (itc ? suggestItcUse(rows, itc) : null), [rows, itc]);
  const use = suggested ? ({ ...suggested, ...edits } as ItcUse) : null;
  const plan = ledger && itc && use ? planOffset(rows, ledger, itc, use) : null;

  if (!rows.length || !ledger) {
    return (
      <div className="space-y-2">
        <p>GSTN posts the tax payable once the return is saved. Fetch it with the ledger balance.</p>
        <Button onClick={onRefresh} busy={busy === 'refresh'} disabled={disabled}>Fetch tax payable and ledger balance</Button>
      </div>
    );
  }
  const tax = (k: Major) => rows.reduce((a, r) => a + r[k].tx, 0);
  const short = plan ? MAJORS.filter((k) => plan.shortfall[k] > 0) : [];

  return (
    <div className="space-y-4">
      <div className="-mx-5 overflow-x-auto">
        <table className="ledger">
          <thead><tr><th>Tax payable (GSTN)</th>{MAJORS.map((k) => <th key={k} className="text-right">{MAJOR_LABEL[k]}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.trans_typ}>
                <td>{r.trans_desc || r.trans_typ}</td>
                {MAJORS.map((k) => (
                  <td key={k} className="num text-right">
                    {inr(r[k].tx)}
                    {(r[k].intr > 0 || r[k].fee > 0) && <div className="text-[11.5px] text-ink-soft">{r[k].intr > 0 ? `+ interest ${inr(r[k].intr)}` : ''}{r[k].fee > 0 ? ` + late fee ${inr(r[k].fee)}` : ''}</div>}
                  </td>
                ))}
              </tr>
            ))}
            <tr className="font-semibold"><td>Total tax</td>{MAJORS.map((k) => <td key={k} className="num text-right">{inr(tax(k))}</td>)}</tr>
          </tbody>
        </table>
      </div>

      <div className="-mx-5 overflow-x-auto">
        <table className="ledger">
          <thead><tr><th>Ledger balance</th>{MAJORS.map((k) => <th key={k} className="text-right">{MAJOR_LABEL[k]}</th>)}</tr></thead>
          <tbody>
            <tr><td>Cash ledger</td>{MAJORS.map((k) => <td key={k} className="num text-right">{inr(ledger.cash[k].total)}</td>)}</tr>
            <tr><td>Credit ledger (ITC)</td>{MAJORS.map((k) => <td key={k} className="num text-right">{inr(ledger.itc[k])}</td>)}</tr>
            {MAJORS.some((k) => ledger.blocked[k] > 0) && <tr><td>Blocked ITC (not usable)</td>{MAJORS.map((k) => <td key={k} className="num text-right">{inr(ledger.blocked[k])}</td>)}</tr>}
            {currentItc && <tr><td>This return’s net ITC – 4(C)</td>{MAJORS.map((k) => <td key={k} className="num text-right">{inr(currentItc[MAJOR_HEAD[k]])}</td>)}</tr>}
            {itc && <tr className="font-semibold"><td>ITC available for set-off</td>{MAJORS.map((k) => <td key={k} className="num text-right">{inr(itc[k])}</td>)}</tr>}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-start gap-2 text-[13px]">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={includeCurrent} onChange={(e) => { setIncludeCurrent(e.target.checked); setEdits({}); }} />
          <span>Add this return’s 4(C) ITC to the credit ledger balance. Leave on if the ledger does not yet show this month’s credit, as on the portal’s “Payment of tax” screen. If GSTN says the credit is not enough, turn it off.</span>
        </label>
        <Button variant="ghost" onClick={onRefresh} busy={busy === 'refresh'} disabled={disabled}>Refresh from GSTN{ledgerFetchedAt ? ` (fetched ${new Date(ledgerFetchedAt).toLocaleTimeString('en-IN', { timeStyle: 'short' })})` : ''}</Button>
      </div>

      {use && plan && (
        <>
          <div className="-mx-5 overflow-x-auto">
            <table className="ledger">
              <thead><tr><th>ITC used (₹, whole rupees)</th>{MAJORS.map((k) => <th key={k} className="text-right">Pays {MAJOR_LABEL[k]}</th>)}<th className="text-right">Left in ledger</th></tr></thead>
              <tbody>
                {MAJORS.map((credit) => (
                  <tr key={credit}>
                    <td>{MAJOR_LABEL[credit]} credit</td>
                    {MAJORS.map((paid) => {
                      const cell = CELLS.find(([c, p]) => c === credit && p === paid);
                      if (!cell) return <td key={paid} className="text-center text-ink-soft">—</td>;
                      const f = cell[2];
                      return (
                        <td key={paid}>
                          <input value={String(use[f])} inputMode="numeric" disabled={disabled} aria-label={`${MAJOR_LABEL[credit]} credit used for ${MAJOR_LABEL[paid]}`}
                            onChange={(e) => setEdits({ ...edits, [f]: Number(e.target.value.replace(/\D/g, '')) || 0 })}
                            className={`num w-full min-w-24 text-right ${edits[f] != null && edits[f] !== suggested?.[f] ? 'border-amber' : ''}`} />
                        </td>
                      );
                    })}
                    <td className="num text-right">{inr(plan.itcLeft[credit])}</td>
                  </tr>
                ))}
                <tr className="font-semibold"><td>Paid in cash (tax + interest + late fee)</td>{MAJORS.map((k) => <td key={k} className="num text-right">{inr(plan.cashNeeded[k])}</td>)}<td /></tr>
                <tr><td>Cash available</td>{MAJORS.map((k) => <td key={k} className={`num text-right ${plan.shortfall[k] > 0 ? 'bg-red-tint font-semibold text-red-ink' : ''}`}>{inr(plan.cashAvailable[k])}</td>)}<td /></tr>
              </tbody>
            </table>
          </div>
          {Object.keys(edits).length > 0 && <button type="button" className="text-[13px] text-ledger hover:underline" onClick={() => setEdits({})}>Reset to the suggested set-off</button>}
          {plan.errors.map((e) => <Notice key={e} tone="error">{e}</Notice>)}
          {plan.warnings.map((w) => <Notice key={w} tone="warn">{w}</Notice>)}
          {short.length > 0 && (
            <Notice tone="error">
              The cash ledger is short by {short.map((k) => `${MAJOR_LABEL[k]} ₹${inr(plan.shortfall[k])}`).join(', ')}. On the GST portal create a challan (Services → Payments → Create Challan, PMT-06) for this amount and pay it, then refresh here.
            </Notice>
          )}

          {!canOffset ? <p className="text-ink-soft">Only an owner or admin can set off the liability.</p> : (
            <div className="space-y-3">
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5 h-4 w-4" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                <span>I want to set off the liability as shown. GSTN debits the cash and credit ledgers, and the return cannot be edited afterwards.</span>
              </label>
              <Button onClick={() => onOffset({ itcUse: use, includeCurrentItc: includeCurrent, confirmed })} busy={busy === 'offset'}
                disabled={disabled || !confirmed || plan.errors.length > 0 || short.length > 0}>
                Offset liability
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
