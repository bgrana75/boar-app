package team.sopa.boar.ui.setup

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import team.sopa.boar.engine.BoarEngine
import team.sopa.boar.engine.models.AnswerTier
import team.sopa.boar.engine.models.Units
import team.sopa.boar.setup.SetupState
import team.sopa.boar.setup.SetupViewModel
import team.sopa.boar.ui.t
import team.sopa.boar.ui.theme.Boar

/** First-run setup (port of SetupWizardScreen.tsx): hardware, model and knowledge, downloads, indexing. */
@Composable
fun SetupScreen(state: SetupState, vm: SetupViewModel, onDone: () -> Unit) {
    val c = Boar.colors
    Column(Modifier.fillMaxSize().background(c.bgTerminal).statusBarsPadding().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text("🐗 BOAR", style = Boar.type.headline, color = c.textHeading)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            listOf("hardware", "modelTier", "install", "indexing").forEachIndexed { i, k ->
                val on = state.step == i + 1
                Text("${i + 1} ${t("setupWizard.steps.$k")}", style = Boar.type.micro, color = if (on) c.textAccentEmerald else if (state.step > i + 1) c.textSecondary else c.textDim,
                    fontWeight = if (on) FontWeight.Bold else FontWeight.Normal)
            }
        }
        when (state.step) {
            1 -> Hardware(state, vm)
            2 -> ModelAndKnowledge(state, vm)
            3 -> Downloads(state, vm)
            else -> Indexing(state, onDone)
        }
    }
}

@Composable
private fun Card(content: @Composable () -> Unit) {
    val c = Boar.colors
    Column(Modifier.fillMaxWidth().background(c.bgCard, RoundedCornerShape(12.dp)).border(1.dp, c.borderSubtle, RoundedCornerShape(12.dp)).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)) { content() }
}

@Composable
private fun Button(label: String, enabled: Boolean = true, onClick: () -> Unit) {
    val c = Boar.colors
    Text(label, style = Boar.type.title, color = if (enabled) c.textInverse else c.textDim,
        modifier = Modifier.fillMaxWidth().background(if (enabled) c.emerald500 else c.bgCard, RoundedCornerShape(12.dp)).clickable(enabled = enabled, onClick = onClick).padding(14.dp))
}

@Composable
private fun Line(label: String, value: String) = Row(Modifier.fillMaxWidth()) {
    Text(label, style = Boar.type.body, color = Boar.colors.textSecondary, modifier = Modifier.weight(1f))
    Text(value, style = Boar.type["mono.sm"], color = Boar.colors.textAccentEmerald)
}

@Composable
private fun Hardware(state: SetupState, vm: SetupViewModel) {
    Card {
        Text(t("setupWizard.step1.terminalTitle"), style = Boar.type.title, color = Boar.colors.textHeading)
        Text(t("setupWizard.step1.terminalText"), style = Boar.type.body, color = Boar.colors.textSecondary)
    }
    Card {
        Text(t("setupWizard.step1.hardwareTitle"), style = Boar.type.title, color = Boar.colors.textHeading)
        Line(t("setupWizard.step1.deviceRam"), Units.formatBytes(state.totalRamBytes))
        Line(t("setupWizard.step1.availableStorage"), Units.formatBytes(state.freeDiskBytes))
        Line(t("setupWizard.step1.inferenceEngine"), "llama.cpp · ${BoarEngine.loadedVariant ?: "—"}")
    }
    Button(t("setupWizard.step1.selectTierButton")) { vm.next() }
}

