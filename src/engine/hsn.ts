import type { FormatProfile } from './config/versions';

/**
 * HSN/SAC structure checks (offline). Validates shape, chapter, SAC heading and the minimum digits
 * for the turnover band. It does not prove that a full 6/8-digit code exists in the tariff – the portal
 * checks that against its master when the return is uploaded.
 */

/** Customs Tariff chapters (first 2 digits of an HSN). 77 is reserved and has no codes. */
export const HSN_CHAPTERS: Record<string, string> = {
  '01': 'Live animals', '02': 'Meat and edible meat offal', '03': 'Fish, crustaceans and molluscs',
  '04': 'Dairy produce, eggs, honey', '05': 'Other products of animal origin', '06': 'Live trees and plants, cut flowers',
  '07': 'Edible vegetables', '08': 'Edible fruit and nuts', '09': 'Coffee, tea, mate and spices', '10': 'Cereals',
  '11': 'Milling products, malt, starches', '12': 'Oil seeds and oleaginous fruits', '13': 'Lac, gums, resins',
  '14': 'Vegetable plaiting materials', '15': 'Animal or vegetable fats and oils', '16': 'Preparations of meat or fish',
  '17': 'Sugars and sugar confectionery', '18': 'Cocoa and cocoa preparations', '19': 'Preparations of cereals, flour, starch or milk',
  '20': 'Preparations of vegetables, fruit or nuts', '21': 'Miscellaneous edible preparations', '22': 'Beverages, spirits and vinegar',
  '23': 'Food industry residues, animal fodder', '24': 'Tobacco and substitutes', '25': 'Salt, sulphur, earths, stone, lime, cement',
  '26': 'Ores, slag and ash', '27': 'Mineral fuels and oils', '28': 'Inorganic chemicals', '29': 'Organic chemicals',
  '30': 'Pharmaceutical products', '31': 'Fertilisers', '32': 'Tanning or dyeing extracts, paints, inks',
  '33': 'Essential oils, perfumery, cosmetics', '34': 'Soap, washing and lubricating preparations, candles',
  '35': 'Albuminoidal substances, glues, enzymes', '36': 'Explosives, matches, pyrotechnics', '37': 'Photographic and cinematographic goods',
  '38': 'Miscellaneous chemical products', '39': 'Plastics and articles thereof', '40': 'Rubber and articles thereof',
  '41': 'Raw hides, skins and leather', '42': 'Leather articles, handbags, travel goods', '43': 'Furskins and artificial fur',
  '44': 'Wood and articles of wood', '45': 'Cork and articles of cork', '46': 'Straw and basketware',
  '47': 'Wood pulp, waste paper', '48': 'Paper and paperboard', '49': 'Printed books, newspapers', '50': 'Silk',
  '51': 'Wool and animal hair', '52': 'Cotton', '53': 'Other vegetable textile fibres', '54': 'Man-made filaments',
  '55': 'Man-made staple fibres', '56': 'Wadding, felt, nonwovens, ropes', '57': 'Carpets and floor coverings',
  '58': 'Special woven fabrics, lace, embroidery', '59': 'Impregnated or coated textile fabrics', '60': 'Knitted or crocheted fabrics',
  '61': 'Apparel, knitted or crocheted', '62': 'Apparel, not knitted or crocheted', '63': 'Other made-up textile articles',
  '64': 'Footwear', '65': 'Headgear', '66': 'Umbrellas, walking sticks', '67': 'Prepared feathers, artificial flowers',
  '68': 'Articles of stone, plaster, cement', '69': 'Ceramic products', '70': 'Glass and glassware',
  '71': 'Pearls, precious stones and metals, jewellery', '72': 'Iron and steel', '73': 'Articles of iron or steel',
  '74': 'Copper', '75': 'Nickel', '76': 'Aluminium', '78': 'Lead', '79': 'Zinc', '80': 'Tin',
  '81': 'Other base metals, cermets', '82': 'Tools and cutlery of base metal', '83': 'Miscellaneous articles of base metal',
  '84': 'Machinery, boilers, mechanical appliances', '85': 'Electrical machinery and equipment', '86': 'Railway locomotives and rolling stock',
  '87': 'Vehicles other than railway', '88': 'Aircraft and spacecraft', '89': 'Ships and boats',
  '90': 'Optical, measuring, medical instruments', '91': 'Clocks and watches', '92': 'Musical instruments',
  '93': 'Arms and ammunition', '94': 'Furniture, bedding, lamps, prefabricated buildings', '95': 'Toys, games, sports requisites',
  '96': 'Miscellaneous manufactured articles', '97': 'Works of art and antiques', '98': 'Project imports, baggage (special classification)',
};

