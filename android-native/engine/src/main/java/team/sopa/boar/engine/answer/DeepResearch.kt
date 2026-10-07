package team.sopa.boar.engine.answer

import team.sopa.boar.engine.EngineTweaks
import team.sopa.boar.engine.rag.Chunk
import team.sopa.boar.engine.rag.ConversationHistory
import team.sopa.boar.engine.rag.Js
import team.sopa.boar.engine.routing.ResearchContext

/**
 * One instruction-style generation: system + user in the model's chat template, or a plain prompt ending in "Answer:"
 * for a model without one (src/inference/format.ts taskRequest). Returns the text; [onToken] streams it.
 */
fun interface StageGenerator {
    /** Generates within [timeoutMs] (null: no limit); on timeout it returns what was written and reports it through [GenResult.timedOut]. */
    suspend fun generate(system: String, user: String, nPredict: Int, temperature: Float, timeoutMs: Long?, onToken: ((String) -> Unit)?): GenResult
}

enum class ResearchStage { DECOMPOSING, RESEARCHING, SYNTHESIZING }

data class ResearchProgress(
    val stage: ResearchStage,
    val subQuestionIndex: Int? = null,
    val subQuestionCount: Int? = null,
    val subQuestion: String? = null,
    val answering: Boolean = false,
)

data class ResearchResult(
    val answer: String,
    val subQuestions: List<String>,
    /** Global numbered sources: "[n]" in the answer is citations[n - 1]. */
    val citations: List<Chunk>,
    /** The same sources as retrieved, before compression. */
    val fullCitations: List<Chunk>,
    /** A stage hit its time limit and was cut off. */
    val timedOut: Boolean = false,
)

/**
 * Deep Research (port of src/services/orchestrator.ts): one model, several passes. Decompose the question into 2–3
 * sub-questions, research each over its own retrieval (compressed, off-topic sources dropped, numbered globally),
 * then synthesize one answer. Same prompts as the TS (golden test with a recording generator).
 */
