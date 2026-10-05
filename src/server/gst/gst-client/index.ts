import 'server-only';
import type { FiledReturn, GstnProcessingState, Gstr1Summary } from './sandbox-protocol';
import { sandboxClient } from './sandbox';

export { GstnError, GstnSessionError, describeGstnError } from './sandbox-protocol';

/**
 * Boundary between the app and whatever moves a return to GSTN.
 *
 * `manual`: the user signs in on the GST portal in their own browser and uploads the JSON there.
 * `sandbox`: Sandbox.co.in GST Compliance API (an authorised GSP route) – login OTP, save, status,
 * proceed to file, summary, EVC OTP, file and track, all from inside the app. Nothing outside src/server/gst/gst-upload,
 * gst-login and gst-session talks to a client, so GSTR-1 import, validation, the data model, JSON
 * generation, error mapping, audit and status rules stay untouched when one is added.
 *
 * Rules for any implementation: use only documented, officially supported interfaces; never solve or
 * bypass CAPTCHA/OTP; never fabricate references, acknowledgements or processing results.
 */
export interface GstClientCapabilities {
  /** Can authenticate the taxpayer from inside the app (OTP typed by the user). */
  authenticate: boolean;
  /** Can submit the generated JSON itself. */
  upload: boolean;
  /** Can fetch processing status / error report itself. */
  uploadStatus: boolean;
  /** Can run proceed-to-file, fetch GSTN's summary, send the EVC OTP, file and fetch the ARN. */
  fileReturn: boolean;
}

/** Identifies the taxpayer session: one per company, scoped to the tenant. */
export interface ClientContext {
  orgId: string;
  companyId: string;
  gstin: string;
}

export interface UploadContext extends ClientContext {
  fp: string;
}

export interface ClientSession {
  state: 'none' | 'otp_sent' | 'active' | 'expired';
  message: string;
  expiresAt?: Date | null;
  /** Masked GST username. */
  connectedAs?: string;
}

/** Any GSTN response the app keeps as evidence. Never contains tokens. */
export interface ClientResponse {
  raw: unknown;
  transactionId?: string;
}

export interface ClientUploadResult extends ClientResponse {
  /** Reference issued by GSTN for the submission. */
  reference: string;
}

export interface ClientStatusResult extends ClientResponse {
  state: GstnProcessingState;
  /** GSTN's own status code (P, PE, ER, REC, IP). */
  code: string;
  reference?: string;
  errorReport?: unknown;
}

export interface GstClient {
  readonly id: string;
  readonly label: string;
  readonly capabilities: GstClientCapabilities;
  session?(ctx: ClientContext): Promise<ClientSession>;
  requestLoginOtp?(ctx: ClientContext, username: string, startedBy: { userId: string; email: string }): Promise<ClientResponse>;
  verifyLoginOtp?(ctx: ClientContext, otp: string): Promise<ClientSession>;
  endSession?(ctx: ClientContext): Promise<void>;
  upload?(ctx: UploadContext, payload: string, fileName: string): Promise<ClientUploadResult>;
  uploadStatus?(ctx: UploadContext, reference: string): Promise<ClientStatusResult>;
  proceedToFile?(ctx: UploadContext): Promise<ClientUploadResult>;
  summary?(ctx: UploadContext): Promise<ClientResponse & { summary: Gstr1Summary }>;
  requestEvcOtp?(ctx: UploadContext, pan: string): Promise<ClientResponse>;
  fileReturn?(ctx: UploadContext, pan: string, otp: string, summary: Gstr1Summary): Promise<ClientResponse & { ackNum?: string }>;
  trackReturn?(ctx: UploadContext): Promise<ClientResponse & { filings: FiledReturn[] }>;
}

/** The user performs the portal step themselves; this client never makes network calls. */
export const manualClient: GstClient = {
  id: 'manual',
  label: 'Manual upload on the GST portal',
  capabilities: { authenticate: false, upload: false, uploadStatus: false, fileReturn: false },
};

const CLIENTS: Record<string, GstClient> = { manual: manualClient, sandbox: sandboxClient };

export function getGstClient(): GstClient {
  const id = process.env.GST_INTEGRATION ?? 'manual';
  const c = CLIENTS[id];
  if (!c) throw new Error(`GST_INTEGRATION="${id}" is not available. Supported: ${Object.keys(CLIENTS).join(', ')}`);
  return c;
}

/** Official GST portal home page – where the user signs in and uploads in the manual workflow. */
export const GST_PORTAL_URL = process.env.GST_PORTAL_URL ?? 'https://www.gst.gov.in/';
