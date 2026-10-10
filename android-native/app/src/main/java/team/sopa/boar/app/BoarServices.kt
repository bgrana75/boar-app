package team.sopa.boar.app

import android.content.Context
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import team.sopa.boar.engine.BoarEngine
import team.sopa.boar.engine.CpuTopology
import team.sopa.boar.engine.EngineParams
import team.sopa.boar.engine.LlamaSession
import team.sopa.boar.engine.models.LoadGuard
import team.sopa.boar.engine.answer.ModelHost
import team.sopa.boar.engine.answer.Personalities
import team.sopa.boar.engine.answer.SessionEngine
import team.sopa.boar.engine.answer.StepEngine
import team.sopa.boar.engine.chat.ChatStore
import team.sopa.boar.engine.db.NativeSqlite
import team.sopa.boar.engine.models.AssetKind
import team.sopa.boar.engine.models.Catalog
import team.sopa.boar.engine.models.CatalogAsset
import team.sopa.boar.engine.rag.KnowledgeBase
import team.sopa.boar.engine.rag.OpenPack
import team.sopa.boar.engine.rag.Packs
import team.sopa.boar.engine.rag.Retriever
import team.sopa.boar.engine.rag.WikiPack
import team.sopa.boar.engine.settings.AppSettings
import java.io.File

/**
 * Everything the screens share, opened once per process on the Expo app's own files (files/settings.json,
 * files/SQLite/aoair_knowledge.db, files/models, files/corpus), so an upgrade keeps models, chats and settings.
 * One generation model is loaded at a time ([host]); the embedder loads when retrieval first needs it.
 */
class BoarServices private constructor(private val context: Context) {
    private val files = context.filesDir
    val settings = AppSettings(File(files, "settings.json"))
    val catalog: Catalog = Catalog.parse(asset("boar-data/catalog.json"))
    val personalities: Personalities = Personalities.parse(asset("boar-data/personalities.json"))
    val topology: CpuTopology = CpuTopology.read()
    /** Total RAM, for the Auto context size; 0 when Android doesn't say. */
    val totalRamBytes: Long = runCatching {
        android.app.ActivityManager.MemoryInfo().also { context.getSystemService(android.app.ActivityManager::class.java).getMemoryInfo(it) }.totalMem
    }.getOrDefault(0L)

    private val kbDb = NativeSqlite.open(File(files, "SQLite").apply { mkdirs() }.resolve("aoair_knowledge.db").path)
    val knowledgeBase = KnowledgeBase(kbDb)
    val chats = ChatStore(kbDb)

    private fun asset(path: String) = context.assets.open(path).bufferedReader().use { it.readText() }

    /** Portuguese article names for PT questions (assets/lexicon/pt-en.json), loaded on first use. */
    val lexicon: Map<String, String> by lazy {
        runCatching { Json.parseToJsonElement(asset("lexicon/pt-en.json")).jsonObject.mapValues { it.value.jsonPrimitive.content } }.getOrDefault(emptyMap())
    }

    fun fileOf(asset: CatalogAsset) = File(files, asset.filename)
    fun installed(kind: AssetKind) = catalog.models.filter { it.kind == kind && fileOf(it).isFile }

    /** The user's model, else the first installed one (the catalog's order puts the default first). */
    fun activeModel(): CatalogAsset? =
        settings.activeModelId("llm")?.let(catalog::byId)?.takeIf { fileOf(it).isFile } ?: installed(AssetKind.LLM).firstOrNull()

    /** CR-2: the marker next to the models and the bookkeeping in settings.json. */
    val loadGuard = LoadGuard(object : LoadGuard.MarkerStore {
        private val f = File(files, "model-load.marker.json")
        override fun read() = f.takeIf { it.isFile }?.readText()
        override fun write(json: String) = f.writeText(json)
        override fun clear() { f.delete() }
    }, settings.loadLedger)

    /**
     * The model the chat answers with: the active one, unless its load killed the app (CR-2). Then the model loaded
     * before it, else the smallest installed one that isn't blocked, so a phone doesn't crash on every start.
     */
    fun answerModel(): CatalogAsset? {
        val m = activeModel() ?: return null
        if (!loadGuard.isBlocked(m.id)) return m
        val ok = installed(AssetKind.LLM).filter { !loadGuard.isBlocked(it.id) }
        return settings.lastLoadedModelId?.let { id -> ok.firstOrNull { it.id == id } } ?: ok.minByOrNull { it.sizeBytes }
    }

    // --- Packs and retrieval -----------------------------------------------------------------------------------

    private val embeddingSha = catalog.models.first { it.kind == AssetKind.EMBEDDING && it.required }.sha256

    @Volatile private var openPacks: List<OpenPack>? = null

    /** Installed knowledge packs in knowledgePacks()'s order: catalog packs first, then other files by name. */
    val packs: List<OpenPack> get() = openPacks ?: synchronized(this) { openPacks ?: scanPacks().also { openPacks = it } }

    /** After a pack is downloaded or removed: the next search opens the current set. */
    fun reloadPacks() = synchronized(this) {
        openPacks?.forEach { p -> runCatching { when (p) { is OpenPack.Format1 -> p.db.close(); is OpenPack.Format2 -> p.pack.close() } } }
        openPacks = null
    }

