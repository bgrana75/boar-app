import { describe, it, expect, vi, beforeEach } from "vitest";

type FakeContext = {
  model: string;
  released: boolean;
  release: () => Promise<void>;
  completion: (params: unknown, onToken: (d: { token: string }) => void) => Promise<{ text: string }>;
  stopCompletion: () => Promise<void> | undefined;
  releasedWhileGenerating: boolean;
};
/** llama.rn's JSI stopCompletion returns undefined instead of a promise (rc.4 and rc.6 alike). */
let stopReturnsNothing = false;
const created: FakeContext[] = [];
const initParams: Record<string, unknown>[] = [];
const ram = { total: 12 * 1024 ** 3, rss: 1024 ** 3, avail: 0 };
let fileSize = 1_000_000;
let header: Record<string, string> | null = null;
let inFlightInits = 0;
let maxConcurrentInits = 0;
/** Native messages the next initLlama calls reject with, in order. */
const initFailures: string[] = [];
const platform = { OS: "android" };
/** When set, every context's completion resolves at once with this (one setting reaches contexts created later). */
let reply: unknown = null;

vi.mock("react-native", () => ({ Platform: { get OS() { return platform.OS; } } }));
vi.mock("llama.rn", () => ({
  getBackendDevicesInfo: async () => [
    { backend: "Metal", type: "gpu", deviceName: "MTL0", maxMemorySize: 0 },
    { backend: "CPU", type: "cpu", deviceName: "CPU", maxMemorySize: 0 },
  ],
  loadLlamaModelInfo: async () => {
    if (!header) throw new Error("no header");
    return header;
  },
  initLlama: async (params: { model: string }, onProgress?: (pct: number) => void) => {
    onProgress?.(0);
    onProgress?.(50);
    onProgress?.(100);
    const { model } = params;
    initParams.push(params);
    const failure = initFailures.shift();
    if (failure) throw new Error(failure);
    inFlightInits++;
    maxConcurrentInits = Math.max(maxConcurrentInits, inFlightInits);
    await new Promise((r) => setTimeout(r, 5));
    inFlightInits--;
    let finish: (() => void) | null = null;
    let generating = false;
    const ctx: FakeContext = {
      model,
      released: false,
      releasedWhileGenerating: false,
      release: async () => {
        if (generating) ctx.releasedWhileGenerating = true;
        ctx.released = true;
      },
      // Like llama.cpp: runs until stopped, and settles a moment after the stop (prompt still processing).
      completion: (_params, onToken) =>
        reply ? Promise.resolve(reply as { text: string }) : new Promise((resolve) => {
          generating = true;
          onToken({ token: "Hi" });
          finish = () =>
            setTimeout(() => {
              generating = false;
              resolve({ text: "Hi" });
            }, 20);
        }),
      stopCompletion: () => {
        finish?.();
        return stopReturnsNothing ? undefined : Promise.resolve();
      },
    };
    created.push(ctx);
    return ctx;
  },
}));
vi.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///docs/",
  getInfoAsync: async () => ({ exists: true, size: fileSize }),
}));
vi.mock("ram-monitor", () => ({
  getDeviceTotalRamBytes: () => ram.total,
  getMemoryInfo: () => ({ rssBytes: ram.rss }),
  getAvailableRamBytes: () => ram.avail,
}));

import { LlamaEngine, PREFIX_WARM_IDLE_MS, WARM_N_PREDICT, defaultContextSize } from "./LlamaEngine";

const live = () => created.filter((c) => !c.released);

beforeEach(() => {
  created.length = 0;
  initParams.length = 0;
  Object.assign(ram, { total: 12 * 1024 ** 3, rss: 1024 ** 3, avail: 0 });
  fileSize = 1_000_000;
  header = null;
  inFlightInits = 0;
  maxConcurrentInits = 0;
  initFailures.length = 0;
  platform.OS = "android";
  stopReturnsNothing = false;
  reply = null;
});

