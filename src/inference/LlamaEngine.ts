import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";
import { getBackendDevicesInfo, initLlama, loadLlamaModelInfo, LlamaContext } from "llama.rn";
import { getAvailableRamBytes, getDeviceTotalRamBytes, getMemoryInfo } from "ram-monitor";
import {
  availableRamFrom,
  describeFit,
  estimateMemoryFit,
  GgufShape,
  MemoryFit,
  parseGgufShape,
  toGb,
  contextSizeForRam,
  shouldRepack,
} from "./memoryFit";
import { BackendInfo, cpuDeviceNames, initWithCpuFallback, kvCacheParams } from "./initFallback";
import { describeModelFile, type LoadGuard, type LoadMeta } from "./loadMarker";
import { MODEL_CATALOG } from "../models/manifest";
import { listDiscoveredModels } from "../models/discoveredModels";
import { classifyLoadFailure, ModelLoadError } from "./loadError";
import { loadGuard as appLoadGuard } from "./loadGuard";

export { contextSizeForRam };

export interface ChatMessageInput {
  role: string;
  content: string;
}

export interface GenerateOptions {
  /** Legacy hand-built prompt string (assemblePrompt, src/rag/pure.ts). Exactly one of `prompt`/`messages` must be given. */
  prompt?: string;
  /**
   * Role-separated messages (assembleChatMessages, src/rag/pure.ts) for a
   * model that needs its own real chat/instruction template — passed
   * straight through to llama.rn's completion() with jinja enabled, which
   * applies the loaded GGUF's own embedded chat_template rather than any
   * template string this app would have to guess/hardcode. Only used for
   * models explicitly flagged `ModelCapabilities.usesChatTemplate`
   * (src/routing/types.ts) — everyone else keeps using `prompt`, unchanged.
   */
  messages?: ChatMessageInput[];
  nPredict?: number;
  temperature?: number;
  onToken?: (piece: string) => void;
  stop?: string[];
  /**
   * Safety-net budget, not a performance target — no per-generation timeout
   * existed anywhere in the app before this (see docs/ADAPTIVE_ROUTING.md
   * §14). Left unset for regular single-pass chat (already indirectly
   * bounded by nPredict); set for orchestrator.ts's multi-stage Deep
   * Research calls, where a stuck stage would otherwise compound silently
   * across several sequential model calls with no ceiling at all.
   */
  timeoutMs?: number;
  /** Called once, right before the timeout triggers stop() — lets the caller distinguish a timeout from a natural finish or a user-initiated stop. */
  onTimeout?: () => void;
  /**
   * Cap on tokens inside a <think> block (models that reason first, e.g.
   * LFM2.5, Qwen3). llama.cpp forces the block closed when it is spent, and
   * nPredict is raised by the same amount, so reasoning never eats the
   * answer's budget. Without it, LFM2.5 used all 200-512 tokens thinking and
   * returned an empty answer. Only applies to the chat-template path.
   */
  thinkingBudget?: number;
  /** false asks the chat template to skip the thinking block (templates that support enable_thinking, e.g. Qwen3). */
  enableThinking?: boolean;
  /** llama.cpp's own measurements for this completion (prompt = prefill). */
  onTimings?: (t: GenerationTimings) => void;
}

/** The fixed start of the answer prompt (src/rag/pure.ts answerPromptPrefix): chat-template and plain variants. */
export interface PromptPrefix {
  system: string;
  prompt: string;
}

/**
 * Idle time after a completion with another prompt (session title, summary, Deep Research stage) before the
 * answer prefix is prefilled again. Back-to-back stages don't pay a refill between them.
 */
export const PREFIX_WARM_IDLE_MS = 750;

/**
 * Tokens the prefix warm-up generates (and discards). Not 0: with n_predict 0, llama.rn 0.13 rc.6 returns
 * before the prompt is decoded, so the KV cache never held the prefix and every answer re-read it (Pixel 6a,
 * 2026-10-04: warm "1 token in 0 ms" even after a title prompt replaced the cache; answers evaluated their
 * whole prompt although 229 of its first tokens matched the prefix). One token makes the decode loop run.
 */
