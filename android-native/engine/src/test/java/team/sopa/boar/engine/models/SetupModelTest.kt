package team.sopa.boar.engine.models

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Port of src/ui-android/setupModel.test.ts. */
class SetupModelTest {
    private val gb = 1024.0 * 1024 * 1024
    private fun asset(id: String, tier: AnswerTier) = CatalogAsset(id, AssetKind.LLM, id, null, "models/$id.gguf", 1, "", "", "", "", false, tier)
    private val big = asset("qwen3-4b", AnswerTier.DEFAULT)
    private val small = asset("qwen2.5-1.5b", AnswerTier.COMPACT)
    private val models = listOf(big, small)
    private fun ram(g: Double) = (g * gb).toLong()

    @Test fun `recommends the 4B on a 12 GB phone (reads 10_7 GB)`() = assertEquals(big, SetupModel.recommended(models, ram(10.7)))

    @Test fun `recommends the 1_5B on an 8 GB phone and smaller`() {
        assertEquals(small, SetupModel.recommended(models, ram(7.3)))
        assertEquals(small, SetupModel.recommended(models, ram(3.8)))
    }

    @Test fun `recommends the 1_5B when the RAM couldn't be read`() = assertEquals(small, SetupModel.recommended(models, 0))

    @Test fun `flags the 4B under 12 GB, never the 1_5B`() {
        assertTrue(SetupModel.heavyForPhone(big, ram(7.3)))
        assertFalse(SetupModel.heavyForPhone(big, ram(10.7)))
        assertFalse(SetupModel.heavyForPhone(small, ram(3.8)))
    }

    @Test fun `doesn't warn when the RAM couldn't be read`() = assertFalse(SetupModel.heavyForPhone(big, 0))

    @Test fun `takes the user's pick over everything`() =
        assertEquals(big, SetupModel.toInstall(models, setOf(small.id), ram(10.7), big.id))

    @Test fun `keeps a model already on the phone instead of downloading another`() =
        assertEquals(small, SetupModel.toInstall(models, setOf(small.id), ram(10.7)))

    @Test fun `falls back to the recommended one`() {
        assertEquals(big, SetupModel.toInstall(models, emptySet(), ram(10.7)))
        assertEquals(small, SetupModel.toInstall(models, emptySet(), ram(7.3)))
    }
}
