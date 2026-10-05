import type { Section } from '../types';

/**
 * Parses the error report JSON the GST portal produces after processing an uploaded file
 * ("Generate error report" on the Prepare Offline page). The report mirrors the upload JSON
 * with `error_msg` / `error_cd` attached to the failing nodes, so we walk it generically
 * instead of hard-coding a shape that may drift between portal releases.
 */
export interface PortalError {
  section: Section | string;
  ctin?: string;
  documentNo?: string;
  errorCode?: string;
  message: string;
  path: string;
}

const SECTION_ALIAS: Record<string, Section> = {
  b2b: 'b2b', b2cl: 'b2cl', b2cs: 'b2cs', cdnr: 'cdnr', cdnur: 'cdnur', exp: 'exp', at: 'at', txpd: 'txpd',
  nil: 'nil', hsn: 'hsn_b2b', hsn_b2b: 'hsn_b2b', hsn_b2c: 'hsn_b2c', doc_issue: 'docs',
};

export function parsePortalErrorReport(report: unknown): PortalError[] {
  const out: PortalError[] = [];
  const walk = (node: unknown, path: string[], ctx: { section?: string; ctin?: string }) => {
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, [...path, String(i)], ctx));
    if (!node || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    const next = { ...ctx };
    if (typeof o.ctin === 'string') next.ctin = o.ctin;
    const msg = o.error_msg ?? o.error_message ?? o.errorMsg;
    if (typeof msg === 'string' && msg.trim()) {
      const sec = next.section ?? path[0];
      out.push({
        section: SECTION_ALIAS[sec] ?? sec ?? 'unknown',
        ctin: next.ctin,
        documentNo: (o.inum ?? o.nt_num ?? o.hsn_sc ?? undefined) as string | undefined,
        errorCode: (o.error_cd ?? o.error_code) as string | undefined,
        message: msg.trim(),
        path: path.join('.'),
      });
    }
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object') walk(v, [...path, k], { ...next, section: next.section ?? (SECTION_ALIAS[k] ? k : undefined) });
    }
  };
  // Some reports wrap sections under "error_report"
  const root = report && typeof report === 'object' && 'error_report' in report ? (report as Record<string, unknown>).error_report : report;
  walk(root, [], {});
  return out;
}
