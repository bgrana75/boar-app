package team.sopa.boar.eval

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import team.sopa.boar.engine.CpuTopology
import team.sopa.boar.engine.EngineParams
import team.sopa.boar.engine.EngineTweaks
import team.sopa.boar.engine.LlamaSession
import team.sopa.boar.engine.answer.AnswerEvent
import team.sopa.boar.engine.answer.AnswerPipeline
import team.sopa.boar.engine.answer.AnswerRequest
import team.sopa.boar.engine.answer.Personalities
import team.sopa.boar.engine.db.NativeSqlite
import team.sopa.boar.engine.eval.DeviceEval
import team.sopa.boar.engine.eval.EvalConfig
import team.sopa.boar.engine.eval.EvalQuery
import team.sopa.boar.engine.eval.EvalRequest
import team.sopa.boar.engine.eval.EvalRequestException
import team.sopa.boar.engine.eval.EvalSets
import team.sopa.boar.engine.eval.ModelRef
import team.sopa.boar.engine.eval.Resolved
import team.sopa.boar.engine.rag.KnowledgeBase
import team.sopa.boar.engine.rag.OpenPack
import team.sopa.boar.engine.rag.Packs
import team.sopa.boar.engine.rag.Retriever
import team.sopa.boar.engine.rag.WikiPack
import java.io.File

/**
 * The native app's side of scripts/eval-device.mjs, byte-compatible with the Expo app's (src/eval/deviceEvalRequest.ts):
 * takes files/eval/requests/pending.json, reports in <requestId>.status.json, writes eval/<runId>.jsonl and
 * .run.json. Runs the legacy pipeline (the fixed-model answer path); adaptive routing and the "answer" pipeline
 * are reported as not supported yet. Debug builds only (the caller checks).
 */