describe("LlamaEngine Metal fallback (iPhone 13)", () => {
  it("loads on CPU after the Metal init failure ('Failed to load model' in JS) and reports it", async () => {
    platform.OS = "ios";
    initFailures.push("Failed to load model"); // all llama.rn's JSI passes up; "MTL0" is only in the native log
    const engine = new LlamaEngine();
    const r = await engine.load("models/a.gguf");
    expect(initParams).toHaveLength(2);
    expect(initParams[0]).toMatchObject({ n_gpu_layers: 0, flash_attn_type: "off" });
    expect(initParams[1]).toMatchObject({ n_gpu_layers: 0, devices: ["CPU"], flash_attn_type: "off" });
    expect(r.backend).toEqual({ kind: "cpu-fallback", reason: "Failed to load model" });
    expect(engine.getModelInfo()?.backend?.kind).toBe("cpu-fallback");
  });

  it("still fails with the load message when the CPU retry fails too", async () => {
    initFailures.push("Failed to load model", "Failed to load model");
    await expect(new LlamaEngine().load("models/a.gguf")).rejects.toThrow(/Failed to load "models\/a.gguf": Failed to load model/);
  });
});

describe("LlamaEngine CR-2 marker and model swap", () => {
  it("writes the marker before initLlama with the previous model, clears it after, and releases the old model first", async () => {
    const log: string[] = [];
    const guard = {
      begin: async (meta: any, previous: any) =>
        void log.push(`begin ${meta.modelId} prev=${previous?.modelId ?? "-"} inits=${initParams.length} live=${created.filter((c) => !c.released).length}`),
      end: async (meta: any, ok: boolean) => void log.push(`end ${meta.modelId} ${ok} inits=${initParams.length}`),
      consume: async () => null,
      ensureChecked: async () => {},
    };
    const engine = new LlamaEngine(guard as any);
    await engine.load("models/q15.gguf", { meta: { modelId: "q15", label: "1.5B" } });
    const first = created[0];
    const origInit = initParams.length;
    await engine.load("models/q4.gguf", { meta: { modelId: "q4", label: "4B" } });
    // live=0 at the 4B's begin: the 1.5B was released before the 4B's initLlama.
    expect(log).toEqual(["begin q15 prev=- inits=0 live=0", "end q15 true inits=1", "begin q4 prev=q15 inits=1 live=0", "end q4 true inits=2"]);
    // The 1.5B is released before the 4B's context is created: never both resident.
    expect(first.released).toBe(true);
    expect(origInit).toBe(1);
  });

  it("a failed load still clears the marker (the app survived it)", async () => {
    const ends: boolean[] = [];
    const guard = { begin: async () => {}, end: async (_m: any, ok: boolean) => void ends.push(ok), consume: async () => null, ensureChecked: async () => {} };
    initFailures.push("model file not found");
    await expect(new LlamaEngine(guard as any).load("models/a.gguf")).rejects.toThrow();
    expect(ends).toEqual([false]);
  });
});

describe("LlamaEngine load progress", () => {
  it("reports llama.rn's 0-100 as 0..1", async () => {
    const seen: number[] = [];
    await new LlamaEngine(null).load("models/a.gguf", { onProgress: (f) => seen.push(f) });
    expect(seen).toEqual([0, 0.5, 1]);
  });
});

