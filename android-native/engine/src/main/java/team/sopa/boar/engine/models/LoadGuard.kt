package team.sopa.boar.engine.models

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * CR-2 (src/inference/loadMarker.ts) plus #73's mapped retry. A model load that gets the app killed (low memory) leaves
 * no error behind, so a marker is written right before the load and cleared after it returns. A marker found on the
 * next start means that load killed the app:
 * - it had repacked weights (llama.cpp copies them into app memory for its fast ARM kernels, which Android can only
 *   swap): the next load of that model keeps the mapped file instead, once ([mappedNext]);
 * - otherwise it's a crash: the model isn't loaded again on its own ([isBlocked]) until the user picks it again
 *   ([confirm]) or it loads fine; the chat says so once ([consume]).
 */
class LoadGuard(private val store: MarkerStore, private val ledger: Ledger, private val now: () -> Long = System::currentTimeMillis) {
    @Serializable
    data class Meta(val filename: String, val modelId: String? = null, val label: String? = null)

    @Serializable
    data class Marker(
        val filename: String,
        val modelId: String? = null,
        val label: String? = null,
        val previous: Meta? = null,
        val at: Long,
        /** The load used repacked weights (the default); a mapped-file load that dies is a crash. */
        val repacked: Boolean = false,
    )

    /** What the chat shows once: "<crashed> closed the app … using <fallback>". */
    @Serializable
    data class Crash(val crashedModelId: String, val crashedLabel: String, val fallbackModelId: String, val fallbackLabel: String, val at: Long)

    interface MarkerStore {
        fun read(): String?
        fun write(json: String)
        fun clear()
    }

    /** Where the outcome is remembered (settings.json, the Expo app's keys plus loadMappedIds). */
    interface Ledger {
        var crashedIds: List<String>
        var mappedIds: List<String>
        var pendingCrash: Crash?
    }

    private var checked = false

    /** Once per process, before any new marker: a marker left over means the last load killed the app. */
    @Synchronized
    fun ensureChecked() {
        if (checked) return
        checked = true
        val raw = runCatching { store.read() }.getOrNull() ?: return
        runCatching {
            val m = json.decodeFromString(Marker.serializer(), raw)
            val id = m.modelId ?: m.filename
            if (m.repacked) {
                ledger.mappedIds = (ledger.mappedIds + id).distinct()
            } else {
                ledger.crashedIds = (ledger.crashedIds + id).distinct()
                ledger.mappedIds = ledger.mappedIds - id
                ledger.pendingCrash = toCrash(m)
            }
        }
        runCatching { store.clear() }
    }

    /** True when the next load of [modelId] should keep the mapped file (its last repacked load was killed). */
    fun mappedNext(modelId: String): Boolean { ensureChecked(); return modelId in ledger.mappedIds }

    /** A model whose load killed the app: not loaded again on its own. */
    fun isBlocked(modelId: String): Boolean { ensureChecked(); return modelId in ledger.crashedIds }

    fun begin(meta: Meta, previous: Meta?, repacked: Boolean) {
        ensureChecked()
        store.write(json.encodeToString(Marker.serializer(), Marker(meta.filename, meta.modelId, meta.label, previous, now(), repacked)))
    }

    /** After the load returned. A model that loaded is unblocked, and goes back to repacked weights on its next load. */
    fun end(meta: Meta, loaded: Boolean) {
        store.clear()
        val id = meta.modelId ?: return
        if (loaded) {
            if (id in ledger.crashedIds) ledger.crashedIds = ledger.crashedIds - id
            if (id in ledger.mappedIds) ledger.mappedIds = ledger.mappedIds - id
        }
    }

    /** The user picked the model again: let it load (CR-2's confirmation). */
    fun confirm(modelId: String) {
        ensureChecked()
        if (modelId in ledger.crashedIds) ledger.crashedIds = ledger.crashedIds - modelId
    }

    /** The last crash, once. */
    @Synchronized
    fun consume(): Crash? {
        ensureChecked()
        return ledger.pendingCrash?.also { ledger.pendingCrash = null }
    }

    companion object {
        /** Decode below this rate, for at least [STALL_MIN_MS], is a stall (a 4B on a 6 GB phone normally writes 3.5–6 tok/s). */
        const val STALL_TOK_PER_SEC = 1.0
        const val STALL_MIN_MS = 10_000.0

        /**
         * memoryFit.ts isDecodeStall (#73): repacked weights pushed to swap make every token wait for them to be
         * decompressed (0.1 tok/s on a Pixel 6a with the 4B, about 1 answer in 6 in long conversations).
         */
        fun isDecodeStall(generatedTokens: Int, decodeMs: Double): Boolean =
            decodeMs >= STALL_MIN_MS && generatedTokens * 1000.0 / decodeMs < STALL_TOK_PER_SEC

        private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

        fun toCrash(m: Marker) = Crash(
            crashedModelId = m.modelId ?: m.filename,
            crashedLabel = m.label ?: m.modelId ?: m.filename,
            fallbackModelId = m.previous?.modelId ?: m.previous?.filename ?: "",
            fallbackLabel = m.previous?.label ?: m.previous?.modelId ?: m.previous?.filename ?: "",
            at = m.at,
        )

        fun crashFromJson(s: String): Crash? = runCatching { json.decodeFromString(Crash.serializer(), s) }.getOrNull()
        fun crashToJson(c: Crash): String = json.encodeToString(Crash.serializer(), c)
    }
}
