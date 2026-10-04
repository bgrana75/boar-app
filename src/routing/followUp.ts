/**
 * What to search the library for when the question is a follow-up.
 *
 * Retrieval saw only the question's own words, so a follow-up found nothing:
 * "What did he publish?" after a Darwin answer, "What are the side effects?"
 * after a vaccines answer (Pixel 6a, 2026-10-04, both models: no sources). The
 * model still resolved "he" from the history and answered from memory, uncited,
 * which is the weaker case for the bounty (Qwen3-4B 0.49 from memory vs 0.61
 * with passages, r4to's eval).
 *
 * Rule, from the conversation's previous question:
 * - A question that points back ("he", "it", "that", "ele", "isso"…) is searched
 *   together with the previous question, and with the previous question alone
 *   when that finds nothing.
 * - A short question with no name of its own ("What are the side effects?") is
 *   searched as written first, and with the previous question only when that
 *   finds nothing. A self-contained question that finds sources keeps them, and
 *   one with a name ("the capital of Australia") never borrows another topic.
 *
 * Pure (no native imports), like context.ts, so it is unit-testable.
 */
import type { ConversationHistory } from "../rag/pure";
import { tokenizeTerms } from "./context";

/** Words that only make sense with an earlier subject (English and Portuguese). */
const POINTS_BACK =
  /(?:^|[^\p{L}])(he|she|it|its|they|them|their|theirs|him|his|her|hers|this|that|these|those|there|ele|ela|eles|elas|dele|dela|deles|delas|isso|isto|aquilo|nele|nela|esse|essa|esses|essas)(?![\p{L}])/iu;

/** At most this many content words for a question to borrow the previous one's topic when it finds nothing. */
export const SHORT_FOLLOW_UP_TERMS = 3;

export interface FollowUpSearch {
  /** Search this instead of the question (it points back). */
  direct?: string;
  /**
   * With `direct`: the previous question alone, when the combined text finds nothing. The keyword search
   * wants most of the query's words in a source, and the combined query has many: "Who proposed the theory
   * of evolution… What did he publish?" found 0 chunks, the Evolution article lacking "publish" (Pixel 6a).
   */
  previous?: string;
  /** Search this only if the question alone found nothing (short, no name of its own). */
  fallback?: string;
}

function previousQuestion(history?: ConversationHistory): string | null {
  const turns = history?.turns ?? [];
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].role === "user" && turns[i].text.trim()) return turns[i].text.trim();
  return null;
}

/** A capitalized word after the first one: a name the question brings itself ("Australia", "EIP-1559"). */
function namesItsOwnSubject(query: string): boolean {
  const words = query.trim().split(/\s+/).slice(1);
  return words.some((w) => /^[\p{Lu}0-9]/u.test(w.replace(/^["'(«“]/, "")));
}

export function followUpSearch(query: string, history?: ConversationHistory): FollowUpSearch {
  const previous = previousQuestion(history);
  if (!previous) return {};
  const combined = `${previous} ${query.trim()}`;
  if (POINTS_BACK.test(query)) return { direct: combined, previous };
  if (tokenizeTerms(query).length <= SHORT_FOLLOW_UP_TERMS && !namesItsOwnSubject(query)) return { fallback: combined };
  return {};
}

/**
 * Runs the search with the follow-up rule. `search` gets the text to search and
 * returns its chunks; the result says which text found them, so the caller
 * compresses against the same words.
 */
export async function searchWithFollowUp<T>(
  query: string,
  history: ConversationHistory | undefined,
  search: (text: string) => Promise<T[]>
): Promise<{ chunks: T[]; searchedFor: string }> {
  const plan = followUpSearch(query, history);
  if (plan.direct) {
    const chunks = await search(plan.direct);
    if (chunks.length || !plan.previous) return { chunks, searchedFor: plan.direct };
    // Found by the earlier subject; compressed against the combined words, so the sentences closest to the
    // follow-up ("publish") are the ones kept.
    return { chunks: await search(plan.previous), searchedFor: plan.direct };
  }
  const chunks = await search(query);
  if (chunks.length || !plan.fallback) return { chunks, searchedFor: query };
  return { chunks: await search(plan.fallback), searchedFor: plan.fallback };
}
