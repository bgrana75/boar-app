package team.sopa.boar.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import team.sopa.boar.chat.Activity
import team.sopa.boar.chat.ChatState
import team.sopa.boar.chat.Source
import team.sopa.boar.chat.UiMessage
import team.sopa.boar.engine.answer.AnswerText
import team.sopa.boar.engine.answer.ResearchStage
import team.sopa.boar.ui.t
import team.sopa.boar.ui.theme.Boar

/** The chat (port of src/ui-android/ChatScreen.tsx's layout): header, messages, input bar. */
@Composable
fun ChatScreen(
    state: ChatState,
    onSend: (String) -> Unit,
    onStop: () -> Unit,
    onNewChat: () -> Unit,
    onMenu: () -> Unit,
    onToggleDeepResearch: (Boolean) -> Unit,
    onRate: (String, String) -> Unit,
) {
    val c = Boar.colors
    val list = rememberLazyListState()
    val last = state.messages.lastOrNull()
    LaunchedEffect(state.messages.size, last?.text?.length) {
        if (state.messages.isNotEmpty()) list.animateScrollToItem(state.messages.size - 1)
    }
    Column(Modifier.fillMaxSize().background(c.bgTerminal).statusBarsPadding().navigationBarsPadding().imePadding()) {
        Header(state, onNewChat, onMenu, onToggleDeepResearch)
        if (state.messages.isEmpty()) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Text(if (state.noModel) "No answer model installed yet." else "BOAR", style = Boar.type.headline, color = c.textMuted)
            }
        } else {
            LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = list, contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                items(state.messages, key = { it.id }) { m -> Bubble(m, state, onRate) }
            }
        }
        InputBar(state.answeringId != null, onSend, onStop)
    }
}

@Composable
private fun Header(state: ChatState, onNewChat: () -> Unit, onMenu: () -> Unit, onToggleDeepResearch: (Boolean) -> Unit) {
    val c = Boar.colors
    Row(
        Modifier.fillMaxWidth().background(c.bgSurface).padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("☰", style = Boar.type.titleLg, color = c.textPrimary, modifier = Modifier.clickable(onClick = onMenu).padding(4.dp))
        Column(Modifier.weight(1f)) {
            Text("BOAR", style = Boar.type.title, color = c.textHeading)
            Text(state.modelLabel ?: "—", style = Boar.type.caption, color = c.textMuted, maxLines = 1)
        }
        Pill(if (state.deepResearch) t("chatHeader.deepResearchActive") else t("chatHeader.deepResearch"), state.deepResearch) { onToggleDeepResearch(!state.deepResearch) }
        Text("＋", style = Boar.type.titleLg, color = c.textAccentEmerald, modifier = Modifier.clickable(onClick = onNewChat).padding(4.dp))
    }
}

@Composable
private fun Pill(label: String, on: Boolean, onClick: () -> Unit) {
    val c = Boar.colors
    Text(
        label, style = Boar.type.caption, color = if (on) c.textAccentEmerald else c.textMuted,
        modifier = Modifier.clip(RoundedCornerShape(16.dp)).background(if (on) c.emeraldBgSubtle else c.bgSubtle).border(1.dp, if (on) c.emeraldBorder else c.borderSubtle, RoundedCornerShape(16.dp))
            .clickable(onClick = onClick).padding(horizontal = 10.dp, vertical = 4.dp),
    )
}

@Composable
private fun activityLabel(a: Activity?): String = when (a) {
    Activity.Retrieving -> t("processingIndicator.retrieving")
    Activity.Thinking -> t("processingIndicator.thinking")
    Activity.Generating -> t("processingIndicator.generating")
    is Activity.Researching -> when (a.stage) {
        ResearchStage.DECOMPOSING -> t("chatScreen.research.decomposing")
        ResearchStage.RESEARCHING -> t("chatScreen.research.researching", "index" to (a.index ?: 1), "count" to (a.count ?: 1))
        ResearchStage.SYNTHESIZING -> t("chatScreen.research.synthesizing")
    }
    null -> ""
}

