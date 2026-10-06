import 'server-only';
import { decrypt, encrypt } from '../../crypto';
import { GstApiSession, oid } from '../../models';
import type { ClientContext, ClientSession, GstClient, UploadContext } from './index';
import {
  ackNumber, fileBody, filingsFrom, GstnError, GstnSessionError, maskUsername, parseSummary, processingState,
  saveBody, splitPeriod, unwrap, type Gstr1Summary,
} from './sandbox-protocol';

/**
 * Sandbox.co.in GST Compliance API client.
 *
 * Two tokens are involved:
 *   - the Sandbox platform token (POST /authenticate with API key + secret, 24 h) authorises
 *     Generate/Verify OTP; it is cached in memory only;
 *   - the taxpayer access token returned by Verify OTP (≈6 h) authorises every return call. It is stored
 *     AES-256-GCM encrypted per company, refreshed shortly before it expires, and never returned to
 *     the browser, logged or written to evidence.
 *
 * Nothing here logs request/response bodies, OTPs, PANs, tokens or the API secret.
 */

const API_VERSION = '1.0.0';
/** Sandbox requires x-source on GST calls ("primary" or "secondary" GSTN route; docs default: primary). */
const X_SOURCE = process.env.SANDBOX_X_SOURCE === 'secondary' ? 'secondary' : 'primary';
const TIMEOUT_MS = 30_000;
/** Refresh the taxpayer token when it has less than this left. */
const REFRESH_BEFORE_MS = 20 * 60_000;
const DEFAULT_SESSION_MS = 6 * 3600_000;

function config() {
  const key = process.env.SANDBOX_API_KEY;
  const secret = process.env.SANDBOX_API_SECRET;
  const base = (process.env.SANDBOX_API_BASE ?? 'https://test-api.sandbox.co.in').replace(/\/+$/, '');
  if (!key || !secret) throw new GstnError('Sandbox API is not configured: set SANDBOX_API_KEY and SANDBOX_API_SECRET in .env.local');
  const testBase = /\/\/test-api\./.test(base);
  if (key.startsWith('key_live_') && testBase) throw new GstnError('SANDBOX_API_KEY is a live key but SANDBOX_API_BASE is the test environment. Use key_test_… keys with https://test-api.sandbox.co.in.');
  if (key.startsWith('key_test_') && !testBase) throw new GstnError('SANDBOX_API_KEY is a test key but SANDBOX_API_BASE is the live environment. Use https://test-api.sandbox.co.in.');
  return { key, secret, base };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RequestOpts {
  token: string;
  body?: unknown;
  query?: Record<string, string>;
}

/** One HTTP call. Only GETs are retried (on 429/5xx/network errors); POSTs to GSTN are never repeated. */
async function request(method: 'GET' | 'POST', path: string, opts: RequestOpts) {
  const { key, base } = config();
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const attempts = method === 'GET' ? 3 : 1;
  for (let i = 0; ; i++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: opts.token, 'x-api-key': key, 'x-api-version': API_VERSION, 'x-source': X_SOURCE,
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: 'no-store',
      });
    } catch (e) {
      if (i + 1 < attempts) { await sleep(1000 * 2 ** i); continue; }
      throw new GstnError(`Could not reach the Sandbox API (${(e as Error).name === 'TimeoutError' ? 'timed out' : 'network error'})`);
    }
    if ((res.status === 429 || res.status >= 500) && i + 1 < attempts) {
      await sleep(Number(res.headers.get('retry-after')) * 1000 || 1000 * 2 ** i);
      continue;
    }
    const body = await res.json().catch(() => ({}));
    return unwrap(res.status, body);
  }
}

/* ---------- platform token ---------- */

let platform: { token: string; exp: number; key: string } | null = null;

async function platformToken(): Promise<string> {
  const { key, secret, base } = config();
  if (platform && platform.key === key && platform.exp > Date.now()) return platform.token;
  let res: Response;
  try {
    res = await fetch(`${base}/authenticate`, {
      method: 'POST', headers: { 'x-api-key': key, 'x-api-secret': secret }, signal: AbortSignal.timeout(TIMEOUT_MS), cache: 'no-store',
    });
  } catch {
    throw new GstnError('Could not reach the Sandbox API to authenticate');
  }
  const body = (await res.json().catch(() => ({}))) as { code?: number; message?: string; data?: { access_token?: string } };
  const token = body.data?.access_token;
  if (!res.ok || !token) throw new GstnError(`Sandbox authentication failed: ${body.message ?? `HTTP ${res.status}`}. Check SANDBOX_API_KEY / SANDBOX_API_SECRET.`, String(body.code ?? res.status));
  platform = { token, key, exp: Date.now() + 23 * 3600_000 }; // valid 24 h; renew an hour early
  return token;
}

