package team.sopa.boar.engine.models

import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.File
import java.net.ServerSocket
import kotlin.concurrent.thread
import java.nio.file.Files
import java.security.MessageDigest
import kotlin.random.Random

/** Downloads against a local HTTP server: fresh, resumed, Range ignored, size changed, bad checksum. */
class AssetStoreTest {
    private val payload = Random(7).nextBytes(3_000_000)
    private val sha = MessageDigest.getInstance("SHA-256").digest(payload).joinToString("") { "%02x".format(it) }
    private lateinit var server: ServerSocket
    private lateinit var dir: File
    private var honorRange = true
    private var served: ByteArray = payload
    private val requests = mutableListOf<String?>()

    /** A minimal HTTP/1.1 server: GET with optional "Range: bytes=N-", one request per connection. */
    @Before fun start() {
        dir = Files.createTempDirectory("boar-assets").toFile()
        server = ServerSocket(0)
        thread(isDaemon = true) {
            while (!server.isClosed) {
                val sock = runCatching { server.accept() }.getOrNull() ?: break
                sock.use { c ->
                    val reader = c.getInputStream().bufferedReader(Charsets.ISO_8859_1)
                    reader.readLine()
                    var range: String? = null
                    while (true) {
                        val line = reader.readLine() ?: break
                        if (line.isEmpty()) break
                        if (line.startsWith("Range:", ignoreCase = true)) range = line.substringAfter(':').trim()
                    }
                    synchronized(requests) { requests += range }
                    val from = range?.removePrefix("bytes=")?.removeSuffix("-")?.toIntOrNull()
                    val out = c.getOutputStream()
                    val head = if (from != null && honorRange) {
                        "HTTP/1.1 206 Partial Content\r\nContent-Length: ${served.size - from}\r\nContent-Range: bytes $from-${served.size - 1}/${served.size}\r\nConnection: close\r\n\r\n"
                    } else {
                        "HTTP/1.1 200 OK\r\nContent-Length: ${served.size}\r\nConnection: close\r\n\r\n"
                    }
                    out.write(head.toByteArray(Charsets.ISO_8859_1))
                    if (from != null && honorRange) out.write(served, from, served.size - from) else out.write(served)
                    out.flush()
                }
            }
        }
    }

    @After fun stop() { server.close(); dir.deleteRecursively() }

    private fun asset(size: Long = payload.size.toLong(), digest: String = sha) = CatalogAsset(
        id = "m", kind = AssetKind.LLM, label = "Test model", filename = "models/m.gguf", sizeBytes = size, sha256 = digest,
        sourceUrl = "http://127.0.0.1:${server.localPort}/m.gguf", license = "MIT", description = "", required = false,
        answerTier = AnswerTier.COMPACT,
    )

    private fun store(a: CatalogAsset) = AssetStore(dir, Catalog(50_000_000_000, 12L shl 30, listOf(a), emptyList()))

    @Test fun `downloads, verifies and records the file`() = runBlocking {
        val a = asset()
        val s = store(a)
        s.download(a)
        assertArrayEquals(payload, s.fileOf(a).readBytes())
        assertEquals(true, s.status(a).checksumOk)
        assertTrue(File(dir, "integrity.json").readText().contains("models/m.gguf"))
    }

    @Test fun `resumes a partial file with a Range request`() = runBlocking {
        val a = asset()
        val s = store(a)
        s.fileOf(a).apply { parentFile.mkdirs(); writeBytes(payload.copyOf(1_000_000)) }
        assertEquals(1_000_000L, s.status(a).partialBytes)
        s.download(a)
        assertEquals(listOf("bytes=1000000-"), requests)
        assertArrayEquals(payload, s.fileOf(a).readBytes())
        assertEquals(true, s.status(a).checksumOk)
    }

    @Test fun `starts over when the server ignores Range`() = runBlocking {
        honorRange = false
        val a = asset()
        val s = store(a)
        s.fileOf(a).apply { parentFile.mkdirs(); writeBytes(payload.copyOf(1_000_000)) }
        s.download(a)
        assertArrayEquals(payload, s.fileOf(a).readBytes())
    }

    @Test fun `refuses a file whose size on the server changed`() = runBlocking {
        val a = asset(size = payload.size + 10L)
        try { store(a).download(a); fail("expected SizeChanged") } catch (e: AssetStore.DownloadException.SizeChanged) {
            assertEquals(payload.size.toLong(), e.serverBytes)
        }
    }

    @Test fun `deletes a download that fails its checksum`() = runBlocking {
        val a = asset(digest = "0".repeat(64))
        val s = store(a)
        try { s.download(a); fail("expected Checksum") } catch (_: AssetStore.DownloadException.Checksum) {}
        assertFalse(s.fileOf(a).exists())
        assertFalse(s.status(a).present)
    }

    @Test fun `reads integrity records written by the Expo app (mtime in seconds)`() {
        val a = asset()
        val s = store(a)
        val f = s.fileOf(a).apply { parentFile.mkdirs(); writeBytes(payload) }
        File(dir, "integrity.json").writeText("""{"models/m.gguf":{"size":${payload.size},"mtime":${f.lastModified() / 1000.0},"sha256":"$sha"}}""")
        assertEquals(true, s.status(a).checksumOk)
        f.setLastModified(f.lastModified() + 5_000)
        assertNull(s.status(a).checksumOk)
    }
}
