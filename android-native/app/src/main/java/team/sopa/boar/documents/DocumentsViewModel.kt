package team.sopa.boar.documents

import android.app.Application
import android.net.Uri
import android.provider.OpenableColumns
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import team.sopa.boar.app.BoarServices
import team.sopa.boar.engine.rag.DocumentImport
import team.sopa.boar.engine.rag.KnowledgeBase

data class DocumentsState(
    val collections: List<KnowledgeBase.Collection> = emptyList(),
    /** null, "reading", "chunking" or "embedding". */
    val stage: String? = null,
    val done: Int = 0,
    val total: Int = 0,
    val error: String? = null,
)

/** My Documents (port of PersonalDocumentsManager.tsx): import files into a collection, switch it on or off, remove it. */
class DocumentsViewModel(app: Application) : AndroidViewModel(app) {
    private val services = BoarServices.get(app)
    private val _state = MutableStateFlow(DocumentsState())
    val state: StateFlow<DocumentsState> = _state

    init { refresh() }

    fun refresh() = _state.update { it.copy(collections = services.knowledgeBase.collections()) }

    fun import(uris: List<Uri>, name: String) {
        if (uris.isEmpty() || _state.value.stage != null) return
        _state.update { it.copy(stage = "reading", error = null, done = 0, total = 0) }
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val resolver = getApplication<Application>().contentResolver
                val files = uris.map { uri ->
                    var fileName = uri.lastPathSegment ?: "document"
                    var size = 0L
                    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                        if (c.moveToFirst()) { fileName = c.getString(0) ?: fileName; size = c.getLong(1) }
                    }
                    if (fileName.lowercase().endsWith(".pdf")) error("\"$fileName\": PDF import isn't in the native app yet (coming with the PDF text library). Text, Markdown, CSV and JSON work.")
                    val text = resolver.openInputStream(uri)?.use { it.readBytes().toString(Charsets.UTF_8) } ?: error("Couldn't read \"$fileName\"")
                    DocumentImport.File(fileName, if (size > 0) size else text.toByteArray().size.toLong(), text)
                }
                _state.update { it.copy(stage = "chunking") }
                DocumentImport.import(services.knowledgeBase, services::embed, files, name, onProgress = { d, t ->
                    _state.update { it.copy(stage = "embedding", done = d, total = t) }
                })
            } catch (e: Exception) {
                _state.update { it.copy(error = e.message ?: e.toString()) }
            }
            _state.update { it.copy(stage = null) }
            refresh()
        }
    }

    fun setActive(id: String, on: Boolean) {
        services.knowledgeBase.setCollectionActive(id, on)
        refresh()
    }

    fun remove(id: String) {
        viewModelScope.launch(Dispatchers.IO) { services.knowledgeBase.deleteCollection(id); refresh() }
    }
}
