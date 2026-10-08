import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

describe('AI usage pricing', () => {
  it('prices calls per model from token counts', async () => {
    const { costInr, monthKey } = await import('./ai-usage');
    // Opus 5.5: $4 in, $20 out, $0.20 cache read, $5 cache write per million; ₹85/$.
    expect(costInr('claude-opus-5-5', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(340);
    expect(costInr('claude-opus-5-5', { inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 10_000, cacheWriteTokens: 0 })).toBe(Math.round((0.008 + 0.02 + 0.002) * 85 * 100) / 100);
    expect(costInr('claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(1020);
    expect(costInr('something-new', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(340);
    expect(monthKey(new Date('2026-09-30T20:00:00Z'))).toBe('2026-10'); // already 1 Oct in India
  });
});