class DeviceEvalRunner(
    private val context: Context,
    /** classifyTask and isRetrievalIrrelevant, as task type names. */
    private val classify: (String) -> String,
    private val retrievalIrrelevant: (String) -> Boolean,
    private val log: (String) -> Unit = { Log.i(TAG, it) },
) {
    private val files = context.filesDir
    private val evalDir = File(files, "eval")
    private val requestsDir = File(evalDir, "requests")
    private val json = Json { prettyPrint = false }

    private fun asset(name: String) = context.assets.open("boar-data/$name").bufferedReader().readText()

    private fun writeStatus(requestId: String, vararg fields: Pair<String, Any?>) {
        requestsDir.mkdirs()
        val all = listOf<Pair<String, Any?>>("requestId" to requestId) + fields.toList() + listOf("updatedAt" to System.currentTimeMillis())
        val o = json(*all.toTypedArray())
        atomicWrite(File(requestsDir, "$requestId.status.json"), o.toString())
    }

    /** Waits up to [waitMs] for a request and runs it. Returns true when one ran. */
    suspend fun pollOnce(waitMs: Long): Boolean = withContext(Dispatchers.IO) {
        val pending = File(requestsDir, "pending.json")
        val until = System.currentTimeMillis() + waitMs
        while (!pending.exists()) {
            if (System.currentTimeMillis() > until) return@withContext false
            delay(1000)
        }
        val text = pending.readText()
        pending.delete()
        val request = try {
            DeviceEval.parseRequest(text)
        } catch (e: EvalRequestException) {
            writeStatus(DeviceEval.requestIdOf(text), "state" to "failed", "error" to "invalid request: ${e.message}")
            return@withContext true
        }
        run(request)
        true
    }

    private fun installedModels(): List<Pair<ModelRef, File>> {
        val catalog = Json.parseToJsonElement(asset("catalog.json")).jsonObject["models"]!!.jsonArray.map { it.jsonObject }
        return catalog.filter { it["kind"]!!.jsonPrimitive.content == "llm" }.mapNotNull { m ->
            val f = File(files, m["filename"]!!.jsonPrimitive.content)
            if (f.isFile) ModelRef(m["id"]!!.jsonPrimitive.content, m["label"]!!.jsonPrimitive.content) to f else null
        }
    }

    private suspend fun run(request: EvalRequest) {
        val installed = installedModels()
        val installedIds = installed.map { it.first.id }
        if (request.pipeline == "answer") {
            writeStatus(request.requestId, "state" to "failed", "error" to "this native build runs the legacy pipeline only", "installedModels" to installedIds)
            return
        }
        val sets = EvalSets.parse(asset("eval-set.json"))
        val resolved = DeviceEval.resolve(request, installed.map { it.first }, sets.evalSet, "Adaptive routing", sets.extraSets)
        if (resolved is Resolved.Err) {
            writeStatus(request.requestId, "state" to "failed", "error" to resolved.error, "installedModels" to installedIds)
            return
        }
        resolved as Resolved.Ok
        val configs = resolved.configs.map { it.id }
        val total = resolved.configs.size * resolved.queries.size
        writeStatus(request.requestId, "state" to "accepted", "configs" to configs, "total" to total, "completed" to 0, "installedModels" to installedIds)
        log("[EVAL] device request ${request.requestId}: ${configs.joinToString(", ")} x ${resolved.queries.size} queries")

        val runId = DeviceEval.newRunId()
        evalDir.mkdirs()
        val rowsFile = File(evalDir, "$runId.jsonl")
        val rows = ArrayList<JsonObject>()
        val personalities = Personalities.parse(asset("personalities.json"))
        val systemPrompt = personalities.get(personalities.defaultId).systemPrompt
        val maxTokens = personalities.defaultMaxTokens
        val topology = CpuTopology.read()
        val retrieval = openRetrieval(topology)
        try {
            var completed = 0
            for (config in resolved.configs) {
                var session: LlamaSession? = null
                var loadMs = 0.0
                var residency = "cold"
                for (q in resolved.queries) {
                    val current = "${config.id} / ${q.id}"
                    writeStatus(request.requestId, "state" to "running", "configs" to configs, "total" to total, "completed" to completed, "current" to current, "installedModels" to installedIds)
                    atomicWrite(File(evalDir, "$runId.run.json"), json(
                        "runId" to runId, "configs" to configs, "queries" to resolved.queries.map { it.id }, "current" to current,
                    ).toString())
                    val row = when (config) {
                        is EvalConfig.Adaptive -> failureRow(runId, config, q, personalities.defaultId, maxTokens, "adaptive routing is not in the native build yet")
                        is EvalConfig.Model -> {
                            if (session == null) {
                                val file = installed.first { it.first.id == config.modelId }.second
                                val t0 = System.nanoTime()
                                session = LlamaSession.load(file.absolutePath, EngineTweaks().resolve(topology).params)
                                loadMs = (System.nanoTime() - t0) / 1e6
                            } else {
                                residency = "resident"
                                loadMs = 0.0
                            }
                            val s = session
                            if (s == null) failureRow(runId, config, q, personalities.defaultId, maxTokens, "model failed to load")
                            else answerRow(s, retrieval, runId, config, q, personalities.defaultId, systemPrompt, maxTokens, residency, loadMs)
                        }
                    }
                    rows += row
                    completed++
                    atomicWrite(rowsFile, rows.joinToString("") { it.toString() + "\n" })
                    log("[EVAL] ${q.id}: ${row["outcome"]} ${row["tokPerSec"] ?: ""}")
                }
                session?.close()
            }
            File(evalDir, "$runId.run.json").delete()
            writeStatus(request.requestId, "state" to "done", "configs" to configs, "total" to total, "completed" to rows.size, "runId" to runId,
                "resultPath" to "files/eval/$runId.jsonl", "stopped" to false, "installedModels" to installedIds)
        } catch (e: Throwable) {
            writeStatus(request.requestId, "state" to "failed", "configs" to configs, "total" to total, "completed" to rows.size, "error" to (e.message ?: e.toString()), "installedModels" to installedIds)
            throw e
        } finally {
            retrieval?.close()
        }
    }

    /** The knowledge base, embedder and packs at the Expo app's paths; null when the knowledge base is missing. */
    private class Retrieval(val retriever: Retriever, val embedder: LlamaSession, val closeables: List<AutoCloseable>) : AutoCloseable {
        override fun close() { closeables.forEach { runCatching { it.close() } }; embedder.close() }
    }

    private suspend fun openRetrieval(topology: CpuTopology): Retrieval? {
        val dbFile = File(files, "SQLite/aoair_knowledge.db")
        val embFile = File(files, "models/embedding.gguf")
        if (!dbFile.isFile || !embFile.isFile) { log("[EVAL] no knowledge base or embedding model: answers without retrieval"); return null }
        val embedder = LlamaSession.load(embFile.absolutePath, EngineParams(nCtx = 512, threads = 2, embeddings = true)) ?: return null
        val kbDb = NativeSqlite.open(dbFile.absolutePath)
        val closeables = mutableListOf<AutoCloseable>(kbDb)
        val sha = Json.parseToJsonElement(asset("catalog.json")).jsonObject["models"]!!.jsonArray.map { it.jsonObject }
            .first { it["kind"]!!.jsonPrimitive.content == "embedding" && it["required"]?.jsonPrimitive?.content == "true" }["sha256"]!!.jsonPrimitive.content
        // Local pack files in name order (knowledgePacks lists catalog packs first; same files, by name).
        val packs = File(files, "corpus").listFiles { f -> f.name.endsWith(".sqlite") }.orEmpty().sortedBy { it.name }.mapNotNull { f ->
            runCatching {
                val db = NativeSqlite.open(f.absolutePath, readOnly = true)
                val meta = db.query("SELECT key, value FROM meta") { it.string(0)!! to (it.string(1) ?: "") }.toMap()
                val id = "local-${f.name.removeSuffix(".sqlite")}"
                when (Packs.packFormat(meta, sha)) {
                    1 -> OpenPack.Format1(id, db).also { closeables += db }
                    2 -> OpenPack.Format2(id, WikiPack.open(db, NativeSqlite.zstd)).also { closeables += db }
                    else -> { db.close(); null }
                }
            }.getOrNull()
        }
        val lexiconFile = File(files, "lexicon/pt-en.json")
        val lexicon: Map<String, String> = if (lexiconFile.isFile) {
            Json.parseToJsonElement(lexiconFile.readText()).jsonObject.mapValues { it.value.jsonPrimitive.content }
        } else emptyMap()
        val retriever = Retriever(KnowledgeBase(kbDb), { packs }, { text -> runBlocking { embedder.embed(text) } }, { lexicon })
        log("[EVAL] retrieval: knowledge base + ${packs.size} packs, lexicon ${lexicon.size} names")
        return Retrieval(retriever, embedder, closeables)
    }

    private suspend fun answerRow(
        s: LlamaSession, retrieval: Retrieval?, runId: String, config: EvalConfig.Model, q: EvalQuery, personalityId: String,
        systemPrompt: String, maxTokens: Int, residency: String, loadMs: Double,
    ): JsonObject {
        val pipeline = AnswerPipeline(s, { query, k -> retrieval?.retriever?.retrieve(query, k) ?: emptyList() }, classify, retrievalIrrelevant)
        val peak = PeakRss().apply { start() }
        val start = System.nanoTime()
        var genStart = 0L
        var firstToken = 0L
        var tokens = 0
        var done: AnswerEvent.Done? = null
        var error: String? = null
        try {
            pipeline.answer(AnswerRequest(q.query, systemPrompt, null, maxTokens)).collect { e ->
                when (e) {
                    is AnswerEvent.Stage -> if (e.stage == team.sopa.boar.engine.answer.AnswerStage.THINKING) genStart = System.nanoTime()
                    is AnswerEvent.Piece -> { tokens++; if (firstToken == 0L) firstToken = System.nanoTime() }
                    is AnswerEvent.Done -> done = e
                    else -> {}
                }
            }
        } catch (e: Throwable) {
            error = e.message ?: e.toString()
        }
        val end = System.nanoTime()
        val peakRss = peak.stop()
        val d = done
        val answer = d?.text ?: ""
        val ttftMs = if (genStart > 0) ((if (firstToken > 0) firstToken else end) - genStart) / 1e6 else null
        val genLatency = if (genStart > 0 && ttftMs != null) (end - genStart) / 1e6 - ttftMs else null
        val outcome = if (error != null) "failure" else if (answer.isNotBlank()) "success" else "failure"
        val m = d?.metrics
        val titles = d?.sources?.map { it.title } ?: emptyList()
        val taskType = d?.taskType ?: classify(q.query)
        return json(
            "modelId" to config.modelId, "taskType" to taskType, "adaptiveRoutingUsed" to false,
            "reasonCodes" to DeviceEval.fixedPlanReasonCodes(!retrievalIrrelevant(taskType), config.modelId),
            "retrievalUsed" to (titles.isNotEmpty()), "modelSwitches" to 0, "crossMessageModelSwitch" to false,
            "modelResidency" to residency, "modelLoadMs" to loadMs, "ttftMs" to ttftMs, "generationLatencyMs" to genLatency,
            "totalLatencyMs" to (end - start) / 1e6, "tokensGenerated" to tokens, "tokPerSec" to DeviceEval.tokensPerSecond(tokens, genLatency),
            "peakRssBytes" to peakRss, "outcome" to outcome, "errorMessage" to (error ?: if (outcome == "failure") "empty answer" else null),
            "runId" to runId, "evalSetVersion" to q.setVersion, "retrievalMs" to d?.retrievalMs,
            "contextTokensBefore" to d?.tokensBefore, "contextTokensAfter" to d?.tokensAfter,
            "promptTokens" to m?.promptTokensDecoded, "promptMs" to m?.prefillMs, "cachedTokens" to m?.let { it.promptTokens - it.promptTokensDecoded },
            "predictedTokens" to m?.generatedTokens, "predictedMs" to m?.decodeMs,
            "configId" to config.id, "configLabel" to config.label, "personalityId" to personalityId, "maxTokens" to maxTokens,
            "queryId" to q.id, "category" to q.category, "query" to q.query, "answer" to answer, "promptFormat" to d?.promptFormat,
            "retrievedTitles" to titles, "expectedKbTitles" to q.expectedKbTitles, "expectedKbHit" to DeviceEval.expectedKbHit(q.expectedKbTitles, titles),
            "timedOut" to false, "createdAt" to System.currentTimeMillis(), "engine" to "native",
        )
    }

    private fun failureRow(runId: String, config: EvalConfig, q: EvalQuery, personalityId: String, maxTokens: Int, error: String) = json(
        "modelId" to (config as? EvalConfig.Model)?.modelId, "taskType" to classify(q.query), "adaptiveRoutingUsed" to (config is EvalConfig.Adaptive),
        "outcome" to "failure", "errorMessage" to error, "tokensGenerated" to 0, "runId" to runId, "evalSetVersion" to q.setVersion,
        "configId" to config.id, "configLabel" to config.label, "personalityId" to personalityId, "maxTokens" to maxTokens,
        "queryId" to q.id, "category" to q.category, "query" to q.query, "answer" to "", "retrievedTitles" to emptyList<String>(),
        "expectedKbTitles" to q.expectedKbTitles, "expectedKbHit" to DeviceEval.expectedKbHit(q.expectedKbTitles, emptyList()),
        "timedOut" to false, "createdAt" to System.currentTimeMillis(), "engine" to "native",
    )

    companion object {
        const val TAG = "BOAR_EVAL"
    }
}