class DeepResearch(
    private val generator: StageGenerator,
    /** retrieve(query, topK) */
    private val retrieve: (String, Int) -> List<Chunk>,
    /** Time limit for a stage of n tokens (EngineTweaks.stageTimeoutMs, the user's setting); null = none. */
    private val timeoutFor: (Int) -> Long? = EngineTweaks()::stageTimeoutMs,
) {
    suspend fun run(
        query: String,
        systemPrompt: String?,
        history: ConversationHistory?,
        maxTokens: Int,
        onProgress: (ResearchProgress) -> Unit = {},
        onToken: (String) -> Unit = {},
        shouldStop: () -> Boolean = { false },
        retrieveK: Int = 6,
        answerLanguage: String? = null,
        onSources: (List<Chunk>) -> Unit = {},
        onPartialSources: (List<Chunk>, Int, Int) -> Unit = { _, _, _ -> },
    ): ResearchResult {
        timedOut = false
        onProgress(ResearchProgress(ResearchStage.DECOMPOSING))
        val subQuestions = decompose(query)
        val subResults = ArrayList<Pair<String, String>>()
        val perQuestion = ArrayList<List<Chunk>>()
        var all: List<Chunk> = emptyList()
        val fullById = LinkedHashMap<String, Chunk>()
        fun full() = all.map { fullById[it.chunkId] ?: it }
        for ((i, sub) in subQuestions.withIndex()) {
            if (shouldStop()) return ResearchResult("", subQuestions, all, full(), timedOut)
            onProgress(ResearchProgress(ResearchStage.RESEARCHING, i, subQuestions.size, sub))
            val retrieved = retrieve(sub, retrieveK)
            for (c in retrieved) fullById.putIfAbsent(c.chunkId, c)
            val compressed = ResearchContext.compressContext(sub, retrieved, tokenBudget = SUB_QUESTION_CONTEXT_TOKENS).chunks
            // A source off the topic of this sub-question, or of the whole question, is not read, numbered or shown.
            val chunks = compressed.filter { ResearchContext.onTopic(sub, it) || ResearchContext.onTopic(query, it) }
            perQuestion += chunks
            val merged = ResearchContext.mergeSources(perQuestion)
            val grew = merged.sources.size > all.size
            all = merged.sources
            if (grew) onPartialSources(all, i, subQuestions.size)
            onProgress(ResearchProgress(ResearchStage.RESEARCHING, i, subQuestions.size, sub, answering = true))
            subResults += sub to researchSubQuestion(sub, chunks, merged.indexMaps[i], systemPrompt, history)
        }
        onSources(all)
        if (shouldStop()) return ResearchResult("", subQuestions, all, full(), timedOut)
        onProgress(ResearchProgress(ResearchStage.SYNTHESIZING))
        val answer = synthesize(query, subResults, systemPrompt, maxTokens, onToken, answerLanguage)
        return ResearchResult(answer, subQuestions, all, full(), timedOut)
    }

    private var timedOut = false

    private suspend fun stage(system: String, user: String, nPredict: Int, temperature: Float, onToken: ((String) -> Unit)?): String {
        val r = generator.generate(system, user, nPredict, temperature, timeoutFor(nPredict), onToken)
        if (r.timedOut) timedOut = true
        return r.text
    }

    private suspend fun decompose(query: String): List<String> {
        val prompt = "Break this research question into 2-3 focused sub-questions that " +
            "together cover it well (e.g. technical analysis, counter-arguments, " +
            "practical implications — whichever fit this question). One per line, " +
            "no numbering, no extra commentary.\n\nQuestion: $query\n\nSub-questions:"
        return parseSubQuestions(stage("You plan research.", prompt, 150, 0.4f, null), query)
    }

    private suspend fun researchSubQuestion(sub: String, chunks: List<Chunk>, globalIndices: List<Int>, systemPrompt: String?, history: ConversationHistory?): String {
        val summary = history?.summary?.let { Js.trim(it) }?.takeIf { it.isNotEmpty() }?.let { "Summary of earlier conversation:\n$it\n\n" } ?: ""
        val context = if (chunks.isNotEmpty()) "Context:\n${numberedContext(chunks, globalIndices)}\n\n" else ""
        val system = "${instructionOf(systemPrompt)} Answer the question in a short paragraph using the context. " +
            "Cite sources with the exact bracket numbers shown in the context, like [3]. " +
            "If the context does not cover it, say so."
        return stage(system, "$summary${context}Question: $sub", 300, 0.6f, null)
    }

    private suspend fun synthesize(query: String, results: List<Pair<String, String>>, systemPrompt: String?, maxTokens: Int, onToken: (String) -> Unit, answerLanguage: String?): String {
        val perspectives = results.mapIndexed { i, (q, a) -> "Perspective ${i + 1} ($q):\n$a" }.joinToString("\n\n")
        val system = "${instructionOf(systemPrompt)} You are synthesizing multiple research perspectives into one answer. " +
            "Compare them, reconcile any conflicts, and write one unified, well-reasoned answer. " +
            "Keep the source numbers exactly as the perspectives cite them, like [3]; do not renumber or invent sources."
        val language = answerLanguage?.let { Js.trim(it) }?.takeIf { it.isNotEmpty() }?.let { "\n\n($it)" } ?: ""
        return stage(system, "Original question: $query\n\n$perspectives$language", maxTokens, 0.6f, onToken)
    }

    companion object {
        /** Per-sub-question context budget: three of these plus the synthesis still prefill fast. */
        const val SUB_QUESTION_CONTEXT_TOKENS = 600
        private val LIST_MARK = Regex("^[-*\\d.)${Js.WS.removePrefix("[").removeSuffix("]")}]+")

        /** The decomposition's lines as sub-questions (at most 3); the question itself when none is usable. */
        fun parseSubQuestions(text: String, query: String): List<String> {
            val lines = text.split("\n").map { Js.trim(it.replaceFirst(LIST_MARK, "")) }.filter { it.length > 8 }
            return lines.take(3).ifEmpty { listOf(query) }
        }

        /** Context block numbered with global source numbers. */
        fun numberedContext(chunks: List<Chunk>, globalIndices: List<Int>): String =
            chunks.mapIndexed { i, c -> "[${globalIndices[i] + 1}] ${c.title}\n${c.body}" }.joinToString("\n\n")

        private fun instructionOf(systemPrompt: String?): String =
            systemPrompt?.let { Js.trim(it) }?.takeIf { it.isNotEmpty() } ?: "You are an offline research assistant."
    }
}