export const WARM_N_PREDICT = 1;

/** Fewer evaluated tokens than this say little about prompt reading speed. */
const MIN_PREFILL_SAMPLE_TOKENS = 32;

export interface GenerationTimings {
  promptTokens: number;
  promptMs: number;
  predictedTokens: number;
  predictedMs: number;
  /** Prompt tokens reused from the previous completion's KV cache (prefix cache hit). */
  cachedTokens?: number;
}

/**
 * assemblePrompt (src/rag/pure.ts) hand-builds a plain-text prompt with our
 * own "User:"/"Assistant:"/"Question:" role labels rather than using
 * llama.rn's chat-template API (which would auto-derive stop tokens from
 * the GGUF's own Jinja template) — so nothing tells the model where a turn
 * actually ends. Left unset, a model that's done answering (especially on
 * a short/trivial prompt with little else to say) just keeps predicting
 * tokens and starts hallucinating a fake continuation of the conversation,
 * inventing new "User:" turns rather than stopping. These match our own
 * template's role markers so generation halts the moment it tries to do that.
 */
const DEFAULT_STOP_SEQUENCES = ["\nUser:", "\n\nUser:", "\nQuestion:", "\n\nQuestion:"];

export interface LoadedModelInfo {
  filename: string;
  nCtx: number;
  nThreads: number;
  /** "cpu-fallback" with the native reason when the GPU backend failed to start (initFallback.ts). */
  backend?: BackendInfo;
  /** Whether the weights were repacked for the ARM kernels (in app memory) or kept as the mapped file. */
  repacked?: boolean;
}

export function defaultContextSize(): number {
  let total = 0;
  try {
    total = getDeviceTotalRamBytes();
  } catch {
    total = 0;
  }
  return contextSizeForRam(total);
}

/** Reasoning-block markers per model family, as llama.cpp's reasoning-budget sampler needs them. */
export function thinkingTagsFor(arch: string | null): { start: string; end: string } {
  // Gemma 4 opens its reasoning channel with "<|channel>thought" (see src/services/thinking.ts).
  if (arch && /^gemma/i.test(arch)) return { start: "<|channel>thought", end: "<channel|>" };
  return { start: "<think>", end: "</think>" };
}

/** Injected before the forced end tag when the budget runs out, so the model moves on to the answer. */
const THINKING_BUDGET_MESSAGE = "\nI have thought enough; answering now.\n";

export interface LoadOptions {
  nCtx?: number;
  nThreads?: number;
  /** Who this model is, for the crash marker (CR-2): shown as "<label> closed the app". */
  meta?: { modelId?: string; label?: string };
  /**
   * Loading progress, 0..1 (llama.rn's weight loading). It reaches 1 before initLlama
   * returns: on the first init after install, iOS still compiles Metal after that.
   */
  onProgress?: (fraction: number) => void;
}

export interface LoadResult {
  /** Memory estimate taken right before loading; null when the RAM readouts were unavailable. */
  fit: MemoryFit | null;
  /** Non-null when the model loaded but will stream from storage (slower); show it to the user. */
  warning: string | null;
  /** Which backend attempt loaded it ("cpu-fallback" = the GPU backend failed to start; see initFallback.ts). */
  backend?: BackendInfo;
}

/**
 * Thin wrapper around llama.rn. Loads a GGUF model with mmap so weights
 * stream from disk rather than being fully resident, keeping peak RAM under
 * the model's working-set size (weights touched + KV cache), not the full
 * file size. No network access anywhere in this module.
 */
export class LlamaEngine {
  /** guard: the CR-2 crash marker around initLlama (null = none, e.g. in tests). */
  constructor(private readonly guard: LoadGuard | null = appLoadGuard) {}