describe("LlamaEngine load/unload", () => {
  it("never leaves an orphaned context when loads overlap (quick model swaps)", async () => {
    const engine = new LlamaEngine();
    await Promise.all([engine.load("models/a.gguf"), engine.load("models/b.gguf"), engine.load("models/a.gguf")]);
    expect(maxConcurrentInits).toBe(1);
    expect(live()).toHaveLength(1);
    expect(live()[0].model).toBe("file:///docs/models/a.gguf");
    expect(engine.getModelInfo()?.filename).toBe("models/a.gguf");
  });

  it("skips a load of the model that is already loaded", async () => {
    const engine = new LlamaEngine();
    await engine.load("models/a.gguf");
    await Promise.all([engine.load("models/a.gguf"), engine.load("models/a.gguf")]);
    expect(created).toHaveLength(1);
  });

  it("serializes unload with a pending load, leaving nothing loaded", async () => {
    const engine = new LlamaEngine();
    await Promise.all([engine.load("models/a.gguf"), engine.unload()]);
    expect(live()).toHaveLength(0);
    expect(engine.isLoaded).toBe(false);
  });

  it("keeps working after a failed load", async () => {
    const engine = new LlamaEngine();
    const fs = await import("expo-file-system/legacy");
    const spy = vi.spyOn(fs, "getInfoAsync").mockResolvedValueOnce({ exists: false } as any);
    await expect(engine.load("models/missing.gguf")).rejects.toThrow(/not found/);
    await engine.load("models/b.gguf");
    expect(engine.getModelInfo()?.filename).toBe("models/b.gguf");
    spy.mockRestore();
  });

  it("stops and waits for a running generation before releasing its model", async () => {
    const engine = new LlamaEngine();
    await engine.load("models/a.gguf");
    const reply = engine.generate({ prompt: "say hi" });
    await engine.load("models/b.gguf");
    await expect(reply).resolves.toBe("Hi");
    expect(created[0].released).toBe(true);
    expect(created[0].releasedWhileGenerating).toBe(false);
    expect(engine.getModelInfo()?.filename).toBe("models/b.gguf");
  });

  it("switches models twice mid-generation with a stopCompletion that returns no promise and keeps one context loaded", async () => {
    stopReturnsNothing = true;
    const engine = new LlamaEngine();
    await engine.load("models/a.gguf");
    const first = engine.generate({ prompt: "say hi" });
    await engine.load("models/b.gguf");
    const second = engine.generate({ prompt: "say hi" });
    await engine.load("models/a.gguf");
    await expect(first).resolves.toBe("Hi");
    await expect(second).resolves.toBe("Hi");
    expect(created).toHaveLength(3);
    expect(live()).toHaveLength(1);
    expect(live()[0].model).toContain("models/a.gguf");
    expect(created.some((c) => c.releasedWhileGenerating)).toBe(false);
    expect(engine.getModelInfo()?.filename).toBe("models/a.gguf");
  });
});

const GiB = 1024 ** 3;
const QWEN3_MOE_HEADER = {
  "general.architecture": "qwen3moe",
  "qwen3moe.block_count": "48",
  "qwen3moe.embedding_length": "2048",
  "qwen3moe.attention.head_count": "32",
  "qwen3moe.attention.head_count_kv": "4",
  "qwen3moe.attention.key_length": "128",
  "qwen3moe.attention.value_length": "128",
  "qwen3moe.expert_count": "128",
  "qwen3moe.expert_used_count": "8",
  "qwen3moe.expert_feed_forward_length": "768",
  "qwen3moe.vocab_size": "151936",
};

describe("LlamaEngine pre-flight memory check (mmap-aware)", () => {
  it("loads a MoE file larger than free RAM with a streaming warning instead of throwing", async () => {
    fileSize = 11 * GiB;
    ram.avail = 7 * GiB;
    header = QWEN3_MOE_HEADER;
    const engine = new LlamaEngine();
    const result = await engine.load("models/qwen3-30b-a3b.gguf");
    expect(engine.isLoaded).toBe(true);
    expect(result.fit?.verdict).toBe("streaming");
    expect(result.warning).toMatch(/streams from storage/);
    expect(initParams[0]).toMatchObject({ use_mmap: true, use_mlock: false });
  });

  it("returns the same warning when the already-loaded model is re-requested", async () => {
    fileSize = 11 * GiB;
    ram.avail = 7 * GiB;
    header = QWEN3_MOE_HEADER;
    const engine = new LlamaEngine();
    await engine.load("models/m.gguf");
    const again = await engine.load("models/m.gguf");
    expect(created).toHaveLength(1);
    expect(again.fit?.verdict).toBe("streaming");
  });

  it("still refuses when KV + buffers alone cannot fit, without creating a context", async () => {
    header = QWEN3_MOE_HEADER;
    // A phone too small for it: 2.5 GB total leaves nothing after the system's reserve.
    ram.total = 2.5 * GiB;
    ram.avail = 200 * 1024 ** 2;
    const engine = new LlamaEngine();
    await expect(engine.load("models/m.gguf")).rejects.toThrow(/cannot be streamed/);
    expect(created).toHaveLength(0);
  });

  it("budgets total RAM minus the system's reserve when the native module has no available-RAM readout", async () => {
    // 12 GB − max(2.5 GB, 25%) = 9 GB available, 1MB dense file without header → resident.
    const engine = new LlamaEngine();
    const result = await engine.load("models/a.gguf");
    expect(result.fit?.availableBytes).toBe(9 * GiB);
    expect(result.fit?.fromMetadata).toBe(false);
    expect(result.warning).toBeNull();
  });

  it("skips the check when RAM readouts are unavailable", async () => {
    ram.total = 0;
    const engine = new LlamaEngine();
    const result = await engine.load("models/a.gguf");
    expect(result.fit).toBeNull();
    expect(engine.isLoaded).toBe(true);
  });

  it("estimates a downloaded model without loading it", async () => {
    fileSize = 11 * GiB;
    ram.avail = 7 * GiB;
    header = QWEN3_MOE_HEADER;
    const engine = new LlamaEngine();
    const fit = await engine.estimateFit("models/m.gguf");
    expect(fit?.verdict).toBe("streaming");
    expect(created).toHaveLength(0);
  });
});

