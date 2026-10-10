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

        override fun residentFilename(): String? = filename
        override fun filenameOf(modelId: String): String? = catalog.byId(modelId)?.takeIf { fileOf(it).isFile }?.filename

        override suspend fun load(modelId: String): StepEngine? = lock.withLock {
            val asset = catalog.byId(modelId)?.takeIf { fileOf(it).isFile } ?: return null
            if (filename != asset.filename || session == null) {
                session?.close()
                session = null
                filename = null
                val s = LlamaSession.load(fileOf(asset).path, settings.engineTweaks.resolve(topology).params) ?: return null
                session = s
                filename = asset.filename
            }
            SessionEngine(session!!)
        }

        /** The loaded session, for the default path (AnswerPipeline). */
        fun current(): LlamaSession? = session

        /** Frees the model; the next answer loads it again (with changed Advanced tweaks, or another model). */
        suspend fun unload() = lock.withLock {
            session?.close()
            session = null
            filename = null
        }
    }

    /** Loads the active model if it isn't resident; null when no model is installed or it fails to load. */
    suspend fun activeSession(): LlamaSession? {
        val m = activeModel() ?: return null
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
