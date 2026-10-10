package team.sopa.boar.models

import android.app.ActivityManager
import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import team.sopa.boar.app.BoarServices
import team.sopa.boar.engine.EngineParams
import team.sopa.boar.engine.LlamaSession
import team.sopa.boar.engine.models.AssetKind
import team.sopa.boar.engine.models.AssetStore
import team.sopa.boar.engine.models.CatalogAsset
import team.sopa.boar.engine.rag.SeedCorpus

/** One catalog row (CatalogRowState): on disk, downloading with progress, speed and ETA, or failed. */
data class Row(
    val present: Boolean = false,
    val downloading: Boolean = false,
    val progress: Double = 0.0,
    val bytesWritten: Long = 0,
    val speedBytesPerSec: Double? = null,
    val etaSeconds: Double? = null,
    val error: String? = null,
    val indexing: Boolean = false,
)

data class ModelsState(
    val items: List<CatalogAsset> = emptyList(),
    val rows: Map<String, Row> = emptyMap(),
    val activeLlm: String? = null,
    val activating: String? = null,
    val totalRamBytes: Long = 0,
    val toast: String? = null,
)

/** The models and knowledge catalog (port of ModelCatalogScreen.tsx): download, use, remove. */
class ModelsViewModel(app: Application) : AndroidViewModel(app) {
    private val services = BoarServices.get(app)
    private val store = AssetStore(app.filesDir, services.catalog)
    private val _state = MutableStateFlow(ModelsState())
    val state: StateFlow<ModelsState> = _state

    init {
        val ram = runCatching { ActivityManager.MemoryInfo().also { app.getSystemService(ActivityManager::class.java).getMemoryInfo(it) }.totalMem }.getOrDefault(0L)
        // Answer models first, then the embedding model, then knowledge, as the catalog lists them.
        val items = services.catalog.models.sortedBy { when (it.kind) { AssetKind.LLM -> 0; AssetKind.EMBEDDING -> 1; AssetKind.CORPUS -> 2 } }
        _state.update { it.copy(items = items, totalRamBytes = ram) }
        refresh()
    }

    fun refresh() {
        _state.update { s ->
            s.copy(activeLlm = services.activeModel()?.id, rows = s.items.associate { a ->
                val prev = s.rows[a.id] ?: Row()
                a.id to prev.copy(present = store.status(a).present)
            })
        }
    }

    private fun row(id: String, change: (Row) -> Row) = _state.update { s -> s.copy(rows = s.rows + (id to change(s.rows[id] ?: Row()))) }

    fun download(a: CatalogAsset) {
        if (_state.value.rows[a.id]?.downloading == true) return
        row(a.id) { Row(downloading = true) }
        viewModelScope.launch(Dispatchers.IO) {
            var lastT = System.nanoTime()
            var lastB = 0L
            var speed: Double? = null
            try {
                store.download(a) { p ->
                    val now = System.nanoTime()
                    val dt = (now - lastT) / 1e9
                    if (dt >= 1.0) {
                        val inst = (p.bytesDone - lastB) / dt
                        speed = speed?.let { it * 0.7 + inst * 0.3 } ?: inst
                        lastT = now
                        lastB = p.bytesDone
                    }
                    val eta = speed?.takeIf { it > 0 }?.let { (p.bytesTotal - p.bytesDone) / it }
                    row(a.id) { it.copy(progress = if (p.bytesTotal > 0) p.bytesDone.toDouble() / p.bytesTotal else 0.0, bytesWritten = p.bytesDone, speedBytesPerSec = speed, etaSeconds = eta) }
                }
                row(a.id) { Row(present = true) }
                if (a.kind == AssetKind.CORPUS && a.format != "sqlite-pack") index(a)
                if (a.kind == AssetKind.CORPUS) services.reloadPacks()
            } catch (e: Exception) {
                row(a.id) { Row(error = e.message ?: e.toString()) }
            }
            refresh()
        }
    }

    /** A corpus pack is searchable once indexed with the embedding model (as setup does). */
    private suspend fun index(pack: CatalogAsset) {
        val emb = services.installed(AssetKind.EMBEDDING).firstOrNull() ?: return
        val embedder = LlamaSession.load(services.fileOf(emb).path, EngineParams(nCtx = 512, threads = 2, embeddings = true)) ?: return
        row(pack.id) { it.copy(indexing = true) }
        try {
            val builtin = getApplication<Application>().assets.open("corpus/corpus.json").bufferedReader().use { it.readText() }
            val collections = listOf(SeedCorpus.Collection(SeedCorpus.BUILTIN, SeedCorpus.docs(SeedCorpus.BUILTIN, builtin))) +
                services.catalog.corpusCatalog.filter { it.format != "sqlite-pack" && services.fileOf(it).isFile }
                    .map { SeedCorpus.Collection(it.id, SeedCorpus.docs(it.id, services.fileOf(it).readText())) }
            SeedCorpus(services.knowledgeBase) { embedder.embed(it) }.seed(collections)
        } finally {
            embedder.close()
            row(pack.id) { it.copy(indexing = false) }
        }
    }

    /** "Use": the model the chat answers with from now on, loaded right away. */
    fun use(a: CatalogAsset) {
        if (_state.value.activating != null) return
        _state.update { it.copy(activating = a.id) }
        viewModelScope.launch(Dispatchers.Default) {
            services.settings.setActiveModelId(a.kind.name.lowercase(), a.id)
            if (a.kind == AssetKind.LLM) runCatching { services.host.unload(); services.activeSession() }
            _state.update { it.copy(activating = null, toast = a.label) }
            refresh()
        }
    }

    fun remove(a: CatalogAsset) {
        viewModelScope.launch(Dispatchers.IO) {
            if (a.id == _state.value.activeLlm) services.host.unload()
            if (a.kind == AssetKind.CORPUS && a.format != "sqlite-pack") services.knowledgeBase.deleteSeedChunksWithPrefix(SeedCorpus.chunkIdPrefix(a.id))
            if (a.kind == AssetKind.CORPUS) services.reloadPacks()
            store.delete(a)
            row(a.id) { Row() }
            refresh()
        }
    }

    fun toastShown() = _state.update { it.copy(toast = null) }
}
