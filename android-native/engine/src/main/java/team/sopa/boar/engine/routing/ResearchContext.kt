package team.sopa.boar.engine.routing

import team.sopa.boar.engine.rag.Chunk
import team.sopa.boar.engine.rag.Compress
import java.text.Normalizer

/**
 * What Deep Research needs from src/routing/context.ts: the on-topic test for a source (onTopic and its helpers),
 * context.ts's compressContext and mergeSources. Regex sources are the TypeScript's, translated by [JsRegex].
 */
object ResearchContext {
    /** Below this, a source counts as weak (MIN_TERM_COVERAGE). */
    const val MIN_TERM_COVERAGE = 0.75
    private const val TITLE_MIN_COVERAGE = 0.5
    const val MIN_TERMS_FOR_COVERAGE = 3

    private fun terms(text: String) = Compress.tokenizeTerms(text)

    /** termCoverage: share of the question's distinct content words found in [text]. */
    fun termCoverage(query: String, text: String): Double {
        val q = terms(query).distinct()
        if (q.isEmpty()) return 1.0
        val t = terms(text).toSet()
        return q.count { it in t }.toDouble() / q.size
    }

    /** Same word despite the tiny stemmer ("earthquak"/"earthquake"); a longer suffix is another word. */
    private fun sameTerm(a: String, b: String): Boolean {
        if (a == b) return true
        val (short, long) = if (a.length <= b.length) a to b else b to a
        return short.length >= 5 && long.startsWith(short) && long.length - short.length <= 3
    }

    private val COMPOUNDS = linkedMapOf(
        "snakebite" to listOf("snake", "bite"),
        "nosebleed" to listOf("nose", "bleed"),
        "heatstroke" to listOf("heat", "stroke"),
        "frostbite" to listOf("frost", "bite"),
    )
    private val COMPOUND_PART = COMPOUNDS.values.flatten().distinct().associateWith { JsRegex.re("\\b$it(s|es)?\\b", "i") }

    private fun titleNames(title: String, ts: Iterable<String>): Boolean {
        val t = terms(title)
        for (q in ts) {
            if (t.any { sameTerm(it, q) }) return true
            // Parts on the raw words: the tiny stemmer turns "bites" into "bit".
            val parts = COMPOUNDS[q]
            if (parts != null && parts.all { COMPOUND_PART[it]!!.containsMatchIn(title) }) return true
        }
        return false
    }

    /** A pack chunk's section path ("During your trip > … > Water contamination"), or "". */
    private fun sectionHeading(c: Chunk): String {
        val colon = c.body.indexOf(':')
        return if (colon in 1..120) c.body.substring(0, colon) else ""
    }

    private val YEAR = JsRegex.re("(?<![\\d.,])(1[0-9]{3}|20[0-9]{2})(?![\\d.,]?\\d)", "g")
    private fun yearsIn(text: String) = YEAR.findAll(text).map { it.value }.toList()

    private val WORD = JsRegex.re("[\\p{L}][\\p{L}\\p{N}'’-]*", "gu")
    private val UPPER = JsRegex.re("^\\p{Lu}", "u")
    private fun properNounTerms(query: String): List<String> =
        WORD.findAll(query).map { it.value }.drop(1).filter { UPPER.containsMatchIn(it) && it != "I" }.flatMap { terms(it) }.toList()

    private val COMBINING = Regex("[\\u0300-\\u036f]")
    private val AZ09 = Regex("[a-z0-9]+")
    private val PLACE = setOf("in", "at", "near", "to", "into", "from", "em", "no", "na", "perto")
    private val COMMA_SPLIT = JsRegex.re(",\\s+")

    /** Lead text of a passage past its "Section:" heading (cut at 120 characters, as onTopic does). */
    private fun pastHeading(c: Chunk, limit: Int): String {
        val colon = c.body.indexOf(':')
        return if (colon in 1..limit) c.body.substring(colon + 1) else c.body
    }

    private fun firstSentence(text: String) = Compress.splitSentences(team.sopa.boar.engine.rag.Js.trim(text)).firstOrNull() ?: ""

