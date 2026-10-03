package team.sopa.boar.engine.models

/**
 * The answer model the setup wizard recommends, from the phone's RAM (port of src/ui-android/setupModel.ts).
 *
 * Measured (eval_scores, 2026-10-02): on a POCO F3 (8 GB, reads 7.3 GB) the 1.5B answers at 16-18 tok/s,
 * while 4B-class models ran at ~5 tok/s with 3.4-3.9 GB peak memory. On a POCO X6 Pro (12 GB, reads
 * 10.7 GB) Android closed the backgrounded app holding the 4B. So the 4B is recommended only from 12 GB
 * phones; 8 GB phones get the 1.5B.
 */
object SetupModel {
    /** 12 GB phones report about 10.7 GB, 8 GB phones about 7.3 GB. */
    const val RECOMMEND_DEFAULT_MIN_RAM_BYTES: Long = 10L * 1024 * 1024 * 1024

    fun recommended(models: List<CatalogAsset>, totalRamBytes: Long): CatalogAsset? {
        val tier = if (totalRamBytes >= RECOMMEND_DEFAULT_MIN_RAM_BYTES) AnswerTier.DEFAULT else AnswerTier.COMPACT
        return models.firstOrNull { it.answerTier == tier } ?: models.firstOrNull()
    }

    /** True when the model is bigger than this phone is recommended for: it may be slow or closed in the background. */
    fun heavyForPhone(model: CatalogAsset, totalRamBytes: Long): Boolean =
        model.answerTier == AnswerTier.DEFAULT && totalRamBytes > 0 && totalRamBytes < RECOMMEND_DEFAULT_MIN_RAM_BYTES

    /** The model to download: the user's pick, else one already on the phone, else the recommended one. */
    fun toInstall(models: List<CatalogAsset>, present: Set<String>, totalRamBytes: Long, chosenId: String? = null): CatalogAsset? =
        models.firstOrNull { it.id == chosenId } ?: models.firstOrNull { it.id in present } ?: recommended(models, totalRamBytes)
}