describe("repacked weights or the mapped file (memoryFit.ts shouldRepack)", () => {
  const MiB = 1024 ** 2;
  const stalled = { text: "x", timings: { prompt_n: 40, prompt_ms: 2000, predicted_n: 9, predicted_ms: 90_000 } };
  const normal = { text: "x", timings: { prompt_n: 40, prompt_ms: 2000, predicted_n: 400, predicted_ms: 90_000 } };
  const answerWith = (r: unknown) => void (reply = r);

  it("marks the load as repacked, and keeps the mapped file once when the guard says the last repacked load closed the app", async () => {
    const begins: any[] = [];
    let keep = true;
    const guard = {
      begin: async (_m: any, _p: any, o: any) => void begins.push(o),
      end: async () => {},
      takeKeepMapped: async () => {
        const k = keep;
        keep = false;
        return k;
      },
    };
    const engine = new LlamaEngine(guard as any);
    await engine.load("models/q4.gguf");
    expect(initParams[0]).toMatchObject({ no_extra_bufts: true });
    await engine.load("models/q15.gguf");
    expect(initParams[1]).toMatchObject({ no_extra_bufts: false });
    expect(begins).toEqual([{ repacked: false }, { repacked: true }]);
  });

  it("after a stalled answer, reloads the model as the mapped file before the next question (Android)", async () => {
    const engine = new LlamaEngine(null);
    await engine.load("models/q4.gguf", { nCtx: 3072 });
    answerWith(normal);
    await engine.generate({ prompt: "a" });
    expect(created).toHaveLength(1);
    answerWith(stalled);
    await engine.generate({ prompt: "b" });
    answerWith(normal);
    // Sent while the reload runs: it waits for the reloaded model instead of finding none.
    await expect(engine.generate({ prompt: "c" })).resolves.toBe("x");
    expect(created).toHaveLength(2);
    expect(created[0].released).toBe(true);
    expect(initParams[1]).toMatchObject({ no_extra_bufts: true, n_ctx: 3072 });
    expect(engine.getModelInfo()?.repacked).toBe(false);
    // Same model asked again (the chat re-mounting): stays mapped, no third load.
    await engine.load("models/q4.gguf", { nCtx: 3072 });
    expect(created).toHaveLength(2);
  });

  it("does not reload on iOS (no swap: a slow answer is a slow model) or when already mapped", async () => {
    platform.OS = "ios";
    const engine = new LlamaEngine(null);
    await engine.load("models/q4.gguf");
    answerWith(stalled);
    await engine.generate({ prompt: "b" });
    await engine.generate({ prompt: "c" }).catch(() => {});
    expect(created).toHaveLength(1);
  });
});

describe("LlamaEngine generate queue (double-send race)", () => {
  it("never runs two completions on one context at once", async () => {
    const engine = new LlamaEngine();
    await engine.load("models/a.gguf");
    const ctx = created[0] as any;
    let running = 0;
    let maxRunning = 0;
    ctx.completion = (_p: unknown, onToken: (d: { token: string }) => void) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      onToken({ token: "x" });
      return new Promise((resolve) =>
        setTimeout(() => {
          running--;
          resolve({ text: "x", timings: { prompt_n: 12, prompt_ms: 30, predicted_n: 1, predicted_ms: 5 }, tokens_cached: 8 });
        }, 10)
      );
    };
    const timings: unknown[] = [];
    const [a, b] = await Promise.all([
      engine.generate({ prompt: "one", onTimings: (t) => timings.push(t) }),
      engine.generate({ prompt: "two" }),
    ]);
    expect([a, b]).toEqual(["x", "x"]);
    expect(maxRunning).toBe(1);
    expect(timings[0]).toEqual({ promptTokens: 12, promptMs: 30, predictedTokens: 1, predictedMs: 5, cachedTokens: 8 });
  });

  it("keeps serving after a failed generation", async () => {
    const engine = new LlamaEngine();
    await expect(engine.generate({ prompt: "x" })).rejects.toThrow(/not loaded/);
    await engine.load("models/a.gguf");
    const first = engine.generate({ prompt: "x" });
    await new Promise((r) => setTimeout(r, 0));
    const queued = engine.generate({ prompt: "y" });
    await engine.stop();
    // The running one ends with what it had; the queued one never starts.
    await expect(first).resolves.toBe("Hi");
    await expect(queued).resolves.toBe("");
  });
});

