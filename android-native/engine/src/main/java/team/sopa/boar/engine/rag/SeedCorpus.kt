package team.sopa.boar.engine.rag

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Indexes the bundled corpus and downloaded corpus packs into the knowledge base (port of src/rag/seedCorpus.ts):
 * one chunk per document, id "wiki-<collection>-<slug of the title>" (the first document with a slug wins), embedded
 * as "title\nbody". Chunk ids match the Expo app's, so an upgraded install finds its index complete and skips it.
 */
class SeedCorpus(private val kb: KnowledgeBase, private val embed: suspend (String) -> FloatArray) {
    data class Doc(val id: String, val title: String, val source: String, val body: String)
    data class Collection(val id: String, val docs: List<Doc>, val error: String? = null)
    data class Progress(val done: Int, val total: Int, val title: String, val collectionId: String, val collectionDone: Int, val collectionTotal: Int)

    class Stopped : RuntimeException("seeding stopped")

    /** Indexes what's missing; returns how many documents it embedded. */
    suspend fun seed(collections: List<Collection>, onProgress: (Progress) -> Unit = {}, shouldStop: () -> Boolean = { false }): Int {
        kb.deleteSeedChunks(RETIRED_SEED_IDS)
        val total = collections.sumOf { it.docs.size }
        val count = kb.seedChunkCount()
        if (count == total.toLong()) return 0
        var done = 0
        var embedded = 0
        var lastReport = 0L
        for (c in collections) {
            if (c.error != null) continue
            for ((i, doc) in c.docs.withIndex()) {
                if (shouldStop()) throw Stopped()
                done++
                val now = System.currentTimeMillis()
                if (now - lastReport > 250 || done == total) {
                    lastReport = now
                    onProgress(Progress(done, total, doc.title, c.id, i + 1, c.docs.size))
                }
                if (kb.hasChunk(doc.id)) continue
                kb.insertChunk(Chunk(doc.id, doc.id, doc.title, doc.body, source = doc.source), embed("${doc.title}\n${doc.body}"))
                embedded++
            }
        }
        return embedded
    }

    companion object {
        const val BUILTIN = "builtin"

        /** Seed chunks the app no longer ships (removed before seeding). */
        val RETIRED_SEED_IDS = listOf("app-moe-ram", "app-mmap-streaming", "app-bm25-vs-cosine", "app-grapheneos", "app-ram-budgeting")

        private val NON_ALNUM = Regex("[^a-z0-9]+")
        private val EDGE_DASH = Regex("^-|-$")

        fun slug(title: String) = title.lowercase().replace(NON_ALNUM, "-").replace(EDGE_DASH, "")

        fun chunkIdPrefix(collectionId: String) = "wiki-${if (collectionId == BUILTIN) "min" else collectionId}-"

        /** A corpus JSON file ([{ title, source, body }]) as seed documents, one per slug. */
        fun docs(collectionId: String, json: String): List<Doc> {
            val byId = LinkedHashMap<String, Doc>()
            for (e in Json.parseToJsonElement(json).jsonArray) {
                val o = e.jsonObject
                val title = o["title"]!!.jsonPrimitive.content
                val id = chunkIdPrefix(collectionId) + slug(title)
                byId.putIfAbsent(id, Doc(id, title, o["source"]?.jsonPrimitive?.content ?: "", o["body"]!!.jsonPrimitive.content))
            }
            return byId.values.toList()
        }
    }
}
