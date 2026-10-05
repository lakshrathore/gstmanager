/** GSTINs found in a GSTR-1 JSON, grouped by role. Pure – used by the GSTIN and JSON validators. */
export interface JsonGstins { supplier: string[]; recipients: string[]; ecommerce: string[]; all: string[] }

const ROLE: Record<string, keyof Omit<JsonGstins, 'all'>> = { gstin: 'supplier', ctin: 'recipients', etin: 'ecommerce', stin: 'ecommerce' };

export function gstinsFromJson(json: unknown): JsonGstins {
  const found: Record<keyof Omit<JsonGstins, 'all'>, Set<string>> = { supplier: new Set(), recipients: new Set(), ecommerce: new Set() };
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (ROLE[k] && typeof x === 'string' && x.trim()) found[ROLE[k]].add(x.trim().toUpperCase());
        else walk(x);
      }
    }
  };
  walk(json);
  const supplier = [...found.supplier], recipients = [...found.recipients], ecommerce = [...found.ecommerce];
  return { supplier, recipients, ecommerce, all: [...new Set([...supplier, ...recipients, ...ecommerce])] };
}

/** "1 supplier, 12 recipients, 1 e-commerce operator" */
export const describeJsonGstins = (g: JsonGstins) =>
  [g.supplier.length && `${g.supplier.length} supplier`, g.recipients.length && `${g.recipients.length} recipient${g.recipients.length === 1 ? '' : 's'}`,
    g.ecommerce.length && `${g.ecommerce.length} e-commerce operator${g.ecommerce.length === 1 ? '' : 's'}`].filter(Boolean).join(', ');