describe("default context size", () => {
  it("uses 2048 on 4GB devices and 4096 otherwise (or when RAM is unknown)", async () => {
    ram.total = 4 * 1024 ** 3;
    expect(defaultContextSize()).toBe(2048);
    const engine = new LlamaEngine();
    await engine.load("models/a.gguf");
    expect(initParams[0]).toMatchObject({ n_ctx: 2048 });
    ram.total = 12 * 1024 ** 3;
    expect(defaultContextSize()).toBe(4096);
    ram.total = 0;
    expect(defaultContextSize()).toBe(4096);
  });
});

describe("thinking budget", () => {
  it("caps reasoning and adds its budget on top of the answer's tokens (chat-template path only)", async () => {
    const engine = new LlamaEngine();
    await engine.load("models/a.gguf");
    const seen: any[] = [];
    (created[0] as any).completion = (p: any) => {
      seen.push(p);
      return Promise.resolve({ text: "ok" });
    };
    await engine.generate({ messages: [{ role: "user", content: "q" }], nPredict: 300, thinkingBudget: 256 });
    await engine.generate({ prompt: "q", nPredict: 300, thinkingBudget: 256 });
    // llama.rn ignores thinking_budget_tokens unless the end tag is given.
    expect(seen[0]).toMatchObject({ n_predict: 556, thinking_budget_tokens: 256, thinking_start_tag: "<think>", thinking_end_tag: "</think>" });
    expect(seen[0].thinking_budget_message).toBeTruthy();
    expect(seen[1].n_predict).toBe(300);
    expect(seen[1].thinking_budget_tokens).toBeUndefined();
    await engine.generate({ messages: [{ role: "user", content: "q" }], nPredict: 200, thinkingBudget: 256, enableThinking: false });
    expect(seen[2]).toMatchObject({ n_predict: 200, enable_thinking: false });
    expect(seen[2].thinking_budget_tokens).toBeUndefined();
  });
});

describe("thinkingTagsFor", () => {
  it("uses Gemma 4's channel markers and <think> for everyone else", async () => {
    const { thinkingTagsFor } = await import("./LlamaEngine");
    expect(thinkingTagsFor("gemma4")).toEqual({ start: "<|channel>thought", end: "<channel|>" });
    expect(thinkingTagsFor("lfm2moe")).toEqual({ start: "<think>", end: "</think>" });
    expect(thinkingTagsFor(null)).toEqual({ start: "<think>", end: "</think>" });
  });

  it("picks the tags from the loaded model's GGUF header", async () => {
    header = { "general.architecture": "gemma4", "gemma4.block_count": "30", "gemma4.embedding_length": "2560", "gemma4.attention.head_count": "8" } as any;
    const engine = new LlamaEngine();
    await engine.load("models/gemma.gguf");
    const seen: any[] = [];
    (created[0] as any).completion = (p: any) => {
      seen.push(p);
      return Promise.resolve({ text: "ok" });
    };
    await engine.generate({ messages: [{ role: "user", content: "q" }], nPredict: 100, thinkingBudget: 64 });
    expect(seen[0]).toMatchObject({ thinking_start_tag: "<|channel>thought", thinking_end_tag: "<channel|>" });
  });
});

