package team.sopa.boar.engine.routing

import team.sopa.boar.engine.rag.Js
import java.time.Instant
import java.time.ZoneId

/**
 * Small talk answered without the model (port of src/routing/smallTalk.ts): a greeting, thanks, "who are you", the
 * time. These never get better from the library, and on a phone a cold model load plus generation is seconds for
 * "hi". Deterministic: same message, same reply. Anything else (a joke, a real question after "hi,") returns null.
 */
object SmallTalk {
    data class Reply(val text: String, val kind: String) // kind: "greeting" | "about" | "time" | "date"

    private val PUNCT = Regex("[!.?~,;]+")
    private val SPACES = Regex("${Js.WS}+")

    private fun norm(s: String): String =
        Js.trim(SPACES.replace(PUNCT.replace(Js.COMBINING.replace(Js.nfd(Js.trim(s).lowercase()), ""), " "), " "))

    private enum class Kind { HELLO, MORNING, AFTERNOON, EVENING, NIGHT, HOWAREYOU, THANKS, BYE, OK }

    private val PHRASES: List<Pair<Kind, Regex>> = listOf(
        Kind.MORNING to """^(good morning|morning|bom dia)$""",
        Kind.AFTERNOON to """^(good afternoon|boa tarde)$""",
        Kind.EVENING to """^(good evening|boa noite)$""",
        Kind.NIGHT to """^(good night|night)$""",
        Kind.HOWAREYOU to """^(how are you|how(?:'s| is) it going|how are things|what'?s up|sup|tudo (bem|bom|certo|joia)|como vai|como (voce )?esta|e ai|eai|beleza|blz)$""",
        Kind.THANKS to """^(thanks?( you)?( so much| a lot)?|thx|ty|obrigad[oa]( mesmo)?|valeu|vlw|brigad[oa])$""",
        Kind.BYE to """^(bye|goodbye|see ya|see you|tchau|ate mais|ate logo|falou)$""",
        Kind.OK to """^(ok(ay)?|cool|nice|great|perfect|got it|beleza|show|massa|legal|blz|certo|entendi)$""",
        Kind.HELLO to """^(hi|hello|hey|hey there|yo|hiya|oi|ola|ola tudo bem|opa|e ai boar|oi boar|hi boar|hello boar|hey boar)$""",
    ).map { (k, s) -> k to JsRegex.re(s) }

    private val SEGMENT_SPLIT = JsRegex.re("""[,;]|\band\b""", "i")

    /** The kinds of every segment, or null when one segment isn't small talk ("hi, what is a monsoon"). */
    private fun kinds(message: String): List<Kind>? {
        // Split before norm(), which turns the commas into spaces.
        val segments = SEGMENT_SPLIT.split(message).map(::norm).filter { it.isNotEmpty() }
        if (segments.isEmpty()) return null
        return segments.map { seg -> PHRASES.firstOrNull { it.second.containsMatchIn(seg) }?.first ?: return null }
    }

    private val ABOUT_RE = JsRegex.re(
        """^(what'?s? (is )?your name|who are you|what are you|what can you do|how can you help( me)?|how do you work|are you (an? )?(ai|bot|robot|human|real|person|online|offline)|qual (e )?(o )?seu nome|quem e voce|quem (e )?vc|o que (e )?voce|o que voce (faz|pode fazer)|como voce funciona|voce e (uma? )?(ia|robo|humano|pessoa))( please| por favor)?$""",
    )
    private val TIME_RE = JsRegex.re("""^(what time is it|what'?s? (is )?the time|que horas sao|que hora e)( now| agora)?$""")
    private val DATE_RE = JsRegex.re("""^(what day is (it( today)?|today)|what'?s? (is )?today'?s date|what is the date( today)?|que dia e hoje|qual (e )?a data( de)? hoje)$""")

    private val PT_WORDS = JsRegex.re(
        """\b(oi|ola|opa|bom|boa|tudo|como|obrigad[oa]|brigad[oa]|valeu|vlw|tchau|ate|falou|beleza|blz|show|massa|legal|certo|entendi|eai|qual|quem|voce|vc|que|hoje|horas|seu)\b""",
    )

