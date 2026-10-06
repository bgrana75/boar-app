package team.sopa.boar.engine.answer

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Answer styles (port of src/constants/personalities.ts). The texts come from the TypeScript source through
 * scripts/export-native-data.mjs (assets/boar-data/personalities.json), so both apps send the same prompts.
 */
@Serializable
data class Personality(
    val id: String,
    val label: String,
    val icon: String,
    val description: String,
    /** Unused for "custom": the user writes their own. */
    val systemPrompt: String,
    /** Appended to the question: small models follow what is closest to it. */
    val styleReminder: String? = null,
)

@Serializable
data class Personalities(
    val personalities: List<Personality>,
    val defaultId: String,
    val maxTokensOptions: List<Int>,
    val defaultMaxTokens: Int,
) {
    /** Unknown ids fall back to the first style, as getPersonality does. */
    fun get(id: String?): Personality = personalities.firstOrNull { it.id == id } ?: personalities.first()

    /** The system prompt and style reminder for a setting; "custom" uses the user's prompt and no reminder. */
    fun promptFor(id: String?, customPrompt: String?): Pair<String, String?> {
        val effective = id ?: defaultId
        return if (effective == "custom") (customPrompt ?: "") to null else get(effective).let { it.systemPrompt to it.styleReminder }
    }

    companion object {
        private val json = Json { ignoreUnknownKeys = true }
        fun parse(text: String): Personalities = json.decodeFromString(serializer(), text)
    }
}
