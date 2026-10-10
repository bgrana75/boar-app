package team.sopa.boar.engine.routing

/**
 * English search words for a question (port of src/routing/ptQuery.ts). A Portuguese question gets English words so
 * it can find the knowledge packs, which are in English ("Como faço para parar um sangramento no nariz?" retrieved
 * nothing from the Preparedness pack). A fixed dictionary of health, first-aid and emergency terms: no model call, so
 * it is instant and can't invent a query. Null when no term is known (the question is searched as written).
 */
object PtQuery {
    // Longest phrases first: "sangramento no nariz" before "sangramento".
    private val PT_EN: List<Pair<Regex, String>> = listOf(
        """sangramento (no|do|pelo) nariz|sangramento nasal|sangue (no|do|pelo) nariz|nariz[^.?!]{0,20}sangr\w*|sangr\w*[^.?!]{0,20}nariz|epistaxe""" to "nosebleed nose bleed",
        """primeiros socorros""" to "first aid",
        """picada de (cobra|serpente)|mordida de (cobra|serpente)|picad[ao] por (uma )?(cobra|serpente)|mordid[ao] por (uma )?(cobra|serpente)|(cobra|serpente)[^.]{0,30}(picou|mordeu)|(picou|mordeu)[^.]{0,30}(cobra|serpente)""" to "snakebite snake bite",
        """picada de (abelha|vespa)|ferroada""" to "bee sting",
        """picada de escorpi[ãa]o""" to "scorpion sting",
        """parada card[íi]aca""" to "cardiac arrest",
        """ataque card[íi]aco|infarto""" to "heart attack",
        """\bavc\b|derrame""" to "stroke",
        """\brcp\b|reanima[çc][ãa]o( cardiopulmonar)?|massagem card[íi]aca""" to "cpr",
        // A scald is a burn: "derramou água fervente no braço" must find Burn, not the physics of boiling.
        """(derram|caiu|queim|escald|jog)\w*[^.]{0,40}(água|[áa]gua|[óo]leo|caf[ée]|ch[áa]|sopa|leite) (fervente|fervendo|quente|escaldante)|(água|[áa]gua|[óo]leo) (fervente|fervendo|quente|escaldante)[^.]{0,40}(derram|caiu|queim|escald)\w*|escaldadura|escaldou|se queimou|queimou (o|a|a m[ãa]o|o bra[çc]o)""" to "burn scald",
        """[áa]gua (fervente|fervendo)|[áa]gua quente""" to "boiling water",
        // Shivering, confused, slurred speech in the cold: hypothermia.
        """(tremend\w*|tremores?|calafrios?)[^.]{0,80}\bfrio\b|\bfrio\b[^.]{0,80}(tremend\w*|tremores?|calafrios?)""" to "hypothermia",
        """[áa]gua pot[áa]vel|[áa]gua (segura|limpa) para beber|tornar a [áa]gua (segura|pot[áa]vel)""" to "safe drinking water",
        """[áa]gua contaminada""" to "contaminated water",
        """insola[çc][ãa]o|golpe de calor""" to "heatstroke heat stroke",
        """rea[çc][ãa]o al[ée]rgica|choque anafil[áa]tico|anafilaxia""" to "anaphylaxis allergic reaction",
        """sangramento|hemorragia|sangrando""" to "bleeding",
        """queimadura|queimou|queimad[oa]""" to "burn",
        """cobra|serpente""" to "snake",
        """engasg\w*|asfixia""" to "choking",
        """afogamento|afogad[oa]""" to "drowning",
        """hipotermia""" to "hypothermia",
        """desidrata[çc][ãa]o""" to "dehydration",
        """desmai\w*""" to "fainting",
        """convuls[ãa]o|convuls\w*""" to "seizure",
        """fratura|osso quebrado|quebrou o (bra[çc]o|perna|osso)""" to "fracture broken bone",
        """tor[çc][ãa]o|entorse""" to "sprain",
        """envenenamento|envenenad[oa]|veneno""" to "poisoning",
        """ferida|ferimento|machucad[oa]|corte profundo""" to "wound",
        """febre""" to "fever",
        """alergia""" to "allergy",
        // Before "terremoto": the plates (Sextant RF-1, "…perto das bordas das placas?").
        """(bordas?|limites?|fronteiras?) (das|entre as) placas|placas? tect[ôo]nicas?|tect[ôo]nica de placas""" to "plate tectonics plate boundary",
        """terremoto|sismo|tremor de terra""" to "earthquake",
        """enchente|inunda[çc][ãa]o|alagamento""" to "flood",
        """furac[ãa]o|tuf[ãa]o|ciclone""" to "hurricane",
        """inc[êe]ndio|fogo""" to "fire",
        """evacua[çc][ãa]o|evacuar""" to "evacuation",
        """nariz""" to "nose",
        """crian[çc]a|beb[êe]s?(?![a-zà-ÿ])""" to "child",
        """parar|estancar|interromper""" to "stop",
        """tratar|tratamento|cuidar""" to "treat",
        """prevenir|evitar""" to "prevent",
    ).map { (re, en) -> JsRegex.re(re, "i") to en }

    /** English search words for the Portuguese terms in [query] (each matched phrase consumed), or null. */
    fun englishSearchTerms(query: String): String? {
        val out = ArrayList<String>()
        var rest = query
        for ((re, en) in PT_EN) {
            if (re.containsMatchIn(rest)) {
                rest = re.replace(rest, " ")
                if (en !in out) out += en
            }
        }
        return if (out.isEmpty()) null else out.joinToString(" ")
    }

    // English first-aid questions phrased as a story ("I just got bitten by a snake while hiking") share few words with
    // the articles (Snakebite, Burn, Hypothermia): search with their names. No "first aid" added: it pulls in generic
    // first-aid articles ("Mental health first aid").
    private val EN_CANONICAL: List<Pair<Regex, String>> = listOf(
        """\b(bitten|bit) by (a |an )?(snake|viper|rattlesnake|cobra)|\bsnake ?bites?\b""" to "snakebite snake bite",
        """\b(spill\w*|splash\w*|scald\w*|pour\w*)\b[^.]{0,40}\b(boiling|hot) (water|oil|coffee|tea)|\b(boiling|hot) (water|oil)[^.]{0,40}\b(spill\w*|scald\w*|burn\w*)|\bscalds?\b""" to "burn scald",
        """\bshiver\w*[^.]{0,80}\bcold\b|\bcold\b[^.]{0,80}\bshiver\w*""" to "hypothermia",
        """\bnose ?bleeds?\b|\bbleed\w*[^.?!]{0,20}\bnose\b|\bnose\b[^.?!]{0,20}\bbleed\w*""" to "nosebleed nose bleed",
        // Any other bleeding ("My arm is bleeding a lot"): the articles' word, not the story's.
        """\bbleed(s|ing)?\b""" to "bleeding",
        """\bchok(e|ing)\b""" to "choking",
        // Earthquakes and floods: the question's own words find the "During an earthquake" sections better.
    ).map { (re, t) -> JsRegex.re(re, "i") to t }

    /** Canonical English search words for an English first-aid question, or null. */
    fun canonicalHealthTerms(query: String): String? {
        val out = EN_CANONICAL.filter { it.first.containsMatchIn(query) }.map { it.second }.toMutableList()
        // A nosebleed is not generic bleeding (it would pull in "Emergency bleeding control").
        if ("nosebleed nose bleed" in out) out.remove("bleeding")
        return if (out.isEmpty()) null else out.joinToString(" ")
    }
}
