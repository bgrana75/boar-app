package team.sopa.boar.engine.answer

import team.sopa.boar.engine.rag.ConversationTurn
import team.sopa.boar.engine.rag.Js

/** Chat titles and running summaries (port of src/services/summarize.ts), with the same prompts and settings. */
object Summarize {
    private const val TITLE_INSTRUCTION =
        "Generate a short 3-5 word title (no punctuation, no quotes) for a chat that starts with the user's message. Reply with the title only."
    private const val SUMMARY_INSTRUCTION =
        "Summarize the key facts, constraints, and user preferences from this conversation into 2-3 bullet points."
    private val EDGE_QUOTE = Regex("^[\"']|[\"']\\z")

    /** generateSessionTitle's clean-up: first line, edge quotes removed, at most 60 characters; "New chat" when empty. */
    fun cleanTitle(text: String): String = Js.trim(text).replace(EDGE_QUOTE, "").split("\n")[0].take(60).ifEmpty { "New chat" }

    suspend fun title(generator: StageGenerator, firstUserMessage: String, timeoutMs: Long? = null): String =
        cleanTitle(generator.generate(TITLE_INSTRUCTION, "\"$firstUserMessage\"", 16, 0.3f, timeoutMs, null).text)

    suspend fun summary(generator: StageGenerator, turns: List<ConversationTurn>, previousSummary: String?, timeoutMs: Long? = null): String {
        val transcript = turns.joinToString("\n") { "${if (it.role == "user") "User" else "Assistant"}: ${it.text}" }
        val input = (if (!previousSummary.isNullOrEmpty()) "Existing summary:\n$previousSummary\n\n" else "") + transcript
        return Js.trim(generator.generate(SUMMARY_INSTRUCTION, input, 150, 0.3f, timeoutMs, null).text)
    }
}