@Composable
private fun ModelAndKnowledge(state: SetupState, vm: SetupViewModel) {
    val c = Boar.colors
    Text(t("setupWizard.step2.title"), style = Boar.type.titleLg, color = c.textHeading)
    Text(t("setupWizard.step2.subtitle"), style = Boar.type.body, color = c.textSecondary)
    for (m in state.models) {
        val on = m.id == state.chosenId
        Column(Modifier.fillMaxWidth().background(if (on) c.emeraldBgSubtle else c.bgCard, RoundedCornerShape(12.dp))
            .border(1.dp, if (on) c.emeraldBorder else c.borderSubtle, RoundedCornerShape(12.dp)).clickable { vm.choose(m.id) }.padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(m.shortName, style = Boar.type.title, color = c.textHeading, modifier = Modifier.weight(1f))
                Text(Units.formatBytes(m.sizeBytes), style = Boar.type["mono.xs"], color = c.textMuted)
            }
            if (m.id == state.recommendedId) Text(t("setupWizard.step2.recommended"), style = Boar.type.micro, color = c.textAccentEmerald, fontWeight = FontWeight.Bold)
            if (vm.isHeavy(m)) Text(t("setupWizard.step2.heavy") + " — " + t("setupWizard.step2.heavyNote"), style = Boar.type.micro, color = c.textAccentAmber)
            m.answerTier?.let { Text(t("setupWizard.step2.models.${if (it == AnswerTier.DEFAULT) "default" else "compact"}"), style = Boar.type.subtext, color = c.textSecondary) }
        }
    }
    Text(t("setupWizard.step2.knowledgeTitle"), style = Boar.type.titleLg, color = c.textHeading)
    Text(t("setupWizard.step2.knowledgeSubtitle"), style = Boar.type.body, color = c.textSecondary)
    for (tier in state.tiers) {
        val on = tier.id == state.tierId
        Column(Modifier.fillMaxWidth().background(if (on) c.emeraldBgSubtle else c.bgCard, RoundedCornerShape(12.dp))
            .border(1.dp, if (on) c.emeraldBorder else c.borderSubtle, RoundedCornerShape(12.dp)).clickable { vm.chooseTier(tier.id) }.padding(12.dp)) {
            Text(tier.label, style = Boar.type.title, color = c.textHeading)
            Text(tier.description, style = Boar.type.subtext, color = c.textSecondary)
        }
    }
    Button(t("setupWizard.step2.installButton"), enabled = state.chosenId != null) { vm.install() }
    Text(t("setupWizard.step2.backButton"), style = Boar.type.body, color = c.textMuted, modifier = Modifier.clickable { vm.back() }.padding(6.dp))
}

@Composable
private fun Downloads(state: SetupState, vm: SetupViewModel) {
    val c = Boar.colors
    Text(t("setupWizard.step3.title"), style = Boar.type.titleLg, color = c.textHeading)
    Text(t("setupWizard.step3.subtitle"), style = Boar.type.body, color = c.textSecondary)
    Card {
        Text(t("setupWizard.step3.keepOpenLabel"), style = Boar.type.caption, color = c.textAccentAmber, fontWeight = FontWeight.Bold)
        Text(t("setupWizard.step3.keepOpenText"), style = Boar.type.subtext, color = c.textSecondary)
    }
    state.downloads.forEachIndexed { i, d ->
        Card {
            Text(t("setupWizard.step3.assetCounter", "current" to (i + 1), "total" to state.downloads.size, "label" to d.asset.shortName), style = Boar.type.body, color = c.textPrimary)
            val frac = if (d.done) 1f else if (d.bytesTotal > 0) (d.bytesDone.toFloat() / d.bytesTotal).coerceIn(0f, 1f) else 0f
            LinearProgressIndicator(progress = { frac }, modifier = Modifier.fillMaxWidth(), color = c.emerald500, trackColor = c.bgSubtle)
            Text(if (d.done) "✓" else "${Units.formatBytes(d.bytesDone)} / ${Units.formatBytes(d.bytesTotal)}" + if (d.verifying) " · SHA-256" else "",
                style = Boar.type["mono.xs"], color = c.textMuted)
            d.error?.let { Text("${t("setupWizard.step3.downloadFailedLabel")}: $it", style = Boar.type.subtext, color = c.crimson400) }
        }
    }
    if (state.error != null) Button(t("setupWizard.step3.retryDownloads")) { vm.retry() }
}

@Composable
private fun Indexing(state: SetupState, onDone: () -> Unit) {
    val c = Boar.colors
    Text(t("setupWizard.step4.title"), style = Boar.type.titleLg, color = c.textHeading)
    Text(t("setupWizard.step4.subtitle"), style = Boar.type.body, color = c.textSecondary)
    Card {
        val frac = if (state.indexTotal > 0) state.indexDone.toFloat() / state.indexTotal else 0f
        LinearProgressIndicator(progress = { if (state.finished) 1f else frac }, modifier = Modifier.fillMaxWidth(), color = c.emerald500, trackColor = c.bgSubtle)
        Text(t("setupWizard.step4.counter", "done" to state.indexDone, "total" to state.indexTotal), style = Boar.type["mono.sm"], color = c.textMuted)
        if (state.indexTitle.isNotEmpty() && !state.finished) Text(state.indexTitle, style = Boar.type.subtext, color = c.textDim, maxLines = 1)
        state.error?.let { Text(it, style = Boar.type.subtext, color = c.crimson400) }
    }
    if (state.finished) Button(t("setupWizard.step3.launchButton"), onClick = onDone)
}
