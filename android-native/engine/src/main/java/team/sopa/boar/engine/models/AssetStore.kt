package team.sopa.boar.engine.models

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.security.MessageDigest
import kotlin.coroutines.coroutineContext
import kotlin.math.abs

/**
 * Installed assets on disk: status, sha256 verification and resumable downloads
 * (port of src/models/ModelManager.ts).
 *
 * Same layout and records as the Expo app, so an upgrade keeps everything: assets live at
 * `<filesDir>/<asset.filename>` and verified files are listed in `<filesDir>/integrity.json`
 * as `{filename: {size, mtime (seconds, as Expo reported it), sha256}}`.
 */
class AssetStore(
    private val filesDir: File,
    private val catalog: Catalog,
    /** False in a build without the network permission (the offline variant). */
    private val networkAllowed: Boolean = true,
    private val log: (String) -> Unit = {},
) {
    data class Status(
        val asset: CatalogAsset,
        val present: Boolean,
        val sizeOnDiskBytes: Long,
        /** true = sha256 verified on this phone for this exact file; null = not checked yet. */
        val checksumOk: Boolean?,
        /** Bytes of an interrupted download, the resume point. */
        val partialBytes: Long = 0,
    )

    data class Progress(val bytesDone: Long, val bytesTotal: Long, val phase: Phase) {
        enum class Phase { DOWNLOADING, VERIFYING }
    }

    sealed class DownloadException(message: String) : IOException(message) {
        class NoSource(asset: CatalogAsset) : DownloadException("${asset.label} isn't available for download yet. Import the file instead.")
        class OfflineBuild : DownloadException("This build of BOAR has no network permission. Import the file instead.")
        class Storage(message: String) : DownloadException(message)
        class SizeChanged(asset: CatalogAsset, val serverBytes: Long) : DownloadException(
            "The download server now serves $serverBytes bytes for ${asset.label}, not the ${asset.sizeBytes} this version of BOAR expects. " +
                "Skip it for now, import the file, or update the app.",
        )
        class Paused(asset: CatalogAsset, val bytesDone: Long) : DownloadException(
            "Download of ${asset.label} paused (no data for ${INACTIVITY_TIMEOUT_MS / 1000}s). Tap Retry to resume, or check your connection.",
        )
        class Checksum(asset: CatalogAsset) : DownloadException("${asset.label} didn't match its checksum and was removed. Retry the download.")
        class Http(asset: CatalogAsset, val code: Int) : DownloadException("The server answered $code for ${asset.label}. Retry later.")
    }

    private val json = Json { ignoreUnknownKeys = true }
    private val integrityFile get() = File(filesDir, "integrity.json")
    private val activeDownloads = mutableMapOf<String, CatalogAsset>()

    fun fileOf(asset: CatalogAsset) = File(filesDir, asset.filename)

    fun status(asset: CatalogAsset): Status {
        val f = fileOf(asset)
        if (!f.exists()) return Status(asset, false, 0, null)
        val size = f.length()
        if (size != asset.sizeBytes) {
            // Smaller = an interrupted download, kept as the resume point. Larger can't be a prefix: delete it.
            if (size < asset.sizeBytes || asset.id in activeDownloads) return Status(asset, false, 0, null, partialBytes = size)
            log("${asset.id}: deleting oversized file ($size > ${asset.sizeBytes})")
            f.delete()
            return Status(asset, false, 0, null)
        }
        val rec = loadVerified()[asset.filename]
        val verified = rec != null && rec.size == size && sameMtime(rec.mtime, f) && rec.sha256.equals(asset.sha256, ignoreCase = true)
        return Status(asset, true, size, if (verified) true else null)
    }

    fun statusAll(): List<Status> = catalog.models.map(::status)

    /** Setup is complete: every required asset plus one answer model on disk with the right size. */
    fun requiredPresent(): Boolean =
        catalog.models.filter { it.required }.all { status(it).present } && catalog.answerModels.any { status(it).present }

    /** Streams the installed file through SHA-256 and remembers a match. */
    suspend fun verify(asset: CatalogAsset, onProgress: (Progress) -> Unit = {}): Boolean = withContext(Dispatchers.IO) {
        if (asset.sha256.isEmpty()) return@withContext true
        val f = fileOf(asset)
        val md = MessageDigest.getInstance("SHA-256")
        hashInto(md, f, f.length()) { done -> onProgress(Progress(done, f.length(), Progress.Phase.VERIFYING)) }
        val ok = md.digest().hex().equals(asset.sha256, ignoreCase = true)
        if (ok) recordVerified(asset) else forgetVerified(asset)
        log("${asset.id}: sha256 ${if (ok) "ok" else "MISMATCH"}")
        ok
    }

    /**
     * Downloads [asset] to its file, resuming from a partial one with an HTTP Range request. The sha256
     * is computed while the bytes arrive (the partial part first), so nothing is read twice. A stall of
     * [INACTIVITY_TIMEOUT_MS] or a cancelled coroutine leaves the partial file for the next attempt.
     */
    suspend fun download(asset: CatalogAsset, onProgress: (Progress) -> Unit = {}) = withContext(Dispatchers.IO) {
        if (asset.sourceUrl.isEmpty()) throw DownloadException.NoSource(asset)
        if (!networkAllowed) throw DownloadException.OfflineBuild()
        val dest = fileOf(asset)
        dest.parentFile?.mkdirs()

        val others = synchronized(activeDownloads) { activeDownloads.values.filter { it.id != asset.id } }
        val partialBytes = if (dest.exists()) dest.length() else 0L
        val check = StorageBudget.check(
            StorageBudget.Input(
                usedBytes = usedBytes(setOf(dest) + others.map(::fileOf)),
                reservedBytes = others.sumOf { it.sizeBytes },
                downloadBytes = asset.sizeBytes,
                alreadyDownloadedBytes = partialBytes,
                freeDiskBytes = filesDir.usableSpace.takeIf { it > 0 },
                budgetBytes = catalog.storageBudgetBytes,
            ),
        )
        if (check is StorageBudget.Check.Refused) throw DownloadException.Storage(check.message)

        if (partialBytes == asset.sizeBytes) {
            log("${asset.id}: complete file already on disk, verifying instead of downloading")
            if (!verify(asset, onProgress)) { dest.delete(); throw DownloadException.Checksum(asset) }
            return@withContext
        }
        if (partialBytes > asset.sizeBytes) dest.delete()

        synchronized(activeDownloads) { activeDownloads[asset.id] = asset }
        try {
            transfer(asset, dest, onProgress)
        } finally {
            synchronized(activeDownloads) { activeDownloads.remove(asset.id) }
        }
    }

    private suspend fun transfer(asset: CatalogAsset, dest: File, onProgress: (Progress) -> Unit) {
        val md = MessageDigest.getInstance("SHA-256")
        var resumeFrom = if (dest.exists()) dest.length() else 0L
        if (resumeFrom > 0) hashInto(md, dest, resumeFrom) {}

        for (attempt in 0..1) {
            val conn = (URL(asset.sourceUrl).openConnection() as HttpURLConnection).apply {
                connectTimeout = 30_000
                readTimeout = INACTIVITY_TIMEOUT_MS
                instanceFollowRedirects = true
                setRequestProperty("User-Agent", "BOAR-native")
                if (resumeFrom > 0) setRequestProperty("Range", "bytes=$resumeFrom-")
            }
            try {
                val code = conn.responseCode
                if (code != 200 && code != 206) throw DownloadException.Http(asset, code)
                if (resumeFrom > 0 && code == 200) {
                    // The server ignored Range and sends the whole file: take it from zero rather than append it.
                    log("${asset.id}: Range ignored, restarting from zero")
                    RandomAccessFile(dest, "rw").use { it.setLength(0) }
                    md.reset()
                    resumeFrom = 0
                }
                val length = conn.contentLengthLong
                val total = if (code == 206) contentRangeTotal(conn) ?: (resumeFrom + length) else length
                if (total > 0 && total != asset.sizeBytes) {
                    if (resumeFrom > 0) {
                        // A mismatch on a resumed request means the partial bytes are of another file: start over.
                        RandomAccessFile(dest, "rw").use { it.setLength(0) }
                        md.reset()
                        resumeFrom = 0
                        conn.disconnect()
                        if (attempt == 0) continue
                    }
                    throw DownloadException.SizeChanged(asset, total)
                }
                var done = resumeFrom
                var lastReport = 0L
                conn.inputStream.use { input ->
                    FileOutputStream(dest, resumeFrom > 0).use { out ->
                        val buf = ByteArray(1 shl 20)
                        while (true) {
                            coroutineContext.ensureActive()
                            val n = try { input.read(buf) } catch (e: SocketTimeoutException) { throw DownloadException.Paused(asset, done) }
                            if (n < 0) break
                            out.write(buf, 0, n)
                            md.update(buf, 0, n)
                            done += n
                            val now = System.currentTimeMillis()
                            if (now - lastReport > 250) { lastReport = now; onProgress(Progress(done, asset.sizeBytes, Progress.Phase.DOWNLOADING)) }
                        }
                    }
                }
                onProgress(Progress(done, asset.sizeBytes, Progress.Phase.DOWNLOADING))
                if (done != asset.sizeBytes) throw DownloadException.Paused(asset, done)
                val ok = md.digest().hex().equals(asset.sha256, ignoreCase = true) || asset.sha256.isEmpty()
                if (!ok) {
                    dest.delete()
                    forgetVerified(asset)
                    throw DownloadException.Checksum(asset)
                }
                recordVerified(asset)
                log("${asset.id}: downloaded and verified ($done bytes)")
                return
            } finally {
                conn.disconnect()
            }
        }
    }

    fun delete(asset: CatalogAsset) {
        fileOf(asset).delete()
        forgetVerified(asset)
    }

    /** Bytes BOAR's assets use on disk, excluding [exclude] (partial downloads in flight). */
    fun usedBytes(exclude: Set<File> = emptySet()): Long =
        STORAGE_DIRS.sumOf { dir -> File(filesDir, dir).walkTopDown().filter { it.isFile && it !in exclude }.sumOf { it.length() } }

    // integrity.json, shared with the Expo app's format.
    @Serializable
    private data class VerifiedRecord(val size: Long, val mtime: Double, val sha256: String)

    private fun loadVerified(): MutableMap<String, VerifiedRecord> = runCatching {
        json.decodeFromString<Map<String, VerifiedRecord>>(integrityFile.readText()).toMutableMap()
    }.getOrElse { mutableMapOf() }

    private fun saveVerified(records: Map<String, VerifiedRecord>) {
        runCatching { integrityFile.writeText(json.encodeToString(records)) }
    }

    private fun recordVerified(asset: CatalogAsset) {
        val f = fileOf(asset)
        if (!f.exists()) return
        val records = loadVerified()
        records[asset.filename] = VerifiedRecord(f.length(), f.lastModified() / 1000.0, asset.sha256)
        saveVerified(records)
    }

    private fun forgetVerified(asset: CatalogAsset) {
        val records = loadVerified()
        if (records.remove(asset.filename) != null) saveVerified(records)
    }

    private fun sameMtime(seconds: Double, f: File) = abs(seconds - f.lastModified() / 1000.0) < 0.002

    companion object {
        const val INACTIVITY_TIMEOUT_MS = 60_000
        private val STORAGE_DIRS = listOf("models/", "corpus/", "poi/", "SQLite/")

        private fun contentRangeTotal(conn: HttpURLConnection): Long? =
            conn.getHeaderField("Content-Range")?.substringAfterLast('/')?.trim()?.toLongOrNull()

        private fun hashInto(md: MessageDigest, f: File, bytes: Long, onChunk: (Long) -> Unit) {
            f.inputStream().buffered(1 shl 20).use { input ->
                val buf = ByteArray(1 shl 20)
                var left = bytes
                var done = 0L
                while (left > 0) {
                    val n = input.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
                    if (n < 0) break
                    md.update(buf, 0, n)
                    left -= n
                    done += n
                    onChunk(done)
                }
            }
        }

        private fun ByteArray.hex() = joinToString("") { "%02x".format(it) }
    }
}
