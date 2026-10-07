package team.sopa.boar.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import team.sopa.boar.R
import kotlin.math.roundToInt

/**
 * Brand type (port of src/ui-android/theme/fonts.ts and components/AppText.tsx): Baloo 2 for titles and weight 800+,
 * Lexend at the nearest weight for everything read, the platform monospace only for code. Android doesn't synthesize
 * weights for custom fonts, so each weight is its own file.
 */
object BrandType {
    private val baloo700 = FontFamily(Font(R.font.baloo2_700bold, FontWeight.Bold))
    private val baloo800 = FontFamily(Font(R.font.baloo2_800extrabold, FontWeight.ExtraBold))
    private val lexend400 = FontFamily(Font(R.font.lexend_400regular, FontWeight.Normal))
    private val lexend500 = FontFamily(Font(R.font.lexend_500medium, FontWeight.Medium))
    private val lexend600 = FontFamily(Font(R.font.lexend_600semibold, FontWeight.SemiBold))
    private val lexend700 = FontFamily(Font(R.font.lexend_700bold, FontWeight.Bold))

    /** Body size for text that sets none. */
    const val BODY = 16

    /** familyFor: the bundled face for a style's family and weight, and whether digits are fixed-width. */
    fun familyFor(family: String?, weight: Int): Pair<FontFamily, Boolean> {
        if (family == "code") return FontFamily.Monospace to false
        val mono = family == "monospace"
        if (family == "display" || weight >= 800) return (if (weight >= 800) baloo800 else baloo700) to false
        val f = when {
            weight >= 700 -> lexend700
            weight >= 600 -> lexend600
            weight >= 500 -> lexend500
            else -> lexend400
        }
        return f to mono
    }

    /** scaledSize: the new UI's scale (body 16, nothing under 12); titles keep their size. */
    fun scaledSize(size: Float): Float = when {
        size <= 11 -> 12f
        size == 12f -> 13f
        size == 13f -> 14f
        size <= 15 -> 16f
        else -> size
    }

    /** fontScaleFactor: the Settings text size. */
    fun factor(scale: String?) = when (scale) { "compact" -> 0.9f; "large" -> 1.2f; else -> 1f }

    /** brandStyle for a generated TextSpec at a text-size setting. */
    fun style(spec: TextSpec, scale: String?): TextStyle {
        val (family, tabular) = familyFor(spec.family, spec.weight)
        val size = (scaledSize(spec.size) * factor(scale)).roundToInt()
        val line = spec.lineHeight?.let { if (spec.size > 0) (it * size / spec.size).roundToInt() else it.roundToInt() }
        return TextStyle(
            fontFamily = family,
            fontSize = size.sp,
            lineHeight = line?.sp ?: TextStyle.Default.lineHeight,
            letterSpacing = spec.letterSpacing?.let { (it / size).em } ?: TextStyle.Default.letterSpacing,
            fontFeatureSettings = if (tabular) "tnum" else null,
        )
    }
}

/** The text styles of one text-size setting, by the TS names ("ui.body", "mono.sm"). */
class BoarType(private val scale: String) {
    private val specs = when (scale) { "compact" -> TypeTokens.compact; "large" -> TypeTokens.large; else -> TypeTokens.standard }
    private val cache = HashMap<String, TextStyle>()
    operator fun get(name: String): TextStyle = cache.getOrPut(name) { BrandType.style(specs.getValue(name), scale) }
    val body get() = this["ui.body"]
    val bodyLg get() = this["ui.bodyLg"]
    val caption get() = this["ui.caption"]
    val subtext get() = this["ui.subtext"]
    val micro get() = this["ui.micro"]
    val titleSm get() = this["ui.titleSm"]
    val title get() = this["ui.title"]
    val titleLg get() = this["ui.titleLg"]
    val headline get() = this["ui.headline"]
}

private val LocalColors = staticCompositionLocalOf { ThemeTokens.byId(null) }
private val LocalType = staticCompositionLocalOf { BoarType("standard") }

object Boar {
    val colors: BoarColors @Composable @ReadOnlyComposable get() = LocalColors.current
    val type: BoarType @Composable @ReadOnlyComposable get() = LocalType.current
}

/** The app theme: Campfire or Moonlight colors and the brand type at the user's text size. */
@Composable
fun BoarTheme(themeId: String? = null, fontScale: String = "standard", content: @Composable () -> Unit) {
    val c = ThemeTokens.byId(themeId)
    val scheme = darkColorScheme(
        primary = c.emerald500, onPrimary = c.textInverse, secondary = c.cyan500, background = c.bgTerminal,
        onBackground = c.textPrimary, surface = c.bgSurface, onSurface = c.textPrimary, surfaceVariant = c.bgCard,
        onSurfaceVariant = c.textSecondary, outline = c.borderDefault, error = c.crimson500,
    )
    CompositionLocalProvider(LocalColors provides c, LocalType provides BoarType(fontScale)) {
        MaterialTheme(colorScheme = scheme, content = content)
    }
}
