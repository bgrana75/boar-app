package team.sopa.boar.engine.answer

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import team.sopa.boar.engine.rag.ConversationTurn
import java.io.File

class SummarizeTest {
    @Test fun `title clean-up matches generateSessionTitle`() {
        for (c in Json.parseToJsonElement(File("src/test/resources/golden/titles.json").readText()).jsonArray) {
            val (input, want) = c.jsonArray.map { it.jsonPrimitive.content }
            assertEquals(input, want, Summarize.cleanTitle(input))
        }
    }

    @Test fun `prompts and settings as summarize ts`() = runBlocking {
        val calls = ArrayList<List<Any?>>()
        val gen = StageGenerator { system, user, n, temp, _, _ -> calls += listOf(system, user, n, temp); GenResult("\"Seasons on Earth\"\nmore") }
        // As the TS: edge quotes come off the whole reply before the first line is taken, so this one keeps its closing quote.
        assertEquals("Seasons on Earth\"", Summarize.title(gen, "Why do we have seasons?"))
        assertEquals("\"Why do we have seasons?\"", calls[0][1])
        assertEquals(listOf(16, 0.3f), calls[0].subList(2, 4))
        Summarize.summary(gen, listOf(ConversationTurn("user", "Hi"), ConversationTurn("assistant", "Hello")), "Old")
        assertEquals("Existing summary:\nOld\n\nUser: Hi\nAssistant: Hello", calls[1][1])
        assertEquals(listOf(150, 0.3f), calls[1].subList(2, 4))
    }
}