  private context: LlamaContext | null = null;
  /** Who is loaded, for the next crash marker's "previous" (the model the app falls back to). */
  private loadedMeta: LoadMeta | null = null;
  private modelInfo: LoadedModelInfo | null = null;
  // load()/unload() run one at a time. Concurrent loads (e.g. switching
  // models and closing Settings quickly) used to both release, both create a
  // context, and the one overwritten in this.context was never released,
  // leaking a whole model's memory.
  private queue: Promise<void> = Promise.resolve();
  // The completion currently running, if any. Releasing a context while it
  // runs leaves its promise unsettled forever (the chat stays "generating"),
  // so unload stops it and waits for it first.
  private inFlight: Promise<unknown> | null = null;
  // generate() calls run one at a time: two completions on one llama.cpp
  // context interleave their tokens and corrupt the KV cache (double-send
  // race, review boar.md). A second call waits for the first to settle.
  private genQueue: Promise<unknown> = Promise.resolve();
  // Bumped by stop(): a generation queued before a stop resolves empty
  // instead of starting after the user already pressed Stop.
  private stopEpoch = 0;

  // Answer prompt prefix kept in the KV cache (setAnswerPrefix). llama.rn re-evaluates a prompt only from its
  // first token that differs from the cache, but the session title right after a new chat's first answer (and
  // any other prompt) replaces the cache, so on the iPhone 13 every new chat's question prefilled all its
  // ~400 tokens at ~100 tok/s (4-5 s to the first token).
  private prefix: PromptPrefix | null = null;
  /** Whether the KV cache holds `prefix` (a load or another prompt drops it). */
  private prefixCached = false;
  /** Tokens the warm prefix fills (the warm-up's whole prompt), once it has run. */
  private prefixTokens = 0;
  /** The last answer's prompt reading: tokens llama.cpp evaluated and the time to its first token. */
  private lastPrefill: { tokens: number; ms: number } | null = null;
  private warmTimer: ReturnType<typeof setTimeout> | null = null;
  /** generate() calls not settled yet: a prefix refill never waits in front of one of them. */
  private pending = 0;

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  private lastLoad: LoadResult = { fit: null, warning: null };
  // general.architecture of the loaded model (from the GGUF header), for its thinking tags.
  private arch: string | null = null;
  private lastHeaderArch: string | null = null;

  load(modelFilename: string, opts?: LoadOptions): Promise<LoadResult> {
    let result: LoadResult = { fit: null, warning: null };
    return this.enqueue(async () => {
      result = await this.loadNow(modelFilename, opts);
    }).then(() => result);
  }