    private fun scanPacks(): List<OpenPack> {
        val dir = File(files, "corpus")
        val catalogFiles = catalog.corpusCatalog.filter { it.format == "sqlite-pack" }.map { it.id to File(files, it.filename) }
        val local = dir.listFiles { f -> f.name.endsWith(".sqlite") }.orEmpty().sortedBy { it.name }
            .filter { f -> catalogFiles.none { it.second == f } }.map { "local-${it.name.removeSuffix(".sqlite")}" to it }
        return (catalogFiles + local).filter { it.second.isFile }.mapNotNull { (id, f) ->
            runCatching {
                val db = NativeSqlite.open(f.path, readOnly = true)
                val meta = db.query("SELECT key, value FROM meta") { it.string(0)!! to (it.string(1) ?: "") }.toMap()
                when (Packs.packFormat(meta, embeddingSha)) {
                    1 -> OpenPack.Format1(id, db)
                    2 -> OpenPack.Format2(id, WikiPack.open(db, NativeSqlite.zstd))
                    else -> { db.close(); null }
                }
            }.getOrNull()
        }
    }

    private val embedLock = Mutex()
    private var embedder: LlamaSession? = null

    /** The embedding model, loaded on first use; an empty vector when none is installed. */
    suspend fun embed(text: String): FloatArray = embedLock.withLock {
        val e = embedder ?: run {
            val f = installed(AssetKind.EMBEDDING).firstOrNull()?.let(::fileOf) ?: return FloatArray(0)
            LlamaSession.load(f.path, EngineParams(nCtx = 512, threads = 2, embeddings = true)).also { embedder = it }
        } ?: return FloatArray(0)
        e.embed(text)
    }

    val retriever: Retriever by lazy {
        Retriever(knowledgeBase, { packs }, { text -> runBlocking { embed(text) } }, { lexicon })
    }

    // --- The generation model ----------------------------------------------------------------------------------

    /** One generation model at a time, loaded with the user's Advanced tweaks. */
    val host = SessionHost()

    inner class SessionHost : ModelHost {
        private val lock = Mutex()
        private var session: LlamaSession? = null
        private var filename: String? = null
        private var residentId: String? = null
        private var residentRepacked = false
        /** Models that stalled with repacked weights in this process: mapped from storage until the app restarts (#73). */
        private val keepMapped = java.util.Collections.synchronizedSet(HashSet<String>())

        override fun residentFilename(): String? = filename
        override fun filenameOf(modelId: String): String? = catalog.byId(modelId)?.takeIf { fileOf(it).isFile }?.filename

        override suspend fun load(modelId: String): StepEngine? = lock.withLock {
            val asset = catalog.byId(modelId)?.takeIf { fileOf(it).isFile } ?: return null
            val tweaks = settings.engineTweaks
            // A stall while repacked: reload as the mapped file before the next generation (the caller waits on the lock).
            val reloadMapped = filename == asset.filename && residentRepacked && asset.id in keepMapped && tweaks.weightRepack != true
            if (filename != asset.filename || session == null || reloadMapped) {
                val previous = (residentId ?: settings.lastLoadedModelId)?.let(catalog::byId)?.let { LoadGuard.Meta(it.filename, it.id, it.label) }
                session?.close()
                session = null
                filename = null
                residentId = null
                val meta = LoadGuard.Meta(asset.filename, asset.id, asset.label)
                val repack = tweaks.weightRepack ?: !(loadGuard.mappedNext(asset.id) || asset.id in keepMapped)
                loadGuard.begin(meta, previous, repack)
                val s = LlamaSession.load(fileOf(asset).path, tweaks.resolve(topology, totalRamBytes).params.copy(repack = repack))
                loadGuard.end(meta, s != null)
                if (s == null) return null
                session = s
                filename = asset.filename
                residentId = asset.id
                residentRepacked = repack
                if (repack) s.onGenerated = { m ->
                    if (LoadGuard.isDecodeStall(m.generatedTokens, m.decodeMs) && keepMapped.add(asset.id))
                        android.util.Log.w("BOAR", "${asset.id} stalled with repacked weights (${m.generatedTokens} tokens in ${m.decodeMs.toInt()} ms): mapped from the next answer")
                }
                settings.lastLoadedModelId = asset.id
            }
            SessionEngine(session!!, tweaks.thinkingEnabled)
        }

        /** The loaded session, for the default path (AnswerPipeline). */
        fun current(): LlamaSession? = session

        /** Frees the model; the next answer loads it again (with changed Advanced tweaks, or another model). */
        suspend fun unload() = lock.withLock {
            session?.close()
            session = null
            filename = null
            residentId = null
        }
    }

    /** Loads the active model if it isn't resident; null when no model is installed or it fails to load. */
    suspend fun activeSession(): LlamaSession? {
        val m = answerModel() ?: return null
        host.load(m.id) ?: return null
        return host.current()
    }

    companion object {
        @Volatile private var instance: BoarServices? = null

        fun get(context: Context): BoarServices = instance ?: synchronized(this) {
            instance ?: run {
                // The CPU build is chosen once per process, from the user's tweak (Auto by default).
                val app = context.applicationContext
                BoarEngine.init(app.applicationInfo.nativeLibraryDir, AppSettings(File(app.filesDir, "settings.json")).engineTweaks.cpuBuild)
                BoarServices(app).also { instance = it }
            }
        }
    }
}
