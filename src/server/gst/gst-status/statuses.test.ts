import { describe, expect, it } from 'vitest';
import { DATA_LOCKED, EVIDENCE_REQUIRED, normalizeStatus, RETURN_STATUSES, TRANSITIONS } from './statuses';

describe('return status rules', () => {
  it('maps legacy statuses', () => {
    expect(normalizeStatus('has_errors')).toBe('validation_error');
    expect(normalizeStatus('processed_with_errors')).toBe('error');
    expect(normalizeStatus('bogus')).toBe('draft');
  });

  it('only reaches processed / filed / error from the portal side', () => {
    const into = (to: string) => RETURN_STATUSES.filter((s) => TRANSITIONS[s].includes(to as never) && s !== to);
    expect(into('processed').sort()).toEqual(['processing', 'uploaded']);
    expect(into('filed')).toEqual(['processed']);
    expect(into('error').sort()).toEqual(['processing', 'uploaded']);
  });

  it('requires portal evidence for processed, filed and error', () => {
    expect(EVIDENCE_REQUIRED).toEqual({ processed: 'processing_result', filed: 'acknowledgement', error: 'error_report' });
  });

  it('has no app-side path that skips approval and upload', () => {
    for (const s of ['imported', 'validated', 'validation_error', 'json_generated'] as const) {
      expect(TRANSITIONS[s]).not.toContain('uploaded');
      expect(TRANSITIONS[s]).not.toContain('processed');
    }
    expect(TRANSITIONS.ready_for_upload).toContain('uploading');
    expect(TRANSITIONS.filed).toEqual([]);
  });

  it('locks data while the file is with the portal but unlocks after a portal error', () => {
    expect(DATA_LOCKED.has('uploading')).toBe(true);
    expect(DATA_LOCKED.has('filed')).toBe(true);
    expect(DATA_LOCKED.has('error')).toBe(false);
  });
});
