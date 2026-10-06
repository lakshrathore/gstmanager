/** Standard UPI deep link (NPCI "upi://pay"); every UPI app understands it and it is what the QR encodes. */
export function upiLink(upiId: string, payeeName: string, amount: number, note: string) {
  const q = new URLSearchParams({ pa: upiId, pn: payeeName || upiId, am: amount.toFixed(2), cu: 'INR', tn: note.slice(0, 60) });
  return `upi://pay?${q.toString().replace(/\+/g, '%20')}`;
}

/** Add-ons: what one unit adds. Returns are sold in blocks of 10 per month. */
export const ADDON_UNITS = { companies: 1, users: 1, returnsPerMonth: 10 } as const;
export type AddonKey = keyof typeof ADDON_UNITS;
export const ADDON_LABELS: Record<AddonKey, string> = {
  companies: 'Extra company (GSTIN)',
  users: 'Extra team member',
  returnsPerMonth: 'Extra 10 returns per month',
};
