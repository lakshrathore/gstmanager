import { z } from 'zod';
import { readPortalJson } from '@/engine';
import { requireLicense } from '@/server/license';
import { api, HttpError } from '@/server/http';
import { getGstClient } from '@/server/gst/gst-client';
import { fetchInwardReturn } from '@/server/gst/gst-client/sandbox';
import { gstnHttpError } from '@/server/gst/gst-login';
import { loadCompany } from '@/server/gst/gstr1';
import { checkPeriod, storeDocs } from '@/server/recon';

const Body = z.object({ companyId: z.string().min(1), fp: z.string(), source: z.enum(['gstr2a', 'gstr2b']) });

/**
 * Downloads GSTR-2A / GSTR-2B straight from GSTN through the GST API integration (needs the company's
 * GST login – OTP – done on any of its returns) and stores it like an uploaded file.
 */
export const POST = api('return:edit', async (req, { auth }) => {
  const b = Body.parse(await req.json());
  checkPeriod(b.fp);
  await requireLicense(auth.orgId, 'gstApi');
  if (getGstClient().id !== 'sandbox') {
    throw new HttpError(409, 'Direct download needs the GST API integration (GST_INTEGRATION=sandbox). Download the Excel/JSON from the GST portal and upload it instead.');
  }
  const company = await loadCompany(auth, b.companyId);
  let json: unknown;
  try {
    json = await fetchInwardReturn({ orgId: auth.orgId, companyId: String(company._id), gstin: company.gstin }, b.source, b.fp);
  } catch (e) {
    if ((e as { name?: string }).name === 'GstnSessionError') {
      throw new HttpError(409, 'Not logged in to GST for this company. Open one of its returns → GST portal tab → log in with OTP, then fetch again.');
    }
    gstnHttpError(e);
  }
  const { docs, notes } = readPortalJson(json, b.source, `${b.source.toUpperCase()} ${b.fp} (GST portal)`, b.fp);
  if (!docs.length) notes.unshift(`GSTN returned no ${b.source === 'gstr2a' ? 'GSTR-2A' : 'GSTR-2B'} invoices or notes for ${b.fp.slice(0, 2)}/${b.fp.slice(2)}`);
  const imp = await storeDocs(auth, b.companyId, b.fp, b.source, docs, { via: 'portal', files: [], notes: notes.map((m) => ({ file: 'GST portal', message: m })) });
  return { import: imp, notes };
}, { feature: 'reconciliation', rateLimit: { key: 'recon-fetch', max: 10, windowMs: 60_000 } });
