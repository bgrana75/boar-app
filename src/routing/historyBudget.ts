/**
 * Conversation history that fits a token budget, for the answer prompt.
 *
 * The chat sent the last 6 messages verbatim, counted in messages. With the
 * detailed personality each answer is ~500 tokens, so history alone grew to
 * ~1,700 tokens and the first word of a follow-up took 20-48 s on a Pixel 6a
 * (1.5B, 2026-10-03), against 1.6 s for the same question in a new chat.
 *
 * Rule: newest turns first, within `budgetTokens`. A question is kept whole;
 * an earlier answer is cut to its opening sentences (`answerTokens`), since a
 * follow-up mostly needs what the answer was about, and the full text is still
 * on screen. The latest exchange is always kept, even over budget.
 *
 * Pure (no native imports), like context.ts, so it is unit-testable.
 */
import type { ConversationTurn } from "../rag/pure";
import { approxTokens, splitSentences } from "./context";

export const HISTORY_BUDGET_TOKENS = 400;
export const HISTORY_ANSWER_TOKENS = 80;

/** The opening sentences of `text` within `maxTokens`; at least the first sentence, cut by characters if it alone is too long. */
export function leadSentences(text: string, maxTokens: number, count = approxTokens): string {
  if (count(text) <= maxTokens) return text;
  const sentences = splitSentences(text);
  let out = "";
  for (const s of sentences) {
    const next = out ? `${out} ${s}` : s;
    if (count(next) > maxTokens) break;
    out = next;
  }
  if (!out) out = `${(sentences[0] ?? text).slice(0, maxTokens * 4).trimEnd()}`;
  return `${out} …`;
}

export function budgetHistory(
  turns: ConversationTurn[],
  opts: { budgetTokens?: number; answerTokens?: number; countTokens?: (s: string) => number } = {}
): ConversationTurn[] {
  const budget = opts.budgetTokens ?? HISTORY_BUDGET_TOKENS;
  const answerTokens = opts.answerTokens ?? HISTORY_ANSWER_TOKENS;
  const count = opts.countTokens ?? approxTokens;

  const kept: ConversationTurn[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    const text = t.role === "assistant" ? leadSentences(t.text, answerTokens, count) : t.text;
    const cost = count(text);
    // The latest exchange (one question and its answer) always goes in.
    if (used + cost > budget && kept.length >= 2) break;
    kept.unshift({ role: t.role, text });
    used += cost;
  }
  return kept;
}
