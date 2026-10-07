package team.sopa.boar.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import team.sopa.boar.app.BoarServices
import team.sopa.boar.engine.BoarEngine
import team.sopa.boar.engine.CpuVariants
import team.sopa.boar.engine.EngineTweaks
import team.sopa.boar.engine.FlashAttn
import team.sopa.boar.engine.KvType
import team.sopa.boar.engine.LazyMode
import team.sopa.boar.engine.LoadMode
import team.sopa.boar.ui.t
import team.sopa.boar.ui.theme.Boar
import team.sopa.boar.ui.theme.ThemeTokens

/** Display settings the app applies live (theme, text size) or by recreating (language). */
interface DisplayPrefs {
    fun setTheme(id: String)
    fun setFontScale(scale: String)
    fun setLanguage(id: String?)
}

/**
 * Settings (port of ModelSetupScreen.tsx's sections that the native app has so far: tone, memory, display, language),
 * plus Advanced tweaks: every engine knob, Auto by default.
 */
@Composable
fun SettingsScreen(services: BoarServices, prefs: DisplayPrefs, onBack: () -> Unit) {
    val c = Boar.colors
    val s = services.settings
    Column(Modifier.fillMaxSize().background(c.bgTerminal).statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().background(c.bgSurface).padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("←", style = Boar.type.titleLg, color = c.textPrimary, modifier = Modifier.clickable(onClick = onBack).padding(4.dp))
            Text(t("modelSetupScreen.header.title"), style = Boar.type.titleLg, color = c.textHeading)
        }
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            ToneSection(services)
            Section(t("modelSetupScreen.sections.memory")) {
                var auto by remember { mutableStateOf(s.autoSummarize) }
                SwitchRow(t("memorySettings.autoSummarizeLabel"), t("memorySettings.autoSummarizeValue"), auto) { auto = it; s.autoSummarize = it }
                var titles by remember { mutableStateOf(s.autoGenerateTitles) }
                SwitchRow(t("memorySettings.autoTitlesLabel"), t("memorySettings.autoTitlesValue"), titles) { titles = it; s.autoGenerateTitles = it }
                var turns by remember { mutableStateOf(s.historyTurnThreshold) }
                Choices(t("memorySettings.turnsBeforeSummarizing"), listOf(4, 6, 8, 12).map { it to "$it" }, turns) { turns = it; s.historyTurnThreshold = it }
                var max by remember { mutableStateOf(s.maxSavedSessions) }
                Choices(t("memorySettings.maxSavedSessions"), listOf(5, 10, 25, 50).map { it to "$it" }, max) { max = it; s.maxSavedSessions = it }
            }
            Section(t("modelSetupScreen.sections.displayTheme")) {
                var theme by remember { mutableStateOf(ThemeTokens.byId(s.themeId).id) }
                Choices(null, ThemeTokens.all.map { it.id to "${it.icon} ${it.name}" }, theme) { theme = it; s.themeId = it; prefs.setTheme(it) }
                var scale by remember { mutableStateOf(s.fontScale) }
                Choices(t("native.settings.textSize"), listOf("compact", "standard", "large").map { it to t("native.settings.$it") }, scale) { scale = it; s.fontScale = it; prefs.setFontScale(it) }
            }
            Section(t("modelSetupScreen.sections.language")) {
                var lang by remember { mutableStateOf(s.languageId ?: "system") }
                Choices(null, listOf("system" to "System", "en" to "English", "pt" to "Português"), lang) { lang = it; val id = it.takeIf { v -> v != "system" }; s.languageId = id; prefs.setLanguage(id) }
            }
            TweaksSection(services)
        }
    }
}

@Composable
private fun ToneSection(services: BoarServices) {
    val s = services.settings
    val personalities = services.personalities
    Section(t("modelSetupScreen.sections.tone")) {
        var id by remember { mutableStateOf(s.personalityId ?: personalities.defaultId) }
        Choices(null, personalities.personalities.map { it.id to "${it.icon} ${t("personalities.${it.id}.label")}" }, id) { id = it; s.personalityId = it }
        Text(t("personalities.$id.description"), style = Boar.type.subtext, color = Boar.colors.textMuted)
        if (id == "custom") {
            var prompt by remember { mutableStateOf(s.customSystemPrompt ?: "") }
            Field(prompt, t("personalitySettings.customPromptPlaceholder")) { prompt = it; s.customSystemPrompt = it }
        }
        var tokens by remember { mutableStateOf(s.maxTokens) }
        Choices(t("personalitySettings.maxOutputTokens"), personalities.maxTokensOptions.map { it to "$it" }, tokens) { tokens = it; s.maxTokens = it }
        Note(t("personalitySettings.maxOutputTokensNote"))
        var deep by remember { mutableStateOf(s.deepResearchMode) }
        SwitchRow(t("personalitySettings.deepResearchTitle"), t("personalitySettings.deepResearchNote"), deep) { deep = it; s.deepResearchMode = it }
        var adaptive by remember { mutableStateOf(s.adaptiveRoutingEnabled) }
        SwitchRow(t("native.settings.adaptiveTitle"), t("native.settings.adaptiveNote"), adaptive) { adaptive = it; s.adaptiveRoutingEnabled = it }
    }
}

