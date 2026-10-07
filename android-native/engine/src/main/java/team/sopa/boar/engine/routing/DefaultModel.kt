package team.sopa.boar.engine.routing

/** Memory fit of a model on this device (src/inference/memoryFit.ts FitVerdict); [value] is the TypeScript string. */
enum class FitVerdict(val value: String) {
    /** Whole file + buffers fit in available RAM. */
    RESIDENT("resident"),

    /** File larger than available RAM, but the per-token hot set fits: MoE streams experts from storage. */
    STREAMING("streaming"),

    /** Buffers fit but the per-token hot set does not: every token re-reads weights from storage. Very slow. */
    THRASHING("thrashing"),

    /** KV + compute buffers alone exceed available RAM: loading would OOM. */
    INSUFFICIENT("insufficient"),
    ;

    companion object {
        fun of(value: String): FitVerdict = entries.first { it.value == value }
    }
}

/**
 * Which answer model a device gets when the user has not picked one (port of src/routing/defaultModel.ts). The
 * "default" tier (Qwen3-4B, dense: every token reads all 2.5 GB) only when it can stay resident: more than 4.5 GB of
 * RAM, fit "resident" or "streaming", not measured under 6 tok/s; otherwise the "compact" tier. Other installed models
 * only win when neither tier can: the largest measured at 6 tok/s or more. Pure.
 */
object DefaultModel {
    const val COMPACT_ONLY_MAX_RAM_BYTES: Long = 4_831_838_208 // 4.5 GiB

    /**
     * At <= COMPACT_ONLY_MAX_RAM_BYTES nothing bigger than the compact model is used unless the user confirmed it (the
     * 4B on 3.8 GB was OOM-killed). The compact 1.5B is ~1.0 GB; this leaves margin for its peers.
     */
    const val LOW_RAM_MAX_MODEL_BYTES: Double = 1.6e9

    /**
     * Lower cap for the automatic pick only: on a 4 GB iPhone 13 ~1.5 GB models load but decode at ~0.35 tok/s, so
     * the app never picks them by itself (a user's choice keeps LOW_RAM_MAX_MODEL_BYTES).
     */
    const val AUTO_PICK_MAX_MODEL_BYTES: Double = 1.1e9

    /** Measured median decode speed under which a model is too slow to be the automatic default. */
    const val DEFAULT_MIN_TOK_PER_SEC: Double = 6.0

    /** Catalog tier: "default" or "compact"; null for any other model. */
    enum class Tier(val value: String) { DEFAULT("default"), COMPACT("compact") }

    /** Answer-tier and size only (tooBigForLowRam / tooBigForAutoPick / isCompactModel inputs). */
    interface Sized {
        val answerTier: Tier?
        val sizeBytes: Long?
    }

    class Candidate(
        val id: String,
        override val answerTier: Tier? = null,
        /** Memory fit on this device; null = unknown. */
        val fit: FitVerdict? = null,
        /** File size; null = unknown. */
        override val sizeBytes: Long? = null,
        /** Median measured tok/s on this device, only with enough samples; null = not measured. */
        val tokPerSec: Double? = null,
    ) : Sized

    /** Why the picked model was picked: "default-tier", "compact-low-ram", "compact-does-not-fit", "compact-default-too-slow", "largest-fast", "smallest-fallback". */
    data class Choice(val id: String, val reason: String)

    /** [reason]: a pick reason, or why it was not picked: "low-ram", "wont-fit", "too-slow", "unmeasured", "outranked". */
    data class Ranked(val id: String, val picked: Boolean, val reason: String)

    /** [ranked]: every candidate once, the pick first, then the rest in order of preference. */
    data class Ranking(val pick: Choice?, val ranked: List<Ranked>)

    private fun lowRam(totalRamBytes: Long) = totalRamBytes > 0 && totalRamBytes <= COMPACT_ONLY_MAX_RAM_BYTES

    private fun aboveLowRamCap(m: Sized, totalRamBytes: Long, cap: Double): Boolean {
        if (!lowRam(totalRamBytes) || m.answerTier == Tier.COMPACT) return false
        return m.answerTier == Tier.DEFAULT || (m.sizeBytes?.toDouble() ?: Double.POSITIVE_INFINITY) > cap
    }

    /** True when a model may not be used on this device, even as the saved pick, until the user confirms it. */
    fun tooBigForLowRam(m: Sized, totalRamBytes: Long): Boolean = aboveLowRamCap(m, totalRamBytes, LOW_RAM_MAX_MODEL_BYTES)

