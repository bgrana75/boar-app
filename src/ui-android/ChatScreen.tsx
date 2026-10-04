import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Pressable,
  FlatList,
  StyleSheet,
  Keyboard,
  ActivityIndicator,
  Animated,
  AppState,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Image,
} from "react-native";
import { Text, TextInput } from "./components/AppText";
import { Ambient } from "./components/Ambient";
import { ChatEmptyState } from "./components/ChatEmptyState";
import { suggestionsFor } from "./chat/suggestions";
import { ModelManager } from "../models/ModelManager";
import { LinearGradient } from "expo-linear-gradient";
import { impact, notification, ImpactFeedbackStyle, NotificationFeedbackType } from "../services/haptics";
import * as Clipboard from "expo-clipboard";
import { useTranslation } from "react-i18next";
import { llamaEngine } from "../inference/LlamaEngine";
import { embeddingEngine } from "../rag/embed";
import { retrieve, assemblePrompt, RetrievedChunk, ConversationTurn } from "../rag/retrieve";
import { assembleChatMessages, ANSWER_CONTEXT_CHUNKS } from "../rag/pure";
import { budgetHistory } from "../routing/historyBudget";
import { compressForAnswer } from "../rag/compress";
import { classifyTask, isRetrievalIrrelevant } from "../routing/classify";
import type { TaskType } from "../routing/types";
import { onSeedProgress, seedKnowledgeBaseIfEmpty } from "../rag/seedCorpus";
import { MODEL_CATALOG, CORPUS_CATALOG, REQUIRED_MODELS, CatalogModel } from "../models/manifest";
import { listDiscoveredModels } from "../models/discoveredModels";
import { subscribeDownloads, listDownloadStates } from "../services/downloadManager";
import {
  getActiveModelId,
  getPersonalityId,
  setPersonalityId,
  getCustomSystemPrompt,
  getMaxTokens,
  getMemorySettings,
  MemorySettings as MemorySettingsType,
  DEFAULT_MEMORY_SETTINGS,
  getDeepResearchMode,
  getVoiceInputEnabled,
  getAdaptiveRoutingEnabled,
} from "../models/settings";
import { runDeepResearch, ResearchProgress } from "../services/orchestrator";
import { runAdaptiveChat } from "../services/adaptiveChat";
import { getPersonality, PersonalityId, PERSONALITIES } from "../constants/personalities";
import {
  createSession,
  addMessage as persistMessage,
  getMessages as getSessionMessages,
  listSessions,
  deleteSession,
  setSessionTitle,
  setSessionSummary,
  pruneSessions,
  setMessageFeedback,
  ChatSession,
} from "../services/chatHistory";
import { generateSessionTitle, summarizeConversation } from "../services/summarize";
import { PromptIdeasCarousel } from "./PromptIdeasCarousel";
import { VoiceInputButton } from "./VoiceInputButton";
import { ProcessingIndicator, ProcessingStatus } from "./ProcessingIndicator";
import { Drawer, DrawerItem } from "./Drawer";
import { AboutScreen } from "./AboutScreen";
import { KnowledgeBaseScreen } from "./KnowledgeBaseScreen";
import { ExecutionTelemetryScreen } from "./ExecutionTelemetryScreen";
import { ModelSetupScreen } from "./ModelSetupScreen";
import { EvaluationScreen } from "./EvaluationScreen";
import { takePendingEvalRequest } from "../eval/deviceEvalRequest";
import type { EvalRequest } from "../eval/deviceEvalRequest.pure";
import { ChatHeader } from "./ChatHeader";
import { Toast } from "./Toast";
import { ModelLoadErrorCard } from "./components/ModelLoadErrorCard";
import { MarkdownMessage } from "./components/MarkdownMessage";
import { splitInlineBullets } from "../services/answerFormat";
import { ReasoningPeek } from "./components/ReasoningPeek";
import { splitThinking, stripThinking } from "../services/thinking";
import { cleanCitations } from "../services/citations";
import { SourceFootnotes } from "./components/SourceFootnotes";
import { recordQueryStats, trackPeakRss, startAppMemoryTracking, QueryStats } from "../services/telemetry";
import { recordExecution } from "../services/executionTelemetry";
import { getMemoryInfo } from "ram-monitor";
import { useTheme, colors, typography } from "./theme";
import { spacing, radii } from "./theme/spacing";

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  citations?: RetrievedChunk[];
  stopped?: boolean;
  timedOut?: boolean;
  interruptedByBackground?: boolean;
  feedback?: "up" | "down" | null;
}

const VERBATIM_MESSAGE_COUNT = 6;

function researchStageLabel(p: ResearchProgress, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (p.stage === "decomposing") return t("chatScreen.research.decomposing");
  if (p.stage === "researching") {
    return t("chatScreen.research.researching", {
      index: (p.subQuestionIndex ?? 0) + 1,
      count: p.subQuestionCount ?? 1,
    });
  }
  return t("chatScreen.research.synthesizing");
}

async function resolveActiveModel(kind: "llm" | "embedding"): Promise<CatalogModel> {
  const activeId = await getActiveModelId(kind);
  const fallback = REQUIRED_MODELS.find((m) => m.kind === kind)!;
  if (!activeId) return fallback;
  // Models picked from the Hugging Face browser live in discoveredModels, not MODEL_CATALOG.
  const candidates = [...MODEL_CATALOG, ...(await listDiscoveredModels())];
  const found = candidates.find((m) => m.id === activeId && m.kind === kind);
  if (!found) console.warn(`[ChatScreen] active ${kind} model "${activeId}" not found, using ${fallback.id}`);
  return found ?? fallback;
}