    /** Two consecutive question terms appear, consecutive, in the title or the first sentence, not as a place. */
    private fun sharesQuestionPair(query: String, c: Chunk): Boolean {
        val qt = terms(query)
        val pairs = qt.drop(1).mapIndexed { i, t -> qt[i] to t }.filter { (a, b) -> a != b }
        if (pairs.isEmpty()) return false
        fun has(raw: String): Boolean {
            val nfkd = COMBINING.replace(Normalizer.normalize(raw.lowercase(), Normalizer.Form.NFKD), "")
            val words = AZ09.findAll(nfkd).map { it.value }.map { it to terms(it).firstOrNull() }.toList()
            return pairs.any { (a, b) ->
                words.indices.any { i ->
                    i + 1 < words.size && words[i].second != null && words[i + 1].second != null &&
                        sameTerm(words[i].second!!, a) && sameTerm(words[i + 1].second!!, b) && !(i > 0 && words[i - 1].first in PLACE)
                }
            }
        }
        return has(COMMA_SPLIT.split(c.title)[0]) || has(firstSentence(pastHeading(c, 120)))
    }

    private fun leadsTitle(title: String, q: Set<String>): Boolean {
        val first = terms(title).firstOrNull() ?: return false
        return q.any { sameTerm(first, it) }
    }

    private val SOURCE_LABEL = JsRegex.re("^(Wikipedia|Wikibooks|Wikivoyage|US government|Appropedia|ethereum\\.org|Ethereum EIPs\\/ERCs|Ethereum specs|Bitcoin BIPs):\\s*")
    private val TITLE_SEP = JsRegex.re(":\\s+")
    private val TRAILING_PAREN = JsRegex.re("\\s*\\([^)]*\\)\\s*$")
    private fun mainTitle(title: String) = TITLE_SEP.split(title.replaceFirst(SOURCE_LABEL, ""))[0]

    private fun titleSegmentNamed(title: String, q: Set<String>): Boolean = TITLE_SEP.split(title).any { seg ->
        val st = terms(seg.replaceFirst(TRAILING_PAREN, ""))
        st.isNotEmpty() && st.all { it in q }
    }

    private val ACRONYM = JsRegex.re("\\(([A-Z][A-Z0-9-]{1,9})\\)\\s*$")

    /** onTopic: whether a source is about the question (see context.ts for the cases each rule comes from). */
    fun onTopic(query: String, c: Chunk): Boolean {
        val q = terms(query).toSet()
        val text = "${c.title} ${c.body}"
        // A year or a proper noun in the question must be in the source.
        val years = yearsIn(text)
        if (!yearsIn(query).all { it in years }) return false
        val proper = properNounTerms(query)
        if (proper.isNotEmpty()) {
            val words = terms(text).toSet()
            if (proper.none { it in words }) return false
        }
        if (titleSegmentNamed(c.title, q)) return true
        if (sharesQuestionPair(query, c)) return true
        val acronym = ACRONYM.find(c.title)?.groupValues?.get(1)
        if (acronym != null && (terms(acronym).firstOrNull() ?: "") in q) return true
        if (leadsTitle(mainTitle(c.title), q)) return true
        if (titleNames(c.title, q) || titleNames(sectionHeading(c), q)) {
            return termCoverage(query, text) >= if (q.size < MIN_TERMS_FOR_COVERAGE) 1.0 else TITLE_MIN_COVERAGE
        }
        // One or two content words: the passage must open with them.
        if (q.size < MIN_TERMS_FOR_COVERAGE) {
            val first = terms(firstSentence(pastHeading(c, 80))).toSet()
            return q.isNotEmpty() && q.all { it in first }
        }
        return termCoverage(query, text) >= MIN_TERM_COVERAGE
    }

    /** context.ts compressContext: the older opening check, and the shown relevance. */
    fun compressContext(query: String, chunks: List<Chunk>, tokenBudget: Int = 1200, maxSentencesPerChunk: Int = 4, pinned: Set<String> = emptySet()) =
        Compress.compress(query, chunks, tokenBudget, maxSentencesPerChunk, pinned, openingMustFitWithMatch = false, withRelevance = true)

    data class Merged(val sources: List<Chunk>, val indexMaps: List<List<Int>>)

    /** mergeSources: one global numbered list; the same chunk from two lists gets one number. */
    fun mergeSources(lists: List<List<Chunk>>): Merged {
        val sources = ArrayList<Chunk>()
        val byId = HashMap<String, Int>()
        val maps = lists.map { list -> list.map { c -> byId.getOrPut(c.chunkId) { sources.add(c); sources.size - 1 } } }
        return Merged(sources, maps)
    }
}
