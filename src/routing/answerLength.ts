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
 * Length = min(max tokens, decode speed × writing time), as a word target with a
 * margin for formatting and citations. Writing time = the step limit minus the
 * time to the first word minus a safety margin, at most ANSWER_TIME_BUDGET_S.
 * Speed and first-word time come from the latest answer when it is recent, since
 * a phone that heats up writes slower (Pixel 6a, 2026-10-04: 4.9 → 2.5 tok/s over
 * one conversation, and with the median speed two answers were still cut).
 * A model never measured on this phone only gets the max-tokens target.
 *
 * Pure (no native imports), so it is unit-testable.
 */

/** The step timeout the answer has to fit in, first word included (STEP_TIMEOUT_MS in executor.ts). */
export const STEP_LIMIT_S = 120;
/** Kept free under the step limit: decode keeps slowing while the phone heats during the answer. */
export const SAFETY_S = 15;
/** Most seconds of writing an answer may take. */
export const ANSWER_TIME_BUDGET_S = 90;
/** Least: below this the answer would be a sentence, whatever the phone. */
export const MIN_WRITE_S = 30;
/** A measurement older than this says little about the phone's current temperature. */
export const RECENT_MS = 15 * 60_000;
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

export function answerLength(i: { maxTokens: number; tokPerSec?: number; ttftMs?: number }): AnswerLength {
  const writeS = Math.min(ANSWER_TIME_BUDGET_S, Math.max(MIN_WRITE_S, STEP_LIMIT_S - (i.ttftMs ?? 0) / 1000 - SAFETY_S));
  const byTime = i.tokPerSec && i.tokPerSec > 0 ? Math.floor(i.tokPerSec * writeS) : Infinity;
  const tokens = Math.min(i.maxTokens, byTime);
  const words = Math.max(MIN_ANSWER_WORDS, Math.round((tokens * WORDS_PER_TOKEN) / 10) * 10);
  return { tokens, words, limit: byTime < i.maxTokens ? "time" : "max" };
}

export function lengthInstruction(words: number): string {
  return `Keep the whole answer under about ${words} words, and finish it.`;
}

export interface SpeedRecord {
  modelId?: string;
  createdAt?: number;
  outcome?: string;
  tokensGenerated?: number;
  tokPerSec?: number;
  ttftMs?: number;
}

/**
 * The speed to size the next answer with: the model's latest successful answer of at least 16 tokens
 * when it is recent (with its time to the first word), else `typical` (the median over all answers).
 */
export function currentSpeed(
  records: SpeedRecord[],
  modelId: string | undefined,
  now: number,
  typical?: number
): { tokPerSec?: number; ttftMs?: number } {
  if (!modelId) return {};
  const latest = records
    .filter((r) => r.modelId === modelId && (!r.outcome || r.outcome === "success") && (r.tokensGenerated ?? 0) >= 16 && (r.tokPerSec ?? 0) > 0)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
  if (latest && latest.createdAt !== undefined && now - latest.createdAt <= RECENT_MS) {
    return { tokPerSec: latest.tokPerSec, ttftMs: latest.ttftMs };
  }
  return { tokPerSec: typical };
}
