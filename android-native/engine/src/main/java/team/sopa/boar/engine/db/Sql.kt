package team.sopa.boar.engine.db

import java.io.Closeable

/**
 * The SQL the engine needs, behind an interface: on the phone the bundled SQLite 3.53 with FTS5 (JNI,
 * [NativeSqlite]); in JVM tests sqlite-jdbc, a real SQLite with FTS5 too. Arguments are bound by position
 * (`?`): String, Long/Int, Double/Float, ByteArray, Boolean or null.
 */
interface SqlDatabase : Closeable {
    fun <T> query(sql: String, args: List<Any?> = emptyList(), map: (SqlRow) -> T): List<T>
    /** Runs one statement; returns the number of rows it changed. */
    fun execute(sql: String, args: List<Any?> = emptyList()): Long
    /** Runs a script of statements without arguments. */
    fun exec(script: String)
    fun lastInsertRowid(): Long
    fun <T> transaction(block: () -> T): T
}

interface SqlRow {
    val columnCount: Int
    fun columnName(i: Int): String
    fun isNull(i: Int): Boolean
    fun long(i: Int): Long
    fun double(i: Int): Double
    fun string(i: Int): String?
    fun blob(i: Int): ByteArray?

    fun index(name: String): Int = (0 until columnCount).firstOrNull { columnName(it) == name }
        ?: throw IllegalArgumentException("no column $name")
    fun long(name: String) = long(index(name))
    fun double(name: String) = double(index(name))
    fun string(name: String) = string(index(name))
    fun blob(name: String) = blob(index(name))
}

class SqlException(val code: Int, message: String) : RuntimeException("SQLite error $code: $message")

/** zstd frame decompression (format-2 pack blocks). */
fun interface Zstd {
    fun decompress(src: ByteArray): ByteArray
}
