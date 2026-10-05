import 'server-only';
import { audit } from '../audit';
import type { Auth } from '../auth';
import { decrypt, encrypt } from '../crypto';
import { HttpError } from '../http';
import { GeneratedJson, GstProfile, GstReturn, GstSession, oid, UploadJob } from '../models';
import { importPortalErrors, jsonFileName, loadCompany, loadReturn } from '../services/returns';
import { PortalHttpClient } from './httpClient';
import { portalProtocol } from './protocol';
import { PortalNotConfiguredError, PortalSessionExpiredError, type LoginStep } from './types';

export const PORTAL_MODE: 'http' | 'manual' = process.env.PORTAL_MODE === 'http' ? 'http' : 'manual';
const IDLE_MINUTES = Number(process.env.PORTAL_SESSION_IDLE_MINUTES ?? 15);

const aad = (orgId: string, companyId: string) => `${orgId}:${companyId}:portal-session`;

/* ---------- session persistence (encrypted, per company) ---------- */

async function loadClient(auth: Auth, companyId: string) {
  const s = await GstSession.findOne({ orgId: oid(auth.orgId), companyId: oid(companyId) }).select('+jarEnc').lean();
  if (!s?.jarEnc) return { session: s, http: PortalHttpClient.create(companyId) };
  return { session: s, http: await PortalHttpClient.restore(decrypt(s.jarEnc, aad(auth.orgId, companyId)), companyId) };
}

async function persist(auth: Auth, companyId: string, gstin: string, http: PortalHttpClient | null, step: LoginStep | { state: 'expired' | 'none'; message?: string }) {
  const active = step.state === 'active';
  await GstSession.updateOne(
    { orgId: oid(auth.orgId), companyId: oid(companyId) },
    {
      $set: {
        gstin, state: step.state === 'not_applicable' ? 'none' : step.state,
        jarEnc: http && step.state !== 'expired' && step.state !== 'none' ? encrypt(await http.serialize(), aad(auth.orgId, companyId)) : null,
        expiresAt: active ? new Date(Date.now() + IDLE_MINUTES * 60_000) : null,
        lastActivityAt: new Date(),
        message: 'message' in step ? step.message : undefined,
        startedBy: oid(auth.userId),
      },
    },
    { upsert: true },
  );
}

/** Public view – never includes cookies or scratch state. */
function view(step: LoginStep | null, s: { state?: string; expiresAt?: Date | null; message?: string | null } | null) {
  return {
    mode: PORTAL_MODE,
    protocolConfigured: portalProtocol.configured,
    state: step?.state ?? s?.state ?? 'none',
    expiresAt: step && step.state === 'active' ? step.expiresAt : s?.expiresAt ?? null,
    message: (step && 'message' in step ? step.message : s?.message) ?? null,
    captchaImage: step?.state === 'captcha_required' ? `data:${step.captchaMime};base64,${step.captchaImage}` : null,
  };
}

function ensureHttpMode() {
  if (PORTAL_MODE !== 'http') throw new HttpError(409, 'Portal HTTP mode is disabled (PORTAL_MODE=manual). Use the manual upload workflow.');
  if (!portalProtocol.configured) throw new HttpError(501, new PortalNotConfiguredError().message);
}

async function guard<T>(auth: Auth, companyId: string, gstin: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PortalSessionExpiredError) {
      await persist(auth, companyId, gstin, null, { state: 'expired', message: e.message });
      throw new HttpError(440, e.message);
    }
    if (e instanceof PortalNotConfiguredError) throw new HttpError(501, e.message);
    throw e;
  }
}

/* ---------- GSTAuthService ---------- */