export function ChatScreen({
  onRelaunchWizard,
}: {
  onRelaunchWizard?: () => void;
}) {
  const { colors, typography } = useTheme();
  const { t, i18n } = useTranslation();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [ready, setReady] = useState(false);
  const [loadStatus, setLoadStatus] = useState(t("chatScreen.initializingCore"));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  /** Set synchronously when a send starts, so a second tap can't slip in before `generating` updates. */
  const sendingRef = useRef(false);
  const [showPromptIdeas, setShowPromptIdeas] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showKnowledgeBase, setShowKnowledgeBase] = useState(false);
  const [showExecutionTelemetry, setShowExecutionTelemetry] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [voiceInputEnabled, setVoiceInputEnabledState] = useState(true);
  const showSettingsRef = useRef(false);
  showSettingsRef.current = showSettings;
  const [deviceEvalRequest, setDeviceEvalRequest] = useState<EvalRequest | null>(null);
  const [personalityId, setPersonalityIdState] = useState<PersonalityId>("succinct");
  const [processing, setProcessing] = useState<{ messageId: string; status: ProcessingStatus; label?: string } | null>(null);
  const [deepResearchActive, setDeepResearchActive] = useState(false);
  const [deepResearchEnabled, setDeepResearchEnabled] = useState(false);
  const [liveTokPerSec, setLiveTokPerSec] = useState<number | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeModel, setActiveModel] = useState<CatalogModel | null>(null);
  // send() reads the loaded model for telemetry without re-creating itself on every model change.
  const activeModelRef = useRef<CatalogModel | null>(null);
  activeModelRef.current = activeModel;

  // Knowledge packs on the phone: an empty chat only suggests questions they can answer.
  const [installedCorpora, setInstalledCorpora] = useState<string[]>([]);
  // Bumped when a download finishes, so a pack installed while the chat is empty adds its questions.
  const [downloadsDone, setDownloadsDone] = useState(0);
  const showEmptyState = messages.length === 0 && !showPromptIdeas;
  useEffect(() => {
    if (!showEmptyState) return;
    let cancelled = false;
    const manager = new ModelManager();
    Promise.all(CORPUS_CATALOG.map((c) => manager.statusOf(c)))
      .then((all) => {
        if (!cancelled) setInstalledCorpora(all.filter((st) => st.present).map((st) => st.asset.id));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // Also re-read when Settings or My Documents closes (a pack added or removed there).
  }, [showEmptyState, showSettings, showKnowledgeBase, downloadsDone]);
  const suggestions = useMemo(
    () => suggestionsFor(activeModel?.id, i18n.language, installedCorpora),
    [activeModel?.id, i18n.language, installedCorpora]
  );
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  // Assistant messages whose model reasoning (<think>…</think>) is expanded.
  const [shownReasoning, setShownReasoning] = useState<Set<string>>(new Set());
  const toggleReasoning = useCallback((id: string) => {
    setShownReasoning((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const [toast, setToast] = useState<string | null>(null);

  const listRef = useRef<FlatList<Message>>(null);
  // Keep the newest text in view while the reply streams, unless the user
  // scrolled up to read something; scrolling back near the bottom resumes it.
  const followBottom = useRef(true);
  const scrollToBottom = useCallback((animated = false) => {
    // Deferred a frame: on Android the content size reported to
    // onContentSizeChange can still be the previous one, leaving the end of
    // the reply cut off at the bottom of the list.
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated }));
  }, []);
  const onListScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    followBottom.current = contentSize.height - layoutMeasurement.height - contentOffset.y < 120;
  }, []);
  const inputRef = useRef<TextInput>(null);
  // Labels for whatever's downloadable — the built-in catalog (sync,
  // available immediately) plus anything the user added via the Hugging
  // Face browser (loaded once on mount; discoveredModels.ts persists these
  // separately from MODEL_CATALOG, see that file's own comment).
  const assetLabelsRef = useRef<Record<string, string>>(
    Object.fromEntries([...MODEL_CATALOG, ...CORPUS_CATALOG].map((m) => [m.id, m.label]))
  );
  // Which asset ids we've personally observed mid-download, so a
  // downloadManager notification firing for an unrelated reason (or one
  // that was already finished/failed before this screen mounted) doesn't
  // produce a false "download complete" toast.
  const seenDownloadingRef = useRef<Set<string>>(new Set());
  const memorySettingsRef = useRef<MemorySettingsType>(DEFAULT_MEMORY_SETTINGS);
  const deepResearchModeRef = useRef(false);
  const sessionSummaryRef = useRef<string | null>(null);
  const messagesRef = useRef<Message[]>([]);
  const backgroundTaskRef = useRef<Promise<void> | null>(null);
  const sendTaskRef = useRef<Promise<void> | null>(null);
  const processingRef = useRef<{ messageId: string; status: ProcessingStatus; label?: string } | null>(null);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    processingRef.current = processing;
  }, [processing]);

  useEffect(() => {
    const showSub = Keyboard.addListener("keyboardDidShow", (e) => {
      setKeyboardHeight(e.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener("keyboardDidHide", () => {
      setKeyboardHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  useEffect(() => {
    listDiscoveredModels().then((models) => {
      for (const m of models) assetLabelsRef.current[m.id] = m.label;
    });
  }, []);

  // downloadManager is a module-level singleton (see its own comment) —
  // a download started from the Models screen keeps running after the user
  // leaves Settings, so this toasts its completion in chat. Only toasts a
  // transition we actually watched happen (downloading -> done, no error),
  // and not one that finished while Settings was open: the user already saw
  // it there, and the toast would only appear later, on returning to chat.
  useEffect(() => {
    return subscribeDownloads(() => {
      for (const { assetId, state: dl } of listDownloadStates()) {
        if (dl.downloading) {
          seenDownloadingRef.current.add(assetId);
        } else if (seenDownloadingRef.current.has(assetId)) {
          seenDownloadingRef.current.delete(assetId);
          if (!dl.error) setDownloadsDone((n) => n + 1);
          if (!dl.error && !showSettingsRef.current) {
            const known = assetLabelsRef.current[assetId];
            if (known) {
              setToast(t("chatScreen.modelDownloadComplete", { label: known }));
            } else {
              // Added from the Hugging Face browser after this screen mounted.
              listDiscoveredModels().then((models) => {
                for (const m of models) assetLabelsRef.current[m.id] = m.label;
                const label = assetLabelsRef.current[assetId] ?? assetId;
                setToast(t("chatScreen.modelDownloadComplete", { label }));
              });
            }
          }
        }
      }
    });
  }, [t]);

  const refreshSessions = useCallback(async () => {
    setSessions(await listSessions());
  }, []);

  useEffect(() => {
    (async () => {
      setPersonalityIdState(await getPersonalityId());
      memorySettingsRef.current = await getMemorySettings();
      const drMode = await getDeepResearchMode();
      deepResearchModeRef.current = drMode;
      setVoiceInputEnabledState(await getVoiceInputEnabled());
      setDeepResearchEnabled(drMode);
      await refreshSessions();
    })();
  }, [refreshSessions]);

  const copyMessage = useCallback(
    async (id: string, text: string) => {
      await Clipboard.setStringAsync(text);
      impact(ImpactFeedbackStyle.Light);
      setCopiedMessageId(id);
      setTimeout(() => setCopiedMessageId((cur) => (cur === id ? null : cur)), 1500);
    },
    []
  );

  // Tapping the currently-active thumb again clears the rating (matches
  // copyMessage's own toggle-back-off pattern) rather than being a
  // one-way, unchangeable vote.
  const rateMessage = useCallback(
    async (id: string, rating: "up" | "down") => {
      const current = messagesRef.current.find((m) => m.id === id)?.feedback ?? null;
      const next = current === rating ? null : rating;
      impact(ImpactFeedbackStyle.Light);
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, feedback: next } : m)));
      await setMessageFeedback(id, next);
    },
    []
  );

  // Cycles every tone; Custom only when a custom prompt is written (an empty one acts like the default).
  // Long-press a sent message to put it back in the input and send it again.
  const reuseMessage = useCallback(
    (text: string) => {
      setInput(text);
      inputRef.current?.focus();
      impact(ImpactFeedbackStyle.Medium);
      setToast(t("chatScreen.messageReused"));
    },
    [t]
  );

  const cycleTone = useCallback(async () => {
    const customPrompt = (await getCustomSystemPrompt()) ?? "";
    const order = PERSONALITIES.map((p) => p.id).filter((id) => id !== "custom" || customPrompt.trim().length > 0);
    const next = order[(order.indexOf(personalityId) + 1) % order.length];
    setPersonalityIdState(next);
    await setPersonalityId(next);
    impact(ImpactFeedbackStyle.Light);
    setToast(t("chatScreen.toneChanged", { tone: `${getPersonality(next).icon} ${t(`personalities.${next}.label`)}` }));
  }, [personalityId, t]);

  const initModels = useCallback(async () => {
    try {
      setLoadError(null);
      setReady(false);
      setLoadStatus(t("chatScreen.mountingWeights"));
      const llm = await resolveActiveModel("llm");
      const emb = await resolveActiveModel("embedding");
      setActiveModel(llm);

      await Promise.all([
        llamaEngine.load(llm.filename),
        embeddingEngine.load(emb.filename),
      ]);
      startAppMemoryTracking();

      setLoadStatus(t("chatScreen.indexingKnowledgeBase"));
      const stopProgress = onSeedProgress((p) =>
        setLoadStatus(`${t("chatScreen.indexingKnowledgeBase")} ${p.done.toLocaleString()} / ${p.total.toLocaleString()}`)
      );
      await seedKnowledgeBaseIfEmpty().finally(stopProgress);
      setReady(true);
    } catch (e: any) {
      setLoadError(e?.message ?? String(e));
    }
  }, [t]);

  useEffect(() => {
    initModels();
  }, [initModels]);

  const generatingRef = useRef(false);
  useEffect(() => {
    generatingRef.current = generating;
  }, [generating]);

  // Development builds only: pick up an evaluation request written over adb
  // by scripts/eval-device.mjs (see src/eval/deviceEvalRequest.ts). Waits
  // until models are loaded, and leaves the request pending while a chat
  // reply is still generating.
  useEffect(() => {
    if (!__DEV__ || !ready || deviceEvalRequest) return;
    let cancelled = false;
    const check = async () => {
      if (cancelled || generatingRef.current) return;
      try {
        const request = await takePendingEvalRequest();
        if (request && !cancelled) setDeviceEvalRequest(request);
      } catch (e: any) {
        console.warn("[EVAL] could not read device request:", e?.message ?? e);
      }
    };
    check();
    const id = setInterval(check, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [ready, deviceEvalRequest]);

  const stopRequestedRef = useRef(false);

  // Stop only takes effect between generated tokens, so while the prompt is
  // still being processed it can take a while; show that the tap registered.
  const [stopping, setStopping] = useState(false);
  const stopGeneration = useCallback(async () => {
    stopRequestedRef.current = true;
    setStopping(true);
    setProcessing((prev) => (prev ? { ...prev, label: t("chatScreen.stopping") } : prev));
    impact(ImpactFeedbackStyle.Heavy);
    await llamaEngine.stop();
  }, [t]);

  const cancelBackgroundTask = useCallback(async () => {
    if (!backgroundTaskRef.current) return;
    await llamaEngine.stop();
    await backgroundTaskRef.current.catch(() => {});
    backgroundTaskRef.current = null;
  }, []);

  /**
   * Stops whatever's actively generating (single-pass or Deep Research) and
   * waits for send()'s own promise to fully settle — including its finally
   * block and DB persistence — before returning. Switching sessions or
   * starting a new chat while a generation is in flight used to just swap
   * `messages`/`activeSessionId` out from under it: the old generation kept
   * running against a now-stale assistantId, so its token updates and even
   * its final "insert the finished answer" update silently no-opped (a
   * .map() that can't find a matching id), losing the response from the
   * live UI even though it was still correctly persisted to that session's
   * history (only a fresh DB read — e.g. re-selecting the session — ever
   * surfaced it again). Awaiting the real generation task here, not just
   * the post-generation title/summary background task, closes that gap.
   */
  const stopAndAwaitGeneration = useCallback(async () => {
    if (!sendTaskRef.current) return;
    stopRequestedRef.current = true;
    await llamaEngine.stop();
    await sendTaskRef.current.catch(() => {});
  }, []);

  /**
   * Per docs/ADAPTIVE_ROUTING.md §14: no AppState handling existed anywhere
   * in the app before this — an in-flight generation (or, once the
   * execution engine exists, a multi-step routing pipeline) would just keep
   * burning CPU/battery invisibly if the user backgrounded the app, with no
   * cancellation and no way to know it happened. Default policy: background
   * -> stop immediately (reusing the exact same stop path as the Stop
   * button — no second cancellation mechanism), mark the in-progress
   * message as interrupted so it's visibly explained rather than silently
   * truncated, and let the user retry by just asking again.
   */
  useEffect(() => {
    const sub = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "background") return;
      if (!sendTaskRef.current) return;
      const interruptedId = processingRef.current?.messageId;
      stopAndAwaitGeneration().then(() => {
        if (interruptedId) {
          setMessages((prev) =>
            prev.map((m) => (m.id === interruptedId ? { ...m, interruptedByBackground: true } : m))
          );
        }
      });
    });
    return () => sub.remove();
  }, [stopAndAwaitGeneration]);

  const resetToNewChat = useCallback(async () => {
    await stopAndAwaitGeneration();
    await cancelBackgroundTask();
    setMessages([]);
    setActiveSessionId(null);
    sessionSummaryRef.current = null;
    impact(ImpactFeedbackStyle.Medium);
  }, [stopAndAwaitGeneration, cancelBackgroundTask]);

  const selectSession = useCallback(async (id: string) => {
    await stopAndAwaitGeneration();
    await cancelBackgroundTask();
    const records = await getSessionMessages(id);
    followBottom.current = true;
    setMessages(records.map((r) => ({ id: r.id, role: r.role, text: r.text, feedback: r.feedback })));
    setActiveSessionId(id);
    const session = sessions.find((s) => s.id === id);
    sessionSummaryRef.current = session?.summary ?? null;
  }, [stopAndAwaitGeneration, cancelBackgroundTask, sessions]);

  const removeSession = useCallback(
    async (id: string) => {
      await deleteSession(id);
      await refreshSessions();
      if (id === activeSessionId) await resetToNewChat();
    },
    [activeSessionId, refreshSessions, resetToNewChat]
  );

  /** `text`: send this instead of the input box (a prompt idea). */
  const send = useCallback(async (text?: string) => {
    const query = (text ?? input).trim();
    // sendingRef, not only `generating`: the state flips after the awaits below, and taps during
    // cancelBackgroundTask (a summary still reading its prompt, tens of seconds) each sent the
    // question again, all with the same millisecond ids (UNIQUE constraint failed: chat_messages.id).
    if (!query || generating || sendingRef.current) return;
    sendingRef.current = true;
    setInput("");
    setGenerating(true);

    let sessionId = activeSessionId;
    const isNewSession = !sessionId;
    // Unique even for two sends in the same millisecond.
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const userMsg: Message = { id: `${stamp}-u`, role: "user", text: query };
    const assistantId = `${stamp}-a`;
    try {
      await cancelBackgroundTask();
      stopRequestedRef.current = false;
      if (!sessionId) {
        const session = await createSession();
        sessionId = session.id;
        setActiveSessionId(sessionId);
      }
      // Explicit id, matching the in-memory message id used for the FlatList
      // key/React state — so a thumbs-up/down tap on this exact message can
      // reference `item.id` directly as answer_feedback's foreign key later,
      // rather than needing a separate id-mapping step.
      await persistMessage(sessionId, "user", query, userMsg.id);
    } catch (e: any) {
      console.warn("[ChatScreen] send failed before generation:", e?.message ?? e);
      sendingRef.current = false;
      setGenerating(false);
      setInput(query);
      return;
    }

    setMessages((prev) => [...prev, userMsg, { id: assistantId, role: "assistant", text: "" }]);
    setProcessing({ messageId: assistantId, status: "retrieving" });

    // The loaded model answers unless adaptive routing picks another (its telemetry overrides this).
    const baseModelId = activeModelRef.current?.id;
    let fixedTaskType: TaskType | undefined;
    const peakRss = trackPeakRss(() => {
      try {
        return getMemoryInfo().rssBytes;
      } catch {
        return 0;
      }
    });
    const startTime = performance.now();
    let ttftMs = 0;
    let tokensGenerated = 0;
    let assistantText = "";

    try {
      const [maxTokens, activePersonalityId, customPrompt] = await Promise.all([
        getMaxTokens(),
        getPersonalityId(),
        getCustomSystemPrompt(),
      ]);
      const personality = getPersonality(activePersonalityId);
      const systemPrompt = activePersonalityId === "custom" ? customPrompt : personality.systemPrompt;
      const styleReminder = activePersonalityId === "custom" ? undefined : personality.styleReminder;

      const priorMessages = messagesRef.current.filter((m) => m.text.length > 0);
      // Within a token budget: earlier answers cut to their opening sentences (historyBudget.ts).
      const verbatimTurns: ConversationTurn[] = budgetHistory(
        priorMessages
          .slice(-VERBATIM_MESSAGE_COUNT)
          .map((m) => ({ role: m.role, text: m.role === "assistant" ? stripThinking(m.text) : m.text }))
      );
      const history = { summary: sessionSummaryRef.current, turns: verbatimTurns };

      let firstToken = true;
      let firstTokenTime = 0;
      const onToken = (piece: string) => {
        tokensGenerated += 1;
        assistantText += piece;
        if (firstToken) {
          firstToken = false;
          firstTokenTime = performance.now();
          ttftMs = firstTokenTime - startTime;
          setProcessing({ messageId: assistantId, status: "generating" });
        } else {
          const elapsedSinceFirst = (performance.now() - firstTokenTime) / 1000;
          if (elapsedSinceFirst > 0) setLiveTokPerSec(tokensGenerated / elapsedSinceFirst);
        }
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, text: m.text + piece } : m))
        );
      };

      let chunks: RetrievedChunk[];
      // Adaptive-routing-specific telemetry, merged into the regular
      // recordQueryStats() call below — stays null (contributing nothing)
      // for Deep Research and for the plain fixed-active-model path, so
      // existing QueryStats consumers see no shape change for those.
      let adaptiveTelemetry: Partial<QueryStats> | null = null;

      if (deepResearchModeRef.current) {
        // Deep Research Mode is completely separate from adaptive routing
        // and untouched by it — orchestrator.ts's own sequential pipeline,
        // same as before this integration.
        setDeepResearchActive(true);
        const result = await runDeepResearch(
          query,
          systemPrompt,
          history,
          maxTokens,
          (p: ResearchProgress) => {
            setProcessing({ messageId: assistantId, status: "thinking", label: researchStageLabel(p, t) });
          },
          onToken,
          () => stopRequestedRef.current
        );
        chunks = result.citations;
        if (result.timedOut) {
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, timedOut: true } : m))
          );
        }
      } else {
        // classifyTask/isRetrievalIrrelevant are the same deterministic,
        // tested rule router.ts uses (src/routing/classify.ts) — reused
        // directly by the fixed-model path below regardless of whether
        // adaptive routing is enabled, so a pure greeting like "wake up!"
        // never retrieves unrelated knowledge-base chunks either way.
        const runFixedModelChat = async (): Promise<RetrievedChunk[]> => {
          let c: RetrievedChunk[];
          fixedTaskType = classifyTask(query);
          if (isRetrievalIrrelevant(fixedTaskType)) {
            c = [];
          } else {
            setProcessing({ messageId: assistantId, status: "retrieving" });
            // Only the sentences that answer: a shorter prompt brings the first word sooner.
            c = compressForAnswer(query, await retrieve(query, ANSWER_CONTEXT_CHUNKS), fixedTaskType).chunks;
          }
          setProcessing({ messageId: assistantId, status: "thinking" });
          // Use the model's own chat template when its file ships one; the
          // plain prompt is only a fallback. Off-template, models ramble,
          // echo instructions, and reasoning models never open <think>.
          await llamaEngine.generate(
            llamaEngine.hasEmbeddedChatTemplate()
              ? { messages: assembleChatMessages(query, c, systemPrompt, history, styleReminder), nPredict: maxTokens, onToken }
              : { prompt: assemblePrompt(query, c, systemPrompt, history, styleReminder), nPredict: maxTokens, onToken }
          );
          return c;
        };

        const adaptiveRoutingEnabled = await getAdaptiveRoutingEnabled();

        if (adaptiveRoutingEnabled) {
          try {
            const result = await runAdaptiveChat(
              { query, systemPrompt, styleReminder, history },
              maxTokens,
              {
                onToken,
                shouldStop: () => stopRequestedRef.current,
                onStepStart: (step) => {
                  setProcessing({
                    messageId: assistantId,
                    status: step.type === "retrieve" ? "retrieving" : "thinking",
                  });
                },
              }
            );

            // executeRoutingPlan doesn't throw when a required step's model
            // can't be resolved — it resolves normally with an empty answer
            // and a warning instead. And when NOTHING is available at all
            // (no model resolves to any role), planRoute never even builds
            // a generate step, so executor-level `warnings` stays empty too
            // — checking for that would miss this case entirely. The
            // simple, comprehensive signal is just "no answer text and the
            // user didn't stop it themselves" — a try/catch alone wouldn't
            // see either of these as a failure, but the user would still be
            // left with a blank response, so it's checked explicitly and
            // falls back the same way a thrown error does.
            if (result.answer.trim().length === 0 && !stopRequestedRef.current) {
              console.warn("[ChatScreen] adaptive routing produced no answer, falling back:", result.warnings, result.plan.reasonCodes);
              adaptiveTelemetry = { adaptiveRoutingUsed: true, outcome: "failure" };
              chunks = await runFixedModelChat();
            } else {
              chunks = result.citations;
              if (result.timedOut) {
                setMessages((prev) =>
                  prev.map((m) => (m.id === assistantId ? { ...m, timedOut: true } : m))
                );
              }
              if (result.modelUsed) setActiveModel(result.modelUsed);
              adaptiveTelemetry = {
                adaptiveRoutingUsed: true,
                modelId: result.plan.steps.find((s) => s.type === "generate")?.modelId,
                taskType: result.taskType,
                reasonCodes: result.plan.reasonCodes,
                modelSwitches: result.modelSwitches,
                crossMessageModelSwitch: result.crossMessageModelSwitch,
                modelResidency: result.modelResidency,
                modelLoadMs: result.modelLoadMs,
                retrievalUsed: chunks.length > 0,
                generationLatencyMs: result.generationLatencyMs,
                outcome: stopRequestedRef.current ? "cancelled" : "success",
              };
              // Override the generic ttftMs/tokPerSec the base
              // recordQueryStats() call below already computes (measured
              // from message-send start, which for this path includes
              // model load time) with executor.ts's precisely-scoped
              // value — model load time is measured separately
              // (modelLoadMs) and deliberately excluded from ttftMs here,
              // the whole point of this fix. Only assigned when actually
              // available (no generate step ran at all, e.g. no model
              // resolvable, leaves it unset) — QueryStats.ttftMs is a
              // required field, so setting it to undefined here would
              // overwrite the base object's generic fallback instead of
              // preserving it.
              if (result.ttftMs !== undefined) {
                adaptiveTelemetry.ttftMs = result.ttftMs;
                if (result.generationLatencyMs && result.generationLatencyMs > 0) {
                  adaptiveTelemetry.tokPerSec = tokensGenerated / (result.generationLatencyMs / 1000);
                }
              }
            }
          } catch (e: any) {
            // A routing failure must never leave the user without a
            // response — same fixed-active-model path as adaptive routing
            // being off, just reached via a caught exception instead.
            console.warn("[ChatScreen] adaptive routing threw, falling back to active model:", e?.message ?? String(e));
            adaptiveTelemetry = { adaptiveRoutingUsed: true, outcome: "failure" };
            chunks = await runFixedModelChat();
          }
        } else {
          chunks = await runFixedModelChat();
        }
      }

      const wasStopped = stopRequestedRef.current;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, citations: chunks, stopped: wasStopped } : m
        )
      );
      notification(wasStopped ? NotificationFeedbackType.Warning : NotificationFeedbackType.Success);

      const durationMs = performance.now() - startTime;
      const finalStats: QueryStats = {
        tokensGenerated,
        durationMs,
        ttftMs,
        tokPerSec: tokensGenerated > 0 ? tokensGenerated / ((durationMs - ttftMs) / 1000) : 0,
        peakRssBytes: peakRss.stop(),
        timestamp: Date.now(),
        totalLatencyMs: durationMs,
        modelId: baseModelId,
        ...(fixedTaskType ? { taskType: fixedTaskType, retrievalUsed: chunks.length > 0 } : {}),
        ...(adaptiveTelemetry ?? {}),
      };
      recordQueryStats(finalStats);
      // Persisted (SQLite), survives reload/restart — telemetry.ts's
      // recordQueryStats above stays the separate, unmodified in-memory
      // compatibility layer for the existing live Usage Stats display; this
      // is the new Phase 7 source of truth. Fire-and-forget: telemetry
      // must never block or fail the chat response the user already has.
      recordExecution({
        modelId: finalStats.modelId,
        taskType: finalStats.taskType,
        adaptiveRoutingUsed: finalStats.adaptiveRoutingUsed ?? false,
        reasonCodes: finalStats.reasonCodes,
        retrievalUsed: finalStats.retrievalUsed,
        modelSwitches: finalStats.modelSwitches,
        crossMessageModelSwitch: finalStats.crossMessageModelSwitch,
        modelResidency: finalStats.modelResidency,
        modelLoadMs: finalStats.modelLoadMs,
        ttftMs: finalStats.ttftMs,
        generationLatencyMs: finalStats.generationLatencyMs,
        totalLatencyMs: finalStats.totalLatencyMs,
        tokensGenerated: finalStats.tokensGenerated,
        tokPerSec: finalStats.tokPerSec,
        peakRssBytes: finalStats.peakRssBytes,
        outcome: finalStats.outcome ?? (wasStopped ? "cancelled" : "success"),
      }).catch(() => {});

      if (assistantText.trim().length > 0) {
        await persistMessage(sessionId, "assistant", assistantText, assistantId);
      }

      const settings = memorySettingsRef.current;
      const allMessages = [...priorMessages, userMsg, { ...userMsg, id: assistantId, role: "assistant" as const, text: assistantText }];

      if (isNewSession && settings.autoGenerateTitles && !wasStopped) {
        const sid = sessionId;
        backgroundTaskRef.current = generateSessionTitle(query)
          .then(async (title) => {
            await setSessionTitle(sid, title);
            await refreshSessions();
          })
          .catch(() => {})
          .finally(() => {
            backgroundTaskRef.current = null;
          });
      } else if (settings.autoSummarize && !wasStopped) {
        const totalTurns = Math.floor(allMessages.length / 2);
        if (totalTurns > settings.historyTurnThreshold) {
          const olderMessages = allMessages.slice(0, -VERBATIM_MESSAGE_COUNT);
          if (olderMessages.length > 0) {
            const sid = sessionId;
            // Bounded like the answer's history: the whole detailed chat (thousands of tokens) took tens
            // of seconds to read, and the next question waited for it (cancelBackgroundTask).
            const turnsToSummarize: ConversationTurn[] = budgetHistory(
              olderMessages.map((m) => ({
                role: m.role,
                text: m.role === "assistant" ? stripThinking(m.text) : m.text,
              }))
            );
            const previousSummary = sessionSummaryRef.current;
            backgroundTaskRef.current = summarizeConversation(turnsToSummarize, previousSummary)
              .then(async (summary) => {
                sessionSummaryRef.current = summary;
                await setSessionSummary(sid, summary);
              })
              .catch(() => {})
              .finally(() => {
                backgroundTaskRef.current = null;
              });
          }
        }
      }

      await pruneSessions(settings.maxSavedSessions);
    } catch (e: any) {
      peakRss.stop();
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, text: `Error: ${e?.message ?? e}` } : m
        )
      );
      // Minimal failure record — adaptiveTelemetry is scoped inside the
      // inner try block above, not accessible here, so this can't say
      // whether adaptive routing was involved; still worth capturing that
      // a request failed at all, with what timing we do have.
      recordExecution({
        adaptiveRoutingUsed: false,
        modelId: baseModelId,
        totalLatencyMs: performance.now() - startTime,
        tokensGenerated,
        outcome: "failure",
        errorMessage: e?.message ?? String(e),
      }).catch(() => {});
    } finally {
      sendingRef.current = false;
      setGenerating(false);
      setStopping(false);
      setProcessing(null);
      setLiveTokPerSec(null);
      setDeepResearchActive(false);
    }
  }, [input, generating, activeSessionId, cancelBackgroundTask, refreshSessions]);

  // send() itself isn't awaited by its callers (onPress/onSubmitEditing) —
  // stopAndAwaitGeneration needs a handle on the in-flight promise so a
  // session switch can wait for it to actually finish. Only the entry point
  // sets sendTaskRef; send() doesn't need to know about it.
  const handleSend = useCallback((text?: string) => {
    followBottom.current = true;
    scrollToBottom(true);
    sendTaskRef.current = send(text).finally(() => {
      sendTaskRef.current = null;
    });
  }, [send, scrollToBottom]);

  const drawerItems: DrawerItem[] = [
    { key: "prompts", label: t("chatScreen.drawerItems.prompts"), onPress: () => setShowPromptIdeas(true) },
    { key: "knowledge", label: t("chatScreen.drawerItems.myDocuments"), onPress: () => setShowKnowledgeBase(true) },
    { key: "settings", label: t("chatScreen.drawerItems.settings"), onPress: () => setShowSettings(true) },
    { key: "telemetry", label: t("chatScreen.drawerItems.telemetry"), onPress: () => setShowExecutionTelemetry(true) },
    { key: "about", label: t("chatScreen.drawerItems.about"), onPress: () => setShowAbout(true) },
  ];

  if (deviceEvalRequest) {
    return <EvaluationScreen deviceRequest={deviceEvalRequest} onClose={() => setDeviceEvalRequest(null)} />;
  }

  if (showSettings) {
    return (
      <ModelSetupScreen
        mode="optional"
        onClose={async () => {
          setShowSettings(false);
          getVoiceInputEnabled().then(setVoiceInputEnabledState);
          // Deep Research is switched in Settings only.
          const drMode = await getDeepResearchMode();
          deepResearchModeRef.current = drMode;
          setDeepResearchEnabled(drMode);
          // Settings loads a newly chosen LLM itself; only re-run the full
          // init (with its loading screen) if what's loaded doesn't match.
          const llm = await resolveActiveModel("llm");
          if (ready && llamaEngine.getModelInfo()?.filename === llm.filename) {
            setActiveModel(llm);
          } else {
            initModels();
          }
        }}
        onRelaunchWizard={onRelaunchWizard}
      />
    );
  }

  if (showExecutionTelemetry) {
    return <ExecutionTelemetryScreen chatBusy={generating} onClose={() => setShowExecutionTelemetry(false)} />;
  }

  if (showKnowledgeBase) {
    return <KnowledgeBaseScreen onClose={() => setShowKnowledgeBase(false)} />;
  }

  if (showAbout) {
    return <AboutScreen onClose={() => setShowAbout(false)} />;
  }

  const isDeepActive = deepResearchEnabled || deepResearchActive;

  return (
    <LinearGradient
      colors={isDeepActive ? [colors.frontier.gradientStart, colors.bg.terminal] : [colors.bg.terminal, colors.bg.surface]}
      style={styles.container}
    >
      {/* The theme's light: Campfire's ember glow, Moonlight's moon */}
      <Ambient />

      <View style={[styles.flex, { paddingBottom: keyboardHeight }]}>
        <ChatHeader
          toneIcon={getPersonality(personalityId).icon}
          deepResearchActive={isDeepActive}
          liveTokPerSec={liveTokPerSec}
          activeModelLabel={activeModel?.label}
          onOpenDrawer={() => {
            refreshSessions();
            setDrawerOpen(true);
          }}
          onCycleTone={cycleTone}
          onNewChat={resetToNewChat}
        />

        {/* Deep Research Mode Banner */}
        {isDeepActive && (
          <View style={[styles.deepResearchBanner, { backgroundColor: colors.frontier.badgeBg, borderBottomColor: colors.frontier.badgeBorder }]}>
            <View style={styles.deepBannerPill}>
              <Text style={styles.deepBannerIcon}>🔬</Text>
              <Text style={[styles.deepBannerText, { color: colors.frontier.text }]}>
                {t("chatScreen.deepResearchBanner")}
              </Text>
            </View>
          </View>
        )}

        {loadError && (
          <ModelLoadErrorCard
            error={loadError}
            onOpenSettings={() => setShowSettings(true)}
            onRelaunchWizard={onRelaunchWizard}
            onRetry={initModels}
          />
        )}

        {!ready && !loadError && (
          <View style={[styles.loadingBanner, { backgroundColor: colors.emerald.bgSubtle, borderBottomColor: colors.emerald.border }]}>
            <ActivityIndicator color={colors.emerald[400]} size="small" />
            <Text style={[styles.loadingBannerText, { color: colors.text.accentEmerald }]}>{loadStatus}</Text>
          </View>
        )}

        <FlatList
          ref={listRef}
          style={styles.flex}
          data={messages}
          keyExtractor={(m) => m.id}
          contentContainerStyle={[styles.list, showEmptyState && styles.listEmpty]}
          ListEmptyComponent={
            showEmptyState ? (
              <ChatEmptyState
                suggestions={suggestions}
                onAsk={(q) => (ready && !generating ? handleSend(q) : setInput(q))}
                onFill={(q) => {
                  setInput(q);
                  requestAnimationFrame(() => inputRef.current?.focus());
                }}
              />
            ) : null
          }
          // Animated scrolling during active streaming fires on nearly every
          // token — each call starts a new scroll animation before the last
          // one finishes, so they fight each other and the view visibly
          // lags behind the growing text until generation stops and the
          // final call actually completes. Snap instantly while generating;
          // animate only for the normal (new message / not streaming) case.
          onContentSizeChange={() => {
            if (followBottom.current) scrollToBottom(!generating);
          }}
          // The list gets shorter when the keyboard opens; keep the end in view.
          onLayout={() => {
            if (followBottom.current) scrollToBottom();
          }}
          onScroll={onListScroll}
          scrollEventThrottle={100}
          renderItem={({ item }) => {
            const showProcessing =
              item.text === "" && processing?.messageId === item.id && processing.status !== "generating";
            const isStreamingThis = generating && item.role === "assistant" && processing?.messageId === item.id;
            const split = item.role === "assistant" ? splitThinking(item.text) : null;
            // Sources are attached when the reply finishes, so clean invented citations only then.
            const shownText = split
              ? isStreamingThis
                ? split.answer
                : splitInlineBullets(cleanCitations(split.answer, item.citations?.length))
              : item.text;
            const reasoningShown = shownReasoning.has(item.id);

            return (
              <Pressable
                onLongPress={item.role === "user" ? () => reuseMessage(item.text) : undefined}
                delayLongPress={350}
                style={[
                  styles.bubble,
                  item.role === "user"
                    ? [styles.userBubble, { backgroundColor: colors.bg.cardHover }]
                    : [styles.assistantBubble, { backgroundColor: colors.bg.surface, borderColor: colors.border.default }],
                ]}
              >
                {/* Bubble role label */}
                <View style={styles.bubbleHeader}>
                  <View style={styles.bubbleRole}>
                    {item.role !== "user" && (
                      <Image source={require("../../assets/mascot.png")} style={styles.bubbleAvatar} resizeMode="contain" />
                    )}
                    <Text
                      style={[
                        styles.bubbleRoleLabel,
                        item.role === "user"
                          ? [styles.userRoleLabel, { color: colors.text.accentCyan }]
                          : [styles.assistantRoleLabel, { color: colors.text.accentEmerald }],
                      ]}
                    >
                      {item.role === "user" ? t("chatScreen.roleYou") : t("chatScreen.roleAssistant")}
                    </Text>
                  </View>
                </View>

                {showProcessing ? (
                  <ProcessingIndicator
                    status={processing!.status as Exclude<ProcessingStatus, "idle">}
                    label={processing!.label}
                  />
                ) : (
                  <>
                    {split?.thinking && reasoningShown && (
                      <Text style={[styles.reasoningText, { color: colors.text.dim, borderLeftColor: colors.border.default }]}>
                        {split.thinking}
                      </Text>
                    )}
                    {split?.thinkingInProgress && !split.answer && isStreamingThis ? (
                      <ReasoningPeek
                        thinking={split.thinking ?? ""}
                        expanded={reasoningShown}
                        onToggle={() => toggleReasoning(item.id)}
                      />
                    ) : split?.thinkingInProgress && !split.answer ? (
                      // Ended (stopped or out of tokens) while still reasoning.
                      <Text style={[styles.reasoningText, { color: colors.text.dim, borderLeftColor: colors.border.default }]}>
                        💭 {t("chatScreen.reasoningUnfinished")}
                      </Text>
                    ) : (
                      <MarkdownMessage content={shownText} isStreaming={isStreamingThis} />
                    )}
                  </>
                )}

                {item.citations && item.citations.length > 0 && (
                  <SourceFootnotes citations={item.citations} />
                )}

                {item.stopped && (
                  <View style={[styles.stoppedBadge, { backgroundColor: colors.amber.bgSubtle, borderColor: colors.amber.border }]}>
                    <Text style={[styles.stoppedTag, { color: colors.text.accentAmber }]}>⏹ {t("chatScreen.stoppedByUser")}</Text>
                  </View>
                )}

                {item.timedOut && (
                  <View style={[styles.stoppedBadge, { backgroundColor: colors.amber.bgSubtle, borderColor: colors.amber.border }]}>
                    <Text style={[styles.stoppedTag, { color: colors.text.accentAmber }]}>⏱ {t("chatScreen.stageTimedOut")}</Text>
                  </View>
                )}

                {item.interruptedByBackground && (
                  <View style={[styles.stoppedBadge, { backgroundColor: colors.amber.bgSubtle, borderColor: colors.amber.border }]}>
                    <Text style={[styles.stoppedTag, { color: colors.text.accentAmber }]}>⏸ {t("chatScreen.interruptedByBackground")}</Text>
                  </View>
                )}

                {item.role === "assistant" && item.text.length > 0 && (
                  <View style={[styles.bubbleFooter, { borderTopColor: colors.border.subtle }]}>
                    <Pressable
                      onPress={() => rateMessage(item.id, "up")}
                      hitSlop={6}
                      accessibilityLabel={t("chatScreen.rateUp")}
                      style={[
                        styles.footerBtn,
                        {
                          backgroundColor:
                            item.feedback === "up" ? colors.emerald.bgSubtle : colors.bg.subtle,
                          borderColor:
                            item.feedback === "up" ? colors.emerald.border : colors.border.subtle,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.footerGlyph,
                          {
                            color:
                              item.feedback === "up" ? colors.text.accentEmerald : colors.text.dim,
                          },
                        ]}
                      >
                        ▲
                      </Text>
                      {item.feedback === "up" && (
                        <Text
                          style={[
                            styles.footerBtnLabel,
                            { color: colors.text.accentEmerald },
                          ]}
                        >
                          {t("chatScreen.rateHelpful", "Helpful")}
                        </Text>
                      )}
                    </Pressable>

                    <Pressable
                      onPress={() => rateMessage(item.id, "down")}
                      hitSlop={6}
                      accessibilityLabel={t("chatScreen.rateDown")}
                      style={[
                        styles.footerBtn,
                        {
                          backgroundColor:
                            item.feedback === "down" ? colors.crimson.bgSubtle : colors.bg.subtle,
                          borderColor:
                            item.feedback === "down" ? colors.crimson.border : colors.border.subtle,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.footerGlyph,
                          {
                            color:
                              item.feedback === "down" ? colors.crimson[400] : colors.text.dim,
                          },
                        ]}
                      >
                        ▼
                      </Text>
                      {item.feedback === "down" && (
                        <Text
                          style={[
                            styles.footerBtnLabel,
                            { color: colors.crimson[400] },
                          ]}
                        >
                          {t("chatScreen.rateUnhelpful", "Unhelpful")}
                        </Text>
                      )}
                    </Pressable>

                    <View style={styles.footerSpacer} />

                    {split?.thinking && (
                      <Pressable
                        onPress={() => toggleReasoning(item.id)}
                        hitSlop={6}
                        accessibilityLabel={reasoningShown ? t("chatScreen.hideReasoning") : t("chatScreen.showReasoning")}
                        style={[
                          styles.footerBtn,
                          {
                            backgroundColor: reasoningShown ? colors.emerald.bgSubtle : colors.bg.subtle,
                            borderColor: reasoningShown ? colors.emerald.border : colors.border.subtle,
                          },
                        ]}
                      >
                        <Text style={styles.footerGlyph}>💭</Text>
                      </Pressable>
                    )}

                    <Pressable
                      onPress={() => copyMessage(item.id, shownText)}
                      hitSlop={6}
                      accessibilityLabel={t("chatScreen.copyResponse")}
                      style={[
                        styles.footerBtn,
                        {
                          backgroundColor:
                            copiedMessageId === item.id ? colors.emerald.bgSubtle : colors.bg.subtle,
                          borderColor:
                            copiedMessageId === item.id ? colors.emerald.border : colors.border.subtle,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.footerGlyph,
                          {
                            color:
                              copiedMessageId === item.id
                                ? colors.text.accentEmerald
                                : colors.text.dim,
                          },
                        ]}
                      >
                        {copiedMessageId === item.id ? "✓" : "⧉"}
                      </Text>
                      {copiedMessageId === item.id && (
                        <Text
                          style={[
                            styles.footerBtnLabel,
                            { color: colors.text.accentEmerald },
                          ]}
                        >
                          {t("chatScreen.copied", "Copied")}
                        </Text>
                      )}
                    </Pressable>
                  </View>
                )}
              </Pressable>
            );
          }}
        />

        {/* Input Bar */}
        <View style={[styles.inputContainer, { backgroundColor: colors.bg.cardElevated, borderTopColor: colors.border.default }]}>
          <View style={styles.inputRow}>
            {voiceInputEnabled && (
              <VoiceInputButton
                disabled={!ready || generating}
                onTranscript={(text) => setInput((prev) => (prev ? `${prev} ${text}` : text))}
              />
            )}
            <TextInput
              ref={inputRef}
              style={[styles.input, { backgroundColor: colors.bg.input, color: colors.text.primary, borderColor: colors.border.default }]}
              value={input}
              onChangeText={setInput}
              placeholder={t("chatScreen.inputPlaceholder")}
              placeholderTextColor={colors.text.dim}
              editable={ready && !generating}
              onSubmitEditing={() => handleSend()}
              returnKeyType="send"
              multiline={false}
            />
            {generating ? (
              <Pressable
                style={styles.stopBtn}
                onPress={stopGeneration}
                disabled={stopping}
                hitSlop={8}
                accessibilityLabel={t("chatScreen.stopGeneration")}
              >
                {stopping ? (
                  <ActivityIndicator color={colors.text.primary} size="small" />
                ) : (
                  <Text style={styles.stopBtnText}>⏹</Text>
                )}
              </Pressable>
            ) : (
              <Pressable
                style={[styles.sendBtn, (!ready || !input.trim()) && styles.sendBtnDisabled]}
                onPress={() => handleSend()}
                disabled={!ready || !input.trim()}
                hitSlop={8}
                accessibilityLabel={t("chatScreen.sendMessage")}
              >
                <Text style={styles.sendBtnText}>➤</Text>
              </Pressable>
            )}
          </View>
        </View>

        {showPromptIdeas && (
          <PromptIdeasCarousel
            onDismiss={() => setShowPromptIdeas(false)}
            onUsePrompt={(prompt) => {
              setShowPromptIdeas(false);
              // Sent straight away; while the model loads or an answer runs it waits in the input box instead,
              // as the send button would.
              if (generating || !ready) {
                setInput(prompt);
                requestAnimationFrame(() => inputRef.current?.focus());
              } else {
                handleSend(prompt);
              }
            }}
          />
        )}
      </View>

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        items={drawerItems}
        sessions={sessions}
        activeSessionId={activeSessionId}
        onNewChat={resetToNewChat}
        onSelectSession={selectSession}
        onDeleteSession={removeSession}
      />

      {toast && <Toast message={toast} onHide={() => setToast(null)} />}
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  deepResearchBanner: {
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    backgroundColor: colors.frontier.badgeBg,
    borderBottomWidth: 1,
    borderBottomColor: colors.frontier.badgeBorder,
  },
  deepBannerPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  deepBannerIcon: {
    fontSize: 10,
  },
  deepBannerText: {
    ...typography.mono.xs,
    fontSize: 9,
    color: colors.frontier.text,
    fontWeight: "700",
    letterSpacing: 0.4,
  },
  loadingBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    backgroundColor: colors.emerald.bgSubtle,
    borderBottomWidth: 1,
    borderBottomColor: colors.emerald.border,
  },
  loadingBannerText: {
    ...typography.mono.xs,
    color: colors.text.accentEmerald,
    fontWeight: "600",
  },
  list: {
    padding: spacing.md,
    gap: spacing.md,
    paddingBottom: spacing.lg,
  },
  listEmpty: { flexGrow: 1 },
  // Flat and round, as in the new UI: no shadow, 20 radius with an 8 tail; cards are told apart by
  // a lighter fill, not a border.
  bubble: {
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.md,
    borderRadius: 20,
    maxWidth: "92%",
    gap: 4,
  },
  userBubble: {
    alignSelf: "flex-end",
    borderBottomRightRadius: 8,
  },
  assistantBubble: {
    backgroundColor: colors.bg.surface,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    alignSelf: "flex-start",
    borderBottomLeftRadius: 8,
    minWidth: 200,
  },
  bubbleHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  bubbleRole: { flexDirection: "row", alignItems: "center", gap: 6 },
  // The same mascot as the chat header, at the label's size.
  bubbleAvatar: { width: 20, height: 20, borderRadius: 4 },
  bubbleRoleLabel: {
    ...typography.mono.xs,
    fontWeight: "600",
    letterSpacing: 0.5,
  },
  userRoleLabel: {
    color: colors.text.accentCyan,
  },
  assistantRoleLabel: {
    color: colors.text.accentEmerald,
  },
  copyIcon: {
    fontSize: 14,
    paddingHorizontal: 4,
  },
  bubbleFooter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 8,
    paddingTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  footerBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: radii.xs,
    borderWidth: 1,
  },
  footerGlyph: {
    fontSize: 10,
    lineHeight: 12,
    fontWeight: "700",
  },
  footerBtnLabel: {
    ...typography.ui.micro,
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  reasoningText: {
    fontSize: 12,
    fontStyle: "italic",
    lineHeight: 17,
    borderLeftWidth: 2,
    paddingLeft: 8,
    marginBottom: 8,
  },
  footerSpacer: {
    flex: 1,
  },
  stoppedBadge: {
    marginTop: 4,
    alignSelf: "flex-start",
    backgroundColor: colors.amber.bgSubtle,
    borderColor: colors.amber.border,
    borderWidth: 1,
    borderRadius: radii.xs,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  stoppedTag: {
    ...typography.mono.xs,
    color: colors.text.accentAmber,
    fontWeight: "700",
  },
  inputContainer: {
    borderTopWidth: 1,
    borderTopColor: colors.border.default,
    backgroundColor: colors.bg.cardElevated,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  input: {
    flex: 1,
    backgroundColor: colors.bg.input,
    color: colors.text.primary,
    borderColor: colors.border.default,
    borderWidth: 1,
    borderRadius: radii.full,
    paddingHorizontal: 18,
    paddingVertical: 12,
    ...typography.ui.body,
    fontSize: 14,
  },
  sendBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.emerald[600],
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtnDisabled: {
    opacity: 0.35,
    backgroundColor: colors.border.elevated,
  },
  sendBtnText: {
    color: "#FFFFFF",
    fontWeight: "800",
    fontSize: 16,
    marginLeft: 2,
  },
  stopBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.crimson[600],
    alignItems: "center",
    justifyContent: "center",
  },
  stopBtnText: {
    color: "#FFFFFF",
    fontWeight: "800",
    fontSize: 14,
  },
});
