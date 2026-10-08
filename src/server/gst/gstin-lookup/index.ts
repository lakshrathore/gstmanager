import 'server-only';
import { randomUUID } from 'node:crypto';
import { checkGstin, describeGstin, type GstinParts } from '@/engine';
import { HttpError } from '../../http';
import { describeGstnError, GstnError } from '../gst-client';
import { returnPreference, sandboxConfigured, searchGstinPublic } from '../gst-client/sandbox';
import { toTaxpayerProfile, type TaxpayerProfile } from './profile';

/**
 * GSTIN validation for the Validators page.
 *
 *   offline – checksum, state, PAN and registration type (engine, no network)
 *   sandbox – Sandbox.co.in "Search GSTIN" (authorised GSP, needs SANDBOX_API_KEY/SECRET)
 *   portal  – the GST portal's free public "Search Taxpayer". The portal shows a CAPTCHA; the app
 *             relays the image to the user, who types it. The app never reads or solves the CAPTCHA.
 */

export { sandboxConfigured };
export type { TaxpayerProfile };

export interface GstinResult {
  input: string;
  offline: GstinParts;
  profile?: TaxpayerProfile;
  lookupError?: string;
}

export const MAX_BATCH = 100;
export const MAX_SANDBOX_BATCH = 50;

/** Splits pasted text (lines, commas, spaces, tabs) into unique GSTINs, preserving order. */
export function splitGstins(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))];
}

export function checkOffline(list: string[]): GstinResult[] {
  return list.map((g) => ({ input: g, offline: describeGstin(g) }));
}

/** Current quarter of the Indian financial year ("Q1" = Apr–Jun) and the year ("2026-27"). */
function currentQuarter(now = new Date()) {
  const m = now.getMonth() + 1;
  const start = m >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  return { fy: `${start}-${String((start + 1) % 100).padStart(2, '0')}`, quarter: `Q${m >= 4 ? Math.ceil((m - 3) / 3) : 4}` };
}

/** Monthly or quarterly filing now, from GSTN's return preference; undefined when GSTN does not say. */
async function filingFrequency(gstin: string): Promise<'monthly' | 'quarterly' | undefined> {
  const { fy, quarter } = currentQuarter();
  try {
    const list = await returnPreference(gstin, fy);
    const p = (list.find((x) => x.quarter === quarter) ?? list[list.length - 1])?.preference?.toUpperCase();
    return p === 'Q' ? 'quarterly' : p === 'M' ? 'monthly' : undefined;
  } catch {
    return undefined;
  }
}

/** Sandbox lookups for adding companies: GSTN's taxpayer record plus the filing frequency. */
export async function lookupForCompanies(list: string[]): Promise<(GstinResult & { filingFrequency?: 'monthly' | 'quarterly' })[]> {
  const results = await checkWithSandbox(list);
  return Promise.all(results.map(async (r) => (r.profile ? { ...r, filingFrequency: await filingFrequency(r.input) } : r)));
}

/** Offline checks for all, then Sandbox lookups (3 at a time) for the ones that pass offline. */
export async function checkWithSandbox(list: string[]): Promise<GstinResult[]> {
  if (!sandboxConfigured()) throw new HttpError(400, 'Sandbox API is not configured: set SANDBOX_API_KEY and SANDBOX_API_SECRET in .env.local');
  if (list.length > MAX_SANDBOX_BATCH) throw new HttpError(400, `Check up to ${MAX_SANDBOX_BATCH} GSTINs per API run`);
  const out = checkOffline(list);
  const queue = out.filter((r) => r.offline.ok);
  const worker = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      try {
        const p = toTaxpayerProfile(await searchGstinPublic(r.input), r.input);
        if (p) r.profile = p;
        else r.lookupError = 'GSTN returned no taxpayer details for this GSTIN';
      } catch (e) {
        r.lookupError = e instanceof GstnError ? describeGstnError(e) : (e as Error).message;
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return out;
}

/* ---------- GST portal "Search Taxpayer" (CAPTCHA typed by the user) ---------- */

const PORTAL = 'https://services.gst.gov.in/services';
const PORTAL_HEADERS = {
  accept: 'application/json, text/plain, */*',
  referer: `${PORTAL}/searchtp`,
  origin: 'https://services.gst.gov.in',
};
const CAPTCHA_TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 20_000;

interface PendingCaptcha { cookie: string; userId: string; exp: number }
/** Portal cookies per CAPTCHA, kept server-side only. Per-instance (like the rate limiter); survives dev HMR. */
const g = globalThis as unknown as { __gstPortalCaptcha?: Map<string, PendingCaptcha> };
const pending = (g.__gstPortalCaptcha ??= new Map());

function prune(userId: string) {
  const now = Date.now();
  const mine: string[] = [];
  for (const [k, v] of pending) {
    if (v.exp < now) pending.delete(k);
    else if (v.userId === userId) mine.push(k);
  }
  // Keep at most a few open CAPTCHAs per user.
  for (const k of mine.slice(0, Math.max(0, mine.length - 4))) pending.delete(k);
}

function absorb(jar: Map<string, string>, res: Response) {
  for (const c of res.headers.getSetCookie()) {
    const kv = c.split(';')[0];
    const i = kv.indexOf('=');
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
}
const cookieHeader = (jar: Map<string, string>) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

async function portalFetch(url: string, init: RequestInit) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), cache: 'no-store' });
  } catch (e) {
    throw new HttpError(502, `Could not reach the GST portal (${(e as Error).name === 'TimeoutError' ? 'timed out' : 'network error'}). Try again, or use the Sandbox API.`);
  }
}