describe("answer prefix kept in the KV cache (iPhone 13: 4-5 s to the first token)", () => {
  const PREFIX = { system: "You are Boar. Use the context below. You are BOAR, an offline app.", prompt: "You are Boar. Use the context below. You are BOAR, an offline app.\n\n" };
  const answerMsgs = [{ role: "system", content: `${PREFIX.system}\n\nContext:\n[1] Monsoon\nA monsoon is a seasonal wind.` }, { role: "user", content: "what's a monsoon?" }];

  async function loadedEngine() {
    const engine = new LlamaEngine();
    await engine.load("models/a.gguf");
    const seen: any[] = [];
    Object.assign(created[0] as any, {
      isJinjaSupported: () => true,
      completion: (p: any) => {
        seen.push(p);
        return Promise.resolve({ text: p.n_predict === WARM_N_PREDICT ? "" : "ok", timings: { prompt_n: 60, prompt_ms: 600 } });
      },
    });
    vi.useFakeTimers();
    return { engine, seen };
  }
  const warms = (seen: any[]) => seen.filter((p) => p.n_predict === WARM_N_PREDICT);

  it("prefills the tone's prefix after the load, generating one discarded token (n_predict 0 skipped the decode), in the answer's chat format", async () => {
    try {
      const { engine, seen } = await loadedEngine();
      engine.setAnswerPrefix(PREFIX);
      await vi.advanceTimersByTimeAsync(20);
      expect(warms(seen)).toHaveLength(1);
      expect(warms(seen)[0]).toMatchObject({ jinja: true, messages: [{ role: "system", content: PREFIX.system }, { role: "user", content: "" }] });
      // The answer that follows starts with the same system text: nothing to refill after it.
      await engine.generate({ messages: answerMsgs });
      await vi.advanceTimersByTimeAsync(5000);
      expect(warms(seen)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refills it once the session title (another prompt) is done, after an idle moment", async () => {
    try {
      const { engine, seen } = await loadedEngine();
      engine.setAnswerPrefix(PREFIX);
      await vi.advanceTimersByTimeAsync(20);
      await engine.generate({ messages: answerMsgs });
      await engine.generate({ messages: [{ role: "system", content: "Generate a short 3-5 word title" }, { role: "user", content: "q" }], nPredict: 16 });
      await vi.advanceTimersByTimeAsync(PREFIX_WARM_IDLE_MS - 50);
      expect(warms(seen)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(warms(seen)).toHaveLength(2);
      // Plain-prompt models get the plain prefix.
      (created[0] as any).isJinjaSupported = () => false;
      await engine.generate({ prompt: "Title: q" });
      await vi.advanceTimersByTimeAsync(PREFIX_WARM_IDLE_MS + 20);
      expect(warms(seen)[2]).toEqual({ prompt: PREFIX.prompt, n_predict: WARM_N_PREDICT });
    } finally {
      vi.useRealTimers();
    }
  });

  it("never puts a refill in front of a question already waiting, and skips between back-to-back prompts", async () => {
    try {
      const { engine, seen } = await loadedEngine();
      engine.setAnswerPrefix(PREFIX);
      // A question arrives before the post-load refill starts: it goes first, and it prefills the prefix itself.
      const q = engine.generate({ messages: answerMsgs });
      await vi.advanceTimersByTimeAsync(20);
      await q;
      expect(warms(seen)).toHaveLength(0);
      // Deep Research stages one after another: no refill between them.
      await engine.generate({ prompt: "stage 1" });
      await vi.advanceTimersByTimeAsync(100);
      await engine.generate({ prompt: "stage 2" });
      await vi.advanceTimersByTimeAsync(100);
      expect(warms(seen)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(PREFIX_WARM_IDLE_MS);
      expect(warms(seen)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing without a prefix, and a new tone prefills again", async () => {
    try {
      const { engine, seen } = await loadedEngine();
      await engine.generate({ prompt: "Title: q" });
      await vi.advanceTimersByTimeAsync(PREFIX_WARM_IDLE_MS + 20);
      expect(warms(seen)).toHaveLength(0);
      engine.setAnswerPrefix(PREFIX);
      engine.setAnswerPrefix({ ...PREFIX });
      await vi.advanceTimersByTimeAsync(20);
      expect(warms(seen)).toHaveLength(1);
      engine.setAnswerPrefix({ system: "Thorough.", prompt: "Thorough.\n\n" });
      await vi.advanceTimersByTimeAsync(20);
      expect(warms(seen)).toHaveLength(2);
      expect(warms(seen)[1].messages[0].content).toBe("Thorough.");
    } finally {
      vi.useRealTimers();
    }
  });
});