  private async loadNow(modelFilename: string, opts?: LoadOptions): Promise<LoadResult> {
    const nCtx = opts?.nCtx ?? defaultContextSize();
    const nThreads = opts?.nThreads ?? 4;

    // ChatScreen re-mounts (and calls load() again) every time Settings is
    // closed, even if the user didn't touch the model — re-initializing the
    // native llama.cpp context is expensive (seconds, for a multi-GB model),
    // so skip it entirely when nothing actually changed.
    if (
      this.context &&
      this.modelInfo?.filename === modelFilename &&
      this.modelInfo.nCtx === nCtx &&
      this.modelInfo.nThreads === nThreads
    ) {
      return this.lastLoad;
    }

    const modelPath = `${FileSystem.documentDirectory}${modelFilename}`;
    const info = await FileSystem.getInfoAsync(modelPath);
    if (!info.exists) {
      const message = `Model not found at ${modelPath}. Run the setup wizard to install it first.`;
      throw new ModelLoadError(message, "missing", message);
    }
    const fileSizeBytes = (info as { size?: number }).size ?? 0;

    // Release any previously loaded model first (e.g. actually switching
    // models from Settings) so we don't leak the old context's native memory,
    // and so the RAM readouts below no longer count the old model.
    const previous = this.loadedMeta;
    await this.unloadNow();

    // Pre-flight check, mmap-aware (see memoryFit.ts): only the KV cache and
    // compute buffers must be resident, so only those can refuse a load. A
    // file bigger than free RAM loads with a warning (weights stream from
    // storage). Best-effort — missing readouts skip the check.
    const fit = await this.estimateFitAt(modelPath, fileSizeBytes, nCtx);
    if (fit?.verdict === "insufficient") {
      const message = describeFit(modelFilename, fit)!;
      throw new ModelLoadError(message, "memory", message);
    }

    // No RAM readouts: repack, as before this check existed.
    const repack = fit ? shouldRepack(fit) : true;
    let backend: BackendInfo = { kind: "default" };
    // A caller without meta (the chat's preload, the catalog screen) still gets the model's id and label.
    const known =
      opts?.meta?.modelId && opts.meta.label
        ? {}
        : describeModelFile(modelFilename, [...MODEL_CATALOG, ...(await listDiscoveredModels().catch(() => []))]);
    const given = Object.fromEntries(Object.entries(opts?.meta ?? {}).filter(([, v]) => v !== undefined));
    const meta: LoadMeta = { filename: modelFilename, ...known, ...given };
    // Marker on disk while initLlama runs: if the OS kills the app here, the next start knows (CR-2).
    await this.guard?.begin(meta, previous).catch((e: any) => console.warn("[engine] load marker:", e?.message ?? e));
    let loadedOk = false;
    try {
      const onProgress = opts?.onProgress;
      const loaded = await initWithCpuFallback(
        onProgress ? (p) => initLlama(p, (pct: number) => onProgress(Math.min(1, Math.max(0, pct / 100)))) : initLlama,
        {
          model: modelPath,
          use_mmap: true,
          use_mlock: false, // avoid pinning full weights in RAM; rely on mmap streaming
          n_ctx: nCtx,
          n_threads: nThreads,
          n_gpu_layers: 0, // CPU-only for broad device compatibility; adjust per-device
          // A model too big for memory streams from its mapped file (memoryFit.ts shouldRepack), and there the
          // 8-bit KV cache's ~half-size cache matters. Elsewhere it isn't worth it: on a Pixel 6a the 4B read its
          // prompts ~19% slower with it (first word 11.6 s vs 9.5 s median, eval:device standard set, 2026-10-05).
          ...(repack ? {} : kvCacheParams(Platform.OS)),
          no_extra_bufts: !repack,
        },
        { platform: Platform.OS, cpuDevices: () => cpuDeviceNames(getBackendDevicesInfo), log: (m) => console.warn(m) }
      );
      this.context = loaded.context;
      backend = loaded.backend;
      this.modelInfo = { filename: modelFilename, nCtx, nThreads, backend, repacked: repack };
      this.loadedMeta = meta;
      loadedOk = true;
      this.arch = fit ? this.lastHeaderArch : await this.readArch(modelPath);
    } catch (e: any) {
      // The native error (llama.rn/llama.cpp) is terse ("Failed to load model"). The cause goes in
      // `kind`, and our RAM estimate in `hint`, NOT in the message: appended there it made the
      // chat call a Metal failure "not enough memory" (Harbor, iOS dc63525).
      const nativeMessage = e?.message ?? String(e);
      const hint = fit
        ? `this device has ~${toGb(fit.totalBytes)}GB RAM, ~${toGb(fit.availableBytes)}GB free; ` +
          `"${modelFilename}" needs ~${toGb(fit.anonBytes)}GB of buffers plus ~${toGb(fit.hotWeightBytes)}GB of weights per token`
        : undefined;
      if (hint) console.warn(`[engine] load failed (${nativeMessage}); ${hint}`);
      throw new ModelLoadError(`Failed to load "${modelFilename}": ${nativeMessage}`, classifyLoadFailure(nativeMessage, fit?.verdict), nativeMessage, hint);
    } finally {
      // Returned (loaded or failed in JS): the app survived this load.
      await this.guard?.end(meta, loadedOk).catch((e: any) => console.warn("[engine] load marker:", e?.message ?? e));
    }
    this.lastLoad = { fit, warning: fit ? describeFit(modelFilename, fit) : null, backend };
    this.prefixCached = false;
    this.scheduleWarm(0);
    return this.lastLoad;
  }

