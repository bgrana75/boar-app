package team.sopa.boar.engine.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * The model and corpus catalog, read from assets/boar-data/catalog.json, which
 * scripts/export-native-data.mjs writes from src/models/manifest.ts (one source of truth).
 */
@Serializable
data class Catalog(
    val storageBudgetBytes: Long,
    val ramBudgetBytes: Long,
    val models: List<CatalogAsset>,
    val tiers: List<SetupTier>,
) {
    /** LLMs that can be the answer model at setup, the default tier first (manifest.ts ANSWER_MODELS). */
    val answerModels: List<CatalogAsset>
        get() = models.filter { it.kind == AssetKind.LLM && it.answerTier != null }
            .sortedBy { if (it.answerTier == AnswerTier.DEFAULT) 0 else 1 }

    val defaultAnswerModel: CatalogAsset get() = answerModels.first { it.answerTier == AnswerTier.DEFAULT }
    val compactAnswerModel: CatalogAsset get() = answerModels.first { it.answerTier == AnswerTier.COMPACT }
    val requiredModels: List<CatalogAsset> get() = models.filter { it.required } + defaultAnswerModel
    val corpusCatalog: List<CatalogAsset> get() = models.filter { it.kind == AssetKind.CORPUS }

    fun byId(id: String): CatalogAsset? = models.firstOrNull { it.id == id }
    fun tier(id: String): SetupTier? = tiers.firstOrNull { it.id == id }

    companion object {
        private val json = Json { ignoreUnknownKeys = true }
        fun parse(text: String): Catalog = json.decodeFromString(serializer(), text)
    }
}

@Serializable
enum class AssetKind {
    @SerialName("llm") LLM,
    @SerialName("embedding") EMBEDDING,
    @SerialName("corpus") CORPUS,
}

@Serializable
enum class AnswerTier {
    @SerialName("default") DEFAULT,
    @SerialName("compact") COMPACT,
}

@Serializable
data class CatalogAsset(
    val id: String,
    val kind: AssetKind,
    val label: String,
    val displayName: String? = null,
    /** Path under the app's files directory once installed, e.g. "models/embedding.gguf". */
    val filename: String,
    val sizeBytes: Long,
    val sha256: String,
    val sourceUrl: String,
    val license: String,
    val description: String,
    val required: Boolean,
    val answerTier: AnswerTier? = null,
    val bundled: Boolean = false,
    val format: String? = null,
    val requires: List<String> = emptyList(),
) {
    /** Short UI name ("Qwen3 4B"), falling back to the technical label (manifest.ts displayNameOf). */
    val shortName: String get() = displayName ?: label
}

@Serializable
data class SetupTier(
    val id: String,
    val label: String,
    val description: String,
    val corpusPackIds: List<String>,
)
