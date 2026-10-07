package team.sopa.boar.engine.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import team.sopa.boar.engine.db.JdbcSqlite
import team.sopa.boar.engine.rag.KnowledgeBase

class ChatStoreTest {
    private var clock = 1_000L
    private fun store(): ChatStore {
        val db = JdbcSqlite()
        KnowledgeBase(db)
        return ChatStore(db) { clock++ }
    }

    @Test fun `sessions, messages, ratings and meta round-trip`() {
        val s = store()
        val a = s.createSession()
        val b = s.createSession("Trip planning")
        s.addMessage(a.id, "user", "What is a black hole?", "u1")
        s.upsertMessage(a.id, "assistant", "A region", "a1")
        s.upsertMessage(a.id, "assistant", "A region of spacetime [1].", "a1")
        s.setFeedback("a1", "up")
        s.setMessageMeta("a1", """{"sources":[]}""")
        val msgs = s.messages(a.id)
        assertEquals(listOf("u1", "a1"), msgs.map { it.id })
        assertEquals("A region of spacetime [1].", msgs[1].text)
        assertEquals("up", msgs[1].feedback)
        assertEquals("""{"sources":[]}""", msgs[1].meta)
        assertNull(msgs[0].feedback)
        // The session used last comes first.
        assertEquals(listOf(a.id, b.id), s.listSessions().map { it.id })
        s.setFeedback("a1", null)
        assertNull(s.messages(a.id)[1].feedback)
        assertTrue(Regex("^\\d+-[0-9a-z]{6}$").matches(s.newId()))
    }

    @Test fun `delete and prune remove messages, ratings and meta`() {
        val s = store()
        val ids = (1..4).map { i -> s.createSession("s$i").also { s.addMessage(it.id, "user", "q$i", "m$i"); s.setFeedback("m$i", "down"); s.setMessageMeta("m$i", "{}") }.id }
        s.prune(2)
        assertEquals(ids.takeLast(2).reversed(), s.listSessions().map { it.id })
        assertTrue(s.messages(ids[0]).isEmpty())
        s.deleteSession(ids[3])
        assertEquals(listOf(ids[2]), s.listSessions().map { it.id })
        s.clearAll()
        assertTrue(s.listSessions().isEmpty())
    }
}