/* ---------- taxpayer session (encrypted, per company) ---------- */

const aad = (ctx: ClientContext) => `${ctx.orgId}:${ctx.companyId}:${ctx.gstin}:gst-api-session`;
const scope = (ctx: ClientContext) => ({ orgId: oid(ctx.orgId), companyId: oid(ctx.companyId) });
const toDate = (ms: unknown) => (typeof ms === 'number' && ms > 0 ? new Date(ms) : null);

async function storeTokens(ctx: ClientContext, data: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const token = data.access_token;
  if (typeof token !== 'string' || !token) throw new GstnError('GSTN did not return a taxpayer access token');
  const sessionExp = toDate(data.session_expiry) ?? new Date(Date.now() + DEFAULT_SESSION_MS);
  const tokenExp = toDate(data.token_expiry) ?? sessionExp;
  await GstApiSession.updateOne(scope(ctx), {
    $set: { state: 'active', tokenEnc: encrypt(token, aad(ctx)), sessionExpiresAt: sessionExp, tokenExpiresAt: tokenExp, ...extra },
  });
  return { token, sessionExp };
}

async function expire(ctx: ClientContext) {
  await GstApiSession.updateOne(scope(ctx), { $set: { state: 'expired', tokenEnc: null } });
}

const refreshing = new Map<string, Promise<string>>();

/** Current taxpayer token, refreshed when close to expiry. Throws GstnSessionError if the user must log in again. */
async function taxpayerToken(ctx: ClientContext): Promise<string> {
  const s = await GstApiSession.findOne(scope(ctx)).select('+tokenEnc').lean();
  if (!s || s.state !== 'active' || !s.tokenEnc) throw new GstnSessionError('Not logged in to GST. Log in with an OTP first.');
  if (s.gstin !== ctx.gstin) throw new GstnSessionError('The GST login belongs to a different GSTIN. Log in again.');
  const now = Date.now();
  const tokenExp = s.tokenExpiresAt?.getTime() ?? 0;
  if (tokenExp <= now) {
    await expire(ctx);
    throw new GstnSessionError();
  }
  const token = decrypt(s.tokenEnc, aad(ctx));
  if (tokenExp - now > REFRESH_BEFORE_MS) return token;

  const k = `${ctx.orgId}:${ctx.companyId}`;
  const pending = refreshing.get(k);
  if (pending) return pending;
  const p = (async () => {
    try {
      const { data } = await request('POST', '/gst/compliance/tax-payer/session/refresh', { token });
      return (await storeTokens(ctx, data, { lastRefreshAt: new Date() })).token;
    } catch (e) {
      if (e instanceof GstnSessionError) await expire(ctx);
      // The current token is still valid for a few minutes – use it rather than failing the call.
      if (!(e instanceof GstnSessionError)) return token;
      throw e;
    } finally {
      refreshing.delete(k);
    }
  })();
  refreshing.set(k, p);
  return p;
}

/** Runs a taxpayer call; a session rejection marks the stored session expired. */
async function withSession<T>(ctx: ClientContext, fn: (token: string) => Promise<T>): Promise<T> {
  const token = await taxpayerToken(ctx);
  try {
    return await fn(token);
  } catch (e) {
    if (e instanceof GstnSessionError) await expire(ctx);
    throw e;
  }
}

const gstr1Path = (fp: string, suffix = '') => {
  const { year, month } = splitPeriod(fp);
  return `/gst/compliance/tax-payer/gstrs/gstr-1/${year}/${month}${suffix}`;
};

/* ---------- client ---------- */

