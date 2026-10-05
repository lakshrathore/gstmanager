'use client';

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

export async function call<T = unknown>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    headers: json !== undefined ? { 'content-type': 'application/json', ...rest.headers } : rest.headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (res.status === 401 && typeof window !== 'undefined' && !url.startsWith('/api/auth/')) {
    window.location.href = '/login';
  }
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string })?.error ?? `Request failed (${res.status})`, (body as { details?: unknown })?.details);
  return body as T;
}

export const inr = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const periodLabel = (fp: string) =>
  new Date(Number(fp.slice(2)), Number(fp.slice(0, 2)) - 1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' });

export { STATUS_LABELS as STATUS_LABEL } from '@/server/gst/gst-status/statuses';
