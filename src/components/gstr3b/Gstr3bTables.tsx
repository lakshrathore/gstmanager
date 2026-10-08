'use client';

import { useState, type ReactNode } from 'react';
import { inr } from '@/lib/client';
import { STATE_CODES } from '@/engine/masters';
import {
  FIELDS, HEAD_LABEL, HEADS, ITC_LABEL, itcNet, r2, type Amt, type Gstr3bForm, type ItcRow, type PosRow,
} from '@/server/gst/gstr3b/protocol';

/**
 * GSTR-3B tables laid out as on the GST portal (3.1, 3.1.1, 3.2, 4, 5, 5.1). Read-only when
 * `onChange` is not given. Amounts are rupees with paise.
 */

const states = Object.entries(STATE_CODES).filter(([c]) => c !== '96');
const COLS: (keyof Amt)[] = ['txval', 'iamt', 'camt', 'samt', 'csamt'];
const COL_LABEL: Record<keyof Amt, string> = { txval: 'Taxable value', ...HEAD_LABEL };

/** Number cell that keeps what is being typed ("12.") and reports a rounded number. */
export function Num({ value, onChange, disabled }: { value: number; onChange?: (n: number) => void; disabled?: boolean }) {
  const [text, setText] = useState(value ? String(value) : '');
  // Show the typed text while it still means this value; otherwise the value changed from outside.
  const shown = r2(text) === value ? text : value ? String(value) : '';
  if (!onChange) return <span className="num block text-right">{inr(value)}</span>;
  return (
    <input
      value={shown} inputMode="decimal" placeholder="0.00" disabled={disabled} aria-label="Amount"
      onChange={(e) => { const t = e.target.value.replace(/[^\d.-]/g, ''); setText(t); onChange(r2(t)); }}
      className="num w-full min-w-24 text-right"
    />
  );
}

function Table({ title, head, children }: { title: string; head: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="font-semibold">{title}</h3>
      <div className="-mx-5 overflow-x-auto">
        <table className="ledger">
          <thead>{head}</thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </section>
  );
}

function AmtRow({ label, a, fields, set }: { label: string; a: Amt; fields: readonly (keyof Amt)[]; set?: (a: Amt) => void }) {
  return (
    <tr>
      <td className="min-w-64">{label}</td>
      {COLS.map((c) => (
        <td key={c}>{fields.includes(c) ? <Num value={a[c] ?? 0} onChange={set && ((n) => set({ ...a, [c]: n }))} /> : <span className="block text-center text-ink-soft">—</span>}</td>
      ))}
    </tr>
  );
}

function ItcRows({ rows, label, set }: { rows: ItcRow[]; label: (ty: string) => string; set?: (rows: ItcRow[]) => void }) {
  return rows.map((r, i) => (
    <tr key={r.ty}>
      <td className="min-w-64 pl-6">{label(r.ty)}</td>
      {HEADS.map((h) => <td key={h}><Num value={r[h]} onChange={set && ((n) => set(rows.map((x, j) => (j === i ? { ...x, [h]: n } : x))))} /></td>)}
    </tr>
  ));
}

