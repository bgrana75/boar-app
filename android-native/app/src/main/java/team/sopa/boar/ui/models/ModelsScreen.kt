package team.sopa.boar.ui.models

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import team.sopa.boar.engine.models.AssetKind
import team.sopa.boar.engine.models.CatalogAsset
import team.sopa.boar.engine.models.Compatibility
import team.sopa.boar.models.ModelsState
import team.sopa.boar.models.ModelsViewModel
import team.sopa.boar.models.Row as AssetRow
import team.sopa.boar.ui.t
import team.sopa.boar.ui.theme.Boar
import kotlin.math.ceil
import kotlin.math.floor

/** The models and knowledge catalog (ModelCatalogScreen.tsx with CatalogItemCard.tsx's layout and styles). */
@Composable
fun ModelsScreen(state: ModelsState, vm: ModelsViewModel, onBack: () -> Unit) {
    val c = Boar.colors
    Column(Modifier.fillMaxSize().background(c.bgTerminal).statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().background(c.bgSurface).padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("‹ " + t("common.back"), style = Boar.type.body, color = c.textAccentEmerald, modifier = Modifier.clickable(onClick = onBack).padding(4.dp))
            Column {
                Text(t("modelCatalogScreen.title"), style = Boar.type.titleLg, color = c.textHeading)
                Text(t("modelCatalogScreen.subtitle"), style = Boar.type.caption, color = c.textMuted)
            }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(c.borderDefault))
        LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items(state.items, key = { it.id }) { a ->
                val active = if (a.kind == AssetKind.LLM) a.id == state.activeLlm else state.rows[a.id]?.present == true
                CatalogCard(a, state.rows[a.id], active, state.totalRamBytes, state.activating == a.id, state.activating != null, vm)
            }
        }
    }
}

private fun formatMB(bytes: Long): String = when {
    bytes <= 0 -> "0 MB"
    bytes >= 1024L * 1024 * 1024 -> "%.1f GB".format(bytes / (1024.0 * 1024 * 1024))
    else -> "%.0f MB".format(bytes / (1024.0 * 1024))
}

private fun formatSpeed(b: Double?, calculating: String) = when {
    b == null || b <= 0 -> calculating
    b >= 1024 * 1024 -> "%.1f MB/s".format(b / (1024 * 1024))
    else -> "%.0f KB/s".format(b / 1024)
}

private fun formatEta(s: Double?, calculating: String) = when {
    s == null || s <= 0 || s.isInfinite() || s.isNaN() -> calculating
    s < 60 -> "${ceil(s).toInt()}s"
    else -> "${floor(s / 60).toInt()}m ${ceil(s % 60).toInt()}s"
}

