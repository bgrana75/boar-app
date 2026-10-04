/**
 * How long an answer should be on this phone, so it ends instead of being cut.
 *
 * Two hard stops cut answers mid-sentence: the user's Max Output Tokens (512 by
 * default; detailed answers from Qwen2.5-1.5B hit it) and the 120 s step
 * timeout (Qwen3-4B on a Pixel 6a writes ~4 tok/s, so every detailed answer
 * stopped at ~450 tokens, 2026-10-04). Raising them would trade a cut answer for
 * minutes of waiting, so they stay; instead the model is told the length up
 * front and plans a complete answer that fits.
 *
 * Length = min(max tokens, measured decode speed × ANSWER_TIME_BUDGET_S), as a
 * word target with a margin for formatting and citations. A model never measured
 * on this phone only gets the max-tokens target.
 *
 * Pure (no native imports), so it is unit-testable.
 */

/** Seconds of writing an answer may take; leaves room under the 120 s step timeout for the first word. */
export const ANSWER_TIME_BUDGET_S = 90;
/** English prose averages ~0.75 words per token; 0.8 of that leaves room for lists, citations and the closing line. */
const WORDS_PER_TOKEN = 0.75 * 0.8;
/** Below this the target would read as "be terse" rather than "fit the phone"; such a phone gets this many. */
export const MIN_ANSWER_WORDS = 60;

export interface AnswerLength {
  /** Tokens the answer can take on this phone. */
  tokens: number;
  /** The word target given to the model. */
  words: number;
  /** "time" when the phone's speed is the limit, "max" when the user's Max Output Tokens is. */
  limit: "time" | "max";
}

export function answerLength(i: { maxTokens: number; tokPerSec?: number }): AnswerLength {
  const byTime = i.tokPerSec && i.tokPerSec > 0 ? Math.floor(i.tokPerSec * ANSWER_TIME_BUDGET_S) : Infinity;
  const tokens = Math.min(i.maxTokens, byTime);
  const words = Math.max(MIN_ANSWER_WORDS, Math.round((tokens * WORDS_PER_TOKEN) / 10) * 10);
  return { tokens, words, limit: byTime < i.maxTokens ? "time" : "max" };
}

export function lengthInstruction(words: number): string {
  return `Keep the whole answer under about ${words} words, and finish it.`;
}
