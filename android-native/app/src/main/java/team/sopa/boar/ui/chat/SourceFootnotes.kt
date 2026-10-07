package team.sopa.boar.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import team.sopa.boar.chat.Source
import team.sopa.boar.ui.t
import team.sopa.boar.ui.theme.Boar
import team.sopa.boar.ui.theme.BrandType

/** components/SourceFootnotes.tsx: the numbered sources under an answer; tapping one shows the passage the model read. */
@Composable
fun SourceFootnotes(sources: List<Source>) {
    val c = Boar.colors
    val mono = Boar.type["mono.xs"]
    var expanded by remember { mutableStateOf<Int?>(null) }
    Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(Color.White.copy(alpha = 0.08f)))
        Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("📚", fontSize = 11.sp)
            Text(t("sourceFootnotes.title"), style = mono.copy(letterSpacing = 0.5.sp), color = c.textAccentCyan, fontWeight = FontWeight.Bold, modifier = Modifier.padding(start = 4.dp))
            Spacer(Modifier.weight(1f))
            Text("${sources.size}", style = mono, color = c.textMuted, modifier = Modifier.background(Color.White.copy(alpha = 0.07f), RoundedCornerShape(4.dp)).padding(horizontal = 5.dp, vertical = 1.dp))
        }
        sources.forEachIndexed { i, s ->
            val open = expanded == i
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(6.dp))
                        .background(if (open) Color(0x1A06B6D4) else Color(0xCC0F172A))
                        .border(1.dp, if (open) c.cyan500 else c.borderDefault, RoundedCornerShape(6.dp))
                        .clickable { expanded = if (open) null else i }.padding(horizontal = 8.dp, vertical = 5.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Box(Modifier.size(16.dp).background(c.cyanBgSubtle, CircleShape), contentAlignment = Alignment.Center) {
                        Text("${i + 1}", style = mono.copy(fontSize = 9.sp), color = c.textAccentCyan, fontWeight = FontWeight.Bold)
                    }
                    Text(s.title, style = Boar.type.caption.copy(fontFamily = BrandType.familyFor(null, 600).first), color = c.textHeading,
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    // The real similarity to the question, not the fused score (that one is only relative).
                    s.similarity?.let { Text("%.0f%%".format(it * 100), style = mono, color = c.textAccentEmerald, fontWeight = FontWeight.SemiBold) }
                    Text(if (open) "▲" else "▼", fontSize = 8.sp, color = c.textDim)
                }
                if (open) Column(
                    Modifier.fillMaxWidth().background(c.bgTerminal, RoundedCornerShape(6.dp)).border(1.dp, c.borderDefault, RoundedCornerShape(6.dp)).padding(8.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(t("sourceFootnotes.localIndex"), style = mono, color = c.textAccentEmerald, fontWeight = FontWeight.Bold)
                        Text(s.docId ?: s.title, style = mono, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.End, modifier = Modifier.weight(1f))
                    }
                    Text(s.body, style = mono.copy(lineHeight = 16.sp), color = c.textSecondary, maxLines = 6, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}