export const sandboxClient: GstClient = {
  id: 'sandbox',
  label: 'Sandbox GST API',
  capabilities: { authenticate: true, upload: true, uploadStatus: true, fileReturn: true },

  async session(ctx): Promise<ClientSession> {
    const s = await GstApiSession.findOne(scope(ctx)).select('+usernameEnc').lean();
    if (!s || s.state === 'none' || s.gstin !== ctx.gstin) return { state: 'none', message: 'Not logged in to GST.' };
    let connectedAs: string | undefined;
    try {
      connectedAs = s.usernameEnc ? maskUsername(decrypt(s.usernameEnc, aad(ctx))) : undefined;
    } catch {
      connectedAs = undefined;
    }
    if (s.state === 'otp_sent') return { state: 'otp_sent', connectedAs, message: 'OTP sent by GSTN to the registered mobile and email. Enter it to log in.' };
    const exp = s.sessionExpiresAt ?? s.tokenExpiresAt;
    if (s.state !== 'active' || !exp || exp.getTime() <= Date.now()) return { state: 'expired', connectedAs, expiresAt: exp, message: 'GST login expired. Log in again with an OTP.' };
    return { state: 'active', connectedAs, expiresAt: exp, message: 'Logged in to GST through the Sandbox API.' };
  },

  async requestLoginOtp(ctx, username, startedBy) {
    const res = await request('POST', '/gst/compliance/tax-payer/otp', { token: await platformToken(), body: { username, gstin: ctx.gstin } });
    await GstApiSession.updateOne(
      scope(ctx),
      {
        $set: {
          gstin: ctx.gstin, client: 'sandbox', state: 'otp_sent', usernameEnc: encrypt(username, aad(ctx)), tokenEnc: null,
          otpSentAt: new Date(), sessionExpiresAt: null, tokenExpiresAt: null, startedBy: oid(startedBy.userId), startedByEmail: startedBy.email,
        },
      },
      { upsert: true },
    );
    return { raw: res.data, transactionId: res.transactionId };
  },

  async verifyLoginOtp(ctx, otp) {
    const s = await GstApiSession.findOne(scope(ctx)).select('+usernameEnc').lean();
    if (!s?.usernameEnc || s.state !== 'otp_sent' || s.gstin !== ctx.gstin) throw new GstnSessionError('Request an OTP first.');
    const username = decrypt(s.usernameEnc, aad(ctx));
    const { data } = await request('POST', '/gst/compliance/tax-payer/otp/verify', {
      token: await platformToken(), query: { otp }, body: { username, gstin: ctx.gstin },
    });
    const { sessionExp } = await storeTokens(ctx, data, { lastRefreshAt: new Date() });
    return { state: 'active', expiresAt: sessionExp, connectedAs: maskUsername(username), message: 'Logged in to GST through the Sandbox API.' };
  },

  async endSession(ctx) {
    await GstApiSession.updateOne(scope(ctx), { $set: { state: 'none', tokenEnc: null, usernameEnc: null, sessionExpiresAt: null, tokenExpiresAt: null } });
  },

  async upload(ctx: UploadContext, payload) {
    const res = await withSession(ctx, (token) => request('POST', gstr1Path(ctx.fp), { token, body: saveBody(payload) }));
    const ref = (res.inner as { reference_id?: string } | undefined)?.reference_id;
    if (!ref) throw new GstnError('GSTN accepted the request but returned no reference ID');
    return { reference: ref, raw: res.data, transactionId: res.transactionId };
  },

  async uploadStatus(ctx: UploadContext, reference) {
    const { year, month } = splitPeriod(ctx.fp);
    const res = await withSession(ctx, (token) =>
      request('GET', `/gst/compliance/tax-payer/gstrs/${year}/${month}/status`, { token, query: { reference_id: reference } }),
    );
    const d = (res.inner ?? {}) as { status_cd?: string; error_report?: unknown };
    const code = d.status_cd ?? '';
    if (!code) throw new GstnError('GSTN returned a status without a status code');
    return { state: processingState(code), code, reference, errorReport: d.error_report, raw: res.data, transactionId: res.transactionId };
  },

  async proceedToFile(ctx: UploadContext) {
    const res = await withSession(ctx, (token) =>
      request('POST', gstr1Path(ctx.fp, '/new-proceed'), { token, query: { is_nil: 'N' }, body: { gstin: ctx.gstin, ret_period: ctx.fp } }),
    );
    const ref = (res.inner as { reference_id?: string } | undefined)?.reference_id;
    if (!ref) throw new GstnError('GSTN accepted proceed-to-file but returned no reference ID');
    return { reference: ref, raw: res.data, transactionId: res.transactionId };
  },

  async summary(ctx: UploadContext) {
    const res = await withSession(ctx, (token) => request('GET', gstr1Path(ctx.fp), { token, query: { summary_type: 'long' } }));
    return { summary: parseSummary(res.inner), raw: res.data, transactionId: res.transactionId };
  },

  async requestEvcOtp(ctx: UploadContext, pan) {
    const res = await withSession(ctx, (token) =>
      request('POST', '/gst/compliance/tax-payer/evc/otp', { token, query: { gstr: 'gstr-1' }, body: { pan } }),
    );
    return { raw: res.data, transactionId: res.transactionId };
  },

  async fileReturn(ctx: UploadContext, pan, otp, summary: Gstr1Summary) {
    const res = await withSession(ctx, (token) =>
      request('POST', gstr1Path(ctx.fp, '/file'), { token, query: { pan, otp }, body: fileBody(summary, ctx.gstin, ctx.fp) }),
    );
    return { ackNum: ackNumber(res.data, res.inner), raw: res.data, transactionId: res.transactionId };
  },

  async trackReturn(ctx: UploadContext) {
    const { year, month } = splitPeriod(ctx.fp);
    const res = await withSession(ctx, (token) =>
      request('GET', `/gst/compliance/tax-payer/gstrs/${year}/${month}/track`, { token, query: { return_type: 'gstr-1' } }),
    );
    return { filings: filingsFrom(res.inner), raw: res.data, transactionId: res.transactionId };
  },
};