function PosTable({ title, rows, set }: { title: string; rows: PosRow[]; set?: (rows: PosRow[]) => void }) {
  const total = rows.reduce((a, r) => ({ txval: a.txval + r.txval, iamt: a.iamt + r.iamt }), { txval: 0, iamt: 0 });
  return (
    <div className="space-y-1">
      <p className="text-[13px] font-medium">{title}</p>
      <div className="-mx-5 overflow-x-auto">
        <table className="ledger">
          <thead><tr><th>Place of supply</th><th className="text-right">Taxable value</th><th className="text-right">IGST</th>{set && <th />}</tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>
                  {set ? (
                    <select value={r.pos} onChange={(e) => set(rows.map((x, j) => (j === i ? { ...x, pos: e.target.value } : x)))}>
                      {states.map(([c, n]) => <option key={c} value={c}>{c} – {n}</option>)}
                    </select>
                  ) : `${r.pos} – ${STATE_CODES[r.pos] ?? ''}`}
                </td>
                <td><Num value={r.txval} onChange={set && ((n) => set(rows.map((x, j) => (j === i ? { ...x, txval: n } : x))))} /></td>
                <td><Num value={r.iamt} onChange={set && ((n) => set(rows.map((x, j) => (j === i ? { ...x, iamt: n } : x))))} /></td>
                {set && <td><button type="button" className="text-red-ink hover:underline" onClick={() => set(rows.filter((_, j) => j !== i))}>Remove</button></td>}
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={set ? 4 : 3} className="text-ink-soft">None</td></tr>}
            {rows.length > 1 && <tr className="font-semibold"><td>Total</td><td className="num text-right">{inr(total.txval)}</td><td className="num text-right">{inr(total.iamt)}</td>{set && <td />}</tr>}
          </tbody>
        </table>
      </div>
      {set && <button type="button" className="text-[13px] text-ledger hover:underline" onClick={() => set([...rows, { pos: '01', txval: 0, iamt: 0 }])}>+ Add place of supply</button>}
    </div>
  );
}