@Composable
private fun Bubble(m: UiMessage, state: ChatState, onRate: (String, String) -> Unit) {
    val c = Boar.colors
    val type = Boar.type
    val user = m.role == "user"
    val streaming = state.answeringId == m.id
    var reasoningShown by remember { mutableStateOf(false) }
    val clipboard = LocalClipboardManager.current
    Column(
        Modifier.fillMaxWidth()
            .background(if (user) c.bgCardElevated else c.bgCard, RoundedCornerShape(12.dp))
            .border(1.dp, if (user) c.borderDefault else c.borderSubtle, RoundedCornerShape(12.dp))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(if (user) t("chatScreen.roleYou") else t("chatScreen.roleAssistant"), style = type.micro, color = if (user) c.textMuted else c.textAccentEmerald, fontWeight = FontWeight.Bold)
        if (user) {
            Text(m.text, style = type.bodyLg, color = c.textPrimary)
            return@Column
        }
        val split = AnswerText.splitThinking(m.text)
        // Sources are attached when the reply finishes, so invented citations are cleaned only then.
        val shown = if (streaming) split.answer else AnswerText.splitInlineBullets(AnswerText.cleanCitations(split.answer, m.sources.size))
        when {
            m.text.isEmpty() && streaming -> Text(activityLabel(state.activity), style = type.body, color = c.textMuted)
            split.thinkingInProgress && split.answer.isEmpty() && streaming ->
                Text("💭 " + (split.thinking?.takeLast(160) ?: ""), style = type.subtext, color = c.textDim)
            split.thinkingInProgress && split.answer.isEmpty() -> Text("💭 " + t("chatScreen.reasoningUnfinished"), style = type.subtext, color = c.textDim)
            else -> {
                if (reasoningShown && split.thinking != null) Text(split.thinking!!, style = type.subtext, color = c.textDim)
                MarkdownMessage(shown, streaming)
            }
        }
        if (streaming && state.activity == Activity.Generating) state.liveTokPerSec?.let { Text("%.1f tok/s".format(it), style = type["mono.xs"], color = c.textDim) }
        if (m.sources.isNotEmpty()) Sources(m.sources)
        if (m.stopped) Badge("⏹ " + t("chatScreen.stoppedByUser"))
        if (m.timedOut) Badge("⏱ " + t("chatScreen.stageTimedOut"))
        if (m.text.isNotEmpty() && !streaming) Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            FooterButton("▲" + if (m.feedback == "up") " " + t("chatScreen.rateHelpful") else "", m.feedback == "up") { onRate(m.id, "up") }
            FooterButton("▼" + if (m.feedback == "down") " " + t("chatScreen.rateUnhelpful") else "", m.feedback == "down") { onRate(m.id, "down") }
            Spacer(Modifier.weight(1f))
            if (split.thinking != null) FooterButton("💭", reasoningShown) { reasoningShown = !reasoningShown }
            FooterButton("⧉", false) { clipboard.setText(AnnotatedString(shown)) }
        }
    }
}

@Composable
private fun Sources(sources: List<Source>) {
    val c = Boar.colors
    Column(Modifier.fillMaxWidth().background(c.bgSubtle, RoundedCornerShape(8.dp)).padding(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(t("sourceFootnotes.title"), style = Boar.type.micro, color = c.textMuted, fontWeight = FontWeight.Bold)
        sources.forEachIndexed { i, s ->
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("[${i + 1}]", style = Boar.type["mono.xs"], color = c.textAccentEmerald)
                Column {
                    Text(s.title, style = Boar.type.subtext, color = c.textSecondary)
                    s.source?.let { Text(it, style = Boar.type.micro, color = c.textDim, maxLines = 1) }
                }
            }
        }
    }
}

@Composable
private fun Badge(text: String) {
    val c = Boar.colors
    Text(text, style = Boar.type.caption, color = c.textAccentAmber,
        modifier = Modifier.background(c.amberBgSubtle, RoundedCornerShape(8.dp)).border(1.dp, c.amberBorder, RoundedCornerShape(8.dp)).padding(horizontal = 8.dp, vertical = 4.dp))
}

@Composable
private fun FooterButton(label: String, on: Boolean, onClick: () -> Unit) {
    val c = Boar.colors
    Text(label, style = Boar.type.caption, color = if (on) c.textAccentEmerald else c.textDim,
        modifier = Modifier.background(if (on) c.emeraldBgSubtle else c.bgSubtle, RoundedCornerShape(8.dp))
            .border(1.dp, if (on) c.emeraldBorder else c.borderSubtle, RoundedCornerShape(8.dp)).clickable(onClick = onClick).padding(horizontal = 8.dp, vertical = 4.dp))
}

@Composable
private fun InputBar(answering: Boolean, onSend: (String) -> Unit, onStop: () -> Unit) {
    val c = Boar.colors
    var text by remember { mutableStateOf("") }
    Row(Modifier.fillMaxWidth().background(c.bgSurface).padding(10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.weight(1f).background(c.bgInput, RoundedCornerShape(12.dp)).border(1.dp, c.borderDefault, RoundedCornerShape(12.dp)).padding(12.dp)) {
            if (text.isEmpty()) Text(t("chatScreen.inputPlaceholder"), style = Boar.type.bodyLg, color = c.textDim)
            BasicTextField(text, { text = it }, textStyle = Boar.type.bodyLg.copy(color = c.textPrimary), cursorBrush = SolidColor(c.emerald500), modifier = Modifier.fillMaxWidth(), maxLines = 5)
        }
        val canSend = text.isNotBlank() && !answering
        Box(
            Modifier.size(44.dp).background(if (answering) c.crimson500 else if (canSend) c.emerald500 else c.bgCard, CircleShape)
                .clickable(enabled = answering || canSend) { if (answering) onStop() else { onSend(text); text = "" } },
            contentAlignment = Alignment.Center,
        ) { Text(if (answering) "■" else "➤", style = Boar.type.title, color = c.textInverse) }
    }
}
