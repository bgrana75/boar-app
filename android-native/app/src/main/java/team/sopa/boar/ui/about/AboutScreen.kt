package team.sopa.boar.ui.about

import androidx.compose.foundation.Image
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import team.sopa.boar.R
import team.sopa.boar.engine.BoarEngine
import team.sopa.boar.ui.t
import team.sopa.boar.ui.theme.Boar

/** About BOAR (AboutScreen.tsx), with the engine line for the native build and the CPU build it runs. */
@Composable
fun AboutScreen(onClose: () -> Unit) {
    val c = Boar.colors
    val ctx = LocalContext.current
    val info = versionName(ctx)
    val debug = (ctx.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
    Column(Modifier.fillMaxSize().background(c.bgSurface).statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().background(c.bgCardElevated).padding(horizontal = 12.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(t("aboutScreen.title"), style = Boar.type.titleSm, color = c.textHeading, modifier = Modifier.weight(1f))
            Text(t("common.done"), style = Boar.type["mono.xs"], color = c.textAccentCyan, fontWeight = FontWeight.ExtraBold,
                modifier = Modifier.clip(RoundedCornerShape(4.dp)).background(Color.White.copy(alpha = 0.08f)).clickable(onClick = onClose).padding(horizontal = 10.dp, vertical = 4.dp))
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(c.borderDefault))
        Column(Modifier.verticalScroll(rememberScrollState()).padding(12.dp).padding(bottom = 28.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.fillMaxWidth().padding(vertical = 12.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Image(painterResource(R.drawable.boar), null, Modifier.size(64.dp).clip(RoundedCornerShape(14.dp)).padding(bottom = 4.dp), contentScale = ContentScale.Fit)
                Text("BOAR", style = Boar.type.headline, color = c.textHeading)
                Text(t("aboutScreen.heroSubtitle"), style = Boar.type["mono.xs"].copy(letterSpacing = 0.5.sp), color = c.textAccentEmerald, fontWeight = FontWeight.ExtraBold)
                Text(
                    t("aboutScreen.versionBadge", "version" to info, "build" to t(if (debug) "aboutScreen.buildDevelopment" else "aboutScreen.buildRelease")) + " • llama.cpp · ${BoarEngine.loadedVariant ?: "—"}",
                    style = Boar.type["mono.xs"], color = c.textSecondary,
                    modifier = Modifier.padding(top = 4.dp).background(Color.White.copy(alpha = 0.06f), RoundedCornerShape(4.dp)).padding(horizontal = 8.dp, vertical = 3.dp),
                )
            }
            Card(t("aboutScreen.airGappedTitle"), t("native.about.airGappedBody"))
            Card(t("aboutScreen.hardwareTitle"), t("aboutScreen.hardwareBody"))
            Card(t("aboutScreen.benchmarkTitle"), t("aboutScreen.benchmarkBody"))
            Card(t("aboutScreen.repoTitle"), t("aboutScreen.repoBody")) {
                Text("github.com/rferrari/boar-app", style = Boar.type["mono.sm"], color = c.textAccentCyan,
                    modifier = Modifier.fillMaxWidth().background(c.bgTerminal, RoundedCornerShape(6.dp)).border(1.dp, c.borderDefault, RoundedCornerShape(6.dp)).padding(10.dp))
            }
        }
    }
}

@Composable
private fun versionName(ctx: android.content.Context): String =
    runCatching { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName }.getOrNull() ?: "—"

@Composable
private fun Card(title: String, body: String, extra: @Composable () -> Unit = {}) {
    val c = Boar.colors
    Column(Modifier.fillMaxWidth().background(c.bgCard, RoundedCornerShape(12.dp)).border(1.dp, c.borderSubtle, RoundedCornerShape(12.dp)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, style = Boar.type.titleSm, color = c.textHeading)
        Text(body, style = Boar.type.body, color = c.textSecondary)
        extra()
    }
}