export function Gstr3bTables({ form, onChange }: { form: Gstr3bForm; onChange?: (f: Gstr3bForm) => void }) {
  const upd = onChange && (<K extends keyof Gstr3bForm>(k: K, v: Gstr3bForm[K]) => onChange({ ...form, [k]: v }));
  const sup = form.sup_details;
  const setSup = upd && ((k: keyof typeof sup) => (a: Amt) => upd('sup_details', { ...sup, [k]: a }));
  const eco = form.eco_dtls;
  const setEco = upd && ((k: keyof typeof eco) => (a: Amt) => upd('eco_dtls', { ...eco, [k]: a }));
  const inter = form.inter_sup;
  const setInter = upd && ((k: keyof typeof inter) => (rows: PosRow[]) => upd('inter_sup', { ...inter, [k]: rows }));
  const itc = form.itc_elg;
  const setItc = upd && ((k: keyof typeof itc) => (rows: ItcRow[]) => upd('itc_elg', { ...itc, [k]: rows }));
  const net = itcNet(form);
  const fee = form.intr_ltfee;
  const setFee = upd && ((k: keyof typeof fee) => (a: Amt) => upd('intr_ltfee', { ...fee, [k]: a }));
  const amtHead = <tr><th>Nature of supplies</th>{COLS.map((c) => <th key={c} className="text-right">{COL_LABEL[c]}</th>)}</tr>;
  const headHead = (first: string) => <tr><th>{first}</th>{HEADS.map((h) => <th key={h} className="text-right">{HEAD_LABEL[h]}</th>)}</tr>;

  return (
    <div className="space-y-6 text-[13.5px]">
      <Table title="3.1 Outward supplies and inward supplies liable to reverse charge" head={amtHead}>
        <AmtRow label="(a) Outward taxable supplies (other than zero rated, nil rated and exempted)" a={sup.osup_det} fields={FIELDS.osup_det} set={setSup?.('osup_det')} />
        <AmtRow label="(b) Outward taxable supplies (zero rated)" a={sup.osup_zero} fields={FIELDS.osup_zero} set={setSup?.('osup_zero')} />
        <AmtRow label="(c) Other outward supplies (nil rated, exempted)" a={sup.osup_nil_exmp} fields={FIELDS.osup_nil_exmp} set={setSup?.('osup_nil_exmp')} />
        <AmtRow label="(d) Inward supplies (liable to reverse charge)" a={sup.isup_rev} fields={FIELDS.isup_rev} set={setSup?.('isup_rev')} />
        <AmtRow label="(e) Non-GST outward supplies" a={sup.osup_nongst} fields={FIELDS.osup_nongst} set={setSup?.('osup_nongst')} />
      </Table>

      <Table title="3.1.1 Supplies notified under section 9(5)" head={amtHead}>
        <AmtRow label="(i) Taxable supplies on which the e-commerce operator pays tax (filed by the operator)" a={eco.eco_sup} fields={FIELDS.eco_sup} set={setEco?.('eco_sup')} />
        <AmtRow label="(ii) Taxable supplies made through an e-commerce operator (filed by the supplier)" a={eco.eco_reg_sup} fields={FIELDS.eco_reg_sup} set={setEco?.('eco_reg_sup')} />
      </Table>

      <section className="space-y-3">
        <h3 className="font-semibold">3.2 Inter-state supplies out of 3.1(a) and 3.1.1(i)</h3>
        <PosTable title="Supplies made to unregistered persons" rows={inter.unreg_details} set={setInter?.('unreg_details')} />
        <PosTable title="Supplies made to composition taxable persons" rows={inter.comp_details} set={setInter?.('comp_details')} />
        <PosTable title="Supplies made to UIN holders" rows={inter.uin_details} set={setInter?.('uin_details')} />
      </section>

      <Table title="4. Eligible ITC" head={headHead('Details')}>
        <tr><td className="font-medium" colSpan={5}>(A) ITC available (whether in full or part)</td></tr>
        <ItcRows rows={itc.itc_avl} label={(ty) => ITC_LABEL[ty] ?? ty} set={setItc?.('itc_avl')} />
        <tr><td className="font-medium" colSpan={5}>(B) ITC reversed</td></tr>
        <ItcRows rows={itc.itc_rev} label={(ty) => (ty === 'RUL' ? '(1) As per rules 38, 42 & 43 and section 17(5)' : '(2) Others')} set={setItc?.('itc_rev')} />
        <tr className="font-semibold"><td>(C) Net ITC available (A) − (B)</td>{HEADS.map((h) => <td key={h} className="num text-right">{inr(net[h])}</td>)}</tr>
        <tr><td className="font-medium" colSpan={5}>(D) Other details</td></tr>
        <ItcRows rows={itc.itc_inelg} label={(ty) => (ty === 'RUL' ? '(1) ITC reclaimed which was reversed under 4(B)(2) earlier' : '(2) Ineligible ITC under section 16(4) & ITC restricted due to PoS rules')} set={setItc?.('itc_inelg')} />
      </Table>

      <Table title="5. Exempt, nil-rated and non-GST inward supplies" head={<tr><th>Nature of supplies</th><th className="text-right">Inter-state</th><th className="text-right">Intra-state</th></tr>}>
        {form.inward_sup.isup_details.map((r, i) => (
          <tr key={r.ty}>
            <td className="min-w-64">{r.ty === 'GST' ? 'From a supplier under composition scheme, exempt and nil rated supply' : 'Non-GST supply'}</td>
            {(['inter', 'intra'] as const).map((k) => (
              <td key={k}><Num value={r[k]} onChange={upd && ((n) => upd('inward_sup', { isup_details: form.inward_sup.isup_details.map((x, j) => (j === i ? { ...x, [k]: n } : x)) }))} /></td>
            ))}
          </tr>
        ))}
      </Table>

      <Table title="5.1 Interest and late fee" head={headHead('Description')}>
        <tr><td className="min-w-64">Interest</td>{HEADS.map((h) => <td key={h}><Num value={fee.intr_details[h] ?? 0} onChange={setFee && ((n) => setFee('intr_details')({ ...fee.intr_details, [h]: n }))} /></td>)}</tr>
        <tr>
          <td className="min-w-64">Late fee</td>
          {HEADS.map((h) => <td key={h}>{h === 'camt' || h === 'samt' ? <Num value={fee.ltfee_details[h] ?? 0} onChange={setFee && ((n) => setFee('ltfee_details')({ ...fee.ltfee_details, [h]: n }))} /> : <span className="block text-center text-ink-soft">—</span>}</td>)}
        </tr>
      </Table>
    </div>
  );
}
