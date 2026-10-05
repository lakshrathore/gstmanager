import 'server-only';
import { checkGstr1Json, fixGstr1Json, markAutoFixable, type AppliedFix, type JsonCheckReport } from '@/engine';
import { canAccessCompany, type Auth } from '../../auth';
import { HttpError } from '../../http';
import { Company, oid } from '../../models';

/**
 * GSTR-1 JSON validator and auto-fix for the Validators page. Turnover band and filing frequency come
 * from the company with the file's GSTIN (when the user can access it) unless the user sets them.
 */

export interface CheckSettings { aatoAbove5Cr?: boolean; quarterly?: boolean; recomputeTax?: boolean }
type KnownCompany = { name: string; gstin: string } | null;

async function settingsFor(auth: Auth, gstin: string | undefined, s: CheckSettings) {
  const company = gstin ? await Company.findOne({ orgId: oid(auth.orgId), gstin }).lean() : null;
  const known = company && canAccessCompany(auth, String(company._id)) ? company : null;
  return {
    company: (known ? { name: known.name, gstin: known.gstin } : null) as KnownCompany,
    opts: {
      aatoAbove5Cr: s.aatoAbove5Cr ?? known?.aatoAbove5Cr ?? false,
      quarterly: s.quarterly ?? (known ? known.filingFrequency === 'quarterly' : false),
    },
  };
}

const gstinIn = (text: string) => text.match(/"gstin"\s*:\s*"([0-9A-Za-z]{15})"/)?.[1]?.toUpperCase();

export async function checkJson(auth: Auth, text: string, s: CheckSettings): Promise<{ report: JsonCheckReport; company: KnownCompany }> {
  const { company, opts } = await settingsFor(auth, gstinIn(text), s);
  const report = checkGstr1Json(text, opts);
  let parsed: unknown;
  try { parsed = JSON.parse(text.trim()); } catch { parsed = undefined; }
  return { report: markAutoFixable(report, parsed, { recomputeTax: s.recomputeTax }), company };
}

/** Applies the safe fixes, then validates the result. Returns the fixed file as compact JSON text. */
export async function fixJson(auth: Auth, text: string, s: CheckSettings) {
  let parsed: unknown;
  try { parsed = JSON.parse(text.trim()); } catch { throw new HttpError(400, 'The file is not valid JSON, so it cannot be fixed automatically. Correct the syntax error first.'); }
  const { json, fixes } = fixGstr1Json(parsed, { recomputeTax: s.recomputeTax });
  const fixed = JSON.stringify(json);
  const { company, opts } = await settingsFor(auth, gstinIn(fixed), s);
  return { text: fixed, fixes: fixes as AppliedFix[], report: markAutoFixable(checkGstr1Json(json, opts), json, { recomputeTax: s.recomputeTax }), company };
}
