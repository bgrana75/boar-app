package team.sopa.boar.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EngineTweaksTest {
    /** Dimensity 8300 (X6 Pro): 1 prime + 3 big + 4 little. */
    private val x6 = CpuTopology(List(4) { CpuTopology.Core(it, 2_200_000) } + listOf(CpuTopology.Core(4, 3_350_000)) + List(3) { CpuTopology.Core(5 + it, 3_200_000) })
    private val x6Features = CpuVariants.readFeatures(
        "processor\t: 0\nFeatures\t: fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp cpuid asimdrdm jscvt fcma lrcpc dcpop sha3 sm3 sm4 asimddp sha512 sve asimdfhm dit uscat ilrcpc flagm sb paca pacg dcpodp sve2 sveaes svepmull svebitperm svesha3 svesm4 flagm2 frint svei8mm svebf16 i8mm bf16 bti mte mte3\n",
    )
    /** Snapdragon 870 (POCO F3): dotprod and fp16, no i8mm. */
    private val f3Features = setOf("fp", "asimd", "asimdhp", "asimddp", "fphp")

    @Test fun `all Auto gives the measured defaults`() {
        val r = EngineTweaks().resolve(x6)
        assertEquals(4, r.params.threads)
        assertEquals("4,5,6,7", r.params.cpus)
        assertEquals(4096, r.params.nCtx)
        assertEquals(KvType.F16, r.params.typeK)
        assertTrue(r.notes.isEmpty())
        assertTrue(EngineTweaks().isAuto)
    }

    @Test fun `every knob can be set, and impossible values are clamped with a note`() {
        val r = EngineTweaks(threads = 64, cores = "all", contextTokens = 100, batch = 256, microBatch = 1024, kvCache = KvType.Q8_0, flashAttention = FlashAttn.ON).resolve(x6)
        assertEquals(8, r.params.threads)
        assertEquals("", r.params.cpus)
        assertEquals(256, r.params.nCtx)
        assertEquals(256, r.params.nUbatch)
        assertEquals(KvType.Q8_0, r.params.typeV)
        assertEquals(3, r.notes.size)
        assertEquals("1,3", EngineTweaks(cores = "3, 1, 99").resolve(x6).params.cpus)
        assertEquals("4,5,6,7", EngineTweaks(cores = "none").resolve(x6).params.cpus)
    }

    @Test fun `saved tweaks round-trip, and a broken file means all Auto`() {
        val t = EngineTweaks(cpuBuild = "android_armv9.0_1", threads = 6, kvCache = KvType.Q4_0)
        assertEquals(t, EngineTweaks.fromJson(t.toJson()))
        assertEquals("{}", EngineTweaks().toJson())
        assertEquals(EngineTweaks(), EngineTweaks.fromJson("{not json"))
        assertEquals(EngineTweaks(), EngineTweaks.fromJson(null))
    }

    @Test fun `CPU build - Auto picks armv8_6 on the X6 and leaves the F3 to ggml`() {
        assertEquals("android_armv8.6_1", CpuVariants.auto(x6Features))
        assertEquals(listOf("android_armv8.0_1", "android_armv8.2_1", "android_armv8.2_2", "android_armv8.6_1", "android_armv9.0_1"), CpuVariants.supported(x6Features).map { it.name })
        assertNull(CpuVariants.auto(f3Features))
        assertEquals(listOf("android_armv8.0_1", "android_armv8.2_1", "android_armv8.2_2"), CpuVariants.supported(f3Features).map { it.name })
        assertNull(CpuVariants.auto(x6Features + "sme"))
    }

    @Test fun `CPU build - a setting the phone can't run falls back to Auto`() {
        assertEquals("android_armv9.0_1", CpuVariants.resolve("android_armv9.0_1", x6Features))
        assertNull(CpuVariants.resolve("best", x6Features))
        assertNull(CpuVariants.resolve("android_armv8.6_1", f3Features))
        assertEquals("android_armv8.6_1", CpuVariants.resolve("android_armv9.2_2", x6Features))
    }

    @Test fun `generation time limit - Auto grows with the token cap, the user can fix it or turn it off`() {
        assertEquals(120_000L + 512 * 500L, EngineTweaks().stageTimeoutMs(512))
        assertEquals(120_000L + 2048 * 500L, EngineTweaks().stageTimeoutMs(2048))
        assertEquals(300_000L, EngineTweaks(stageTimeoutSeconds = 300).stageTimeoutMs(2048))
        assertNull(EngineTweaks(stageTimeoutSeconds = 0).stageTimeoutMs(2048))
        assertEquals(EngineTweaks(stageTimeoutSeconds = 0), EngineTweaks.fromJson(EngineTweaks(stageTimeoutSeconds = 0).toJson()))
    }
}