  private async readArch(modelPath: string): Promise<string | null> {
    try {
      const meta = (await loadLlamaModelInfo(modelPath)) as Record<string, unknown>;
      return typeof meta["general.architecture"] === "string" ? (meta["general.architecture"] as string) : null;
    } catch {
      return null;
    }
  }

  /**
   * Memory estimate for a downloaded model without loading it (for the model
   * picker's badges). Reads only the GGUF header. Null if RAM readouts are
   * unavailable or the file is missing.
   */
  async estimateFit(modelFilename: string, opts?: { nCtx?: number }): Promise<MemoryFit | null> {
    const modelPath = `${FileSystem.documentDirectory}${modelFilename}`;
    const info = await FileSystem.getInfoAsync(modelPath);
    if (!info.exists) return null;
    return this.estimateFitAt(modelPath, (info as { size?: number }).size ?? 0, opts?.nCtx ?? defaultContextSize());
  }

  private async estimateFitAt(modelPath: string, fileBytes: number, nCtx: number): Promise<MemoryFit | null> {
    let totalRamBytes = 0;
    let rssBytes = 0;
    let availBytes = 0;
    try {
      totalRamBytes = getDeviceTotalRamBytes();
      rssBytes = getMemoryInfo().rssBytes;
      availBytes = getAvailableRamBytes();
    } catch {
      return null;
    }
    if (totalRamBytes <= 0) return null;

    let shape: GgufShape | null = null;
    try {
      const meta = (await loadLlamaModelInfo(modelPath)) as Record<string, unknown>;
      this.lastHeaderArch = typeof meta["general.architecture"] === "string" ? (meta["general.architecture"] as string) : null;
      shape = parseGgufShape(meta);
    } catch {
      // Unreadable header: estimateMemoryFit falls back to file-size heuristics.
    }
    return estimateMemoryFit({
      fileBytes,
      nCtx,
      shape,
      totalRamBytes,
      availableRamBytes: availableRamFrom({ totalBytes: totalRamBytes, rssBytes, availBytes }),
    });
  }

  unload(): Promise<void> {
    return this.enqueue(() => this.unloadNow());
  }

  private async unloadNow() {
    // Stop takes effect between tokens, so a completion still processing its
    // prompt can run on for a while; wait for it rather than release under it.
    if (this.inFlight) {
      // try/await, not .catch(): llama.rn's JSI stopCompletion returns undefined (typed Promise<void>; rc.4 and rc.6),
      // and a throw here left the old context loaded next to the new one (two LLMs mapped, 0.4 tok/s).
      try {
        await this.context?.stopCompletion();
      } catch {}
      await this.inFlight.catch(() => {});
    }
    const context = this.context;
    this.context = null;
    this.prefixCached = false;
    this.modelInfo = null;
    this.loadedMeta = null;
    this.lastLoad = { fit: null, warning: null };
    this.arch = null;
    await context?.release();
  }

  getModelInfo(): LoadedModelInfo | null {
    return this.modelInfo;
  }

  get isLoaded(): boolean {
    return this.context !== null;
  }

  /**
   * Whether the loaded GGUF ships its own chat template (tokenizer.chat_template
   * metadata) that llama.cpp can parse as Jinja — i.e. whether generate({ messages })
   * will be formatted in the model's own instruction format.
   */
  hasEmbeddedChatTemplate(): boolean {
    return this.context?.isJinjaSupported() ?? false;
  }

  generate(opts: GenerateOptions): Promise<string> {
    const epoch = this.stopEpoch;
    this.pending++;
    let ran = false;
    const run = this.genQueue.then(() => {
      if (epoch !== this.stopEpoch) return "";
      ran = true;
      return this.generateNow(opts);
    });
    this.genQueue = run.catch(() => {});
    const settled = () => {
      this.pending--;
      if (!this.prefix) return;
      // An answer keeps the prefix in the cache; any other prompt replaced it.
      if (ran) this.prefixCached = this.sharesPrefix(opts);
      if (!this.prefixCached) this.scheduleWarm(PREFIX_WARM_IDLE_MS);
    };
    run.then(settled, settled);
    return run;
  }

