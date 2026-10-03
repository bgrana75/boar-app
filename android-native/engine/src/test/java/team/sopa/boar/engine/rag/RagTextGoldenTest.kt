package team.sopa.boar.engine.rag

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/** Portuguese lexicon, identifiers, "why" reordering and duplicate removal must match the TypeScript engine. */
class RagTextGoldenTest {
    private val g = Json.parseToJsonElement(File("src/test/resources/golden/rag-pure.json").readText()).jsonObject
    private val JsonElement.str get() = if (this is JsonNull) null else jsonPrimitive.content
    private fun chunk(o: JsonObject) = Chunk(o["chunkId"]!!.str!!, o["docId"]!!.str!!, o["title"]!!.str!!, o["body"]!!.str!!, score = o["score"]!!.jsonPrimitive.double)

    companion object {
        /** The app's real 173k-name lexicon (assets/lexicon/pt-en.json), loaded once for all tests. */
        val lexicon: Map<String, String> by lazy {
            Json.parseToJsonElement(File("../../assets/lexicon/pt-en.json").readText()).jsonObject.mapValues { it.value.jsonPrimitive.content }
        }
    }

    @Test fun `Portuguese detection, names and keys match on 30 questions`() {
        for (c in g["ptLexicon"]!!.jsonArray) {
            val o = c.jsonObject
            val q = o["q"]!!.str!!
            assertEquals("looksPortuguese($q)", o["looksPt"]!!.jsonPrimitive.boolean, PtLexicon.looksPortuguese(q))
            assertEquals("englishNamesIn($q)", o["names"]!!.jsonArray.map { it.str }, PtLexicon.englishNamesIn(q, lexicon))
            assertEquals("normalizeKey($q)", o["key"]!!.str, PtLexicon.normalizeKey(q))
        }
    }

    @Test fun `Portuguese singulars`() {
        for (c in g["singularsPt"]!!.jsonArray) assertEquals(c.jsonObject["out"]!!.jsonArray.map { it.str }, PtLexicon.singularsPt(c.jsonObject["w"]!!.str!!))
    }

    @Test fun `standards named by number`() {
        for (c in g["identifiers"]!!.jsonArray) assertEquals(c.jsonObject["out"]!!.jsonArray.map { it.str }, Identifiers.identifiersIn(c.jsonObject["q"]!!.str!!))
        for (c in g["titleHasId"]!!.jsonArray) {
            val o = c.jsonObject
            assertEquals("${o["t"]} ~ ${o["id"]}", o["out"]!!.jsonPrimitive.boolean, Identifiers.titleHasIdentifier(o["t"]!!.str!!, o["id"]!!.str!!))
        }
    }

    @Test fun `why-questions are recognized and their passages reordered`() {
        for (c in g["explainIntent"]!!.jsonArray) {
            val q = c.jsonObject["q"]!!.str!!
            assertEquals("EXPLAIN_INTENT($q)", c.jsonObject["out"]!!.jsonPrimitive.boolean, Explain.EXPLAIN_INTENT.containsMatchIn(q))
        }
        val o = g["explaining"]!!.jsonObject
        val got = Explain.explainingFirst(o["items"]!!.jsonArray.map { chunk(it.jsonObject) }, RagPure.buildLexicalQuery(o["q"]!!.str!!)!!.terms)
        val exp = o["out"]!!.jsonArray.map { chunk(it.jsonObject) }
        assertEquals(exp.map { it.chunkId to it.score }, got.map { it.chunkId to it.score })
    }

    @Test fun `duplicate passages are removed the same way`() {
        for (c in g["dedupe"]!!.jsonArray) {
            val o = c.jsonObject
            assertEquals(o["out"]!!.jsonArray.map { it.str }, Dedupe.dedupeArticleCopies(o["chunks"]!!.jsonArray.map { chunk(it.jsonObject) }).map { it.chunkId })
        }
        for (c in g["containedShare"]!!.jsonArray) {
            val o = c.jsonObject
            assertEquals(o["out"]!!.jsonPrimitive.double, Dedupe.containedShare(o["a"]!!.str!!, o["b"]!!.str!!), 1e-12)
        }
    }
}