export const GSTAuthService = {
  async status(auth: Auth, companyId: string) {
    await loadCompany(auth, companyId);
    const s = await GstSession.findOne({ orgId: oid(auth.orgId), companyId: oid(companyId) }).lean();
    const profile = await GstProfile.findOne({ orgId: oid(auth.orgId), companyId: oid(companyId) }).lean();
    const v = view(null, s);
    if (v.state === 'active' && s?.expiresAt && s.expiresAt < new Date()) v.state = 'expired';
    return { ...v, savedUsername: profile?.usernameEnc ? decrypt(profile.usernameEnc, aad(auth.orgId, companyId)) : null };
  },

  /** Step 1: user gives portal username; portal returns a CAPTCHA image for the user to read. */
  async startLogin(auth: Auth, companyId: string, username: string, remember: boolean) {
    ensureHttpMode();
    const company = await loadCompany(auth, companyId);
    if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) throw new HttpError(400, 'Invalid portal username');
    const http = PortalHttpClient.create(companyId);
    http.scratch.username = username;
    const step = await guard(auth, companyId, company.gstin, () => portalProtocol.beginLogin(http, username));
    await persist(auth, companyId, company.gstin, http, step);
    if (remember) {
      await GstProfile.updateOne({ orgId: oid(auth.orgId), companyId: oid(companyId) }, { $set: { usernameEnc: encrypt(username, aad(auth.orgId, companyId)) } }, { upsert: true });
    }
    await audit(auth, 'portal.login_started', 'Company', companyId, { gstin: company.gstin, next: step.state });
    return view(step, null);
  },

  async refreshCaptcha(auth: Auth, companyId: string) {
    ensureHttpMode();
    const company = await loadCompany(auth, companyId);
    const { http } = await loadClient(auth, companyId);
    const step = await guard(auth, companyId, company.gstin, () => portalProtocol.refreshCaptcha(http));
    await persist(auth, companyId, company.gstin, http, step);
    return view(step, null);
  },

  /** Step 2: password + the CAPTCHA text the user typed. Password is forwarded once and never stored. */
  async submitUserProvidedCaptcha(auth: Auth, companyId: string, password: string, captcha: string) {
    ensureHttpMode();
    const company = await loadCompany(auth, companyId);
    const { http, session } = await loadClient(auth, companyId);
    if (session?.state !== 'captcha_required' || !http.scratch.username) throw new HttpError(409, 'Start the login again');
    const step = await guard(auth, companyId, company.gstin, () =>
      portalProtocol.submitCredentials(http, { username: http.scratch.username, password, captcha }),
    );
    await persist(auth, companyId, company.gstin, http, step);
    await audit(auth, 'portal.credentials_submitted', 'Company', companyId, { gstin: company.gstin, result: step.state });
    return view(step, null);
  },

  /** Step 3 (if required): OTP typed by the user. */
  async verifyUserProvidedOtp(auth: Auth, companyId: string, otp: string) {
    ensureHttpMode();
    const company = await loadCompany(auth, companyId);
    if (!/^\d{4,8}$/.test(otp)) throw new HttpError(400, 'OTP must be 4–8 digits');
    const { http, session } = await loadClient(auth, companyId);
    if (session?.state !== 'otp_required') throw new HttpError(409, 'No OTP is pending for this session');
    const step = await guard(auth, companyId, company.gstin, () => portalProtocol.submitOtp(http, otp));
    await persist(auth, companyId, company.gstin, http, step);
    await audit(auth, 'portal.otp_submitted', 'Company', companyId, { gstin: company.gstin, result: step.state });
    return view(step, null);
  },

  /** Confirms the session is still valid; extends the idle window when it is. */
  async checkSession(auth: Auth, companyId: string) {
    const company = await loadCompany(auth, companyId);
    const { http, session } = await loadClient(auth, companyId);
    if (session?.state !== 'active') return { ...view(null, session), state: session?.state ?? 'none' };
    const expiredLocally = !session.expiresAt || session.expiresAt < new Date();
    const alive = !expiredLocally && portalProtocol.configured && (await guard(auth, companyId, company.gstin, () => portalProtocol.isAlive(http)));
    if (!alive) {
      await persist(auth, companyId, company.gstin, null, { state: 'expired', message: 'Session expired – sign in again' });
      return { ...view(null, { state: 'expired', message: 'Session expired – sign in again' }) };
    }
    const step: LoginStep = { state: 'active', expiresAt: new Date(Date.now() + IDLE_MINUTES * 60_000).toISOString() };
    await persist(auth, companyId, company.gstin, http, step);
    return view(step, null);
  },

  async logout(auth: Auth, companyId: string) {
    const company = await loadCompany(auth, companyId);
    const { http, session } = await loadClient(auth, companyId);
    if (session?.state === 'active' && portalProtocol.configured) await portalProtocol.logout(http).catch(() => {});
    await persist(auth, companyId, company.gstin, null, { state: 'none' });
    await audit(auth, 'portal.logout', 'Company', companyId, { gstin: company.gstin });
    return view(null, { state: 'none' });
  },
};

/* ---------- PortalAdapter (upload / status / errors) ---------- */

async function requireActive(auth: Auth, companyId: string) {
  const st = await GSTAuthService.checkSession(auth, companyId);
  if (st.state !== 'active') throw new HttpError(440, 'GST portal session is not active – sign in (CAPTCHA/OTP) first');
  return loadClient(auth, companyId);
}

