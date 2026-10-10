package team.sopa.boar.engine.answer

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import team.sopa.boar.engine.ChatMessage
import team.sopa.boar.engine.GenerationEvent
import team.sopa.boar.engine.GenerationMetrics
import team.sopa.boar.engine.LlamaSession
import team.sopa.boar.engine.Sampling
import team.sopa.boar.engine.rag.Chunk
import team.sopa.boar.engine.rag.Compress
import team.sopa.boar.engine.rag.ConversationHistory
import team.sopa.boar.engine.rag.RagPure

/** One question for the default answer path. */
data class AnswerRequest(
    val query: String,
    val systemPrompt: String?,
    val styleReminder: String? = null,
    val maxTokens: Int = 512,
    val history: ConversationHistory? = null,
    /** Advanced tweak; off by default (EngineTweaks.thinking). */
    val enableThinking: Boolean = false,
)

enum class AnswerStage { RETRIEVING, THINKING, GENERATING }

sealed interface AnswerEvent {
    data class Stage(val stage: AnswerStage) : AnswerEvent
    /** The passages the model will read, numbered [1]..[n] in this order, with what compression saved. */
    data class Sources(val chunks: List<Chunk>, val retrievalMs: Double, val tokensBefore: Int, val tokensAfter: Int) : AnswerEvent
    data class Piece(val text: String) : AnswerEvent
    data class Done(
        /** The model's full text (thinking included, as the TS stores it). */
        val text: String,
        val sources: List<Chunk>,
        val taskType: String,
        val retrieved: Boolean,
        val retrievalMs: Double?,
        val tokensBefore: Int?,
        val tokensAfter: Int?,
        val promptFormat: String,
        val metrics: GenerationMetrics?,
    ) : AnswerEvent
}

/**
 * The default answer path, the one the Android app runs when neither Deep Research nor adaptive routing is on
 * (ChatScreen's runFixedModelChat, and the eval's fixed-model plan in src/routing/executor.ts): classify; retrieve
 * and keep the answering sentences unless the task needs no documents; then generate with the model's own chat
 * template (a hand-built prompt with stop words only for a model without one). Same prompts as the TS (golden tests).
 */
class AnswerPipeline(
    private val session: LlamaSession,
    /** retrieve(query, topK): Retriever.retrieve on the phone. */
    private val retrieve: (String, Int) -> List<Chunk>,
    /** classifyTask: the task type's name ("lookup", "greeting", …). */
    private val classify: (String) -> String,
    /** isRetrievalIrrelevant for a task type name. */
    private val retrievalIrrelevant: (String) -> Boolean,
    private val clock: () -> Double = { System.nanoTime() / 1e6 },
) {
    fun answer(req: AnswerRequest): Flow<AnswerEvent> = flow {
        val task = classify(req.query)
        var sources: List<Chunk> = emptyList()
        var retrievalMs: Double? = null
        var before: Int? = null
        var after: Int? = null
        val retrieved = !retrievalIrrelevant(task)
        if (retrieved) {
            emit(AnswerEvent.Stage(AnswerStage.RETRIEVING))
            val t0 = clock()
            // A follow-up ("What did he publish?") is searched with the previous question (FollowUp).
            val found = FollowUp.search(req.query, req.history) { retrieve(it, ANSWER_CONTEXT_CHUNKS) }
            // Only the sentences that answer: a shorter prompt brings the first word sooner.
            val c = Compress.forAnswer(found.searchedFor, found.chunks, task)
            retrievalMs = clock() - t0
            sources = c.chunks
            before = c.tokensBefore
            after = c.tokensAfter
            emit(AnswerEvent.Sources(sources, retrievalMs, c.tokensBefore, c.tokensAfter))
        }
        emit(AnswerEvent.Stage(AnswerStage.THINKING))
        val useTemplate = session.info.optBoolean("hasChatTemplate", false)
        val (prompt, stops) = if (useTemplate) {
            val messages = RagPure.assembleChatMessages(req.query, sources, req.systemPrompt, req.history, req.styleReminder).map { ChatMessage(it.role, it.content) }
            // llama.rn left enable_thinking at the template's default (on); here it's the user's tweak, off by default,
            // so a thinking model doesn't spend the answer's token cap reasoning.
            val f = session.formatChat(messages, enableThinking = req.enableThinking)
            f.prompt to f.stops
        } else {
            RagPure.assemblePrompt(req.query, sources, req.systemPrompt, req.history, req.styleReminder) to DEFAULT_STOP_SEQUENCES
        }
        val text = StringBuilder()
        var metrics: GenerationMetrics? = null
        var first = true
        session.generate(prompt, Sampling(nPredict = req.maxTokens, temperature = 0.7f, stops = stops)).collect { e ->
            when (e) {
                is GenerationEvent.Piece -> {
                    if (first) { first = false; emit(AnswerEvent.Stage(AnswerStage.GENERATING)) }
                    text.append(e.text)
                    emit(AnswerEvent.Piece(e.text))
                }
                is GenerationEvent.Done -> metrics = e.metrics
            }
        }
        emit(AnswerEvent.Done(text.toString(), sources, task, retrieved, retrievalMs, before, after, if (useTemplate) "chat-template" else "plain", metrics))
    }

    companion object {
        /** Passages retrieved per answer (src/rag/pure.ts ANSWER_CONTEXT_CHUNKS). */
        const val ANSWER_CONTEXT_CHUNKS = 4
        /** Turn ends for the hand-built prompt only (src/inference/LlamaEngine.ts DEFAULT_STOP_SEQUENCES). */
        val DEFAULT_STOP_SEQUENCES = listOf("\nUser:", "\n\nUser:", "\nQuestion:", "\n\nQuestion:")
    }
}
