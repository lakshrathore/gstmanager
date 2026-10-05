/**
 * Static GST master data used by the parser, validator and JSON generator.
 * Keep this file free of framework/database imports so the engine stays testable on its own.
 */

export const STATE_CODES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka',
  '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
  '96': 'Foreign Country', '97': 'Other Territory',
};

/** Union territories without legislature: SGST is reported as UTGST (same JSON field `samt`). */
export const UT_CODES = new Set(['04', '26', '31', '35', '38', '97']);

/** GST Unit Quantity Codes accepted in Table 12. */
export const UQC_CODES: Record<string, string> = {
  BAG: 'BAGS', BAL: 'BALE', BDL: 'BUNDLES', BKL: 'BUCKLES', BOU: 'BILLION OF UNITS', BOX: 'BOX',
  BTL: 'BOTTLES', BUN: 'BUNCHES', CAN: 'CANS', CBM: 'CUBIC METERS', CCM: 'CUBIC CENTIMETERS',
  CMS: 'CENTIMETERS', CTN: 'CARTONS', DOZ: 'DOZENS', DRM: 'DRUMS', GGK: 'GREAT GROSS', GMS: 'GRAMMES',
  GRS: 'GROSS', GYD: 'GROSS YARDS', KGS: 'KILOGRAMS', KLR: 'KILOLITRE', KME: 'KILOMETRE', LTR: 'LITRES',
  MLT: 'MILILITRE', MTR: 'METERS', MTS: 'METRIC TON', NOS: 'NUMBERS', OTH: 'OTHERS', PAC: 'PACKS',
  PCS: 'PIECES', PRS: 'PAIRS', QTL: 'QUINTAL', ROL: 'ROLLS', SET: 'SETS', SQF: 'SQUARE FEET',
  SQM: 'SQUARE METERS', SQY: 'SQUARE YARDS', TBS: 'TABLETS', TGM: 'TEN GROSS', THD: 'THOUSANDS',
  TON: 'TONNES', TUB: 'TUBES', UGS: 'US GALLONS', UNT: 'UNITS', YDS: 'YARDS', NA: 'NOT APPLICABLE',
};

/** Table 13 – document types and their portal `doc_num`. */
export const DOC_TYPES: Record<string, number> = {
  'Invoices for outward supply': 1,
  'Invoices for inward supply from unregistered person': 2,
  'Revised Invoice': 3,
  'Debit Note': 4,
  'Credit Note': 5,
  'Receipt voucher': 6,
  'Payment Voucher': 7,
  'Refund voucher': 8,
  'Delivery Challan for job work': 9,
  'Delivery Challan for supply on approval': 10,
  'Delivery Challan in case of liquid gas': 11,
  'Delivery Challan in cases other than by way of supply (excluding at S no. 9 to 11)': 12,
};

/** Excel "Invoice Type" / "Note Supply Type" → JSON `inv_typ`. */
export const INVOICE_TYPES: Record<string, 'R' | 'SEWP' | 'SEWOP' | 'DE' | 'CBW'> = {
  'regular b2b': 'R',
  regular: 'R',
  'sez supplies with payment': 'SEWP',
  'sez supplies without payment': 'SEWOP',
  'deemed exp': 'DE',
  'deemed exports': 'DE',
  'intra-state supplies attracting igst': 'CBW',
};

/** Table 8 description → JSON `sply_ty`. */
export const NIL_SUPPLY_TYPES: Record<string, 'INTRB2B' | 'INTRAB2B' | 'INTRB2C' | 'INTRAB2C'> = {
  'inter-state supplies to registered persons': 'INTRB2B',
  'intra-state supplies to registered persons': 'INTRAB2B',
  'inter-state supplies to unregistered persons': 'INTRB2C',
  'intra-state supplies to unregistered persons': 'INTRAB2C',
};
