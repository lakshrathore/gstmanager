/**
 * GSTR-1 engine public API. Framework-free: no Next.js, no MongoDB, no portal code.
 * Pipeline: readWorkbook → parseGstr1Tables → validateReturn → generateGstr1Json → validateGstr1Json
 */
export * from './types';
export * from './masters';
export * from './util';
export { profileForPeriod, FORMAT_PROFILES, type FormatProfile } from './config/versions';
export { parseGstr1Tables, type SheetTable } from './excel/parseGstr1';
export { readWorkbook } from './excel/readWorkbook';
export { SHEETS } from './excel/template';
export { validateReturn, validateRecord, type ValidationSummary } from './validation/validate';
export { generateGstr1Json, type GenerationLog } from './json/generate';
export { validateGstr1Json, GSTR1_SCHEMA, type SchemaError } from './json/schema';
export { checkGstr1Json, recordsFromGstr1Json, type JsonCheckReport, type JsonIssue, type JsonStage } from './json/check';
export { fixGstr1Json, markAutoFixable, FIX_LABELS, type AppliedFix, type FixCode, type FixOptions } from './json/fix';
export { checkHsn, HSN_CHAPTERS, SAC_HEADINGS, type HsnCheck, type HsnIssue } from './hsn';
export { parsePortalErrorReport, type PortalError } from './portal/errorReport';
export { recomputeRecordTax, naturalKey } from './tax';
