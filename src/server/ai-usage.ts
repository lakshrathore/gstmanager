import 'server-only';
import { HttpError } from './http';
import { licenseState } from './license';
import { AiUsage, oid } from './models';

/**
 * Document AI metering: every Claude API call is priced from its token counts and the model's list
 * price, recorded against the organisation, and checked against the package's monthly allowance
 * (Package.aiBudgetInr) before the next call. Prices are per million tokens in US$.
 */

const PRICES: { match: RegExp; input: number; output: number; cacheRead: number; cacheWrite: number }[] = [
  { match: /fable|mythos/, input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  { match: /opus-5-5/, input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  { match: /opus/, input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { match: /sonnet-5/, input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  { match: /sonnet/, input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { match: /haiku/, input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
];
const USD_INR = Number(process.env.USD_INR) || 85;

export interface Tokens { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }

/** ₹ cost of a call (input = uncached input tokens). Unknown models are priced as Opus 5.5. */
export function costInr(model: string, t: Tokens) {
  const p = PRICES.find((x) => x.match.test(model)) ?? PRICES[1];
  const usd = (t.inputTokens * p.input + t.outputTokens * p.output + (t.cacheReadTokens ?? 0) * p.cacheRead + (t.cacheWriteTokens ?? 0) * p.cacheWrite) / 1e6;
  return Math.round(usd * USD_INR * 100) / 100;
}

/** Calendar month in India time ("2026-10"). */
export const monthKey = (d = new Date()) => new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 7);

export async function spentThisMonth(orgId: string) {
  const r = await AiUsage.aggregate<{ total: number }>([{ $match: { orgId: oid(orgId), month: monthKey() } }, { $group: { _id: null, total: { $sum: '$costInr' } } }]);
  return Math.round((r[0]?.total ?? 0) * 100) / 100;
}

/** Throws unless the plan includes Document AI and this month's allowance is not used up. */
export async function assertAiAllowed(orgId: string) {
  const st = await licenseState(orgId);
  if (st.status !== 'active') throw new HttpError(402, 'Document AI needs an active license.');
  if (!st.plan?.features.includes('documentAI')) throw new HttpError(402, `Your ${st.plan?.name ?? ''} plan does not include Document AI (reading PDFs, scans and photos, and the assistant). Upgrade the package to use it.`);
  const budget = st.plan.aiBudgetInr;
  if (budget > 0) {
    const spent = await spentThisMonth(orgId);
    if (spent >= budget) throw new HttpError(402, `This month’s Document AI allowance (₹${budget.toLocaleString('en-IN')}) is used up (₹${spent.toLocaleString('en-IN')} spent). It renews on the 1st, or ask for a bigger package.`);
  }
}

export async function recordAiUsage(orgId: unknown, kind: 'extract' | 'assistant', model: string, t: Tokens, refId?: string, byEmail?: string) {
  const cost = costInr(model, t);
  await AiUsage.create({
    orgId, month: monthKey(), kind, model, inputTokens: t.inputTokens, outputTokens: t.outputTokens,
    cacheReadTokens: t.cacheReadTokens ?? 0, cacheWriteTokens: t.cacheWriteTokens ?? 0, costInr: cost, refId, byEmail,
  });
  return cost;
}

/** This month and the last few: spend by kind, against the allowance. */
export async function aiUsageSummary(orgId: string) {
  const st = await licenseState(orgId);
  const rows = await AiUsage.aggregate<{ _id: { month: string; kind: string }; calls: number; cost: number; input: number; output: number }>([
    { $match: { orgId: oid(orgId) } },
    { $group: { _id: { month: '$month', kind: '$kind' }, calls: { $sum: 1 }, cost: { $sum: '$costInr' }, input: { $sum: { $add: ['$inputTokens', '$cacheReadTokens', '$cacheWriteTokens'] } }, output: { $sum: '$outputTokens' } } },
    { $sort: { '_id.month': -1 } },
  ]);
  const months = [...new Set(rows.map((r) => r._id.month))].slice(0, 6);
  return {
    enabled: !!st.plan?.features.includes('documentAI'),
    budgetInr: st.plan?.aiBudgetInr ?? 0,
    month: monthKey(),
    spentInr: await spentThisMonth(orgId),
    months: months.map((m) => {
      const of = (k: string) => rows.find((r) => r._id.month === m && r._id.kind === k);
      const e = of('extract'), a = of('assistant');
      return {
        month: m,
        documents: { calls: e?.calls ?? 0, costInr: Math.round((e?.cost ?? 0) * 100) / 100 },
        assistant: { calls: a?.calls ?? 0, costInr: Math.round((a?.cost ?? 0) * 100) / 100 },
        tokens: { input: (e?.input ?? 0) + (a?.input ?? 0), output: (e?.output ?? 0) + (a?.output ?? 0) },
      };
    }),
  };
}

/** For the screens: can Document AI be used right now, and if not, why. */
export async function aiStatus(orgId: string, configured: boolean) {
  if (!configured) return { configured, allowed: false, reason: 'The Claude API is not set up on this server (ANTHROPIC_API_KEY).' };
  try {
    await assertAiAllowed(orgId);
    return { configured, allowed: true, reason: null as string | null };
  } catch (e) {
    return { configured, allowed: false, reason: (e as Error).message };
  }
}
