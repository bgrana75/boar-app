package team.sopa.boar.engine

import java.io.File

/** The phone's cores grouped by top frequency, read from sysfs (no permissions needed). */
data class CpuTopology(val cores: List<Core>) {
    data class Core(val id: Int, val maxKhz: Long)

    /** Cores in the fastest frequency group, e.g. the 1-4 "big" cores of a big.LITTLE SoC. */
    val bigCores: List<Int> get() {
        val top = cores.maxOfOrNull { it.maxKhz } ?: return emptyList()
        val sorted = cores.map { it.maxKhz }.distinct().sortedDescending()
        // Take the fastest group, plus the second one when the fastest has fewer than 2 cores (prime + big).
        val keep = if (cores.count { it.maxKhz == top } < 2 && sorted.size > 1) sorted.take(2).toSet() else setOf(top)
        return cores.filter { it.maxKhz in keep }.map { it.id }
    }

    /** "4-7" style list for [EngineParams.cpus]. */
    fun cpuList(ids: List<Int>): String = ids.sorted().joinToString(",")

    companion object {
        fun read(): CpuTopology {
            val dirs = File("/sys/devices/system/cpu").listFiles { f -> f.name.matches(Regex("cpu\\d+")) }.orEmpty()
            val cores = dirs.mapNotNull { d ->
                val id = d.name.removePrefix("cpu").toIntOrNull() ?: return@mapNotNull null
                val khz = runCatching { File(d, "cpufreq/cpuinfo_max_freq").readText().trim().toLong() }.getOrDefault(0L)
                Core(id, khz)
            }.sortedBy { it.id }
            return CpuTopology(cores)
        }
    }
}
