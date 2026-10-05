/**
 * Portal integration contracts. The rest of the app depends only on these types, so the GSTR-1
 * engine and UI work identically whether uploads happen through the HTTP adapter, manually,
 * or (later) through a licensed GSP adapter.
 */

export type LoginStep =
  | { state: 'captcha_required'; captchaImage: string; captchaMime: string; message?: string }
  | { state: 'otp_required'; message: string }
  | { state: 'active'; expiresAt: string }
  | { state: 'failed'; message: string }
  | { state: 'not_applicable'; message: string };

export type UploadState = 'processing' | 'processed' | 'processed_with_errors' | 'failed';

export interface UploadStatus {
  status: UploadState;
  message?: string;
  /** Portal error report JSON when status is processed_with_errors. */
  errorReport?: unknown;
}

/** Minimal HTTP surface a protocol may use. Cookies, retries, spacing and timeouts are handled for it. */
export interface PortalHttp {
  request(url: string, init?: RequestInit & { idempotent?: boolean }): Promise<Response>;
  /** Small per-session state the protocol needs between steps (stored encrypted with the cookie jar). */
  scratch: Record<string, string>;
}

/**
 * The ONLY place that knows portal URLs, form fields and response shapes.
 * Implement it strictly from mechanisms you have verified are permitted for this use; do not
 * automate CAPTCHA/OTP – those values must always come from the user via the methods below.
 */
export interface PortalProtocol {
  readonly id: string;
  readonly configured: boolean;
  beginLogin(http: PortalHttp, username: string): Promise<LoginStep>;
  refreshCaptcha(http: PortalHttp): Promise<LoginStep>;
  submitCredentials(http: PortalHttp, input: { username: string; password: string; captcha: string }): Promise<LoginStep>;
  submitOtp(http: PortalHttp, otp: string): Promise<LoginStep>;
  isAlive(http: PortalHttp): Promise<boolean>;
  logout(http: PortalHttp): Promise<void>;
  uploadReturn(http: PortalHttp, input: { gstin: string; fp: string; payload: string; fileName: string }): Promise<{ referenceId: string }>;
  uploadStatus(http: PortalHttp, input: { gstin: string; fp: string; referenceId: string }): Promise<UploadStatus>;
  returnStatus(http: PortalHttp, input: { gstin: string; fp: string }): Promise<{ status: string; raw?: unknown }>;
}

export class PortalNotConfiguredError extends Error {
  constructor() {
    super('Portal HTTP protocol is not configured. Implement src/server/portal/protocol.ts with verified, permitted endpoints, or use the manual upload workflow.');
  }
}
export class PortalSessionExpiredError extends Error {
  constructor(message = 'GST portal session expired – please sign in again') {
    super(message);
  }
}
