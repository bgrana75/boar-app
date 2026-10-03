package team.sopa.boar.engine.db

internal object SqliteNative {
    init { System.loadLibrary("boar_engine") }
    external fun open(path: ByteArray, flags: Int): Long
    external fun close(db: Long)
    external fun errmsg(db: Long): ByteArray
    external fun exec(db: Long, sql: ByteArray): Int
    external fun changes(db: Long): Long
    external fun lastInsertRowid(db: Long): Long
    external fun interrupt(db: Long)
    external fun version(): ByteArray
    external fun prepare(db: Long, sql: ByteArray): Long
    external fun bindNull(st: Long, i: Int): Int
    external fun bindLong(st: Long, i: Int, v: Long): Int
    external fun bindDouble(st: Long, i: Int, v: Double): Int
    external fun bindText(st: Long, i: Int, v: ByteArray): Int
    external fun bindBlob(st: Long, i: Int, v: ByteArray): Int
    external fun step(st: Long): Int
    external fun reset(st: Long): Int
    external fun finalize(st: Long)
    external fun columnCount(st: Long): Int
    external fun columnType(st: Long, i: Int): Int
    external fun columnName(st: Long, i: Int): ByteArray
    external fun columnLong(st: Long, i: Int): Long
    external fun columnDouble(st: Long, i: Int): Double
    external fun columnText(st: Long, i: Int): ByteArray?
    external fun columnBlob(st: Long, i: Int): ByteArray?
    external fun zstdDecompress(src: ByteArray): ByteArray?
}

/** The bundled SQLite (with FTS5) through JNI. One connection; calls are serialized by SQLite (FULLMUTEX). */
class NativeSqlite private constructor(private var db: Long) : SqlDatabase {
    private var txDepth = 0

    override fun <T> query(sql: String, args: List<Any?>, map: (SqlRow) -> T): List<T> {
        val st = prepare(sql, args)
        try {
            val row = NativeRow(st)
            val out = ArrayList<T>()
            while (true) {
                when (val rc = SqliteNative.step(st)) {
                    SQLITE_ROW -> out += map(row)
                    SQLITE_DONE -> return out
                    else -> throw error(rc)
                }
            }
        } finally {
            SqliteNative.finalize(st)
        }
    }

    override fun execute(sql: String, args: List<Any?>): Long {
        val st = prepare(sql, args)
        try {
            var rc: Int
            do { rc = SqliteNative.step(st) } while (rc == SQLITE_ROW)
            if (rc != SQLITE_DONE) throw error(rc)
            return SqliteNative.changes(db)
        } finally {
            SqliteNative.finalize(st)
        }
    }

    override fun exec(script: String) {
        val rc = SqliteNative.exec(db, script.toByteArray())
        if (rc != SQLITE_OK) throw error(rc)
    }

    override fun lastInsertRowid(): Long = SqliteNative.lastInsertRowid(db)

    override fun <T> transaction(block: () -> T): T {
        if (txDepth > 0) return block()
        exec("BEGIN")
        txDepth++
        try {
            val r = block()
            exec("COMMIT")
            return r
        } catch (e: Throwable) {
            runCatching { exec("ROLLBACK") }
            throw e
        } finally {
            txDepth--
        }
    }

    fun interrupt() = SqliteNative.interrupt(db)

    override fun close() {
        if (db != 0L) { SqliteNative.close(db); db = 0L }
    }

    private fun prepare(sql: String, args: List<Any?>): Long {
        val st = SqliteNative.prepare(db, sql.toByteArray())
        if (st < 0) throw SqlException((-st).toInt(), "${msg()} in: ${sql.take(200)}")
        args.forEachIndexed { k, v ->
            val i = k + 1
            val rc = when (v) {
                null -> SqliteNative.bindNull(st, i)
                is String -> SqliteNative.bindText(st, i, v.toByteArray())
                is ByteArray -> SqliteNative.bindBlob(st, i, v)
                is Long -> SqliteNative.bindLong(st, i, v)
                is Int -> SqliteNative.bindLong(st, i, v.toLong())
                is Boolean -> SqliteNative.bindLong(st, i, if (v) 1 else 0)
                is Double -> SqliteNative.bindDouble(st, i, v)
                is Float -> SqliteNative.bindDouble(st, i, v.toDouble())
                else -> { SqliteNative.finalize(st); throw IllegalArgumentException("can't bind ${v::class}") }
            }
            if (rc != SQLITE_OK) { SqliteNative.finalize(st); throw error(rc) }
        }
        return st
    }

    private fun msg() = String(SqliteNative.errmsg(db))
    private fun error(rc: Int) = SqlException(rc, msg())

    private class NativeRow(private val st: Long) : SqlRow {
        override val columnCount: Int get() = SqliteNative.columnCount(st)
        override fun columnName(i: Int) = String(SqliteNative.columnName(st, i))
        override fun isNull(i: Int) = SqliteNative.columnType(st, i) == SQLITE_NULL
        override fun long(i: Int) = SqliteNative.columnLong(st, i)
        override fun double(i: Int) = SqliteNative.columnDouble(st, i)
        override fun string(i: Int) = SqliteNative.columnText(st, i)?.let { String(it) }
        override fun blob(i: Int) = SqliteNative.columnBlob(st, i)
    }

    companion object {
        private const val SQLITE_OK = 0
        private const val SQLITE_ROW = 100
        private const val SQLITE_DONE = 101
        private const val SQLITE_NULL = 5
        private const val OPEN_READONLY = 0x1
        private const val OPEN_READWRITE = 0x2
        private const val OPEN_CREATE = 0x4

        fun open(path: String, readOnly: Boolean = false): NativeSqlite {
            val flags = if (readOnly) OPEN_READONLY else OPEN_READWRITE or OPEN_CREATE
            val h = SqliteNative.open(path.toByteArray(), flags)
            if (h <= 0) throw SqlException((-h).toInt(), "can't open $path")
            return NativeSqlite(h)
        }

        val version: String get() = String(SqliteNative.version())
        val zstd = Zstd { src -> SqliteNative.zstdDecompress(src) ?: throw IllegalStateException("zstd: corrupt block") }
    }
}