export const PortalAdapter = {
  async uploadGstr1(auth: Auth, returnId: string, mode: 'http' | 'manual') {
    const { ret, company } = await loadReturn(auth, returnId);
    if (!ret.currentJsonId || ret.jsonStale) throw new HttpError(409, 'Generate the JSON again – records changed since the last generation');
    const json = await GeneratedJson.findOne({ _id: ret.currentJsonId, orgId: ret.orgId }).lean();
    if (!json) throw new HttpError(404, 'Generated JSON not found');
    const job = await UploadJob.create({
      orgId: ret.orgId, returnId: ret._id, jsonId: json._id, mode, createdBy: oid(auth.userId),
      status: mode === 'manual' ? 'awaiting_manual_upload' : 'pending',
      history: [{ at: new Date(), status: mode === 'manual' ? 'awaiting_manual_upload' : 'pending', note: `sha256 ${json.sha256}` }],
    });
    if (mode === 'manual') {
      await audit(auth, 'upload.manual_started', 'UploadJob', String(job._id), { returnId, sha256: json.sha256 });
      return job.toObject();
    }
    ensureHttpMode();
    const { http } = await requireActive(auth, String(company._id));
    try {
      const { referenceId } = await guard(auth, String(company._id), company.gstin, () =>
        portalProtocol.uploadReturn(http, { gstin: company.gstin, fp: ret.fp, payload: json.payload, fileName: jsonFileName(company.gstin, ret.fp) }),
      );
      await UploadJob.updateOne({ _id: job._id }, { $set: { status: 'processing', referenceId }, $inc: { attempts: 1 }, $push: { history: { at: new Date(), status: 'processing', note: `ref ${referenceId}` } } });
      await GstReturn.updateOne({ _id: ret._id }, { $set: { status: 'processing' } });
      await audit(auth, 'upload.submitted', 'UploadJob', String(job._id), { returnId, referenceId, sha256: json.sha256 });
    } catch (e) {
      await UploadJob.updateOne({ _id: job._id }, { $set: { status: 'failed', lastError: (e as Error).message }, $inc: { attempts: 1 } });
      await audit(auth, 'upload.failed', 'UploadJob', String(job._id), { returnId, error: (e as Error).message });
      throw e;
    }
    return UploadJob.findById(job._id).lean();
  },

  async checkUploadStatus(auth: Auth, returnId: string) {
    const { ret, company } = await loadReturn(auth, returnId);
    const job = await UploadJob.findOne({ orgId: ret.orgId, returnId: ret._id }).sort({ createdAt: -1 }).lean();
    if (!job) throw new HttpError(404, 'No upload yet');
    if (job.mode !== 'http' || !job.referenceId || job.status !== 'processing') return job;
    const { http } = await requireActive(auth, String(company._id));
    const st = await guard(auth, String(company._id), company.gstin, () =>
      portalProtocol.uploadStatus(http, { gstin: company.gstin, fp: ret.fp, referenceId: job.referenceId! }),
    );
    await UploadJob.updateOne({ _id: job._id }, { $set: { status: st.status }, $push: { history: { at: new Date(), status: st.status, note: st.message } } });
    if (st.status === 'processed_with_errors' && st.errorReport) await importPortalErrors(auth, returnId, st.errorReport);
    else if (st.status !== 'processing') await GstReturn.updateOne({ _id: ret._id }, { $set: { status: st.status === 'failed' ? 'json_generated' : st.status } });
    return UploadJob.findById(job._id).lean();
  },

  async retrieveReturnStatus(auth: Auth, returnId: string) {
    const { ret, company } = await loadReturn(auth, returnId);
    ensureHttpMode();
    const { http } = await requireActive(auth, String(company._id));
    return guard(auth, String(company._id), company.gstin, () => portalProtocol.returnStatus(http, { gstin: company.gstin, fp: ret.fp }));
  },

  /** Manual workflow: user confirms what happened on the portal. */
  async markManual(auth: Auth, returnId: string, status: 'uploaded' | 'processed' | 'filed', note?: string) {
    const { ret } = await loadReturn(auth, returnId);
    const job = await UploadJob.findOne({ orgId: ret.orgId, returnId: ret._id }).sort({ createdAt: -1 }).lean();
    if (!job) throw new HttpError(409, 'Start an upload first');
    await UploadJob.updateOne({ _id: job._id }, { $set: { status: status === 'filed' ? 'processed' : status }, $push: { history: { at: new Date(), status, note } } });
    await GstReturn.updateOne({ _id: ret._id }, { $set: { status } });
    await audit(auth, `upload.manual_${status}`, 'UploadJob', String(job._id), { returnId, note });
    return { ok: true };
  },
};
