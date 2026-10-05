import { PortalNotConfiguredError, type PortalProtocol } from './types';

/**
 * Placeholder protocol. Deliberately contains NO portal URLs or request formats: they must not be
 * guessed. To enable HTTP mode, replace this object with an implementation built from endpoints and
 * terms you have verified, keeping these rules:
 *   - CAPTCHA images are returned to the user; the typed value arrives via submitCredentials().
 *   - OTP arrives via submitOtp(); never read it from SMS/email automatically.
 *   - Throw PortalSessionExpiredError when the portal indicates the session is no longer valid.
 *   - Respect portal rate limits; PortalHttp already spaces requests and backs off on 429/5xx.
 */
const notConfigured = async (): Promise<never> => {
  throw new PortalNotConfiguredError();
};

export const portalProtocol: PortalProtocol = {
  id: 'unconfigured',
  configured: false,
  beginLogin: notConfigured,
  refreshCaptcha: notConfigured,
  submitCredentials: notConfigured,
  submitOtp: notConfigured,
  isAlive: async () => false,
  logout: async () => {},
  uploadReturn: notConfigured,
  uploadStatus: notConfigured,
  returnStatus: notConfigured,
};