    /** True when the app may not pick a model by itself on this device (the user can still choose it). */
    fun tooBigForAutoPick(m: Sized, totalRamBytes: Long): Boolean = aboveLowRamCap(m, totalRamBytes, AUTO_PICK_MAX_MODEL_BYTES)

    /** The compact tier, or an untiered model no bigger than it: too small to answer from memory unasked. */
    fun isCompactModel(m: Sized): Boolean {
        m.answerTier?.let { return it == Tier.COMPACT }
        return (m.sizeBytes?.toDouble() ?: Double.POSITIVE_INFINITY) <= LOW_RAM_MAX_MODEL_BYTES
    }

    private fun fits(c: Candidate) = c.fit != FitVerdict.THRASHING && c.fit != FitVerdict.INSUFFICIENT
    private fun tooSlow(c: Candidate) = c.tokPerSec != null && c.tokPerSec < DEFAULT_MIN_TOK_PER_SEC
    private fun size(c: Candidate) = c.sizeBytes?.toDouble() ?: Double.POSITIVE_INFINITY

    /** A JavaScript sort comparator's number as an Int: NaN (Infinity - Infinity) means equal. */
    private fun sign(d: Double): Int = if (d > 0) 1 else if (d < 0) -1 else 0
    private val LARGEST_FIRST = Comparator<Candidate> { a, b -> sign(size(b) - size(a)) }

    /**
     * The automatic answer model among the installed ones, and why each other one was not chosen. In order: the
     * default tier when the phone has more than 4.5 GB, it fits and isn't measured under 6 tok/s; else the compact tier
     * when it fits and isn't too slow; else the largest model that fits and was measured at 6 tok/s or more; else the
     * smallest, fitting ones first. An unmeasured speed never disqualifies a tier model.
     */
    fun rankAnswerModels(candidates: List<Candidate>, totalRamBytes: Long): Ranking {
        if (candidates.isEmpty()) return Ranking(null, emptyList())
        val lowRam = lowRam(totalRamBytes)
        val def = candidates.firstOrNull { it.answerTier == Tier.DEFAULT }
        val compact = candidates.firstOrNull { it.answerTier == Tier.COMPACT }
        val others = candidates.filter { it.answerTier == null }

        fun notPicked(c: Candidate): String = when {
            tooBigForAutoPick(c, totalRamBytes) -> "low-ram"
            !fits(c) -> "wont-fit"
            tooSlow(c) -> "too-slow"
            c.answerTier == null && c.tokPerSec == null -> "unmeasured"
            else -> "outranked"
        }

        val pick: Choice? = if (def != null && !lowRam && fits(def) && !tooSlow(def)) {
            Choice(def.id, "default-tier")
        } else if (compact != null && fits(compact) && !tooSlow(compact)) {
            val reason = if (def == null || lowRam) "compact-low-ram" else if (tooSlow(def) && fits(def)) "compact-default-too-slow" else "compact-does-not-fit"
            Choice(compact.id, reason)
        } else {
            val allowed = { c: Candidate -> !tooBigForAutoPick(c, totalRamBytes) }
            val fast = others.filter { allowed(it) && fits(it) && it.tokPerSec != null && !tooSlow(it) }.sortedWith(LARGEST_FIRST).firstOrNull()
            if (fast != null) {
                Choice(fast.id, "largest-fast")
            } else {
                // On a low-RAM phone, nothing above the compact size: no pick rather than an OOM kill.
                val smallest = candidates.filter(allowed).sortedWith { a, b ->
                    val f = (if (fits(b)) 1 else 0) - (if (fits(a)) 1 else 0)
                    if (f != 0) f else sign(size(a) - size(b))
                }.firstOrNull()
                smallest?.let { Choice(it.id, "smallest-fallback") }
            }
        }

        // Preference order for the rest: default, compact, then the others largest first (by identity, as includes()).
        val order = ArrayList<Candidate>(listOfNotNull(def, compact) + others.sortedWith(LARGEST_FIRST))
        for (c in candidates) if (order.none { it === c }) order += c
        val ranked = ArrayList<Ranked>()
        if (pick != null) ranked += Ranked(pick.id, true, pick.reason)
        for (c in order) if (c.id != pick?.id) ranked += Ranked(c.id, false, notPicked(c))
        return Ranking(pick, ranked)
    }

    /** The automatic answer model (see rankAnswerModels); null when nothing is installed. */
    fun pickDefaultAnswerModel(candidates: List<Candidate>, totalRamBytes: Long): Choice? = rankAnswerModels(candidates, totalRamBytes).pick
}
