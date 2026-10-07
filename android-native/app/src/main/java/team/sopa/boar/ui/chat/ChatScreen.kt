package team.sopa.boar.ui.chat

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import team.sopa.boar.R
import team.sopa.boar.chat.Activity
import team.sopa.boar.chat.ChatState
import team.sopa.boar.chat.Source
import team.sopa.boar.chat.UiMessage
import team.sopa.boar.engine.answer.AnswerText
import team.sopa.boar.engine.answer.ResearchStage
import team.sopa.boar.ui.t
import team.sopa.boar.ui.theme.Boar
import team.sopa.boar.ui.theme.BrandType
import kotlin.math.sqrt

/**
 * The chat, laid out as src/ui-android/ChatScreen.tsx and ChatHeader.tsx with their style values: the ambient light,
 * header and sub-bar, the loading and Deep Research strips, the empty state, the bubbles and the input bar.
 */
@Composable
fun ChatScreen(
    state: ChatState,
    onSend: (String) -> Unit,
    onStop: () -> Unit,
    onNewChat: () -> Unit,
    onMenu: () -> Unit,
    onCycleTone: () -> Unit,
    onRate: (String, String) -> Unit,
) {
    val c = Boar.colors
    val list = rememberLazyListState()
    var input by remember { mutableStateOf("") }
    val last = state.messages.lastOrNull()
    LaunchedEffect(state.messages.size, last?.text?.length) {
        if (state.messages.isNotEmpty()) list.animateScrollToItem(state.messages.size - 1)
    }
    Box(Modifier.fillMaxSize().background(c.bgTerminal)) {
        Ambient()
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding()) {
            Header(state, onMenu, onCycleTone, onNewChat)
            if (state.deepResearch) DeepResearchBanner()
            state.loadingKey?.let { LoadingBanner(t(it)) }
            if (state.messages.isEmpty()) {
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    EmptyState(state.suggestions, onAsk = { onSend(it) }, onFill = { input = it })
                }
            } else {
                LazyColumn(
                    Modifier.weight(1f).fillMaxWidth(), state = list,
                    contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 12.dp, bottom = 20.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    items(state.messages, key = { it.id }) { m -> Bubble(m, state, onRate, onReuse = { input = it }) }
                }
            }
            InputBar(input, { input = it }, state.answeringId != null, onSend = { onSend(input); input = "" }, onStop)
        }
    }
}

/** components/Ambient.tsx: Campfire's ember glow rising from the bottom, Moonlight's faint moon at the top right. */
@Composable
private fun Ambient() {
    val c = Boar.colors
    if (c.id == "moonlight") {
        Box(Modifier.fillMaxSize()) {
            Box(Modifier.align(Alignment.TopEnd).offset(x = 40.dp, y = 120.dp).size(110.dp).alpha(0.13f).background(c.cyan500, CircleShape))
        }
        return
    }
    val glow = c.emerald500
    BoxWithConstraints(Modifier.fillMaxSize()) {
        // The ember box: 60 dp past each side, 440 dp tall, 170 dp below the bottom edge; "ellipse at 50% 100%".
        Box(
            Modifier.align(Alignment.BottomCenter).offset(y = 170.dp).size(maxWidth + 120.dp, 440.dp).drawBehind {
                val rx = size.width / 2 * sqrt(2f)
                val ry = size.height * sqrt(2f)
                val center = Offset(size.width / 2, size.height)
                scale(scaleX = 1f, scaleY = ry / rx, pivot = center) {
                    drawCircle(
                        Brush.radialGradient(0f to glow.copy(alpha = 0.25f), 0.45f to glow.copy(alpha = 0.0625f), 0.7f to glow.copy(alpha = 0f), center = center, radius = rx),
                        radius = rx, center = center,
                    )
                }
            },
        )
    }
}

