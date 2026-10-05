/** Paths as the validator prints them: b2b[0].inv[2].itms[0].itm_det.rt */
export function parsePath(path: string): (string | number)[] {
  const out: (string | number)[] = [];
  for (const m of path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) out.push(m[2] !== undefined ? Number(m[2]) : m[1]);
  return out;
}

type Container = Record<string, unknown> | unknown[];
const isContainer = (v: unknown): v is Container => !!v && typeof v === 'object';

/** The container holding the value at `path`, the last key, and the current value (undefined if absent). */
export function locate(root: unknown, path: string): { parent: Container; key: string | number; value: unknown } | null {
  const parts = parsePath(path);
  if (!parts.length) return null;
  let at: unknown = root;
  for (const p of parts.slice(0, -1)) {
    if (!isContainer(at)) return null;
    at = (at as Record<string | number, unknown>)[p];
  }
  if (!isContainer(at)) return null;
  const key = parts[parts.length - 1];
  return { parent: at, key, value: (at as Record<string | number, unknown>)[key] };
}

/** True when the path points at a scalar (or a missing field) the user can type a value for. */
export function isEditable(root: unknown, path: string): boolean {
  const l = locate(root, path);
  return !!l && !Array.isArray(l.parent) && (l.value === undefined || l.value === null || typeof l.value !== 'object');
}

const NUMERIC = new Set(['val', 'txval', 'iamt', 'camt', 'samt', 'csamt', 'ad_amt', 'nil_amt', 'expt_amt', 'ngsup_amt', 'rt', 'qty', 'num', 'totnum', 'cancel', 'net_issue', 'doc_num', 'diff_percent']);

/** Typed input → JSON value: numbers stay numbers (and numeric fields become numbers), text stays text. */
export function coerce(key: string | number, current: unknown, raw: string): unknown {
  const t = raw.trim();
  const looksNumeric = t !== '' && isFinite(Number(t));
  if (typeof current === 'number' || (current === undefined && NUMERIC.has(String(key)))) return looksNumeric ? Number(t) : t;
  return t;
}
