package team.sopa.boar.engine.db

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The SQL features the knowledge base relies on: FTS5 with bm25, fts5vocab, blobs, transactions; zstd. */
class SqlTest {
    @Test fun `fts5 ranks with bm25 and fts5vocab lists terms`() = JdbcSqlite().use { db ->
        db.exec("CREATE VIRTUAL TABLE t USING fts5(title, body, tokenize='porter unicode61')")
        db.transaction {
            db.execute("INSERT INTO t(title, body) VALUES (?, ?)", listOf("Season", "Seasons come from the tilt of Earth's axis."))
            db.execute("INSERT INTO t(title, body) VALUES (?, ?)", listOf("Monsoon", "A monsoon is a seasonal wind."))
        }
        val hits = db.query("SELECT title FROM t WHERE t MATCH ? ORDER BY bm25(t, 2.0, 1.0)", listOf("season OR tilt")) { it.string(0) }
        assertEquals("Season", hits.first())
        db.exec("CREATE VIRTUAL TABLE v USING fts5vocab(t, 'row')")
        val terms = db.query("SELECT term FROM v WHERE term = ?", listOf("season")) { it.string("term") }
        assertEquals(listOf("season"), terms)
    }

    @Test fun `blobs and nulls round-trip`() = JdbcSqlite().use { db ->
        db.exec("CREATE TABLE b(id INTEGER PRIMARY KEY, v BLOB, n TEXT)")
        val vec = byteArrayOf(1, -2, 127, -128)
        db.execute("INSERT INTO b(v, n) VALUES (?, ?)", listOf(vec, null))
        val row = db.query("SELECT v, n FROM b") { Pair(it.blob(0), it.isNull(1)) }.single()
        assertArrayEquals(vec, row.first)
        assertTrue(row.second)
    }

    @Test fun `zstd decompresses a frame`() {
        val text = "BOAR ".repeat(1000).toByteArray()
        val frame = com.github.luben.zstd.Zstd.compress(text)
        assertArrayEquals(text, jvmZstd.decompress(frame))
    }
}
