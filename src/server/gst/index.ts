/**
 * GST module. Routes and UI talk only to these services.
 *
 *   gstr1      – application processing: import, validation, edits, JSON generation (no portal knowledge)
 *   gst-error  – portal error report import + invoice mapping
 *   gst-upload – the portal step: ready → upload attempt → uploaded → processed/error → filed (evidence-based)
 *   gst-status – lifecycle rules; the only writer of GstReturn.status
 *   gst-audit  – hash-chained audit trail
 *   gst-client – boundary for a future officially supported integration (manual today)
 *   gst-login / gst-session – how and where the taxpayer authenticates (on the GST portal today)
 *   json-check – Validators page: GSTR-1 JSON check and safe auto-fix
 *   gstin-lookup – GSTIN validation: offline, Sandbox Search GSTIN, or portal Search Taxpayer (user types CAPTCHA)
 */
export * as gstr1 from './gstr1';
export * as gstError from './gst-error';
export * as gstUpload from './gst-upload';
export * as gstStatus from './gst-status';
export * as gstAudit from './gst-audit';
export * as gstClient from './gst-client';
export * as gstLogin from './gst-login';
export * as gstSession from './gst-session';
export * as gstinLookup from './gstin-lookup';
export * as jsonCheck from './json-check';
