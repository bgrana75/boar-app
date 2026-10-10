package team.sopa.boar.engine.answer

import team.sopa.boar.engine.rag.Compress
import team.sopa.boar.engine.rag.ConversationHistory
import team.sopa.boar.engine.rag.Js

/**
 * What to search the library for when the question is a follow-up (port of src/routing/followUp.ts; golden test:
 * scripts/export-native-golden-followup.mjs).
 *
 * Retrieval saw only the question's own words, so a follow-up found nothing: "What did he publish?" after a Darwin
 * answer, "What are the side effects?" after a vaccines answer (Pixel 6a, Expo app, 2026-10-04). The model resolved "he"
 * from the history and answered from memory, uncited: the weaker case for the bounty (Qwen3-4B 0.49 from memory vs 0.61
 * with passages). From the conversation's previous question:
 * - a question that points back ("he", "it", "isso"…) is searched together with the previous question, and with the
 *   previous question alone when that finds nothing;
 * - a short question with no name of its own is searched as written first, and with the previous question only when
 *   that finds nothing. A question that finds sources keeps them, and one with a name never borrows another topic.
 */
object FollowUp {
    /** Words that only make sense with an earlier subject (English and Portuguese). */
    private val POINTS_BACK = Regex(
        "(?:^|[^\\p{L}])(he|she|it|its|they|them|their|theirs|him|his|her|hers|this|that|these|those|there|ele|ela|eles|elas|dele|dela|deles|delas|isso|isto|aquilo|nele|nela|esse|essa|esses|essas)(?![\\p{L}])",
        RegexOption.IGNORE_CASE,
    )

    /** At most this many content words for a question to borrow the previous one's topic when it finds nothing. */
    const val SHORT_FOLLOW_UP_TERMS = 3

    /**
     * [direct]: search this instead of the question (it points back); [previous]: with [direct], the previous question
     * alone when the combined text finds nothing; [fallback]: search this only if the question alone found nothing.
     */
    data class Plan(val direct: String? = null, val previous: String? = null, val fallback: String? = null)

    /** The chunks found, and the text that found them (the caller compresses against the same words). */
    data class Found<T>(val chunks: List<T>, val searchedFor: String)

    private val SPACES = Regex("${Js.WS}+")
    private val OPENING_MARK = Regex("^[\"'(«“]")
    private val CAPITAL_OR_DIGIT = Regex("^[\\p{Lu}0-9]")

    /** The latest earlier question, never the current one (a history that already holds it would make it its own subject). */
    private fun previousQuestion(query: String, history: ConversationHistory?): String? {
        val turns = history?.turns.orEmpty()
        val current = Js.trim(query)
        for (i in turns.indices.reversed()) {
            val text = Js.trim(turns[i].text)
            if (turns[i].role == "user" && text.isNotEmpty() && text != current) return text
        }
        return null
    }

    /** A capitalized word after the first one: a name the question brings itself ("Australia", "EIP-1559"). */
    private fun namesItsOwnSubject(query: String): Boolean =
        Js.trim(query).split(SPACES).drop(1).any { CAPITAL_OR_DIGIT.containsMatchIn(OPENING_MARK.replaceFirst(it, "")) }

    fun plan(query: String, history: ConversationHistory?): Plan {
        val previous = previousQuestion(query, history) ?: return Plan()
        val combined = "$previous ${Js.trim(query)}"
        if (POINTS_BACK.containsMatchIn(query)) return Plan(direct = combined, previous = previous)
        if (Compress.tokenizeTerms(query).size <= SHORT_FOLLOW_UP_TERMS && !namesItsOwnSubject(query)) return Plan(fallback = combined)
        return Plan()
    }

    /** Runs [find] (the text to search → its chunks) with the follow-up rule. */
    fun <T> search(query: String, history: ConversationHistory?, find: (String) -> List<T>): Found<T> {
        val p = plan(query, history)
        if (p.direct != null) {
            val chunks = find(p.direct)
            if (chunks.isNotEmpty() || p.previous == null) return Found(chunks, p.direct)
            // Found by the earlier subject; compressed against the combined words, so the sentences closest to the
            // follow-up ("publish") are the ones kept.
            return Found(find(p.previous), p.direct)
        }
        val chunks = find(query)
        if (chunks.isNotEmpty() || p.fallback == null) return Found(chunks, query)
        return Found(find(p.fallback), p.fallback)
    }
}