/** Opens a portal search session and returns its CAPTCHA image for the user to read. */
export async function portalCaptcha(userId: string): Promise<{ sessionId: string; image: string; expiresInSec: number }> {
  prune(userId);
  const jar = new Map<string, string>();
  const page = await portalFetch(`${PORTAL}/searchtp`, { headers: { accept: 'text/html' } });
  absorb(jar, page);
  await page.arrayBuffer().catch(() => undefined);
  const img = await portalFetch(`${PORTAL}/captcha?rnd=${Math.random()}`, { headers: { ...PORTAL_HEADERS, accept: 'image/*', cookie: cookieHeader(jar) } });
  absorb(jar, img);
  const type = img.headers.get('content-type') ?? '';
  if (!img.ok || !type.startsWith('image/')) throw new HttpError(502, `The GST portal did not return a CAPTCHA (HTTP ${img.status}). It may be down or busy – try again shortly.`);
  const buf = Buffer.from(await img.arrayBuffer());
  const sessionId = randomUUID();
  pending.set(sessionId, { cookie: cookieHeader(jar), userId, exp: Date.now() + CAPTCHA_TTL_MS });
  return { sessionId, image: `data:${type.split(';')[0]};base64,${buf.toString('base64')}`, expiresInSec: CAPTCHA_TTL_MS / 1000 };
}

/** Submits one GSTIN with the CAPTCHA the user typed. Each CAPTCHA is used once. */
export async function portalSearch(userId: string, sessionId: string, gstin: string, captcha: string): Promise<GstinResult> {
  const offline = describeGstin(gstin);
  if (!checkGstin(gstin).ok) return { input: gstin, offline, lookupError: 'Not searched – fix the GSTIN first' };
  const p = pending.get(sessionId);
  pending.delete(sessionId);
  if (!p || p.userId !== userId || p.exp < Date.now()) throw new HttpError(410, 'This CAPTCHA has expired. Load a new one.');
  const res = await portalFetch(`${PORTAL}/api/search/taxpayerDetails`, {
    method: 'POST',
    headers: { ...PORTAL_HEADERS, 'content-type': 'application/json', cookie: p.cookie },
    body: JSON.stringify({ gstin, captcha }),
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const profile = toTaxpayerProfile(body, gstin);
  if (profile) return { input: gstin, offline, profile };
  const err = (body?.error && typeof body.error === 'object' ? body.error : body ?? {}) as Record<string, unknown>;
  const code = typeof err.errorCode === 'string' ? err.errorCode : typeof err.error_cd === 'string' ? err.error_cd : undefined;
  const msg = typeof err.message === 'string' ? err.message : typeof err.detailMessage === 'string' ? err.detailMessage : undefined;
  // The portal answers HTTP 200 with an error code; SWEB_9000 is a mistyped CAPTCHA. Others are shown as-is.
  if (code === 'SWEB_9000') throw new HttpError(422, 'The characters did not match the CAPTCHA (GST portal SWEB_9000). A new image has been loaded – try again.');
  throw new HttpError(422, `GST portal${code ? ` ${code}` : ''}: ${msg ?? (res.ok ? 'no taxpayer details returned' : `HTTP ${res.status}`)}`);
}
