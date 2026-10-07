package team.sopa.boar.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import team.sopa.boar.ui.theme.Boar
import team.sopa.boar.ui.theme.BrandType

/**
 * An answer's text as the Expo app shows it (port of components/MarkdownMessage.tsx): ``` code blocks, # / ## / ###
 * headings, "- " and "* " bullets, `inline code` and **bold**; a blinking-free cursor while it streams.
 */
private sealed interface MdBlock {
    data class Text(val content: String) : MdBlock
    data class Code(val code: String, val language: String) : MdBlock
}

private val FENCE = Regex("```([a-zA-Z0-9_-]*)\\n([\\s\\S]*?)```")
private val INLINE = Regex("(`[^`]+`|\\*\\*[^*]+\\*\\*)")

private fun parseBlocks(text: String): List<MdBlock> {
    val out = ArrayList<MdBlock>()
    var last = 0
    for (m in FENCE.findAll(text)) {
        if (m.range.first > last) out += MdBlock.Text(text.substring(last, m.range.first))
        out += MdBlock.Code(m.groupValues[2].removeSuffix("\n"), m.groupValues[1].trim().ifEmpty { "CODE" })
        last = m.range.last + 1
    }
    if (last < text.length) out += MdBlock.Text(text.substring(last))
    return out
}

@Composable
private fun inline(text: String): AnnotatedString {
    val c = Boar.colors
    return buildAnnotatedString {
        var last = 0
        for (m in INLINE.findAll(text)) {
            append(text.substring(last, m.range.first))
            val part = m.value
            when {
                part.startsWith("`") && part.length > 2 ->
                    withStyle(SpanStyle(fontFamily = FontFamily.Monospace, color = c.textAccentCyan, background = c.bgBlack)) { append(part.substring(1, part.length - 1)) }
                part.startsWith("**") && part.length > 4 ->
                    withStyle(SpanStyle(fontWeight = FontWeight.ExtraBold, fontFamily = BrandType.familyFor("sans-serif", 800).first, color = c.textHeading)) { append(part.substring(2, part.length - 2)) }
                else -> append(part)
            }
            last = m.range.last + 1
        }
        append(text.substring(last))
    }
}

@Composable
fun MarkdownMessage(content: String, streaming: Boolean, modifier: Modifier = Modifier) {
    val c = Boar.colors
    val type = Boar.type
    SelectionContainer {
        Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            for (block in parseBlocks(content)) when (block) {
                is MdBlock.Code -> Column(
                    Modifier.fillMaxWidth().background(c.bgBlack, RoundedCornerShape(8.dp)).border(1.dp, c.borderDefault, RoundedCornerShape(8.dp)).padding(10.dp),
                ) {
                    Text(block.language.uppercase(), style = type["mono.xs"], color = c.textMuted)
                    Text(block.code, style = type["mono.sm"].copy(fontFamily = FontFamily.Monospace), color = c.textPrimary)
                }
                is MdBlock.Text -> for (line in block.content.split("\n")) {
                    val t = line.trim()
                    when {
                        t.startsWith("### ") -> Text(t.drop(4), style = type.titleSm, color = c.textAccentCyan, modifier = Modifier.padding(top = 4.dp))
                        t.startsWith("## ") -> Text(t.drop(3), style = type.title, color = c.textHeading, modifier = Modifier.padding(top = 6.dp))
                        t.startsWith("# ") -> Text(t.drop(2), style = type.titleLg, color = c.textHeading, modifier = Modifier.padding(top = 8.dp))
                        t.startsWith("- ") || t.startsWith("* ") -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text("•", style = type.body, color = c.textAccentEmerald, fontWeight = FontWeight.ExtraBold)
                            Text(inline(t.drop(2)), style = type.bodyLg, color = c.textPrimary)
                        }
                        else -> Text(inline(line), style = type.bodyLg, color = c.textPrimary)
                    }
                }
            }
            if (streaming) Box(Modifier.padding(top = 2.dp).size(8.dp, 16.dp).background(c.emerald400))
        }
    }
}
