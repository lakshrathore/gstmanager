/**
 * Pure helpers for the Sandbox.co.in GST Compliance API (no I/O, no server-only imports – unit-tested).
 * Shapes follow https://developer.sandbox.co.in (Authenticate, Taxpayer OTP, Save GSTR-1, GST Return
 * Status, New Proceed to File, GSTR-1 Summary, Generate EVC OTP, File GSTR-1, Track Returns).
 */

/** A business or transport failure reported by Sandbox/GSTN. `code` is GSTN's error_cd when present. */
export class GstnError extends Error {
  constructor(
    message: string,
    public code?: string,
    public httpStatus?: number,
    public transactionId?: string,
  ) {
    super(message);
    this.name = 'GstnError';
  }
}

/** Taxpayer session missing, expired or rejected – the user must log in again with an OTP. */
export class GstnSessionError extends GstnError {
  constructor(message = 'GST login has expired. Log in again with an OTP.', code?: string) {
    super(message, code);
    this.name = 'GstnSessionError';
  }
}

/** GSTN error codes that mean the taxpayer session is no longer valid. */
const SESSION_CODES = new Set(['AUTH4033', 'AUTH4037', 'AUTH158', 'RET11402']);
export const isSessionErrorCode = (code?: string) => !!code && SESSION_CODES.has(code);

interface Envelope {
  code?: number;
  message?: string;
  transaction_id?: string;
  data?: {
    status_cd?: string;
    error?: { error_cd?: string; message?: string; error_msg?: string };
    data?: unknown;
    [k: string]: unknown;
  };
}

/**
 * Unwraps a Sandbox response. Sandbox answers HTTP 200 with `data.status_cd: "0"` for GSTN business
 * errors, and a non-200 `code` with `message` for its own validation errors; both become GstnError
 * carrying GSTN's real code and message.
 */
export function unwrap(httpStatus: number, body: unknown): { data: Record<string, unknown>; inner: unknown; transactionId?: string } {
  const env = (body && typeof body === 'object' ? body : {}) as Envelope;
  const tx = env.transaction_id;
  const code = typeof env.code === 'number' ? env.code : httpStatus;
  if (httpStatus === 401 || code === 401) throw new GstnSessionError(env.message || 'Sandbox rejected the access token', '401');
  if (httpStatus >= 400 || code >= 400) {
    throw new GstnError(env.message || `Sandbox API returned HTTP ${code}`, String(code), httpStatus, tx);
  }
  const data = (env.data ?? {}) as NonNullable<Envelope['data']>;
  if (data.status_cd === '0' || data.error) {
    const errCd = data.error?.error_cd;
    const msg = data.error?.message || data.error?.error_msg || 'GSTN rejected the request';
    if (isSessionErrorCode(errCd)) throw new GstnSessionError(`GSTN ${errCd}: ${msg}`, errCd);
    throw new GstnError(msg, errCd, httpStatus, tx);
  }
  return { data: data as Record<string, unknown>, inner: data.data, transactionId: tx };
}

/** What usually causes common GSTN errors – appended to (never replacing) GSTN's own message. */
const HINTS: Record<string, string> = {
  AUTH4041: 'The GST username usually belongs to a different GSTIN/state. Use the username registered for this return’s GSTIN.',
  AUTH403: 'GSTN allows a limited number of API sessions per user. Wait for an older session to expire, then try again.',
  OTP0010: 'The PAN must be an authorised signatory of this GSTIN on the GST portal.',
};

/** User-facing text for a GSTN error: always GSTN's own code and message (plus a hint for common codes). */
export const describeGstnError = (e: GstnError) =>
  `${e.code && !/^\d+$/.test(e.code) ? `GSTN ${e.code}: ` : ''}${e.message}${e.code && HINTS[e.code] ? ` – ${HINTS[e.code]}` : ''}${e.transactionId ? ` (Sandbox transaction ${e.transactionId})` : ''}`;

/** "MMYYYY" → path params used by the return endpoints. */
export function splitPeriod(fp: string): { year: string; month: string } {
  if (!/^(0[1-9]|1[0-2])\d{4}$/.test(fp)) throw new Error(`Invalid return period ${fp}`);
  return { year: fp.slice(2), month: fp.slice(0, 2) };
}

/**
 * Body for Save GSTR-1. The generated JSON is the offline-tool format; the API body is the same
 * document without the offline-tool envelope fields (`version`, `hash`). Nothing else is touched.
 */
export function saveBody(payload: string): Record<string, unknown> {
  const body = JSON.parse(payload) as Record<string, unknown>;
  delete body.version;
  delete body.hash;
  return body;
}

/* ---------- return status ---------- */

export type GstnProcessingState = 'processing' | 'processed' | 'error';

/** P = processed, PE = processed with errors, ER = error, REC/IP = received / in progress. */
export function processingState(statusCd: string): GstnProcessingState {
  if (statusCd === 'P') return 'processed';
  if (statusCd === 'PE' || statusCd === 'ER') return 'error';
  return 'processing';
}

export const STATUS_CD_LABEL: Record<string, string> = {
  P: 'Processed', PE: 'Processed with errors', ER: 'Error', REC: 'Request received', IP: 'In progress',
};