    private val REPLY: Map<Kind, Pair<String, String>> = mapOf( // en to pt
        Kind.HELLO to ("Hi! What would you like to know?" to "Oi! O que você quer saber?"),
        Kind.MORNING to ("Good morning! What would you like to know?" to "Bom dia! O que você quer saber?"),
        Kind.AFTERNOON to ("Good afternoon! What would you like to know?" to "Boa tarde! O que você quer saber?"),
        Kind.EVENING to ("Good evening! What would you like to know?" to "Boa noite! O que você quer saber?"),
        Kind.NIGHT to ("Good night!" to "Boa noite!"),
        Kind.HOWAREYOU to ("All good, and ready offline. What would you like to know?" to "Tudo certo, e pronto offline. O que você quer saber?"),
        Kind.THANKS to ("You're welcome!" to "De nada!"),
        Kind.BYE to ("Bye! I'll be here, offline." to "Tchau! Estou aqui, offline."),
        Kind.OK to ("Great. Ask me anything else." to "Beleza. Pode perguntar mais."),
    )

    private const val ABOUT_EN =
        "I'm BOAR, a research assistant that runs entirely on this phone. I answer from the library on it (Wikipedia and the packs you installed) and show the sources behind each answer. Nothing you ask leaves the phone."
    private const val ABOUT_PT =
        "Sou o BOAR, um assistente de pesquisa que roda inteiro neste celular. Respondo a partir da biblioteca dele (a Wikipédia e os pacotes que você instalou) e mostro as fontes de cada resposta. Nada do que você pergunta sai do celular."

    // The reply of the most meaningful part: "hi, how are you?" answers how-are-you, "ok thanks" answers thanks.
    private val ORDER = listOf(Kind.HOWAREYOU, Kind.THANKS, Kind.BYE, Kind.NIGHT, Kind.MORNING, Kind.AFTERNOON, Kind.EVENING, Kind.HELLO, Kind.OK)

    private val WEEKDAYS_EN = listOf("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
    private val WEEKDAYS_PT = listOf("segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado", "domingo")
    private val MONTHS_EN = listOf("January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December")
    private val MONTHS_PT = listOf("janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro")

    /**
     * A reply for pure small talk, or null when the message needs the normal answer path. [now] in [zone] is the
     * phone's clock (JS formats a Date in the local zone), printed as Intl's en-US / pt-BR formats do.
     */
    fun smallTalkReply(message: String, pt: Boolean, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): Reply? {
        val n = norm(message)
        if (n.isEmpty() || n.length > 80) return null
        // "oi" or "valeu" is too short for a language detector: the phrase itself says Portuguese.
        val isPt = pt || PT_WORDS.containsMatchIn(n)
        if (ABOUT_RE.containsMatchIn(n)) return Reply(if (isPt) ABOUT_PT else ABOUT_EN, "about")
        val t = now.atZone(zone)
        if (TIME_RE.containsMatchIn(n)) {
            val mm = t.minute.toString().padStart(2, '0')
            return if (isPt) {
                Reply("São ${t.hour.toString().padStart(2, '0')}:$mm, pelo relógio deste celular.", "time")
            } else {
                val h12 = if (t.hour % 12 == 0) 12 else t.hour % 12
                Reply("It's ${h12.toString().padStart(2, '0')}:$mm ${if (t.hour < 12) "AM" else "PM"} by this phone's clock.", "time")
            }
        }
        if (DATE_RE.containsMatchIn(n)) {
            val wd = t.dayOfWeek.value - 1
            val mo = t.monthValue - 1
            return if (isPt) {
                Reply("Hoje é ${WEEKDAYS_PT[wd]}, ${t.dayOfMonth} de ${MONTHS_PT[mo]} de ${t.year}, pelo relógio deste celular.", "date")
            } else {
                Reply("Today is ${WEEKDAYS_EN[wd]}, ${MONTHS_EN[mo]} ${t.dayOfMonth}, ${t.year}, by this phone's clock.", "date")
            }
        }
        val k = kinds(message) ?: return null
        val pick = ORDER.first { it in k }
        val r = REPLY.getValue(pick)
        return Reply(if (isPt) r.second else r.first, "greeting")
    }
}
