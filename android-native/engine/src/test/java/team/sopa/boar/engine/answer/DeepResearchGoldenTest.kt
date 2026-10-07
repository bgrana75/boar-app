package team.sopa.boar.engine.answer

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import team.sopa.boar.engine.rag.Chunk
import team.sopa.boar.engine.rag.ConversationHistory
import team.sopa.boar.engine.routing.ResearchContext
import java.io.File

/**
 * Deep Research and its context helpers must match src/services/orchestrator.ts and src/routing/context.ts
 * (scripts/export-native-golden-research.mjs): every stage's prompt and settings, the sources and their numbers.
 */
class DeepResearchGoldenTest {
    private val g = Json.parseToJsonElement(File("src/test/resources/golden/research.json").readText()).jsonObject
    private val JsonElement.str get() = if (this is JsonNull) null else jsonPrimitive.content
    private fun chunk(o: JsonObject) = Chunk(o["chunkId"]!!.str!!, o["docId"]!!.str!!, o["title"]!!.str!!, o["body"]!!.str!!, source = o["source"]?.str, score = o["score"]!!.jsonPrimitive.double)
    private fun compressedLine(o: JsonObject) = "${o["chunkId"]!!.str} | ${o["body"]!!.str} | ${o["relevance"]!!.jsonPrimitive.doubleOrNull}"
    private fun compressedLine(c: Chunk) = "${c.chunkId} | ${c.body} | ${c.relevance}"

    /** The retrieval each research run recorded, replayed by (query, k) in order. */
    private val corpus by lazy {
        g["research"]!!.jsonArray.flatMap { r -> r.jsonObject["retrievals"]!!.jsonArray.flatMap { it.jsonObject["chunks"]!!.jsonArray } }
            .map { chunk(it.jsonObject) }.associateBy { it.chunkId }
    }

    @Test fun `on-topic test and context compression`() {
        // The topic cases use the same stand-in retrieval; their chunks are all in the research recordings or the corpus.
        val docs = File("../../assets/corpus/corpus.json").readText().let { Json.parseToJsonElement(it).jsonArray }
            .mapIndexed { i, d -> d.jsonObject.let { Chunk("seed:$i", "seed:${it["title"]!!.str}", it["title"]!!.str!!, it["body"]!!.str!!, source = it["source"]?.str) } }
            .associateBy { it.chunkId }
        for (t in g["topic"]!!.jsonArray.map { it.jsonObject }) {
            val q = t["query"]!!.str!!
            val chunks = t["chunks"]?.jsonArray?.map { chunk(it.jsonObject) } ?: t["chunkIds"]!!.jsonArray.map { docs[it.str!!]!! }
            // compressContext sees the stand-in's score too; it only reads titles and bodies.
            assertEquals("onTopic $q", t["onTopic"]!!.jsonArray.map { it.jsonPrimitive.boolean }, chunks.map { ResearchContext.onTopic(q, it) })
            val c = ResearchContext.compressContext(q, chunks, tokenBudget = t["budget"]!!.jsonPrimitive.int)
            assertEquals("compress $q", t["compressed"]!!.jsonArray.map { compressedLine(it.jsonObject) }, c.chunks.map(::compressedLine))
            assertEquals("kept $q", t["keptIndices"]!!.jsonArray.map { it.jsonPrimitive.int }, c.keptIndices)
            assertEquals(t["tokensBefore"]!!.jsonPrimitive.int, c.tokensBefore)
            assertEquals(t["tokensAfter"]!!.jsonPrimitive.int, c.tokensAfter)
        }
    }

    @Test fun `merged source numbers`() {
        val m = g["merge"]!!.jsonObject
        val c = (0..3).map { Chunk("seed:$it", "d", "t$it", "b") }
        val got = ResearchContext.mergeSources(listOf(listOf(c[0], c[1]), listOf(c[1], c[2]), emptyList(), listOf(c[2], c[0], c[3])))
        assertEquals(m["sources"]!!.jsonArray.map { it.str }, got.sources.map { it.chunkId })
        assertEquals(m["indexMaps"]!!.jsonArray.map { l -> l.jsonArray.map { it.jsonPrimitive.int } }, got.indexMaps)
    }

    @Test fun `every stage's prompt, the sources and the answer`() = runBlocking {
        for (r in g["research"]!!.jsonArray.map { it.jsonObject }) {
            val q = r["query"]!!.str!!
            val calls = r["calls"]!!.jsonArray.map { it.jsonObject }
            val retrievals = r["retrievals"]!!.jsonArray.map { it.jsonObject }
            var n = 0
            var k = 0
            val generator = StageGenerator { system, user, nPredict, temperature, onToken ->
                val want = calls[n++]
                assertEquals("$q stage $n system", want["system"]!!.str, system)
                assertEquals("$q stage $n user", want["user"]!!.str, user)
                assertEquals("$q stage $n nPredict", want["nPredict"]!!.jsonPrimitive.int, nPredict)
                assertEquals("$q stage $n temperature", want["temperature"]!!.jsonPrimitive.double, temperature.toDouble(), 1e-6)
                want["reply"]!!.str!!.also { onToken?.invoke(it) }
            }
            val retrieve = { sq: String, topK: Int ->
                val want = retrievals[k++]
                assertEquals("$q retrieval $k", want["query"]!!.str, sq)
                assertEquals(want["k"]!!.jsonPrimitive.int, topK)
                want["chunks"]!!.jsonArray.map { chunk(it.jsonObject) }
            }
            val history = r["summary"]!!.str?.let { ConversationHistory(summary = it) }
            val res = DeepResearch(generator, retrieve).run(q, r["system"]!!.str, history, 512, answerLanguage = r["language"]!!.str)
            assertEquals("$q stages", calls.size, n)
            assertEquals("$q sub-questions", r["subQuestions"]!!.jsonArray.map { it.str }, res.subQuestions)
            assertEquals("$q answer", r["answer"]!!.str, res.answer)
            assertEquals("$q citations", r["citations"]!!.jsonArray.map { compressedLine(it.jsonObject) }, res.citations.map(::compressedLine))
            assertEquals("$q full citations", r["fullCitations"]!!.jsonArray.map { it.str }, res.fullCitations.map { it.chunkId })
        }
        assert(corpus.isNotEmpty())
    }
}