const DOC_KEYS = ['inv', 'nt', 'data', 'doc_det', 'docs'];
const hasMsg = (o: Record<string, unknown>) => typeof (o.error_msg ?? o.error_message) === 'string';

/**
 * GSTN attaches an error to a group (e.g. a b2b `ctin` entry) and lists the failing documents under
 * it (`inv: [...]`). The app's error-report parser reads the document number from the node that
 * carries the message, so each grouped error is expanded into one entry per document, keeping the
 * group's fields and GSTN's code/message unchanged.
 */
export function flattenErrorReport(report: unknown): unknown {
  const expand = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.flatMap((n) => split(expand(n)));
    if (!node || typeof node !== 'object') return node;
    return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, expand(v)]));
  };
  const split = (node: unknown): unknown[] => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return [node];
    const o = node as Record<string, unknown>;
    if (!hasMsg(o)) return [o];
    const key = DOC_KEYS.find((k) => Array.isArray(o[k]) && (o[k] as unknown[]).length && (o[k] as unknown[]).every((c) => c && typeof c === 'object' && !hasMsg(c as Record<string, unknown>)));
    if (!key) return [o];
    const { [key]: docs, ...group } = o;
    return (docs as Record<string, unknown>[]).map((d) => ({ ...group, ...d, error_cd: o.error_cd, error_msg: o.error_msg ?? o.error_message }));
  };
  return expand(report);
}

/** GSTN's own "code: message" lines from an error report (first `max`). */
export function errorLines(report: unknown, max = 5): string[] {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (out.length >= max || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    const o = n as Record<string, unknown>;
    const msg = o.error_msg ?? o.error_message ?? o.message;
    if (typeof msg === 'string' && msg.trim()) out.push(`${o.error_cd ?? o.error_code ? `${o.error_cd ?? o.error_code}: ` : ''}${msg.trim()}`);
    Object.values(o).forEach(walk);
  };
  walk(report);
  return out;
}

/* ---------- summary ---------- */

export interface SectionSummary {
  sec_nm: string;
  ttl_rec?: number;
  ttl_val?: number;
  ttl_tax?: number;
  ttl_igst?: number;
  ttl_cgst?: number;
  ttl_sgst?: number;
  ttl_cess?: number;
  chksum?: string;
  [k: string]: unknown;
}

export interface Gstr1Summary {
  gstin?: string;
  ret_period?: string;
  chksum: string;
  sec_sum: SectionSummary[];
  [k: string]: unknown;
}

export function parseSummary(inner: unknown): Gstr1Summary {
  const s = (inner ?? {}) as Partial<Gstr1Summary>;
  if (!s.chksum || !Array.isArray(s.sec_sum)) throw new GstnError('GSTN returned a GSTR-1 summary without a checksum or sections');
  return s as Gstr1Summary;
}

/** Body for File GSTR-1: the summary exactly as GSTN returned it (its checksum binds the filing). */
export function fileBody(summary: Gstr1Summary, gstin: string, fp: string) {
  return { ret_period: fp, gstin, chksum: summary.chksum, sec_sum: summary.sec_sum, newSumFlag: true };
}

/** Acknowledgement number from a File GSTR-1 response, if GSTN sent one. */
export function ackNumber(data: Record<string, unknown>, inner: unknown): string | undefined {
  const i = (inner && typeof inner === 'object' ? inner : {}) as Record<string, unknown>;
  const v = i.ack_num ?? i.ackNum ?? i.reference_id ?? data.ack_num ?? data.reference_id;
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/* ---------- track returns ---------- */

export interface FiledReturn {
  arn?: string;
  ret_prd?: string;
  rtntype?: string;
  status?: string;
  dof?: string;
  mof?: string;
  valid?: string;
}

export function filingsFrom(inner: unknown): FiledReturn[] {
  const i = (inner ?? {}) as { EFiledlist?: FiledReturn[] };
  return Array.isArray(i.EFiledlist) ? i.EFiledlist : [];
}

/** The filed return of a type ("GSTR1", "GSTR3B") for this period, if GSTN lists one with an ARN. */
export function findFiling(list: FiledReturn[], fp: string, rtntype: 'GSTR1' | 'GSTR3B'): FiledReturn | undefined {
  return list.find(
    (r) => (r.rtntype ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '') === rtntype && r.ret_prd === fp && /filed/i.test(r.status ?? '') && !!r.arn,
  );
}

/** The filed GSTR-1 for this period, if GSTN lists one with an ARN. */
export const findGstr1Filing = (list: FiledReturn[], fp: string) => findFiling(list, fp, 'GSTR1');

/** GSTN dates are dd-mm-yyyy. */
export function parseGstnDate(s?: string): Date | null {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s ?? '');
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
  return isNaN(d.getTime()) ? null : d;
}

/* ---------- masking ---------- */

export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const maskPan = (pan: string) => (pan.length === 10 ? `${pan.slice(0, 3)}****${pan.slice(7)}` : '****');
export const maskUsername = (u: string) => (u.length <= 3 ? '***' : `${u.slice(0, 2)}${'*'.repeat(Math.min(u.length - 3, 8))}${u.slice(-1)}`);