@Composable
private fun CatalogCard(item: CatalogAsset, row: AssetRow?, active: Boolean, ramBytes: Long, activating: Boolean, busy: Boolean, vm: ModelsViewModel) {
    val c = Boar.colors
    val mono = Boar.type["mono.xs"]
    val present = row?.present == true
    val corpus = item.kind == AssetKind.CORPUS
    var confirm by remember { mutableStateOf(false) }
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(if (active) Color(0x0F10B981).compositeOver(c.bgCardElevated) else c.bgCardElevated)
            .border(1.dp, if (active) c.emeraldBorder else c.borderDefault, RoundedCornerShape(12.dp)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(item.label, style = Boar.type.titleSm, color = c.textHeading)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    Text(t("catalogItemCard.kind.${item.kind.name.lowercase()}"), style = mono.copy(fontSize = 9.sp), fontWeight = FontWeight.Bold, color = c.textSecondary,
                        modifier = Modifier.background(Color.White.copy(alpha = 0.08f), RoundedCornerShape(4.dp)).padding(horizontal = 5.dp, vertical = 1.dp))
                    Text(formatMB(item.sizeBytes), style = mono, color = c.textDim)
                    Text("•", style = mono, color = c.textDim)
                    Text(item.license, style = mono, color = c.textDim, maxLines = 1, modifier = Modifier.weight(1f, fill = false))
                    if (item.required) { Text("•", style = mono, color = c.textDim); Text(t("catalogItemCard.default"), style = mono.copy(fontSize = 9.sp), color = c.textAccentCyan, fontWeight = FontWeight.Bold) }
                }
            }
            StatusBadge(present, active, row?.downloading == true)
        }
        if (item.kind == AssetKind.LLM && ramBytes > 0) {
            val comp = Compatibility.compute(item.sizeBytes, ramBytes)
            val (icon, fg, bg, border) = when (comp.value) {
                "green" -> listOf("🟢", c.textAccentEmerald, c.emeraldBgSubtle, c.emeraldBorder)
                "yellow" -> listOf("🟡", c.textAccentAmber, c.amberBgSubtle, c.amberBorder)
                "red" -> listOf("🔴", c.crimson400, c.crimsonBgSubtle, c.crimsonBorder)
                else -> listOf(null, null, null, null)
            }
            if (icon != null) Row(
                Modifier.background(bg as Color, RoundedCornerShape(6.dp)).border(1.dp, border as Color, RoundedCornerShape(6.dp)).padding(horizontal = 8.dp, vertical = 3.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                Text(icon as String, fontSize = 10.sp)
                Text(t("catalogItemCard.compat.${comp.value}"), style = mono, color = fg as Color, fontWeight = FontWeight.Bold)
            }
        }
        Text(item.description, style = Boar.type.caption.copy(lineHeight = 18.sp), color = c.textSecondary)
        row?.error?.let { e ->
            Row(Modifier.fillMaxWidth().background(c.crimsonBgSubtle, RoundedCornerShape(6.dp)).border(1.dp, c.crimsonBorder, RoundedCornerShape(6.dp)).padding(8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("⚠️", fontSize = 12.sp)
                Text(e, style = mono, color = c.crimson400)
            }
        }
        val calculating = t("catalogItemCard.calculating")
        if (row?.downloading == true) Column(
            Modifier.fillMaxWidth().background(c.bgTerminal, RoundedCornerShape(8.dp)).border(1.dp, c.borderDefault, RoundedCornerShape(8.dp)).padding(8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(14.dp), color = c.emerald400, strokeWidth = 1.5.dp)
                Text(t("catalogItemCard.downloadingAsset"), style = mono, color = c.textAccentCyan, fontWeight = FontWeight.Bold, modifier = Modifier.padding(start = 6.dp))
                Spacer(Modifier.weight(1f))
                Text("%.0f%%".format(row.progress * 100), style = mono, color = c.textHeading, fontWeight = FontWeight.ExtraBold)
            }
            Box(Modifier.fillMaxWidth().height(8.dp).clip(RoundedCornerShape(4.dp)).background(Color.Black.copy(alpha = 0.6f))) {
                Box(Modifier.fillMaxHeight().fillMaxWidth(maxOf(row.progress, 0.02).toFloat()).clip(RoundedCornerShape(4.dp)).background(c.emerald500))
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("${if (row.bytesWritten > 0) formatMB(row.bytesWritten) else "0 MB"} / ${formatMB(item.sizeBytes)}", style = mono, color = c.textDim)
                Spacer(Modifier.weight(1f))
                Text(formatSpeed(row.speedBytesPerSec, calculating), style = mono, color = c.textAccentCyan, fontWeight = FontWeight.Bold)
                Text(" • ", style = mono, color = c.textDim)
                Text(t("catalogItemCard.eta", "eta" to formatEta(row.etaSeconds, calculating)), style = mono, color = c.textAccentAmber, fontWeight = FontWeight.SemiBold)
            }
        } else Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            when {
                !present -> SmallButton(if (row?.error != null) t("catalogItemCard.retryDownload") else t("catalogItemCard.downloadAsset")) { vm.download(item) }
                row?.indexing == true -> Busy(t("setupWizard.step3.buildingIndex"))
                corpus -> Check(t("catalogItemCard.indexedNote"))
                active -> Check(t("catalogItemCard.activeNote"))
                activating -> Busy(t("catalogItemCard.loadingModel"))
                else -> SmallButton(t("catalogItemCard.selectUse"), enabled = !busy) { vm.use(item) }
            }
            Spacer(Modifier.weight(1f))
            if (present && !item.required) Text("🗑️", fontSize = 16.sp, modifier = Modifier.clickable(enabled = !busy) { confirm = true }.padding(4.dp))
        }
    }
    if (confirm) AlertDialog(
        onDismissRequest = { confirm = false },
        title = { Text(t(if (corpus) "catalogItemCard.removeCorpusTitle" else "catalogItemCard.removeModelTitle")) },
        text = { Text(t(if (corpus) "catalogItemCard.removeCorpusMessage" else "catalogItemCard.removeModelMessage", "size" to formatMB(item.sizeBytes))) },
        confirmButton = { TextButton({ confirm = false; vm.remove(item) }) { Text(t("catalogItemCard.removeAssetButton"), color = c.crimson400) } },
        dismissButton = { TextButton({ confirm = false }) { Text(t("common.cancel")) } },
        containerColor = c.bgCard, titleContentColor = c.textHeading, textContentColor = c.textSecondary,
    )
}