/** Peak resident memory while a question runs, sampled from /proc (VmRSS) every 250 ms. */
private class PeakRss {
    @Volatile private var peak = 0L
    @Volatile private var running = false
    private fun rss(): Long = runCatching {
        File("/proc/self/status").readLines().first { it.startsWith("VmRSS:") }.split(Regex("\\s+"))[1].toLong() * 1024
    }.getOrDefault(0L)
    fun start() {
        running = true
        peak = rss()
        Thread { while (running) { peak = maxOf(peak, rss()); Thread.sleep(250) } }.apply { isDaemon = true }.start()
    }
    fun stop(): Long { running = false; return maxOf(peak, rss()) }
}

private fun atomicWrite(f: File, text: String) {
    val tmp = File(f.parentFile, f.name + ".tmp")
    tmp.writeText(text)
    tmp.renameTo(f)
}

/** A JSON object from pairs; null values are left out, as JSON.stringify drops undefined. */
internal fun json(vararg pairs: Pair<String, Any?>): JsonObject = JsonObject(pairs.mapNotNull { (k, v) -> v?.let { k to toJsonElement(it) } }.toMap())

private fun toJsonElement(v: Any): kotlinx.serialization.json.JsonElement = when (v) {
    is String -> JsonPrimitive(v)
    is Boolean -> JsonPrimitive(v)
    is Int -> JsonPrimitive(v)
    is Long -> JsonPrimitive(v)
    is Double -> JsonPrimitive(v)
    is List<*> -> JsonArray(v.filterNotNull().map(::toJsonElement))
    else -> JsonPrimitive(v.toString())
}
