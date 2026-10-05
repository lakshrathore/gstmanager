import 'server-only';
import { CookieJar } from 'tough-cookie';
import type { PortalHttp } from './types';

const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const MIN_SPACING_MS = Number(process.env.PORTAL_MIN_REQUEST_SPACING_MS ?? 1500);
const lastRequestAt = new Map<string, number>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Cookie-aware fetch wrapper for one portal session.
 * - Per-GSTIN request spacing (never bursts the portal)
 * - Exponential backoff with jitter on 429/502/503/504, honouring Retry-After
 * - Only idempotent requests are retried on network errors
 * - Never logs bodies, headers or cookies
 */
export class PortalHttpClient implements PortalHttp {
  scratch: Record<string, string>;
  private constructor(private jar: CookieJar, scratch: Record<string, string>, private spacingKey: string) {
    this.scratch = scratch;
  }

  static create(spacingKey: string) {
    return new PortalHttpClient(new CookieJar(), {}, spacingKey);
  }

  static async restore(serialized: string, spacingKey: string) {
    const { jar, scratch } = JSON.parse(serialized);
    return new PortalHttpClient(await CookieJar.deserialize(jar), scratch ?? {}, spacingKey);
  }

  async serialize(): Promise<string> {
    return JSON.stringify({ jar: await this.jar.serialize(), scratch: this.scratch });
  }

  private async space() {
    const last = lastRequestAt.get(this.spacingKey) ?? 0;
    const wait = last + MIN_SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt.set(this.spacingKey, Date.now());
  }

  async request(url: string, init: RequestInit & { idempotent?: boolean } = {}): Promise<Response> {
    const idempotent = init.idempotent ?? (!init.method || init.method === 'GET');
    let attempt = 0;
    for (;;) {
      await this.space();
      const headers = new Headers(init.headers);
      const cookie = await this.jar.getCookieString(url);
      if (cookie) headers.set('cookie', cookie);
      try {
        const res = await fetch(url, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
        for (const c of res.headers.getSetCookie()) await this.jar.setCookie(c, url, { ignoreError: true });
        if ([429, 502, 503, 504].includes(res.status) && attempt < MAX_RETRIES && (idempotent || res.status === 429)) {
          const ra = Number(res.headers.get('retry-after'));
          await sleep(isFinite(ra) && ra > 0 ? ra * 1000 : backoff(attempt));
          attempt++;
          continue;
        }
        return res;
      } catch (e) {
        if (!idempotent || attempt >= MAX_RETRIES) throw new Error(`Portal request failed: ${(e as Error).name}`);
        await sleep(backoff(attempt));
        attempt++;
      }
    }
  }
}

const backoff = (attempt: number) => Math.min(30_000, 1000 * 2 ** attempt) * (0.5 + Math.random() / 2);