/* ---------- public taxpayer search (no taxpayer login needed) ---------- */

/** True when Sandbox API keys are configured, whatever GST_INTEGRATION is set to. */
export const sandboxConfigured = () => !!(process.env.SANDBOX_API_KEY && process.env.SANDBOX_API_SECRET);

/** Sandbox "Search GSTIN" – GSTN's public taxpayer details for any GSTIN. Returns GSTN's raw record. */
export async function searchGstinPublic(gstin: string): Promise<unknown> {
  const res = await request('POST', '/gst/compliance/public/gstin/search', { token: await platformToken(), body: { gstin } });
  return res.inner;
}

/* ---------- inward returns (GSTR-2A / GSTR-2B) for purchase reconciliation ---------- */

/** GSTN codes meaning "nothing for this period" rather than a failure. */
const NO_DATA = new Set(['RET13509', 'RET13510', 'RET2B1016']);

/**
 * GSTR-2A (all sections, one call) or GSTR-2B for a period, as GSTN's JSON – the same shape as the
 * portal download, so the file reader handles both. Large GSTR-2B files come in parts (`fc`), which are
 * fetched one by one and merged.
 */
export async function fetchInwardReturn(ctx: ClientContext, kind: 'gstr2a' | 'gstr2b', fp: string): Promise<unknown> {
  const { year, month } = splitPeriod(fp);
  return withSession(ctx, async (token) => {
    try {
      if (kind === 'gstr2a') {
        const { inner } = await request('GET', `/gst/compliance/tax-payer/gstrs/gstr-2a/${year}/${month}`, { token });
        const doc = (inner ?? {}) as Record<string, unknown>;
        if (doc.token && !doc.b2b && !doc.cdn) {
          throw new GstnError('GSTN is preparing a large GSTR-2A file for this period. Try again in a few minutes, or download the Excel/JSON from the GST portal and upload it here.');
        }
        return doc;
      }
      const path = `/gst/compliance/tax-payer/gstrs/gstr-2b/${year}/${month}`;
      const first = (await request('GET', path, { token })).inner as { data?: { fc?: number; docdata?: Record<string, unknown[]> } } | undefined;
      const fc = Number(first?.data?.fc ?? 0);
      if (!first || fc <= 1) return first ?? {};
      const docdata: Record<string, unknown[]> = {};
      for (let i = 1; i <= fc; i++) {
        const part = (await request('GET', path, { token, query: { file_number: String(i) } })).inner as { data?: { docdata?: Record<string, unknown[]> } } | undefined;
        for (const [k, v] of Object.entries(part?.data?.docdata ?? {})) if (Array.isArray(v)) (docdata[k] ??= []).push(...v);
      }
      return { ...first, data: { ...first.data, docdata } };
    } catch (e) {
      if (e instanceof GstnError && !(e instanceof GstnSessionError) && e.code && NO_DATA.has(e.code)) return {};
      if (e instanceof GstnError && e.code === 'RET2B1023') {
        throw new GstnError('GSTR-2B for this period is not generated yet (GSTN generates it on the 14th of the following month).', e.code, e.httpStatus, e.transactionId);
      }
      throw e;
    }
  });
}
