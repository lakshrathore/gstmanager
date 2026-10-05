import 'server-only';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM envelope for secrets at rest (portal cookies, portal username).
 * Keys come from DATA_ENCRYPTION_KEYS="kid1:base64key,kid2:base64key" – first key encrypts,
 * all keys decrypt, which allows rotation without re-encrypting everything at once.
 * Associated data binds a ciphertext to its tenant/company so it can't be replayed elsewhere.
 */
function keys(): Map<string, Buffer> {
  const raw = process.env.DATA_ENCRYPTION_KEYS;
  if (!raw) throw new Error('DATA_ENCRYPTION_KEYS is not set');
  const m = new Map<string, Buffer>();
  for (const part of raw.split(',')) {
    const [kid, b64] = part.trim().split(':');
    const k = Buffer.from(b64 ?? '', 'base64');
    if (!kid || k.length !== 32) throw new Error(`Encryption key "${kid}" must be 32 bytes base64`);
    m.set(kid, k);
  }
  return m;
}

export function encrypt(plain: string, aad: string): string {
  const [kid, key] = keys().entries().next().value as [string, Buffer];
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', kid, iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
}

export function decrypt(token: string, aad: string): string {
  const [v, kid, iv, tag, ct] = token.split('.');
  if (v !== 'v1') throw new Error('Unknown ciphertext version');
  const key = keys().get(kid);
  if (!key) throw new Error(`Encryption key ${kid} not available`);
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

const SECRET_KEYS = /pass(word)?|otp|captcha|cookie|token|secret|authorization|jar/i;
/** Use before logging/auditing any object that might carry credentials. */
export function redact<T>(obj: T): T {
  if (Array.isArray(obj)) return obj.map(redact) as T;
  if (!obj || typeof obj !== 'object' || obj instanceof Date) return obj;
  return Object.fromEntries(
    Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEYS.test(k) ? '[REDACTED]' : redact(v)]),
  ) as T;
}