/** Services Accounting Code headings (SAC = 99 + 2-digit group, then 6 digits in all). */
export const SAC_HEADINGS: Record<string, string> = {
  '9954': 'Construction services', '9961': 'Wholesale trade services', '9962': 'Retail trade services',
  '9963': 'Accommodation, food and beverage services', '9964': 'Passenger transport services', '9965': 'Goods transport services',
  '9966': 'Rental of transport vehicles with operator', '9967': 'Supporting services in transport', '9968': 'Postal and courier services',
  '9969': 'Electricity, gas and water distribution', '9971': 'Financial and related services', '9972': 'Real estate services',
  '9973': 'Leasing or rental without operator', '9981': 'Research and development services', '9982': 'Legal and accounting services',
  '9983': 'Other professional, technical and business services', '9984': 'Telecommunications, broadcasting, information supply',
  '9985': 'Support services', '9986': 'Support services to agriculture, mining, utilities', '9987': 'Maintenance, repair and installation',
  '9988': 'Manufacturing services on inputs owned by others', '9989': 'Other manufacturing services, publishing, printing',
  '9991': 'Public administration services', '9992': 'Education services', '9993': 'Human health and social care services',
  '9994': 'Sewage, waste collection, sanitation', '9995': 'Services of membership organisations',
  '9996': 'Recreational, cultural and sporting services', '9997': 'Other services', '9998': 'Domestic services',
  '9999': 'Services by extraterritorial organisations',
};

export interface HsnIssue { severity: 'error' | 'warning'; message: string; suggestion?: string }

export interface HsnCheck {
  input: string;
  /** Digits only (spaces and dots removed). */
  code: string;
  ok: boolean;
  kind?: 'goods' | 'service';
  chapter?: string;
  chapterName?: string;
  heading?: string;
  headingName?: string;
  /** Minimum digits that applied, when a turnover band was given. */
  minDigits?: number;
  issues: HsnIssue[];
}

export interface HsnCheckOptions {
  /** Aggregate annual turnover above ₹5 crore. Omit to skip the digits-by-turnover rule. */
  aatoAbove5Cr?: boolean;
  /** B2B supply (Table 12 B2B). B2C rows may use 4 digits in either band. Default true. */
  b2b?: boolean;
  profile?: Pick<FormatProfile, 'hsnDigits'>;
}

const DEFAULT_DIGITS = { upTo5Cr: 4, above5Cr: 6 };

export function checkHsn(raw: string | number | null | undefined, o: HsnCheckOptions = {}): HsnCheck {
  const input = String(raw ?? '').trim();
  const code = input.replace(/[\s.]/g, '');
  const issues: HsnIssue[] = [];
  const res: HsnCheck = { input, code, ok: false, issues };
  const err = (message: string, suggestion?: string) => issues.push({ severity: 'error', message, suggestion });
  const warn = (message: string, suggestion?: string) => issues.push({ severity: 'warning', message, suggestion });

  if (!code) { err('HSN/SAC is empty'); return res; }
  if (!/^\d+$/.test(code)) { err('HSN/SAC can contain digits only', 'Remove letters and symbols.'); return res; }
  if (![4, 6, 8].includes(code.length)) {
    err(`HSN/SAC must be 4, 6 or 8 digits (found ${code.length})`, code.length < 4 ? 'Report at least the 4-digit heading.' : 'Use the 6- or 8-digit tariff code.');
  }

  const chapter = code.slice(0, 2);
  res.chapter = chapter;
  if (chapter === '99') {
    res.kind = 'service';
    res.chapterName = 'Services (SAC)';
    if (code.length >= 4) {
      res.heading = code.slice(0, 4);
      res.headingName = SAC_HEADINGS[res.heading];
      if (!res.headingName) err(`SAC heading ${res.heading} does not exist`, 'Valid SAC headings run 9954 and 9961–9999.');
    }
    if (code.length === 8) warn('SAC codes have 6 digits', 'Use the 6-digit SAC (e.g. 998314).');
  } else {
    res.kind = 'goods';
    res.chapterName = HSN_CHAPTERS[chapter];
    if (chapter === '77') err('Chapter 77 is reserved in the tariff and has no HSN codes');
    else if (!res.chapterName) err(`Chapter ${chapter} does not exist in the HSN tariff`, 'Goods chapters run 01–97 (98 is special); services start with 99.');
    else if (chapter === '98') warn('Chapter 98 covers project imports and baggage – it is rarely right for an outward supply');
  }

  if (o.aatoAbove5Cr !== undefined) {
    const d = o.profile?.hsnDigits ?? DEFAULT_DIGITS;
    const min = (o.b2b ?? true) && o.aatoAbove5Cr ? d.above5Cr : d.upTo5Cr;
    res.minDigits = min;
    if (code.length < min) err(`At least ${min} digits are required for your turnover band${o.b2b === false ? '' : ' (B2B)'}`, `Report the ${min}-digit code.`);
  }

  res.ok = !issues.some((i) => i.severity === 'error');
  return res;
}
