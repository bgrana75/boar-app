package team.sopa.boar.chat

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import team.sopa.boar.app.BoarServices
import team.sopa.boar.engine.answer.AnswerEvent
import team.sopa.boar.engine.answer.AnswerPipeline
import team.sopa.boar.engine.answer.AnswerRequest
import team.sopa.boar.engine.answer.AnswerStage
import team.sopa.boar.engine.answer.AnswerText
import team.sopa.boar.engine.answer.DeepResearch
import team.sopa.boar.engine.answer.PipelineInput
import team.sopa.boar.engine.answer.PlanExecutor
import team.sopa.boar.engine.answer.ResearchStage
import team.sopa.boar.engine.answer.SessionEngine
import team.sopa.boar.engine.answer.Summarize
import team.sopa.boar.engine.models.AssetKind
import team.sopa.boar.engine.rag.Chunk
import team.sopa.boar.engine.rag.ConversationHistory
import team.sopa.boar.engine.rag.ConversationTurn
import team.sopa.boar.engine.routing.AdaptivePlan
import team.sopa.boar.engine.routing.Classify
import team.sopa.boar.engine.routing.ModelRole
import team.sopa.boar.engine.routing.Profiles
import team.sopa.boar.engine.routing.RoutingPreset
import team.sopa.boar.engine.routing.TaskType

/** A source as the chat shows it (and stores with the answer): the passage the model read, and its similarity to the question. */
data class Source(val title: String, val source: String?, val relevance: Double?, val similarity: Double? = null, val docId: String? = null, val body: String = "")

data class UiMessage(
    val id: String,
    val role: String,
    val text: String,
    val sources: List<Source> = emptyList(),
    val feedback: String? = null,
    val stopped: Boolean = false,
    val timedOut: Boolean = false,
)

/** What the assistant is doing for the message being answered. */
sealed interface Activity {
    data object Retrieving : Activity
    data object Thinking : Activity
    data object Generating : Activity
    /** Deep Research: stage, sub-question index (1-based) and count. */
    data class Researching(val stage: ResearchStage, val index: Int?, val count: Int?) : Activity
}

data class ChatState(
    val sessionId: String? = null,
    val messages: List<UiMessage> = emptyList(),
    val answeringId: String? = null,
    val activity: Activity? = null,
    val liveTokPerSec: Double? = null,
    val modelLabel: String? = null,
    val noModel: Boolean = false,
    val deepResearch: Boolean = false,
    val error: String? = null,
    /** CR-2, shown once: the model that closed the app and the one answering instead. */
    val loadCrash: team.sopa.boar.engine.models.LoadGuard.Crash? = null,
    /** While the model loads or the corpus indexes: the line the Expo app shows under the header (chatScreen.*). */
    val loadingKey: String? = null,
    val personalityId: String = "succinct",
    val toneIcon: String = "",
    val online: Boolean = false,
    /** Suggested question keys for the empty chat (chat.suggestions.*). */
    val suggestions: List<String> = emptyList(),
)

/**
 * The chat (port of ChatScreen.tsx's send flow): Deep Research when it's on, adaptive routing when that's on, the
 * default answer path otherwise; the answer streams into its message, and both turns are saved with the answer's
 * sources. Stop cancels the generation in flight and the stages after it.
 */
class ChatViewModel(app: Application) : AndroidViewModel(app) {
    private val services = BoarServices.get(app)
    private val _state = MutableStateFlow(ChatState(deepResearch = services.settings.deepResearchMode))
    val state: StateFlow<ChatState> = _state
    private var job: Job? = null
    /** A chat title or summary still being written; a new question stops it (one model, one generation). */
    private var background: Job? = null
    @Volatile private var stopRequested = false

    private val suggestionData = team.sopa.boar.engine.chat.Suggestions.parse(app.assets.open("boar-data/suggestions.json").bufferedReader().use { it.readText() })

    init {
        refreshModel()
        refreshTone()
        watchConnectivity(app)
        preload()
    }

    /** Loads the model when the chat opens, as the Expo app does, so the first answer doesn't wait for it. */
    private fun preload() {
        if (services.activeModel() == null) return
        _state.update { it.copy(loadingKey = "chatScreen.mountingWeights") }
        viewModelScope.launch(Dispatchers.Default) {
            runCatching { services.activeSession() }
            val crash = services.loadGuard.consume()
            _state.update { it.copy(loadingKey = null, loadCrash = crash) }
            if (crash != null) refreshModel()
        }
    }

    private fun refreshTone() {
        val id = services.settings.personalityId ?: services.personalities.defaultId
        _state.update { it.copy(personalityId = id, toneIcon = services.personalities.get(id).icon) }
    }

    /** Back from settings: the tone, Deep Research and model may have changed. */
    fun refreshSettings() {
        refreshTone()
        refreshModel()
        _state.update { it.copy(deepResearch = services.settings.deepResearchMode) }
    }

