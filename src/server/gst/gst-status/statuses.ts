/**
 * Return lifecycle. Shared by server and UI (no server-only imports here).
 *
 * Application side:  draft → imported → validated | validation_error → json_generated → ready_for_upload
 * GST portal side:   uploading → uploaded → processing → processed | error → filed
 *
 * processed / filed / error can only be reached with evidence the user brings back from the
 * GST portal (reference, acknowledgement, error report). The app never infers them.
 */
export const RETURN_STATUSES = [
  'draft', 'imported', 'validated', 'validation_error', 'json_generated', 'ready_for_upload',
  'uploading', 'uploaded', 'processing', 'processed', 'error', 'filed',
] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

export const STATUS_LABELS: Record<ReturnStatus, string> = {
  draft: 'Draft', imported: 'Imported', validated: 'Validated', validation_error: 'Validation error',
  json_generated: 'JSON generated', ready_for_upload: 'Ready for upload', uploading: 'Uploading',
  uploaded: 'Uploaded', processing: 'Processing', processed: 'Processed', error: 'Portal error', filed: 'Filed',
};

/** Earlier builds used these names; they are normalised on read. */
export const LEGACY_STATUS: Record<string, ReturnStatus> = { has_errors: 'validation_error', processed_with_errors: 'error' };
export const normalizeStatus = (s: string | null | undefined): ReturnStatus =>
  (LEGACY_STATUS[s ?? ''] ?? (RETURN_STATUSES.includes(s as ReturnStatus) ? s : 'draft')) as ReturnStatus;

/** Data can't change once the JSON has gone (or is going) to the portal, except after a portal error. */
export const DATA_LOCKED: ReadonlySet<ReturnStatus> = new Set(['uploading', 'uploaded', 'processing', 'processed', 'filed']);

const APP_STATES: ReturnStatus[] = ['imported', 'validated', 'validation_error', 'json_generated'];

export const TRANSITIONS: Record<ReturnStatus, ReturnStatus[]> = {
  draft: ['imported'],
  imported: APP_STATES,
  validated: APP_STATES,
  validation_error: APP_STATES,
  json_generated: [...APP_STATES, 'ready_for_upload'],
  ready_for_upload: [...APP_STATES, 'uploading'],
  uploading: ['uploaded', 'ready_for_upload'],
  uploaded: ['processing', 'processed', 'error'],
  processing: ['processed', 'error'],
  error: [...APP_STATES, 'error'],
  processed: ['filed'],
  filed: [],
};

/** Target statuses that must carry portal evidence, and which kind. */
export const EVIDENCE_REQUIRED: Partial<Record<ReturnStatus, 'processing_result' | 'acknowledgement' | 'error_report'>> = {
  processed: 'processing_result',
  filed: 'acknowledgement',
  error: 'error_report',
};

export const PORTAL_SIDE: ReadonlySet<ReturnStatus> = new Set(['uploading', 'uploaded', 'processing', 'processed', 'error', 'filed']);
