package team.sopa.boar.engine.models

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LoadGuardTest {
    private class Mem : LoadGuard.MarkerStore {
        var v: String? = null
        override fun read() = v
        override fun write(json: String) { v = json }
        override fun clear() { v = null }
    }
    private class L : LoadGuard.Ledger {
        override var crashedIds: List<String> = emptyList()
        override var mappedIds: List<String> = emptyList()
        override var pendingCrash: LoadGuard.Crash? = null
    }

    private val big = LoadGuard.Meta("models/qwen3-4b.gguf", "qwen3-4b", "Qwen3-4B")
    private val small = LoadGuard.Meta("models/qwen2.5-1.5b.gguf", "qwen2.5-1.5b", "Qwen2.5-1.5B")

    /** A process that starts the load and is killed before it returns; then a new process on the same files. */
    private fun killedDuring(store: Mem, ledger: L, meta: LoadGuard.Meta, repacked: Boolean, previous: LoadGuard.Meta? = null): LoadGuard {
        LoadGuard(store, ledger) { 1000 }.begin(meta, previous, repacked)
        return LoadGuard(store, ledger)
    }

    @Test fun `a load that returns leaves no marker and nothing blocked`() {
        val store = Mem(); val ledger = L()
        val g = LoadGuard(store, ledger)
        g.begin(big, null, repacked = true)
        g.end(big, loaded = true)
        assertNull(store.v)
        assertFalse(LoadGuard(store, ledger).isBlocked("qwen3-4b"))
    }

    @Test fun `a killed repacked load keeps the mapped file once, and isn't a crash`() {
        val store = Mem(); val ledger = L()
        val g = killedDuring(store, ledger, big, repacked = true)
        assertTrue(g.mappedNext("qwen3-4b"))
        assertFalse(g.isBlocked("qwen3-4b"))
        assertNull(g.consume())
        // The mapped load works: back to repacked weights next time.
        g.begin(big, null, repacked = false)
        g.end(big, loaded = true)
        assertFalse(g.mappedNext("qwen3-4b"))
    }

    @Test fun `a killed mapped load is a crash, reported once with the fallback`() {
        val store = Mem(); val ledger = L()
        val g1 = killedDuring(store, ledger, big, repacked = true)
        assertTrue(g1.mappedNext("qwen3-4b"))
        g1.begin(big, small, repacked = false)
        val g2 = LoadGuard(store, ledger)
        assertTrue(g2.isBlocked("qwen3-4b"))
        assertFalse(g2.mappedNext("qwen3-4b"))
        val crash = g2.consume()!!
        assertEquals(listOf("qwen3-4b", "Qwen3-4B", "qwen2.5-1.5b", "Qwen2.5-1.5B"), listOf(crash.crashedModelId, crash.crashedLabel, crash.fallbackModelId, crash.fallbackLabel))
        assertNull(g2.consume())
    }

    @Test fun `the user picking the model again, or a load that works, unblocks it`() {
        val store = Mem(); val ledger = L()
        val g = killedDuring(store, ledger, big, repacked = false)
        assertTrue(g.isBlocked("qwen3-4b"))
        g.confirm("qwen3-4b")
        assertFalse(g.isBlocked("qwen3-4b"))
        ledger.crashedIds = listOf("qwen3-4b")
        g.begin(big, null, repacked = true); g.end(big, loaded = true)
        assertFalse(g.isBlocked("qwen3-4b"))
    }

    @Test fun `a failed load (returned, not killed) is neither a crash nor a mapped retry`() {
        val store = Mem(); val ledger = L()
        val g = LoadGuard(store, ledger)
        g.begin(big, null, repacked = true); g.end(big, loaded = false)
        val g2 = LoadGuard(store, ledger)
        assertFalse(g2.isBlocked("qwen3-4b")); assertFalse(g2.mappedNext("qwen3-4b"))
    }

    @Test fun `an unreadable marker is dropped`() {
        val store = Mem().apply { v = "{not json" }; val ledger = L()
        val g = LoadGuard(store, ledger)
        assertFalse(g.isBlocked("qwen3-4b"))
        assertNull(store.v)
    }
}