/** ChatHeader.tsx */
@Composable
private fun Header(state: ChatState, onMenu: () -> Unit, onCycleTone: () -> Unit, onNewChat: () -> Unit) {
    val c = Boar.colors
    val type = Boar.type
    Column(Modifier.fillMaxWidth().background(c.bgSurface).padding(horizontal = 12.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            RoundButton(Color.White.copy(alpha = 0.05f), null, onMenu) { Text("☰", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = c.textHeading) }
            Row(Modifier.weight(1f).padding(start = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Image(painterResource(R.drawable.mascot), null, Modifier.size(42.dp).clip(CircleShape), contentScale = ContentScale.Fit)
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("BOAR", style = type.titleLg.copy(letterSpacing = 0.5.sp), color = c.textHeading)
                        StatusPill(state.online)
                    }
                    Text((state.modelLabel ?: t("chatHeader.localLlmCore")).uppercase(), style = type["mono.xs"], color = c.textDim, maxLines = 1, modifier = Modifier.padding(top = 1.dp))
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                RoundButton(Color.White.copy(alpha = 0.07f), c.borderSubtle, onCycleTone) { Text(state.toneIcon, fontSize = 14.sp) }
                RoundButton(c.emeraldBgSubtle, c.emeraldBorder, onNewChat) { Text("+", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = c.textAccentEmerald) }
            }
        }
        val tps = if (state.activity == Activity.Generating) state.liveTokPerSec else null
        if (state.deepResearch || tps != null) Row(verticalAlignment = Alignment.CenterVertically) {
            if (state.deepResearch) Row(
                Modifier.background(c.frontierBadgeBg, RoundedCornerShape(6.dp)).border(1.dp, c.frontierBadgeBorder, RoundedCornerShape(6.dp)).padding(horizontal = 8.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                Text("🔬", fontSize = 11.sp)
                Text(t("chatHeader.deepResearchActive"), style = type["mono.xs"], color = c.frontierText, fontWeight = FontWeight.Bold)
            }
            Spacer(Modifier.weight(1f))
            tps?.let {
                Row(
                    Modifier.background(Color(0x1F06B6D4), RoundedCornerShape(6.dp)).border(1.dp, c.cyanBorder, RoundedCornerShape(6.dp)).padding(horizontal = 8.dp, vertical = 3.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp),
                ) {
                    Text("●", fontSize = 8.sp, color = c.cyan400)
                    Text("%.1f".format(it), style = type["mono.xs"], color = c.textAccentCyan, fontWeight = FontWeight.Bold)
                    Text("tok/s", style = type["mono.xs"], color = c.textMuted)
                }
            }
        }
    }
    Box(Modifier.fillMaxWidth().height(1.dp).background(c.borderDefault))
}

@Composable
private fun RoundButton(bg: Color, border: Color?, onClick: () -> Unit, content: @Composable () -> Unit) {
    var m = Modifier.size(42.dp).clip(CircleShape).background(bg)
    if (border != null) m = m.border(1.dp, border, CircleShape)
    Box(m.clickable(onClick = onClick), contentAlignment = Alignment.Center) { content() }
}

@Composable
private fun StatusPill(online: Boolean) {
    val c = Boar.colors
    Row(
        Modifier.background(if (online) c.amberBgSubtle else c.emeraldBgSubtle, RoundedCornerShape(4.dp))
            .border(1.dp, if (online) c.amberBorder else c.emeraldBorder, RoundedCornerShape(4.dp)).padding(horizontal = 5.dp, vertical = 1.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Box(Modifier.size(5.dp).background(if (online) c.amber400 else c.emerald400, CircleShape))
        Text(t(if (online) "chatHeader.online" else "chatHeader.offline"), fontFamily = BrandType.familyFor("monospace", 800).first, fontSize = 8.sp,
            fontWeight = FontWeight.ExtraBold, color = if (online) c.textAccentAmber else c.textAccentEmerald)
    }
}

@Composable
private fun DeepResearchBanner() {
    val c = Boar.colors
    Row(Modifier.fillMaxWidth().background(c.frontierBadgeBg).padding(horizontal = 12.dp, vertical = 5.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("🔬", fontSize = 10.sp)
        Text(t("chatScreen.deepResearchBanner"), style = Boar.type["mono.xs"].copy(fontSize = 9.sp, letterSpacing = 0.4.sp), color = c.frontierText, fontWeight = FontWeight.Bold)
    }
    Box(Modifier.fillMaxWidth().height(1.dp).background(c.frontierBadgeBorder))
}

@Composable
private fun LoadingBanner(text: String) {
    val c = Boar.colors
    Row(Modifier.fillMaxWidth().background(c.emeraldBgSubtle).padding(horizontal = 12.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        androidx.compose.material3.CircularProgressIndicator(Modifier.size(12.dp), color = c.textAccentEmerald, strokeWidth = 1.5.dp)
        Text(text, style = Boar.type["mono.xs"], color = c.textAccentEmerald, fontWeight = FontWeight.SemiBold)
    }
    Box(Modifier.fillMaxWidth().height(1.dp).background(c.emeraldBorder))
}

/** components/ChatEmptyState.tsx: the boar, the name and tagline, then the suggested questions (tap asks, long-press fills). */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun EmptyState(suggestions: List<String>, onAsk: (String) -> Unit, onFill: (String) -> Unit) {
    val c = Boar.colors
    val type = Boar.type
    Column(Modifier.fillMaxSize().padding(horizontal = 12.dp).padding(top = 20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.fillMaxWidth().padding(bottom = 8.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Image(painterResource(R.drawable.mascot), null, Modifier.size(96.dp), contentScale = ContentScale.Fit)
            Text("BOAR", style = type.headline, color = c.textHeading)
            Text(t("chat.empty.tagline"), style = type.subtext.copy(fontFamily = BrandType.familyFor(null, 500).first), color = c.textAccentEmerald, textAlign = TextAlign.Center)
        }
        if (suggestions.isNotEmpty()) Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(t("chat.empty.suggestionsLabel"), style = type.caption, color = c.textSecondary, modifier = Modifier.padding(horizontal = 4.dp))
            for (k in suggestions) {
                val q = t("chat.suggestions.$k")
                Column(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(c.bgCard).combinedClickable(onClick = { onAsk(q) }, onLongClick = { onFill(q) })
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text(t("chat.suggestionTopics.$k"), style = type.caption.copy(fontFamily = BrandType.familyFor(null, 600).first), color = c.textAccentEmerald)
                    Text(q, style = type.body, color = c.textPrimary)
                }
            }
        }
    }
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

/** A message bubble (ChatScreen.tsx styles.bubble / userBubble / assistantBubble). */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Bubble(m: UiMessage, state: ChatState, onRate: (String, String) -> Unit, onReuse: (String) -> Unit) {
    val c = Boar.colors
    val type = Boar.type
    val user = m.role == "user"
    val streaming = state.answeringId == m.id
    var reasoningShown by remember { mutableStateOf(false) }
    val clipboard = LocalClipboardManager.current
    val shape = if (user) RoundedCornerShape(20.dp, 20.dp, 8.dp, 20.dp) else RoundedCornerShape(20.dp, 20.dp, 20.dp, 8.dp)
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val maxW = maxWidth * 0.92f
        var mod = Modifier.align(if (user) Alignment.CenterEnd else Alignment.CenterStart).widthIn(min = if (user) 0.dp else 200.dp, max = maxW).clip(shape)
            .background(if (user) c.bgCardHover else c.bgSurface)
        if (!user) mod = mod.border(1.dp, c.borderDefault, shape)
        if (user) mod = mod.combinedClickable(onClick = {}, onLongClick = { onReuse(m.text) })
        Column(mod.padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(Modifier.padding(bottom = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (!user) Image(painterResource(R.drawable.mascot), null, Modifier.size(20.dp).clip(RoundedCornerShape(4.dp)), contentScale = ContentScale.Fit)
                Text(if (user) t("chatScreen.roleYou") else t("chatScreen.roleAssistant"), style = type["mono.xs"].copy(letterSpacing = 0.5.sp),
                    color = if (user) c.textAccentCyan else c.textAccentEmerald, fontWeight = FontWeight.SemiBold)
            }
            if (user) {
                Text(m.text, style = type.bodyLg, color = c.textPrimary)
                return@Column
            }
            val split = AnswerText.splitThinking(m.text)
            // Sources are attached when the reply finishes, so invented citations are cleaned only then.
            val shown = if (streaming) split.answer else AnswerText.splitInlineBullets(AnswerText.cleanCitations(split.answer, m.sources.size))
            val reasoningStyle = Modifier.drawBehind { drawRect(c.borderDefault, size = size.copy(width = 2.dp.toPx())) }.padding(start = 8.dp, bottom = 8.dp)
            when {
                m.text.isEmpty() && streaming -> ProcessingIndicator(activityLabel(state.activity))
                split.thinkingInProgress && split.answer.isEmpty() && streaming ->
                    Text("💭 " + (split.thinking?.takeLast(160) ?: ""), fontSize = 12.sp, lineHeight = 17.sp, fontStyle = FontStyle.Italic, color = c.textDim, modifier = reasoningStyle)
                split.thinkingInProgress && split.answer.isEmpty() ->
                    Text("💭 " + t("chatScreen.reasoningUnfinished"), fontSize = 12.sp, lineHeight = 17.sp, fontStyle = FontStyle.Italic, color = c.textDim, modifier = reasoningStyle)
                else -> {
                    if (reasoningShown && split.thinking != null) Text(split.thinking!!, fontSize = 12.sp, lineHeight = 17.sp, fontStyle = FontStyle.Italic, color = c.textDim, modifier = reasoningStyle)
                    MarkdownMessage(shown, streaming)
                }
            }
            if (m.sources.isNotEmpty()) SourceFootnotes(m.sources)
            if (m.stopped) Badge("⏹ " + t("chatScreen.stoppedByUser"))
            if (m.timedOut) Badge("⏱ " + t("chatScreen.stageTimedOut"))
            if (m.text.isNotEmpty() && !streaming) {
                Box(Modifier.padding(top = 8.dp).fillMaxWidth().height(0.5.dp).background(c.borderSubtle))
                Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    FooterButton("▲", if (m.feedback == "up") t("chatScreen.rateHelpful") else null, m.feedback == "up", c.textAccentEmerald, c.emeraldBgSubtle, c.emeraldBorder) { onRate(m.id, "up") }
                    FooterButton("▼", if (m.feedback == "down") t("chatScreen.rateUnhelpful") else null, m.feedback == "down", c.crimson400, c.crimsonBgSubtle, c.crimsonBorder) { onRate(m.id, "down") }
                    Spacer(Modifier.weight(1f))
                    if (split.thinking != null) FooterButton("💭", null, reasoningShown, c.textAccentEmerald, c.emeraldBgSubtle, c.emeraldBorder) { reasoningShown = !reasoningShown }
                    var copied by remember { mutableStateOf(false) }
                    FooterButton("⧉", null, copied, c.textAccentEmerald, c.emeraldBgSubtle, c.emeraldBorder) { clipboard.setText(AnnotatedString(shown)); copied = true }
                }
            }
        }
    }
}

/** ProcessingIndicator.tsx: the stage line while nothing has streamed yet. */
@Composable
private fun ProcessingIndicator(label: String) {
    val c = Boar.colors
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        androidx.compose.material3.CircularProgressIndicator(Modifier.size(12.dp), color = c.textAccentEmerald, strokeWidth = 1.5.dp)
        Text(label, style = Boar.type.body, color = c.textMuted)
    }
}

@Composable
private fun FooterButton(glyph: String, label: String?, on: Boolean, onColor: Color, onBg: Color, onBorder: Color, onClick: () -> Unit) {
    val c = Boar.colors
    Row(
        Modifier.clip(RoundedCornerShape(4.dp)).background(if (on) onBg else c.bgSubtle).border(1.dp, if (on) onBorder else c.borderSubtle, RoundedCornerShape(4.dp))
            .clickable(onClick = onClick).padding(horizontal = 7.dp, vertical = 3.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(glyph, fontSize = 10.sp, lineHeight = 12.sp, fontWeight = FontWeight.Bold, color = if (on) onColor else c.textDim)
        label?.let { Text(it, style = Boar.type.micro.copy(fontSize = 10.sp, letterSpacing = 0.2.sp), fontWeight = FontWeight.SemiBold, color = onColor) }
    }
}

@Composable
private fun Badge(text: String) {
    val c = Boar.colors
    Text(text, style = Boar.type["mono.xs"], color = c.textAccentAmber, fontWeight = FontWeight.Bold,
        modifier = Modifier.padding(top = 4.dp).background(c.amberBgSubtle, RoundedCornerShape(4.dp)).border(1.dp, c.amberBorder, RoundedCornerShape(4.dp)).padding(horizontal = 6.dp, vertical = 2.dp))
}

/** The input bar (styles.inputContainer / input / sendBtn / stopBtn). Voice input isn't ported yet. */
@Composable
private fun InputBar(text: String, onText: (String) -> Unit, answering: Boolean, onSend: () -> Unit, onStop: () -> Unit) {
    val c = Boar.colors
    Box(Modifier.fillMaxWidth().height(1.dp).background(c.borderDefault))
    Row(Modifier.fillMaxWidth().background(c.bgCardElevated).padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.weight(1f).clip(RoundedCornerShape(50)).background(c.bgInput).border(1.dp, c.borderDefault, RoundedCornerShape(50)).padding(horizontal = 18.dp, vertical = 12.dp)) {
            val style = Boar.type.body.copy(fontSize = 14.sp, color = c.textPrimary)
            if (text.isEmpty()) Text(t("chatScreen.inputPlaceholder"), style = style, color = c.textDim)
            BasicTextField(text, onText, textStyle = style, cursorBrush = SolidColor(c.emerald500), modifier = Modifier.fillMaxWidth(), maxLines = 5)
        }
        val canSend = text.isNotBlank() && !answering
        val bg = if (answering) c.crimson600 else if (canSend) c.emerald600 else c.borderElevated
        Box(
            Modifier.size(48.dp).alpha(if (answering || canSend) 1f else 0.35f).clip(CircleShape).background(bg).clickable(enabled = answering || canSend) { if (answering) onStop() else onSend() },
            contentAlignment = Alignment.Center,
        ) { Text(if (answering) "■" else "➤", color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = if (answering) 14.sp else 16.sp) }
    }
}