    /** The header's tone button: the next style ("custom" only when a custom prompt is written). */
    fun cycleTone() {
        val custom = services.settings.customSystemPrompt.orEmpty().isNotBlank()
        val order = services.personalities.personalities.map { it.id }.filter { it != "custom" || custom }
        val next = order[(order.indexOf(_state.value.personalityId) + 1) % order.size]
        services.settings.personalityId = next
        refreshTone()
    }

    /** ONLINE / OFFLINE in the header (connectivity.pure.ts isOnline: connected and the internet not known unreachable). */
    private fun watchConnectivity(app: Application) {
        val cm = app.getSystemService(android.net.ConnectivityManager::class.java) ?: return
        fun current() = cm.getNetworkCapabilities(cm.activeNetwork)?.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
        _state.update { it.copy(online = current()) }
        runCatching {
            cm.registerDefaultNetworkCallback(object : android.net.ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: android.net.Network) { _state.update { it.copy(online = current()) } }
                override fun onLost(network: android.net.Network) { _state.update { it.copy(online = current()) } }
                override fun onCapabilitiesChanged(network: android.net.Network, caps: android.net.NetworkCapabilities) { _state.update { it.copy(online = current()) } }
            })
        }
    }

    /** After setup or a model change: the active model's name, or that there's none. */
    fun refreshModel() {
        val m = services.answerModel()
        val lang = getApplication<Application>().resources.configuration.locales[0]?.language
        val installed = services.catalog.corpusCatalog.filter { services.fileOf(it).isFile }.map { it.id }
        // shortModelLabel: the catalog label without its parenthesis ("Qwen3-4B-Instruct-2507").
        val label = m?.label?.replace(Regex("\\s*\\([^)]*\\)"), "")?.replace(Regex("\\s{2,}"), " ")?.trim()?.ifEmpty { m.label.trim() }
        _state.update { it.copy(modelLabel = label, noModel = m == null, suggestions = suggestionData.forModel(m?.id, lang, installed)) }
    }

    fun dismissLoadCrash() = _state.update { it.copy(loadCrash = null) }

    fun setDeepResearch(on: Boolean) {
        services.settings.deepResearchMode = on
        _state.update { it.copy(deepResearch = on) }
    }

    fun newChat() {
        if (job?.isActive == true) return
        _state.update { it.copy(sessionId = null, messages = emptyList(), error = null) }
    }

    fun openSession(id: String) {
        if (job?.isActive == true) return
        viewModelScope.launch {
            val msgs = withContext(Dispatchers.IO) { services.chats.messages(id) }.map { r ->
                UiMessage(r.id, r.role, r.text, sourcesFromMeta(r.meta), r.feedback)
            }
            _state.update { it.copy(sessionId = id, messages = msgs, error = null) }
        }
    }

    fun rate(messageId: String, rating: String) {
        val current = _state.value.messages.firstOrNull { it.id == messageId }?.feedback
        val next = if (current == rating) null else rating
        _state.update { s -> s.copy(messages = s.messages.map { if (it.id == messageId) it.copy(feedback = next) else it }) }
        viewModelScope.launch(Dispatchers.IO) { services.chats.setFeedback(messageId, next) }
    }

    fun stop() {
        stopRequested = true
        services.host.current()?.cancel()
    }

    fun send(query: String) {
        val q = query.trim()
        if (q.isEmpty() || job?.isActive == true) return
        stopRequested = false
        job = viewModelScope.launch(Dispatchers.Default) {
            stopBackground()
            val chats = services.chats
            val isNewSession = _state.value.sessionId == null
            // The question stands in as the title until the model writes one.
            val sessionId = _state.value.sessionId ?: chats.createSession().also { s -> chats.setTitle(s.id, q.take(60)) }.id
            val prior = _state.value.messages.filter { it.text.isNotEmpty() }
            val userId = chats.newId()
            val answerId = chats.newId()
            chats.addMessage(sessionId, "user", q, userId)
            _state.update {
                it.copy(sessionId = sessionId, error = null, answeringId = answerId, activity = Activity.Retrieving, liveTokPerSec = null,
                    messages = it.messages + UiMessage(userId, "user", q) + UiMessage(answerId, "assistant", ""))
            }
            val settings = services.settings
            val (systemPrompt, styleReminder) = services.personalities.promptFor(settings.personalityId, settings.customSystemPrompt)
            val history = ConversationHistory(
                summary = chats.listSessions().firstOrNull { it.id == sessionId }?.summary,
                turns = prior.takeLast(VERBATIM_MESSAGE_COUNT).map { ConversationTurn(it.role, if (it.role == "assistant") AnswerText.stripThinking(it.text) else it.text) },
            )
            val text = StringBuilder()
            var sources: List<Chunk> = emptyList()
            var timedOut = false
            var firstAt = 0L
            var tokens = 0
            fun onPiece(piece: String) {
                tokens++
                if (firstAt == 0L) firstAt = System.nanoTime()
                text.append(piece)
                val elapsed = (System.nanoTime() - firstAt) / 1e9
                _state.update { s ->
                    s.copy(activity = Activity.Generating, liveTokPerSec = if (elapsed > 0.5) tokens / elapsed else s.liveTokPerSec,
                        messages = s.messages.map { if (it.id == answerId) it.copy(text = text.toString()) else it })
                }
            }
            try {
                val session = services.activeSession()
                if (session == null) {
                    _state.update { it.copy(noModel = true, error = "no-model") }
                } else if (_state.value.deepResearch) {
                    val r = DeepResearch(SessionEngine(session, settings.engineTweaks.thinkingEnabled), services.retriever::retrieve, settings.engineTweaks::stageTimeoutMs).run(
                        q, systemPrompt, history, settings.maxTokens,
                        onProgress = { p -> _state.update { it.copy(activity = Activity.Researching(p.stage, p.subQuestionIndex?.plus(1), p.subQuestionCount)) } },
                        onToken = ::onPiece,
                        shouldStop = { stopRequested },
                    )
                    sources = r.citations
                    timedOut = r.timedOut
                } else if (settings.adaptiveRoutingEnabled) {
                    val r = adaptive(q, systemPrompt, styleReminder, history, ::onPiece)
                    sources = r.first
                    timedOut = r.second
                } else {
                    val pipeline = AnswerPipeline(session, services.retriever::retrieve, { Classify.classifyTask(it).value }, { Classify.isRetrievalIrrelevant(TaskType.of(it)) })
                    pipeline.answer(AnswerRequest(q, systemPrompt, styleReminder, settings.maxTokens, history, enableThinking = settings.engineTweaks.thinkingEnabled)).collect { e ->
                        when (e) {
                            is AnswerEvent.Stage -> _state.update { it.copy(activity = when (e.stage) { AnswerStage.RETRIEVING -> Activity.Retrieving; AnswerStage.THINKING -> Activity.Thinking; AnswerStage.GENERATING -> Activity.Generating }) }
                            is AnswerEvent.Sources -> sources = e.chunks
                            is AnswerEvent.Piece -> onPiece(e.text)
                            is AnswerEvent.Done -> {}
                        }
                    }
                }
            } catch (e: Throwable) {
                _state.update { it.copy(error = e.message ?: e.toString()) }
            }
            val shown = sources.map { Source(it.title, it.source, it.relevance, it.similarity, it.docId, it.body) }
            val stopped = stopRequested
            chats.upsertMessage(sessionId, "assistant", text.toString(), answerId)
            if (shown.isNotEmpty()) chats.setMessageMeta(answerId, metaOf(shown))
            afterAnswer(sessionId, isNewSession, stopped, prior + UiMessage(userId, "user", q) + UiMessage(answerId, "assistant", text.toString()), systemPrompt)
            chats.prune(settings.maxSavedSessions)
            _state.update { s ->
                s.copy(answeringId = null, activity = null,
                    messages = s.messages.map { if (it.id == answerId) it.copy(text = text.toString(), sources = shown, stopped = stopped, timedOut = timedOut) else it })
            }
        }
    }

    /**
     * Stops a title or summary still being written, as ChatScreen.tsx does (cancelBackgroundTask), instead of making the
     * question wait for it: a summary reads every older turn first, which on a slow phone held the next question for tens
     * of seconds. Cancelling the job keeps one that hasn't started from starting, and makes one that has throw instead of
     * returning, so nothing half-written is saved; the native cancel stops the prompt reading or writing in progress. A
     * stopped title keeps the question as the chat's title; a stopped summary is written after a later answer.
     */
    private suspend fun stopBackground() {
        val running = background?.takeIf { it.isActive } ?: return
        running.cancel()
        services.host.current()?.cancel()
        running.join()
    }

    /**
     * As ChatScreen.tsx after an answer: a new chat gets a model-written title (autoGenerateTitles); a long one gets its
     * older turns summarized (autoSummarize, past historyTurnThreshold), in the background.
     */
    private fun afterAnswer(sessionId: String, isNewSession: Boolean, stopped: Boolean, all: List<UiMessage>, systemPrompt: String?) {
        if (stopped) return
        val s = services.settings
        val session = services.host.current() ?: return
        val gen = SessionEngine(session)
        if (isNewSession && s.autoGenerateTitles) {
            background = viewModelScope.launch(Dispatchers.Default) {
                runCatching { services.chats.setTitle(sessionId, Summarize.title(gen, all.first { it.role == "user" }.text)) }
                runCatching { warmPrefix(session, systemPrompt) }
            }
        } else if (s.autoSummarize && all.size / 2 > s.historyTurnThreshold) {
            val older = all.dropLast(VERBATIM_MESSAGE_COUNT)
            if (older.isEmpty()) return
            val previous = services.chats.listSessions().firstOrNull { it.id == sessionId }?.summary
            background = viewModelScope.launch(Dispatchers.Default) {
                runCatching {
                    val turns = older.map { ConversationTurn(it.role, if (it.role == "assistant") AnswerText.stripThinking(it.text) else it.text) }
                    services.chats.setSummary(sessionId, Summarize.summary(gen, turns, previous))
                }
                runCatching { warmPrefix(session, systemPrompt) }
            }
        }
    }

    /**
     * A title or summary left its own prompt in the KV cache, so the next question would read the whole system prompt
     * again (about 230 tokens, 8 s on a 4B). Prefill it back: the next answer reuses it (#72's warm-up).
     */
    private suspend fun warmPrefix(session: team.sopa.boar.engine.LlamaSession, systemPrompt: String?) {
        val (head, plain) = team.sopa.boar.engine.rag.RagPure.answerPromptPrefix(systemPrompt)
        val prompt = if (session.info.optBoolean("hasChatTemplate", false))
            session.formatChat(listOf(team.sopa.boar.engine.ChatMessage("system", head)), services.settings.engineTweaks.thinkingEnabled).prompt
        else plain
        session.generate(prompt, team.sopa.boar.engine.Sampling(nPredict = 0)).collect {}
    }

    /** runAdaptiveChat: plan with the installed models and the user's routing settings, then execute. */
    private suspend fun adaptive(q: String, systemPrompt: String, styleReminder: String?, history: ConversationHistory, onPiece: (String) -> Unit): Pair<List<Chunk>, Boolean> {
        val s = services.settings
        val statuses = services.catalog.models.filter { it.kind == AssetKind.LLM }.map { Profiles.AvailableModel(it, services.fileOf(it).isFile) }
        val preset = s.routingPreset?.let { runCatching { RoutingPreset.of(it) }.getOrNull() } ?: RoutingPreset.DEFAULT
        val overrides = s.modelRoleAssignments().mapNotNull { (k, v) -> runCatching { ModelRole.of(k) to v }.getOrNull() }.toMap()
        val plan = AdaptivePlan.plan(q, statuses, preset, overrides, s.activeModelId("llm"), totalRamBytes(), s.maxTokens)
        val r = PlanExecutor(services.host, services.retriever::retrieve, { Classify.classifyTask(it).value }, timeoutFor = s.engineTweaks::stageTimeoutMs)
            .execute(plan.plan, PipelineInput(q, systemPrompt, styleReminder, history), onToken = onPiece, onStepStart = { step ->
                _state.update { it.copy(activity = if (step.type.value == "retrieve") Activity.Retrieving else Activity.Thinking) }
            }, shouldStop = { stopRequested })
        if (r.answer.isBlank() && !stopRequested) error("adaptive routing produced no answer: ${r.warnings.joinToString()}")
        return r.citations to r.timedOut
    }

    /** The phone's RAM (ram-monitor's getDeviceTotalRamBytes); 0 when unreadable. */
    private fun totalRamBytes(): Long = runCatching {
        val am = getApplication<Application>().getSystemService(android.app.ActivityManager::class.java)
        android.app.ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }.totalMem
    }.getOrDefault(0L)

    private fun metaOf(sources: List<Source>): String = JsonObject(mapOf("sources" to JsonArray(sources.map { s ->
        JsonObject(listOfNotNull(
            "title" to JsonPrimitive(s.title), s.source?.let { "source" to JsonPrimitive(it) }, s.relevance?.let { "relevance" to JsonPrimitive(it) },
            s.similarity?.let { "similarity" to JsonPrimitive(it) }, s.docId?.let { "docId" to JsonPrimitive(it) }, "body" to JsonPrimitive(s.body),
        ).toMap())
    }))).toString()

    private fun sourcesFromMeta(meta: String?): List<Source> = runCatching {
        Json.parseToJsonElement(meta ?: return emptyList()).jsonObject["sources"]!!.jsonArray.map { e ->
            val o = e.jsonObject
            Source(
                o["title"]!!.jsonPrimitive.content, o["source"]?.jsonPrimitive?.content, o["relevance"]?.jsonPrimitive?.content?.toDoubleOrNull(),
                o["similarity"]?.jsonPrimitive?.content?.toDoubleOrNull(), o["docId"]?.jsonPrimitive?.content, o["body"]?.jsonPrimitive?.content ?: "",
            )
        }
    }.getOrDefault(emptyList())

    companion object {
        /** Messages sent verbatim as history (ChatScreen.tsx VERBATIM_MESSAGE_COUNT). */
        const val VERBATIM_MESSAGE_COUNT = 6
    }
}