  /**
   * Keeps the start of the answer prompt (answerPromptPrefix for the chat's tone) prefilled in the KV cache
   * while nothing else runs: after a load and after a completion with another prompt. A question then
   * prefills only its sources and itself. Null stops it.
   */
  setAnswerPrefix(prefix: PromptPrefix | null): void {
    if (prefix?.system === this.prefix?.system && prefix?.prompt === this.prefix?.prompt) return;
    this.prefix = prefix;
    this.prefixCached = false;
    this.scheduleWarm(0);
  }

  private sharesPrefix({ prompt, messages }: GenerateOptions): boolean {
    if (!this.prefix) return false;
    if (messages) return messages[0]?.role === "system" && messages[0].content.startsWith(this.prefix.system);
    return !!prompt?.startsWith(this.prefix.prompt);
  }

  private scheduleWarm(delayMs: number): void {
    if (this.warmTimer) clearTimeout(this.warmTimer);
    this.warmTimer = null;
    if (!this.prefix || !this.context) return;
    this.warmTimer = setTimeout(() => {
      this.warmTimer = null;
      // A generation waiting or running decides for itself when it settles.
      if (this.pending > 0 || this.prefixCached) return;
      const run = this.genQueue.then(() => this.warmNow());
      this.genQueue = run.catch(() => {});
    }, delayMs);
  }

  /**
   * Expected time to the first token for this prompt, from the last answer's prompt reading speed: the
   * prompt's tokens (in the format generate() will send) minus the warm prefix when it is cached. Null when
   * there is no measurement yet or the prompt can't be tokenized.
   */
  async estimateFirstTokenMs(opts: Pick<GenerateOptions, "prompt" | "messages">): Promise<number | null> {
    const ctx = this.context;
    const rate = this.lastPrefill;
    if (!ctx || !rate || rate.ms <= 0) return null;
    try {
      let text = opts.prompt ?? "";
      if (opts.messages) {
        const r: any = await ctx.getFormattedChat(opts.messages as any, null, { jinja: true });
        text = typeof r === "string" ? r : (r?.prompt ?? "");
      }
      const tokens = ((await ctx.tokenize(text)) as any).tokens?.length ?? 0;
      const cached = this.prefixCached && this.sharesPrefix(opts) ? Math.min(this.prefixTokens, tokens) : 0;
      return (Math.max(tokens - cached, 1) / rate.tokens) * rate.ms;
    } catch {
      return null;
    }
  }

  /** Prefills the prefix (one discarded token, WARM_N_PREDICT), in the same format an answer uses. */
  private async warmNow(): Promise<void> {
    const prefix = this.prefix;
    const context = this.context;
    if (!prefix || !context || this.prefixCached || this.pending > 0) return;
    const params = context.isJinjaSupported()
      ? // The empty user turn keeps templates that require one (Qwen3) rendering; the prefix ends before it.
        { messages: [{ role: "system", content: prefix.system }, { role: "user", content: "" }], jinja: true, n_predict: WARM_N_PREDICT }
      : { prompt: prefix.prompt, n_predict: WARM_N_PREDICT };
    const completion = context.completion(params);
    this.inFlight = completion;
    try {
      const result = (await completion) as { timings?: { prompt_n?: number; prompt_ms?: number }; tokens_evaluated?: number };
      if (result?.tokens_evaluated) this.prefixTokens = result.tokens_evaluated;
      if (this.prefix === prefix && this.context === context) this.prefixCached = true;
      const t = result?.timings;
      if (t) console.log(`[engine] answer prefix prefilled: ${t.prompt_n} tokens in ${Math.round(t.prompt_ms ?? 0)} ms`);
    } catch (e: any) {
      console.warn("[engine] answer prefix prefill failed:", e?.message ?? e);
    } finally {
      if (this.inFlight === completion) this.inFlight = null;
    }
  }

