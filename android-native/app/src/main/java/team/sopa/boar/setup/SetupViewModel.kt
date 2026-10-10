package team.sopa.boar.setup

import android.app.ActivityManager
import android.app.Application
import android.os.StatFs
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import team.sopa.boar.app.BoarServices
import team.sopa.boar.engine.EngineParams
import team.sopa.boar.engine.LlamaSession
import team.sopa.boar.engine.models.AssetKind
import team.sopa.boar.engine.models.AssetStore
import team.sopa.boar.engine.models.CatalogAsset
import team.sopa.boar.engine.models.SetupModel
import team.sopa.boar.engine.models.SetupTier
import team.sopa.boar.engine.rag.SeedCorpus

data class AssetProgress(val asset: CatalogAsset, val bytesDone: Long, val bytesTotal: Long, val verifying: Boolean, val done: Boolean, val error: String? = null)

data class SetupState(
    val step: Int = 1,
    val totalRamBytes: Long = 0,
    val freeDiskBytes: Long = 0,
    val models: List<CatalogAsset> = emptyList(),
    val recommendedId: String? = null,
    val chosenId: String? = null,
    val tiers: List<SetupTier> = emptyList(),
    val tierId: String? = null,
    val downloads: List<AssetProgress> = emptyList(),
    val indexDone: Int = 0,
    val indexTotal: Int = 0,
    val indexTitle: String = "",
    val error: String? = null,
    val finished: Boolean = false,
)

/**
 * The first-run setup (port of SetupWizardScreen.tsx): 1 hardware, 2 answer model (recommended by RAM) and knowledge
 * tier, 3 downloads (resumable, verified), 4 indexing the corpus. Everything after it works offline.
 */
class SetupViewModel(app: Application) : AndroidViewModel(app) {
    private val services = BoarServices.get(app)
    private val store = AssetStore(app.filesDir, services.catalog)
    private val _state = MutableStateFlow(SetupState())
    val state: StateFlow<SetupState> = _state
    private var job: Job? = null

    init {
        val ram = runCatching { ActivityManager.MemoryInfo().also { app.getSystemService(ActivityManager::class.java).getMemoryInfo(it) }.totalMem }.getOrDefault(0L)
        val free = runCatching { StatFs(app.filesDir.path).availableBytes }.getOrDefault(0L)
        val answer = services.catalog.answerModels
        val rec = SetupModel.recommended(answer, ram)
        _state.update {
            it.copy(totalRamBytes = ram, freeDiskBytes = free, models = answer, recommendedId = rec?.id, chosenId = rec?.id,
                tiers = services.catalog.tiers, tierId = services.catalog.tiers.firstOrNull()?.id)
        }
    }

    fun next() = _state.update { it.copy(step = minOf(it.step + 1, 2)) }
    fun back() = _state.update { it.copy(step = maxOf(it.step - 1, 1)) }
    fun choose(id: String) = _state.update { it.copy(chosenId = id) }
    fun chooseTier(id: String) = _state.update { it.copy(tierId = id) }
    fun isHeavy(m: CatalogAsset) = SetupModel.heavyForPhone(m, _state.value.totalRamBytes)

    /** What step 3 downloads: the required assets, the chosen answer model and the tier's corpus packs. */
    private fun plan(): List<CatalogAsset> {
        val s = _state.value
        val catalog = services.catalog
        val chosen = s.chosenId?.let(catalog::byId)
        val packs = s.tierId?.let(catalog::tier)?.corpusPackIds.orEmpty().mapNotNull(catalog::byId)
        return (catalog.models.filter { it.required } + listOfNotNull(chosen) + packs).distinctBy { it.id }
    }

    fun install() {
        if (job?.isActive == true) return
        val assets = plan()
        _state.value.chosenId?.let { services.settings.setActiveModelId("llm", it) }
        _state.update { it.copy(step = 3, error = null, downloads = assets.map { a -> AssetProgress(a, 0, a.sizeBytes, false, store.status(a).present) }) }
        job = viewModelScope.launch(Dispatchers.IO) {
            for (a in assets) {
                if (store.status(a).present) continue
                try {
                    store.download(a) { p -> update(a) { it.copy(bytesDone = p.bytesDone, bytesTotal = p.bytesTotal, verifying = p.phase == AssetStore.Progress.Phase.VERIFYING) } }
                    update(a) { it.copy(done = true, bytesDone = a.sizeBytes) }
                } catch (e: Exception) {
                    update(a) { it.copy(error = e.message) }
                    _state.update { it.copy(error = e.message) }
                    return@launch
                }
            }
            index()
        }
    }

    fun retry() { job = null; install() }

    private fun update(a: CatalogAsset, change: (AssetProgress) -> AssetProgress) =
        _state.update { s -> s.copy(downloads = s.downloads.map { if (it.asset.id == a.id) change(it) else it }) }

    /** Step 4: index the bundled corpus and the downloaded corpus packs with the embedding model. */
    /** Runs step 4 again after it failed (the embedder didn't load, or seeding stopped). */
    fun retryIndex() {
        if (job?.isActive == true) return
        job = viewModelScope.launch(Dispatchers.IO) { index() }
    }

    private suspend fun index() {
        _state.update { it.copy(step = 4, error = null) }
        val app = getApplication<Application>()
        val emb = services.installed(AssetKind.EMBEDDING).firstOrNull() ?: run { _state.update { it.copy(error = "embedding model missing") }; return }
        val embedder = LlamaSession.load(services.fileOf(emb).path, EngineParams(nCtx = 512, threads = 2, embeddings = true))
            ?: run { _state.update { it.copy(error = "embedding model failed to load") }; return }
        try {
            val builtin = app.assets.open("corpus/corpus.json").bufferedReader().use { it.readText() }
            val collections = listOf(SeedCorpus.Collection(SeedCorpus.BUILTIN, SeedCorpus.docs(SeedCorpus.BUILTIN, builtin))) +
                services.catalog.corpusCatalog.filter { it.format != "sqlite-pack" && services.fileOf(it).isFile }.map { p ->
                    runCatching { SeedCorpus.Collection(p.id, SeedCorpus.docs(p.id, services.fileOf(p).readText())) }
                        .getOrElse { e -> SeedCorpus.Collection(p.id, emptyList(), e.message) }
                }
            SeedCorpus(services.knowledgeBase) { text -> embedder.embed(text) }.seed(collections, onProgress = { p ->
                _state.update { it.copy(indexDone = p.done, indexTotal = p.total, indexTitle = p.title) }
            })
            _state.update { it.copy(finished = true) }
        } catch (e: Exception) {
            _state.update { it.copy(error = e.message) }
        } finally {
            withContext(Dispatchers.IO) { embedder.close() }
        }
    }

    /** Whether the app can answer: everything required and an answer model on disk (requiredModelsPresent). */
    fun ready(): Boolean = store.requiredPresent()
}
