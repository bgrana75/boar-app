package team.sopa.boar.engine.models

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import team.sopa.boar.engine.models.StorageBudget.Check
import java.util.Locale

/** Port of src/models/storageBudget.test.ts and the formatBytes cases of units.test.ts. */
class StorageBudgetTest {
    private val gb = 1_000_000_000L
    private val base = StorageBudget.Input(4 * gb, 0, 5 * gb, 0, 300 * gb, 50 * gb)

    @Test fun `allows a download that fits the budget and the disk`() =
        assertEquals(Check.Ok(StorageBudget.APP_RESERVE_BYTES + 9 * gb), StorageBudget.check(base))

    @Test fun `refuses a download that would pass the 50GB budget`() {
        val r = StorageBudget.check(base.copy(usedBytes = 40 * gb, downloadBytes = 10 * gb))
        assertTrue(r is Check.Refused && r.reason == StorageBudget.Reason.BUDGET)
        assertTrue((r as Check.Refused).message, Regex("50 GB storage budget.*10 GB download.*51 GB").containsMatchIn(r.message))
    }

    @Test fun `counts the full size of other downloads still running`() {
        assertTrue(StorageBudget.check(base.copy(usedBytes = 30 * gb, reservedBytes = 12 * gb, downloadBytes = 8 * gb)) is Check.Refused)
        assertTrue(StorageBudget.check(base.copy(usedBytes = 30 * gb, reservedBytes = 12 * gb, downloadBytes = 7 * gb)) is Check.Ok)
    }

    @Test fun `refuses when the phone lacks free space, keeping a margin`() {
        val r = StorageBudget.check(base.copy(freeDiskBytes = 5 * gb))
        assertTrue(r is Check.Refused && r.reason == StorageBudget.Reason.DISK)
        assertTrue(StorageBudget.check(base.copy(freeDiskBytes = 5 * gb + StorageBudget.FREE_SPACE_MARGIN_BYTES)) is Check.Ok)
    }

    @Test fun `only needs free space for the part a paused download hasn't fetched yet`() =
        assertTrue(StorageBudget.check(base.copy(freeDiskBytes = 2 * gb, alreadyDownloadedBytes = 4 * gb)) is Check.Ok)

    @Test fun `skips the disk check when free space is unknown`() =
        assertTrue(StorageBudget.check(base.copy(freeDiskBytes = null)) is Check.Ok)

    @Test fun `formats sizes like Android`() {
        assertEquals("18.6 MB", Units.formatBytes(18_600_000))
        assertEquals("986 MB", Units.formatBytes(986_048_768))
        assertEquals("2.5 GB", Units.formatBytes(2_497_281_120))
        assertEquals("1 kB", Units.formatBytes(12))
        assertEquals("0 kB", Units.formatBytes(0))
        assertEquals("1 GB", Units.formatBytes(999_600_000))
        assertEquals("18,6 MB", Units.formatBytes(18_600_000, Locale.forLanguageTag("pt-BR")))
        // the units.test.ts cases
        assertEquals("36 MB", Units.formatBytes(35_962_880))
        assertEquals("24 GB", Units.formatBytes(24 * gb))
        assertEquals("99.9 MB", Units.formatBytes(99_940_000))
        assertEquals("100 MB", Units.formatBytes(99_960_000))
        assertEquals("128 GB", Units.formatBytes(128 * gb))
        assertEquals("999 kB", Units.formatBytes(999_400))
        assertEquals("1 MB", Units.formatBytes(999_600))
        assertEquals("999 MB", Units.formatBytes(999_400_000))
        assertEquals("1 GB", Units.formatBytes(999_999_999))
        assertEquals("2 kB", Units.formatBytes(1_500))
    }
}
