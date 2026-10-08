import 'server-only';

/**
 * Which AI service reads documents and answers the assistant: Claude (Anthropic) or Groq.
 * AI_PROVIDER=claude | groq picks it; without it, whichever key is set wins (Claude first).
 */

export type AiProvider = 'claude' | 'groq';

const claudeKey = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const groqKey = () => !!process.env.GROQ_API_KEY;

export function aiProvider(): AiProvider {
  const p = (process.env.AI_PROVIDER ?? '').trim().toLowerCase();
  if (p === 'groq') return 'groq';
  if (p === 'claude' || p === 'anthropic') return 'claude';
  return !claudeKey() && groqKey() ? 'groq' : 'claude';
}

export const aiConfigured = () => (aiProvider() === 'groq' ? groqKey() : claudeKey());

/** "Claude API" / "Groq API" – for messages. */
export const aiName = () => (aiProvider() === 'groq' ? 'Groq API' : 'Claude API');
/** The environment variable that holds the key of the chosen provider. */
export const aiKeyVar = () => (aiProvider() === 'groq' ? 'GROQ_API_KEY' : 'ANTHROPIC_API_KEY');
export const aiNotSetUp = () => `The ${aiName()} is not set up on this server: set ${aiKeyVar()} and restart.`;
