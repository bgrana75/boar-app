package team.sopa.boar.engine.models

/**
 * Whether a download fits: within BOAR's 50 GB budget for the app and its offline assets, and within the
 * phone's free space (port of src/models/storageBudget.ts).
 */
object StorageBudget {
    /** Room kept for the app itself (APK, runtime files), which isn't measured on disk here. */
    const val APP_RESERVE_BYTES: Long = 1_000_000_000L
    /** Free space to leave on the phone after a download. */
    const val FREE_SPACE_MARGIN_BYTES: Long = 500_000_000L

    data class Input(
        val usedBytes: Long,
        val reservedBytes: Long,
        val downloadBytes: Long,
        val alreadyDownloadedBytes: Long,
        /** Null when unknown. */
        val freeDiskBytes: Long?,
        val budgetBytes: Long,
    )

    sealed interface Check {
        val projectedBytes: Long
        data class Ok(override val projectedBytes: Long) : Check
        data class Refused(val reason: Reason, override val projectedBytes: Long, val message: String) : Check
    }

    enum class Reason { BUDGET, DISK }

    fun check(input: Input): Check {
        val projected = APP_RESERVE_BYTES + input.usedBytes + input.reservedBytes + input.downloadBytes
        if (projected > input.budgetBytes) {
            return Check.Refused(
                Reason.BUDGET, projected,
                "Not enough room in BOAR's ${Units.formatBytes(input.budgetBytes)} storage budget: this ${Units.formatBytes(input.downloadBytes)} download " +
                    "would bring the total to about ${Units.formatBytes(projected)}. Remove a model first.",
            )
        }
        val stillNeeded = maxOf(input.downloadBytes - input.alreadyDownloadedBytes, 0L)
        val free = input.freeDiskBytes
        if (free != null && stillNeeded + FREE_SPACE_MARGIN_BYTES > free) {
            return Check.Refused(
                Reason.DISK, projected,
                "Not enough free space on this phone: the download needs ${Units.formatBytes(stillNeeded)} and only " +
                    "${Units.formatBytes(free)} is free. Free up space or remove a model first.",
            )
        }
        return Check.Ok(projected)
    }
}
