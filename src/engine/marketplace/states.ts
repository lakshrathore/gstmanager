import { STATE_CODES } from '../masters';

/** Spellings marketplaces use for states/UTs that differ from the GST master names. */
const ALIASES: Record<string, string> = {
  jammukashmir: '01', jandk: '01', jk: '01',
  orissa: '21', odisha: '21',
  pondicherry: '34', puducherry: '34',
  uttaranchal: '05', uttarakhand: '05',
  chhatisgarh: '22', chattisgarh: '22', chhattisgarh: '22',
  newdelhi: '07', delhi: '07', nctofdelhi: '07', nationalcapitalterritoryofdelhi: '07',
  andamannicobar: '35', andamanandnicobar: '35', andamannicobarislands: '35', andamanandnicobarislands: '35',
  dadranagarhaveli: '26', dadraandnagarhaveli: '26', damandiu: '26', damananddiu: '26',
  dadraandnagarhavelianddamananddiu: '26', dnhdd: '26',
  telengana: '36', telangana: '36',
  tamilnadu: '33', tamilnad: '33',
  maharastra: '27', maharashtra: '27',
  karnataka: '29', karnatka: '29',
  westbengal: '19', wb: '19',
  uttarpradesh: '09', up: '09',
  madhyapradesh: '23', mp: '23',
  himachalpradesh: '02', hp: '02',
  andhrapradesh: '37', ap: '37',
  arunachalpradesh: '12',
  ladakh: '38', lakshadweep: '31', chandigarh: '04',
  otherterritory: '97',
};

const key = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');

const BY_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(STATE_CODES).filter(([c]) => c !== '96').map(([c, n]) => [key(n), c]),
);

/**
 * "MAHARASHTRA" | "Maharashtra" | "27" | "27-Maharashtra" | "Tamil Nadu" | "NEW DELHI" → GST state code.
 * Returns '' when the value cannot be mapped (the record then fails validation instead of guessing).
 */
export function stateCode(v: unknown): string {
  if (v == null) return '';
  const s = String(v).trim();
  if (!s) return '';
  const num = s.match(/^(\d{1,2})(?:\D|$)/);
  if (num) {
    const c = num[1].padStart(2, '0');
    return STATE_CODES[c] && c !== '96' ? c : '';
  }
  const k = key(s);
  return BY_NAME[k] ?? ALIASES[k] ?? '';
}
