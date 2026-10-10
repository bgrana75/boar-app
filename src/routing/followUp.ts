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

/** Words that only make sense with an earlier subject (English and Portuguese); "there" is checked apart (thereAsPlace). */
const POINTS_BACK =
  /(?:^|[^\p{L}])(he|she|it|its|they|them|their|theirs|him|his|her|hers|this|that|these|those|ele|ela|eles|elas|dele|dela|deles|delas|isso|isto|aquilo|nele|nela|esse|essa|esses|essas)(?![\p{L}])/iu;

/** Words around an existential "there" ("Is there a cure?", "There are two kinds"), which points at nothing earlier. */
const EXISTENTIAL_BEFORE = new Set(["is", "are", "was", "were", "be", "been", "isn't", "aren't", "wasn't", "weren't"]);
const EXISTENTIAL_AFTER = new Set([
  "is", "are", "was", "were", "be", "been", "isn't", "aren't", "wasn't", "weren't", "will", "would", "could", "might",
  "may", "must", "seem", "seems", "appear", "appears", "exist", "exists", "remain", "remains", "used",
]);

/**
 * "there" as a place ("What happened there?", "Were they there last week?", "There?"), not the existential "is there"
 * of a question that brings its own subject ("Is there an effective treatment for malaria?", CodeRabbit on #80).
 */
function thereAsPlace(query: string): boolean {
  const words = query.toLowerCase().replace(/\u2019/g, "'").split(/[^\p{L}']+/u).filter(Boolean);
  return words.some((w, i) => w === "there" && !EXISTENTIAL_BEFORE.has(words[i - 1] ?? "") && !EXISTENTIAL_AFTER.has(words[i + 1] ?? ""));
}

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

/** The latest earlier question, never the current one (a history that already holds it would make it its own subject). */
function previousQuestion(query: string, history?: ConversationHistory): string | null {
  const turns = history?.turns ?? [];
  const current = query.trim();
  for (let i = turns.length - 1; i >= 0; i--) {
    const text = turns[i].text.trim();
    if (turns[i].role === "user" && text && text !== current) return text;
  }
  return null;
}

/** Words a question or request starts with, capitalized only because they open it (English and Portuguese). */
const OPENERS = new Set(
  (
    "what whats who whos whom whose which when whens where wheres why whys how hows is are was were am be do does did " +
    "can could should would will shall may might must have has had tell explain describe compare list give show define " +
    "summarize summarise name find write help please and but or so then also now ok okay i you we they he she it " +
    "there theres here heres " +
    "a an the any some my your in on at for of to from with about between after before during if " +
    "o os as um uma uns umas qual quais quem como quando onde por porque porquê que quê e mas ou então também agora " +
    "me fale explique descreva compare liste diga mostre defina resuma é são foi foram era há tem têm existe existem " +
    "eu você voce nós ele ela isso isto no na nos nas do da dos das de em para com sobre entre depois antes durante se"
  ).split(" ")
);

/**
 * A name the question brings itself ("Australia", "EIP-1559"): a capitalized word or one starting with a digit. The first
 * word counts too ("Australia capital?", CodeRabbit on #80), unless it is one a question usually opens with.
 */
function namesItsOwnSubject(query: string): boolean {
  const words = query.trim().split(/\s+/);
  return words.some((w, i) => {
    const bare = w.replace(/^["'(«“]/, "");
    if (!/^[\p{Lu}0-9]/u.test(bare)) return false;
    return i > 0 || !OPENERS.has(bare.toLowerCase().replace(/\u2019/g, "'").replace(/'/g, "").replace(/[^\p{L}0-9]+.*$/u, ""));
  });
}

export function followUpSearch(query: string, history?: ConversationHistory): FollowUpSearch {
  const previous = previousQuestion(query, history);
  if (!previous) return {};
  const combined = `${previous} ${query.trim()}`;
  if (POINTS_BACK.test(query) || thereAsPlace(query)) return { direct: combined, previous };
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
