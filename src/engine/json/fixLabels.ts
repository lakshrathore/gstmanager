/** Kinds of automatic JSON fix and their labels. Kept separate so the browser can import it without the engine. */
export type FixCode =
  | 'FORMAT' | 'ROUNDING' | 'VERSION' | 'HASH' | 'UNKNOWN_FIELD' | 'GROUP_MERGED' | 'RATE_MERGED' | 'LINE_MERGED'
  | 'SPLY_TY' | 'TAX_RECALCULATED' | 'HSN_TAX' | 'ITEM_NUMBER' | 'HSN_SAC_UQC' | 'HSN_LAYOUT' | 'HSN_NUMBER' | 'DOC_NUM' | 'NET_ISSUE';

export const FIX_LABELS: Record<FixCode, string> = {
  FORMAT: 'Formats corrected (case, dates, POS, numbers stored as text)',
  ROUNDING: 'Amounts rounded to 2 decimals',
  VERSION: 'Format version set for the period',
  HASH: 'Missing hash field added',
  UNKNOWN_FIELD: 'Unknown fields removed',
  GROUP_MERGED: 'Repeated GSTIN / POS groups merged',
  RATE_MERGED: 'Items with the same rate merged',
  LINE_MERGED: 'Duplicate B2CS / advance lines merged',
  SPLY_TY: 'Supply type (INTER/INTRA) corrected from POS',
  TAX_RECALCULATED: 'Tax recalculated from rate × taxable value',
  HSN_TAX: 'HSN row tax filled in to match the documents (IGST or CGST/SGST)',
  ITEM_NUMBER: 'Item numbers renumbered',
  HSN_SAC_UQC: 'Services (SAC) set to UQC NA and quantity 0',
  HSN_LAYOUT: 'HSN lists combined into hsn.data for this period',
  HSN_NUMBER: 'HSN / document rows renumbered',
  DOC_NUM: 'Document type number corrected',
  NET_ISSUE: 'Net issued recalculated (total − cancelled)',
};
