import 'server-only';
import { getGstClient, type ClientContext } from '../gst-client';

/**
 * Session state with GSTN. The manual client keeps no session in the app: the user's portal session
 * lives only in their browser. An API client reports its own taxpayer session (per company); the
 * token itself never leaves the client module.
 */
export interface SessionState {
  state: 'external' | 'none' | 'otp_sent' | 'active' | 'expired';
  message: string;
  expiresAt?: Date | null;
  connectedAs?: string;
}

export async function sessionState(ctx: ClientContext): Promise<SessionState> {
  const client = getGstClient();
  if (!client.capabilities.authenticate) {
    return { state: 'external', message: 'You sign in on the GST portal in your own browser. This app stores no portal credentials or cookies.' };
  }
  if (!client.session) return { state: 'none', message: `Not connected to ${client.label}.` };
  return client.session(ctx);
}
