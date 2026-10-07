package team.sopa.boar

import android.content.Context
import android.content.res.Configuration
import android.os.Bundle
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.saveable.rememberSaveable
import team.sopa.boar.engine.settings.AppSettings
import team.sopa.boar.ui.settings.DisplayPrefs
import team.sopa.boar.ui.settings.SettingsScreen
import team.sopa.boar.setup.SetupViewModel
import team.sopa.boar.ui.setup.SetupScreen
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.platform.LocalView
import java.io.File
import java.util.Locale
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.launch
import team.sopa.boar.app.BoarServices
import team.sopa.boar.chat.ChatViewModel
import team.sopa.boar.engine.chat.ChatSession
import team.sopa.boar.ui.chat.ChatScreen
import team.sopa.boar.ui.t
import team.sopa.boar.ui.theme.Boar
import team.sopa.boar.ui.theme.BoarTheme

/** The app: first-run setup until the required models are on disk, then the chat with past chats and settings in the drawer. */
class MainActivity : ComponentActivity() {
    /** The app language from settings ("en", "pt"), else the phone's. */
    override fun attachBaseContext(base: Context) {
        val lang = AppSettings(File(base.filesDir, "settings.json")).languageId
        if (lang == null) return super.attachBaseContext(base)
        val config = Configuration(base.resources.configuration).apply { setLocale(Locale.forLanguageTag(lang)) }
        super.attachBaseContext(base.createConfigurationContext(config))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val services = BoarServices.get(this)
        setContent {
            var theme by remember { mutableStateOf(services.settings.themeId) }
            var fontScale by remember { mutableStateOf(services.settings.fontScale) }
            val prefs = object : DisplayPrefs {
                override fun setTheme(id: String) { theme = id }
                override fun setFontScale(scale: String) { fontScale = scale }
                override fun setLanguage(id: String?) { recreate() }
            }
            BoarTheme(theme, fontScale) {
                App(services, prefs)
            }
        }
    }
}

@Composable
private fun App(services: BoarServices, prefs: DisplayPrefs, vm: ChatViewModel = viewModel(), setup: SetupViewModel = viewModel()) {
    val state by vm.state.collectAsState()
    var screen by rememberSaveable { mutableStateOf(if (setup.ready()) "chat" else "setup") }
    if (screen == "setup") {
        val setupState by setup.state.collectAsState()
        // Downloads pause in the background on MIUI: the screen stays on while setup runs.
        val view = LocalView.current
        DisposableEffect(Unit) { view.keepScreenOn = true; onDispose { view.keepScreenOn = false } }
        BackHandler(setupState.step == 2) { setup.back() }
        SetupScreen(setupState, setup) { vm.refreshModel(); screen = "chat" }
        return
    }
    if (screen == "settings") {
        BackHandler { vm.refreshSettings(); screen = "chat" }
        SettingsScreen(services, prefs) { vm.refreshSettings(); screen = "chat" }
        return
    }
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    var sessions by remember { mutableStateOf<List<ChatSession>>(emptyList()) }
    LaunchedEffect(drawer.isOpen, state.answeringId) { if (drawer.isOpen) sessions = services.chats.listSessions() }
    ModalNavigationDrawer(
        drawerState = drawer,
        drawerContent = {
            ModalDrawerSheet(drawerContainerColor = Boar.colors.bgSurface, modifier = Modifier.width(300.dp)) {
                Column(Modifier.fillMaxHeight().statusBarsPadding().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(t("chatHeader.newChatSession"), style = Boar.type.title, color = Boar.colors.textAccentEmerald,
                        modifier = Modifier.fillMaxWidth().clickable { vm.newChat(); scope.launch { drawer.close() } }.padding(8.dp))
                    Text("⚙ " + t("native.drawer.settings"), style = Boar.type.body, color = Boar.colors.textSecondary,
                        modifier = Modifier.fillMaxWidth().clickable { screen = "settings"; scope.launch { drawer.close() } }.padding(8.dp))
                    LazyColumn(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        items(sessions, key = { it.id }) { s ->
                            Text(s.title, style = Boar.type.body, color = if (s.id == state.sessionId) Boar.colors.textHeading else Boar.colors.textSecondary, maxLines = 2,
                                modifier = Modifier.fillMaxWidth().background(if (s.id == state.sessionId) Boar.colors.bgCard else Boar.colors.bgSurface)
                                    .clickable { vm.openSession(s.id); scope.launch { drawer.close() } }.padding(8.dp))
                        }
                    }
                }
            }
        },
    ) {
        ChatScreen(
            state,
            onSend = vm::send,
            onStop = vm::stop,
            onNewChat = vm::newChat,
            onMenu = { scope.launch { drawer.open() } },
            onCycleTone = vm::cycleTone,
            onRate = vm::rate,
        )
    }
}