  private async generateNow({
    prompt,
    messages,
    nPredict = 512,
    temperature = 0.7,
    onToken,
    stop,
    timeoutMs,
    onTimeout,
    onTimings,
    thinkingBudget,
    enableThinking,
  }: GenerateOptions): Promise<string> {
    if (!this.context) throw new Error("LlamaEngine: model not loaded");
    if (!prompt && !messages) {
      throw new Error("LlamaEngine.generate: either prompt or messages must be provided");
    }

    const timer = timeoutMs
      ? setTimeout(() => {
          onTimeout?.();
          this.context?.stopCompletion();
        }, timeoutMs)
      : null;

    // messages+jinja lets llama.cpp apply the loaded GGUF's own embedded
    // chat_template — DEFAULT_STOP_SEQUENCES exist specifically because
    // this app's hand-built "Question:/Answer:" prompt shape gives the
    // model no other signal for where a turn ends (see that constant's own
    // doc comment); a real chat template already has its own proper
    // end-of-turn token the model was fine-tuned to emit, so forcing our
    // unrelated string-based stops on top of it would be either inert or
    // could truncate genuine content that happens to contain "User:"/
    // "Question:". Only applied when the caller passes explicit `stop`.
    const completionParams = messages
      ? {
          messages,
          jinja: true,
          n_predict: nPredict + (enableThinking === false ? 0 : thinkingBudget ?? 0),
          temperature,
          stop: stop ?? [],
          // llama.rn only enforces the budget when it knows the block's tags; when the budget
          // runs out it forces the end tag and generation continues with the answer.
          ...(thinkingBudget && enableThinking !== false
            ? {
                thinking_budget_tokens: thinkingBudget,
                thinking_start_tag: thinkingTagsFor(this.arch).start,
                thinking_end_tag: thinkingTagsFor(this.arch).end,
                thinking_budget_message: THINKING_BUDGET_MESSAGE,
              }
            : {}),
          ...(enableThinking === false ? { enable_thinking: false } : {}),
        }
      : { prompt: prompt!, n_predict: nPredict, temperature, stop: stop ?? DEFAULT_STOP_SEQUENCES };

    let full = "";
    const startedAt = Date.now();
    let firstTokenAt: number | null = null;
    const completion = this.context.completion(completionParams, (data) => {
      if (firstTokenAt === null) firstTokenAt = Date.now();
      full += data.token;
      onToken?.(data.token);
    });
    this.inFlight = completion;
    try {
      const result = await completion;
      const t = (result as { timings?: any; tokens_cached?: number }).timings;
      // Prompt reading speed for the next answer's length (prompt_n: tokens evaluated, the cached prefix excluded).
      if (t?.prompt_n >= MIN_PREFILL_SAMPLE_TOKENS && firstTokenAt !== null) this.lastPrefill = { tokens: t.prompt_n, ms: firstTokenAt - startedAt };
      if (t && onTimings) {
        onTimings({
          promptTokens: t.prompt_n ?? 0,
          promptMs: t.prompt_ms ?? 0,
          predictedTokens: t.predicted_n ?? 0,
          predictedMs: t.predicted_ms ?? 0,
          cachedTokens: (result as { tokens_cached?: number }).tokens_cached,
        });
      }
      return result.text ?? full;
    } finally {
      if (this.inFlight === completion) this.inFlight = null;
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Signals the native completion loop to stop. The in-flight generate()
   * call's completion() promise resolves normally with whatever text was
   * generated so far — this is llama.cpp's own clean-stop behavior, not an
   * error/abort path, so no try/catch needed around a stopped generate().
   */
  async stop(): Promise<void> {
    this.stopEpoch++;
    await this.context?.stopCompletion();
  }
}

export const llamaEngine = new LlamaEngine();