@Composable
private fun StatusBadge(present: Boolean, active: Boolean, downloading: Boolean) {
    val c = Boar.colors
    val mono = Boar.type["mono.xs"]
    val (text, fg, bg, border) = when {
        downloading -> listOf(t("catalogItemCard.badge.downloading"), c.textAccentCyan, c.cyanBgSubtle, c.cyanBorder)
        !present -> listOf(t("catalogItemCard.badge.notOnDisk"), c.textDim, Color.White.copy(alpha = 0.04f), c.borderSubtle)
        active -> listOf(t("catalogItemCard.badge.active"), c.textAccentEmerald, c.emeraldBgSubtle, c.emeraldBorder)
        else -> listOf(t("catalogItemCard.badge.cached"), c.textSecondary, Color.White.copy(alpha = 0.06f), c.borderDefault)
    }
    Row(
        Modifier.background(bg as Color, RoundedCornerShape(6.dp)).border(1.dp, border as Color, RoundedCornerShape(6.dp)).padding(horizontal = 7.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (active && present) Box(Modifier.size(6.dp).background(c.emerald400, CircleShape))
        Text(text as String, style = mono.copy(fontSize = 9.sp), color = fg as Color, fontWeight = FontWeight.ExtraBold)
    }
}

@Composable
private fun SmallButton(label: String, enabled: Boolean = true, onClick: () -> Unit) {
    val c = Boar.colors
    Text(label, style = Boar.type.titleSm.copy(fontSize = 12.sp), color = c.textAccentEmerald,
        modifier = Modifier.clip(RoundedCornerShape(6.dp)).background(c.emeraldBgSubtle).border(1.dp, c.emeraldBorder, RoundedCornerShape(6.dp))
            .clickable(enabled = enabled, onClick = onClick).padding(horizontal = 14.dp, vertical = 8.dp))
}

@Composable
private fun Check(label: String) = Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
    Text("✓", color = Boar.colors.textAccentEmerald, fontWeight = FontWeight.Bold)
    Text(label, style = Boar.type.caption, color = Boar.colors.textAccentEmerald)
}

@Composable
private fun Busy(label: String) = Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
    CircularProgressIndicator(Modifier.size(14.dp), color = Boar.colors.emerald400, strokeWidth = 1.5.dp)
    Text(label, style = Boar.type.caption, color = Boar.colors.textAccentEmerald)
}

private fun Color.compositeOver(bg: Color): Color {
    val a = alpha
    return Color(red * a + bg.red * (1 - a), green * a + bg.green * (1 - a), blue * a + bg.blue * (1 - a), 1f)
}