@Composable
private fun TweaksSection(services: BoarServices) {
    val s = services.settings
    val scope = rememberCoroutineScope()
    var tw by remember { mutableStateOf(s.engineTweaks) }
    val topology = services.topology
    val resolved = tw.resolve(topology)
    val auto = EngineTweaks().resolve(topology).params
    val features = remember { CpuVariants.readFeatures() }
    fun save(next: EngineTweaks) {
        tw = next
        s.engineTweaks = next
        // The model reloads with the new settings on the next answer.
        scope.launch { services.host.unload() }
    }
    val autoLabel = t("native.tweaks.auto")
    @Composable fun autoOf(value: Any) = t("native.tweaks.autoValue", "value" to value)
    Section(t("native.tweaks.title")) {
        Note(t("native.tweaks.intro"))
        val cpuAuto = CpuVariants.auto(features)?.let { n -> CpuVariants.ALL.first { it.name == n }.label } ?: t("native.tweaks.cpuBest")
        Choices(
            t("native.tweaks.cpuBuild"),
            listOf(CpuVariants.AUTO to autoOf(cpuAuto), CpuVariants.BEST to t("native.tweaks.cpuBest")) + CpuVariants.supported(features).map { it.name to it.label },
            tw.cpuBuild,
        ) { save(tw.copy(cpuBuild = it)) }
        Note(t("native.tweaks.cpuBuildNote") + " " + t("native.tweaks.appliesRestart") + " (" + (BoarEngine.loadedVariant ?: "—") + ")")
        val n = topology.cores.size
        Choices(t("native.tweaks.threads"), listOf<Pair<Int?, String>>(null to autoOf(auto.threads)) + (1..n).map { it to "$it" }, tw.threads) { save(tw.copy(threads = it)) }
        Note(t("native.tweaks.threadsNote"))
        Choices(t("native.tweaks.threadsBatch"), listOf<Pair<Int?, String>>(null to autoOf(auto.threadsBatch)) + (1..n).map { it to "$it" }, tw.threadsBatch) { save(tw.copy(threadsBatch = it)) }
        Choices(t("native.tweaks.cores"), listOf(EngineTweaks.AUTO to autoOf(t("native.tweaks.coresFast")), EngineTweaks.ALL to t("native.tweaks.coresAll")), tw.cores) { save(tw.copy(cores = it)) }
        SwitchRow(t("native.tweaks.strict"), null, tw.strictCpu) { save(tw.copy(strictCpu = it)) }
        Choices(t("native.tweaks.context"), listOf<Pair<Int?, String>>(null to autoOf(auto.nCtx)) + listOf(2048, 3072, 4096, 8192, 16384).map { it to "$it" }, tw.contextTokens) { save(tw.copy(contextTokens = it)) }
        Choices(t("native.tweaks.batch"), listOf<Pair<Int?, String>>(null to autoOf(auto.nBatch)) + listOf(128, 256, 512, 1024, 2048).map { it to "$it" }, tw.batch) { save(tw.copy(batch = it)) }
        Choices(t("native.tweaks.microBatch"), listOf<Pair<Int?, String>>(null to autoOf(auto.nUbatch)) + listOf(64, 128, 256, 512).map { it to "$it" }, tw.microBatch) { save(tw.copy(microBatch = it)) }
        Choices(t("native.tweaks.kv"), listOf<Pair<KvType?, String>>(null to autoOf(auto.typeK.name)) + KvType.entries.map { it to it.name }, tw.kvCache) { save(tw.copy(kvCache = it)) }
        Note(t("native.tweaks.kvNote"))
        Choices(t("native.tweaks.flash"), listOf(FlashAttn.AUTO to autoLabel, FlashAttn.ON to t("native.tweaks.on"), FlashAttn.OFF to t("native.tweaks.off")), tw.flashAttention) { save(tw.copy(flashAttention = it)) }
        Choices(
            t("native.tweaks.load"),
            listOf<Pair<LoadMode?, String>>(null to autoOf(t("native.tweaks.loadMmap")), LoadMode.MMAP_MLOCK to t("native.tweaks.loadLock"), LoadMode.NONE to t("native.tweaks.loadRead")),
            tw.loadMode,
        ) { save(tw.copy(loadMode = it)) }
        Choices(t("native.tweaks.moe"), listOf<Pair<LazyMode?, String>>(null to autoOf(t("native.tweaks.off")), LazyMode.AUTO to autoLabel, LazyMode.ON to t("native.tweaks.on")), tw.lazyExperts) { save(tw.copy(lazyExperts = it)) }
        val autoMin = (EngineTweaks.autoStageTimeoutMs(s.maxTokens) / 60_000.0).let { "%.0f".format(it) }
        Choices(
            t("native.tweaks.timeout"),
            listOf<Pair<Int?, String>>(null to autoOf(t("native.tweaks.minutes", "n" to autoMin))) + listOf(2, 5, 10, 20).map { it * 60 to t("native.tweaks.minutes", "n" to it) } + listOf(0 to t("native.tweaks.noLimit")),
            tw.stageTimeoutSeconds,
        ) { save(tw.copy(stageTimeoutSeconds = it)) }
        Note(t("native.tweaks.timeoutNote"))
        if (resolved.notes.isNotEmpty()) Note(t("native.tweaks.adjusted", "notes" to resolved.notes.joinToString("; ")))
        Note(t("native.tweaks.appliesNext"))
        if (!tw.isAuto) Text(
            t("native.tweaks.resetAll"), style = Boar.type.body, color = Boar.colors.textAccentEmerald, fontWeight = FontWeight.Bold,
            modifier = Modifier.clickable { save(EngineTweaks()) }.padding(vertical = 6.dp),
        )
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    val c = Boar.colors
    Column(
        Modifier.fillMaxWidth().background(c.bgCard, RoundedCornerShape(12.dp)).border(1.dp, c.borderSubtle, RoundedCornerShape(12.dp)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(title, style = Boar.type.title, color = c.textHeading)
        content()
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun <T> Choices(label: String?, options: List<Pair<T, String>>, selected: T, onSelect: (T) -> Unit) {
    val c = Boar.colors
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        label?.let { Text(it, style = Boar.type.caption, color = c.textSecondary, fontWeight = FontWeight.SemiBold) }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            for ((value, text) in options) {
                val on = value == selected
                Text(text, style = Boar.type.caption, color = if (on) c.textAccentEmerald else c.textSecondary,
                    modifier = Modifier.background(if (on) c.emeraldBgSubtle else c.bgSubtle, RoundedCornerShape(16.dp))
                        .border(1.dp, if (on) c.emeraldBorder else c.borderSubtle, RoundedCornerShape(16.dp))
                        .clickable { onSelect(value) }.padding(horizontal = 10.dp, vertical = 6.dp))
            }
        }
    }
}

@Composable
private fun SwitchRow(label: String, note: String?, checked: Boolean, onChange: (Boolean) -> Unit) {
    val c = Boar.colors
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Column(Modifier.weight(1f)) {
            Text(label, style = Boar.type.body, color = c.textPrimary)
            note?.let { Text(it, style = Boar.type.subtext, color = c.textMuted) }
        }
        Switch(checked, onChange, colors = SwitchDefaults.colors(checkedTrackColor = c.emerald500, checkedThumbColor = c.textInverse))
    }
}

@Composable
private fun Note(text: String) = Text(text, style = Boar.type.subtext, color = Boar.colors.textMuted)

@Composable
private fun Field(value: String, placeholder: String, onChange: (String) -> Unit) {
    val c = Boar.colors
    androidx.compose.foundation.layout.Box(Modifier.fillMaxWidth().background(c.bgInput, RoundedCornerShape(8.dp)).border(1.dp, c.borderDefault, RoundedCornerShape(8.dp)).padding(10.dp)) {
        if (value.isEmpty()) Text(placeholder, style = Boar.type.body, color = c.textDim)
        BasicTextField(value, onChange, textStyle = Boar.type.body.copy(color = c.textPrimary), cursorBrush = SolidColor(c.emerald500), modifier = Modifier.fillMaxWidth())
    }
}
