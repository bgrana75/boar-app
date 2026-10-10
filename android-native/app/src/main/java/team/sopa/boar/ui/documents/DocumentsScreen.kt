package team.sopa.boar.ui.documents

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import team.sopa.boar.documents.DocumentsState
import team.sopa.boar.documents.DocumentsViewModel
import team.sopa.boar.engine.rag.KnowledgeBase
import team.sopa.boar.ui.t
import team.sopa.boar.ui.theme.Boar

/** My Documents (PersonalDocumentsManager.tsx). */
@Composable
fun DocumentsScreen(state: DocumentsState, vm: DocumentsViewModel, onBack: () -> Unit) {
    val c = Boar.colors
    var name by remember { mutableStateOf("") }
    var nameMissing by remember { mutableStateOf(false) }
    var removing by remember { mutableStateOf<KnowledgeBase.Collection?>(null) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris -> vm.import(uris, name.trim()); name = "" }
    Column(Modifier.fillMaxSize().background(c.bgTerminal).statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().background(c.bgSurface).padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("‹ " + t("common.back"), style = Boar.type.body, color = c.textAccentEmerald, modifier = Modifier.clickable(onClick = onBack).padding(4.dp))
            Text(t("modelSetupScreen.sections.knowledgeBase"), style = Boar.type.titleLg, color = c.textHeading)
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(c.borderDefault))
        Column(Modifier.verticalScroll(rememberScrollState()).padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(t("personalDocumentsManager.hint"), style = Boar.type.subtext, color = c.textMuted)
            Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(c.bgInput).border(1.dp, c.borderDefault, RoundedCornerShape(8.dp)).padding(12.dp)) {
                if (name.isEmpty()) Text(t("personalDocumentsManager.namePlaceholder"), style = Boar.type.body, color = c.textDim)
                BasicTextField(name, { name = it }, textStyle = Boar.type.body.copy(color = c.textPrimary), cursorBrush = SolidColor(c.emerald500), singleLine = true, modifier = Modifier.fillMaxWidth())
            }
            val busy = state.stage != null
            Text(t("personalDocumentsManager.pickButton"), style = Boar.type.title, color = if (busy) c.textDim else c.textInverse,
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(if (busy) c.bgCard else c.emerald600)
                    .clickable(enabled = !busy) {
                        if (name.isBlank()) nameMissing = true
                        else picker.launch(arrayOf("text/plain", "text/markdown", "text/csv", "text/comma-separated-values", "application/json", "application/pdf", "text/*"))
                    }.padding(14.dp))
            state.stage?.let { stage ->
                val label = when (stage) {
                    "reading" -> t("personalDocumentsManager.stageReading")
                    "chunking" -> t("personalDocumentsManager.stageChunking")
                    else -> t("personalDocumentsManager.stageEmbedding", "current" to state.done, "total" to state.total)
                }
                Text(label, style = Boar.type["mono.xs"], color = c.textAccentCyan)
                LinearProgressIndicator(progress = { if (state.total > 0) state.done.toFloat() / state.total else 0f }, modifier = Modifier.fillMaxWidth(), color = c.emerald500, trackColor = c.bgSubtle)
            }
            state.error?.let { Text("${t("personalDocumentsManager.importFailedTitle")}: $it", style = Boar.type.subtext, color = c.crimson400) }
            if (state.collections.isEmpty()) Text(t("personalDocumentsManager.empty"), style = Boar.type.body, color = c.textMuted)
            for (col in state.collections) Column(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(c.bgCardElevated).border(1.dp, if (col.active) c.emeraldBorder else c.borderDefault, RoundedCornerShape(12.dp)).padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(col.name, style = Boar.type.titleSm, color = c.textHeading)
                        Text(t("personalDocumentsManager.docCount", "count" to col.docCount) + " · " + t("personalDocumentsManager.chunkCount", "count" to col.chunkCount),
                            style = Boar.type["mono.xs"], color = c.textDim)
                        col.sourceFilename?.let { Text(it, style = Boar.type.micro, color = c.textDim, maxLines = 1) }
                    }
                    Switch(col.active, { vm.setActive(col.id, it) }, colors = SwitchDefaults.colors(checkedTrackColor = c.emerald500, checkedThumbColor = c.textInverse))
                }
                Text("🗑️ " + t("common.remove"), style = Boar.type.caption, color = c.crimson400, fontWeight = FontWeight.SemiBold, modifier = Modifier.clickable { removing = col }.padding(vertical = 4.dp))
            }
        }
    }
    if (nameMissing) AlertDialog({ nameMissing = false }, confirmButton = { TextButton({ nameMissing = false }) { Text("OK") } },
        title = { Text(t("personalDocumentsManager.nameRequiredTitle")) }, text = { Text(t("personalDocumentsManager.nameRequiredMessage")) },
        containerColor = c.bgCard, titleContentColor = c.textHeading, textContentColor = c.textSecondary)
    removing?.let { col ->
        AlertDialog({ removing = null },
            confirmButton = { TextButton({ vm.remove(col.id); removing = null }) { Text(t("common.remove"), color = c.crimson400) } },
            dismissButton = { TextButton({ removing = null }) { Text(t("common.cancel")) } },
            title = { Text(t("personalDocumentsManager.removeConfirmTitle")) },
            text = { Text(t("personalDocumentsManager.removeConfirmMessage", "name" to col.name, "count" to col.chunkCount)) },
            containerColor = c.bgCard, titleContentColor = c.textHeading, textContentColor = c.textSecondary)
    }
}
