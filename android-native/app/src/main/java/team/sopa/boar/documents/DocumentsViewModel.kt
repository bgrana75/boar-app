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
                    val text = if (fileName.lowercase().endsWith(".pdf")) pdfText(uri, fileName)
                    else resolver.openInputStream(uri)?.use { it.readBytes().toString(Charsets.UTF_8) } ?: error("Couldn't read \"$fileName\"")
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

    /** The PDF's selectable text (no OCR); password-protected PDFs aren't supported, as in the Expo app. */
    private fun pdfText(uri: Uri, fileName: String): String {
        val app = getApplication<Application>()
        com.tom_roush.pdfbox.android.PDFBoxResourceLoader.init(app)
        val input = app.contentResolver.openInputStream(uri) ?: error("Couldn't read \"$fileName\"")
        return try {
            input.use { s -> com.tom_roush.pdfbox.pdmodel.PDDocument.load(s).use { doc -> com.tom_roush.pdfbox.text.PDFTextStripper().getText(doc) } }
        } catch (e: com.tom_roush.pdfbox.pdmodel.encryption.InvalidPasswordException) {
            error("\"$fileName\" is password-protected — password-protected PDFs aren't supported.")
        } catch (e: java.io.IOException) {
            error("Couldn't read \"$fileName\": ${e.message}")
        }.also { if (it.isBlank()) error("\"$fileName\" has no selectable text (scanned pages need OCR, which BOAR doesn't do).") }
    }

    fun setActive(id: String, on: Boolean) {
        services.knowledgeBase.setCollectionActive(id, on)
        refresh()
    }

    fun remove(id: String) {
        viewModelScope.launch(Dispatchers.IO) { services.knowledgeBase.deleteCollection(id); refresh() }
    }
}
