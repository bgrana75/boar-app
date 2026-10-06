/**
 * Pre-load memory estimate that understands mmap.
 *
 * A GGUF loaded with mmap splits into two very different kinds of memory:
 *
 * - **Anonymous memory** (KV cache, compute/scratch buffers, logits): must be
 *   resident. If it does not fit, the process gets OOM-killed. This is the
 *   only thing that justifies refusing a load.
 * - **File-backed weights** (the mmap'd tensors): clean page cache. The kernel
 *   can drop and re-read these pages from storage at any time, so a file
 *   larger than free RAM still loads; it just gets slower as pages are
 *   re-read. For a MoE, each token touches only the shared weights plus the
 *   routed experts, so the hot set is a small fraction of the file.
 *
 * The old check (fileSize * 1.15 > free RAM → throw) treated the whole file as
 * anonymous memory and refused every model bigger than free RAM, including a
 * Qwen3-30B-A3B whose per-token working set is ~10% of its file.
 *
 * Pure module (no native imports) so it is unit-testable; LlamaEngine feeds it
 * the GGUF header (llama.rn loadLlamaModelInfo) and the device RAM readouts.
 * All figures are approximations, not measurements: see docs/ADAPTIVE_ROUTING.md.
 */

export interface GgufShape {
  arch: string;
  nLayer: number;
  nEmbd: number;
  nHead: number;
  nHeadKv: number;
  /** Per-head K/V width. Defaults to nEmbd / nHead when the header omits it. */
  keyLength: number;
  valueLength: number;
  nVocab: number;
  /** Dense FFN width (0 when every layer is MoE and the header omits it). */
  nFf: number;
  /** MoE only; 0 for dense models. */
  expertCount: number;
  expertUsedCount: number;
  expertFf: number;
  sharedExpertFf: number;
}

export type FitVerdict =
  /** Whole file + buffers fit in available RAM. */
  | "resident"
  /** File is larger than available RAM, but the per-token hot set fits: MoE streams experts from storage. */
  | "streaming"
  /** Buffers fit but the per-token hot set does not: every token re-reads weights from storage. Loads, very slowly. */
  | "thrashing"
  /** Anonymous buffers (KV + compute) alone exceed available RAM: loading would OOM. */
  | "insufficient";

export interface MemoryFit {
  verdict: FitVerdict;
  fileBytes: number;
  kvCacheBytes: number;
  computeBytes: number;
  /** Anonymous (non-evictable) memory: KV + compute. */
  anonBytes: number;
  /** Weights touched per generated token (shared + active experts). Equals fileBytes for dense models. */
  hotWeightBytes: number;
  /** Fraction of weights that are routed experts (0 for dense, or when the header is unreadable). */
  expertFraction: number;
  availableBytes: number;
  totalBytes: number;
  /** True when the GGUF header was usable; false means the estimate fell back to file-size heuristics. */
  fromMetadata: boolean;
}

export interface FitInputs {
  fileBytes: number;
  nCtx: number;
  /** Bytes per KV element: 2 for f16 (llama.cpp default), ~1.06 for q8_0. */
  kvBytesPerElem?: number;
  nUbatch?: number;
  shape: GgufShape | null;
  /**
   * Expert fraction to use when there is no GGUF header to read (e.g. a
   * catalog entry not downloaded yet). ~0.9-0.95 for Qwen3-30B-A3B-style MoE.
   */
  expertFractionHint?: number;
  totalRamBytes: number;
  availableRamBytes: number;
}

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

/** Floor for llama.cpp's CPU compute buffers, graph metadata and logits. */
const COMPUTE_FLOOR_BYTES = 192 * MiB;
/**
 * The per-token hot set is not the working set: consecutive tokens route to
 * different experts, and attention/norm weights plus the output head are hit
 * every token. Requiring 2x the single-token hot set keeps "streaming" from
 * meaning "re-read everything every token".
 */
const HOT_SET_SLACK = 2;

const num = (v: unknown): number => {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return NaN;
  // Per-layer arrays (e.g. head_count_kv on hybrid models) come back as "[a, b, ...]": take the max.
  if (v.trim().startsWith("[")) {
    const parts = v.replace(/[[\]]/g, "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    return parts.length ? Math.max(...parts) : NaN;
  }
  return Number(v);
};

/**
 * Parses the flat key→string map returned by llama.rn's loadLlamaModelInfo.
 * Returns null when the essentials (layers, width, heads) are missing, so the
 * caller falls back to file-size heuristics rather than guessing.
 */
export function parseGgufShape(meta: Record<string, unknown> | null | undefined): GgufShape | null {
  if (!meta) return null;
  const arch = typeof meta["general.architecture"] === "string" ? (meta["general.architecture"] as string) : "";
  if (!arch) return null;
  const k = (key: string) => num(meta[`${arch}.${key}`]);
  const nLayer = k("block_count");
  const nEmbd = k("embedding_length");
  const nHead = k("attention.head_count");
  if (![nLayer, nEmbd, nHead].every((n) => Number.isFinite(n) && n > 0)) return null;

  const or = (n: number, fallback: number) => (Number.isFinite(n) && n > 0 ? n : fallback);
  const headDim = nEmbd / nHead;
  const nHeadKv = or(k("attention.head_count_kv"), nHead);
  const keyLength = or(k("attention.key_length"), headDim);
  const valueLength = or(k("attention.value_length"), keyLength);

  const tokens = meta["tokenizer.ggml.tokens"];
  const nVocab = or(k("vocab_size"), Array.isArray(tokens) ? tokens.length : 32_000);

  const expertCount = or(k("expert_count"), 0);
  return {
    arch,
    nLayer,
    nEmbd,
    nHead,
    nHeadKv,
    keyLength,
    valueLength,
    nVocab,
    nFf: or(k("feed_forward_length"), 0),
    expertCount,
    expertUsedCount: expertCount ? or(k("expert_used_count"), 1) : 0,
    expertFf: expertCount ? or(k("expert_feed_forward_length"), or(k("feed_forward_length"), 0)) : 0,
    sharedExpertFf: or(k("expert_shared_feed_forward_length"), 0),
  };
}

/**
 * Fraction of the parameters that are routed experts, from the architecture
 * shape (GGUF does not record per-tensor quant sizes in the header, so
 * parameter counts stand in for bytes; experts and attention are usually
 * quantized alike). Approximate: ignores norms, biases and MLA variants.
 */
export function expertFractionOf(s: GgufShape): number {
  if (!s.expertCount || !s.expertFf) return 0;
  const attn = s.nEmbd * s.nHead * s.keyLength + 2 * s.nEmbd * s.nHeadKv * s.keyLength + s.nHead * s.valueLength * s.nEmbd;
  const shared = 3 * s.nEmbd * s.sharedExpertFf;
  const experts = 3 * s.nEmbd * s.expertFf * s.expertCount;
  const perLayerOther = attn + shared + s.nEmbd * s.expertCount; // + router
  const embeddings = 2 * s.nVocab * s.nEmbd; // token embedding + output head (upper bound if tied)
  const expertParams = s.nLayer * experts;
  const total = expertParams + s.nLayer * perLayerOther + embeddings;
  return total > 0 ? expertParams / total : 0;
}

export function kvCacheBytes(s: GgufShape, nCtx: number, bytesPerElem = 2): number {
  return s.nLayer * nCtx * s.nHeadKv * (s.keyLength + s.valueLength) * bytesPerElem;
}

export function estimateMemoryFit(i: FitInputs): MemoryFit {
  const s = i.shape;
  const nUbatch = i.nUbatch ?? 512;
  const kvPer = i.kvBytesPerElem ?? 2;

  let kv: number;
  let compute: number;
  let expertFraction = 0;
  if (s) {
    kv = kvCacheBytes(s, i.nCtx, kvPer);
    // Activations scratch: a handful of ubatch x width f32 buffers, plus the
    // attention scores (ubatch x ctx per head, reused across layers) and logits.
    compute =
      COMPUTE_FLOOR_BYTES +
      nUbatch * Math.max(s.nEmbd, s.nFf, s.expertFf) * 4 * 8 +
      nUbatch * i.nCtx * s.nHead * 4 +
      s.nVocab * 4 * 8;
    expertFraction = expertFractionOf(s);
  } else {
    // No header: assume KV + compute ~10% of the file (roughly what a dense 1-8B at 4k ctx needs).
    kv = i.fileBytes * 0.08;
    compute = COMPUTE_FLOOR_BYTES + i.fileBytes * 0.02;
    expertFraction = i.expertFractionHint ?? 0;
  }

  const anon = kv + compute;
  // Without a header, assume the common 8-of-128 routing.
  const activeExperts = s && s.expertCount ? s.expertUsedCount / s.expertCount : expertFraction > 0 ? 8 / 128 : 1;
  const hot = i.fileBytes * (1 - expertFraction) + i.fileBytes * expertFraction * activeExperts;

  const avail = Math.max(i.availableRamBytes, 0);
  let verdict: FitVerdict;
  if (anon > avail) verdict = "insufficient";
  else if (anon + i.fileBytes <= avail) verdict = "resident";
  else if (anon + Math.min(hot * HOT_SET_SLACK, i.fileBytes) <= avail && expertFraction > 0) verdict = "streaming";
  else verdict = "thrashing";

  return {
    verdict,
    fileBytes: i.fileBytes,
    kvCacheBytes: kv,
    computeBytes: compute,
    anonBytes: anon,
    hotWeightBytes: hot,
    expertFraction,
    availableBytes: avail,
    totalBytes: i.totalRamBytes,
    fromMetadata: !!s,
  };
}

/**
 * Whether llama.cpp may repack the weights for its fast ARM CPU kernels (llama.rn `no_extra_bufts: false`).
 *
 * Repacked weights are copies in the app's own (anonymous) memory, not the mmap'd file: Android can't drop
 * and re-read them, only compress them into swap. A model whose file doesn't fit the memory budget can't
 * work repacked at all (an 11 GB mixture of experts on a 12 GB phone would need its whole file in RAM instead
 * of streaming its experts), so it stays the mapped file.
 *
 * Only that case, even when little memory is free right now. On a Pixel 6a with the 4B and 1.8-2.1 GB free
 * (background apps open), the mapped file took 25 s to the first word against 10 s repacked, and the repacked
 * load was not killed in three tries (eval:device standard set, 2026-10-06); a stricter rule (file + buffers +
 * 0.75 GB) cost single questions 23 s instead of 9 s (2026-10-05). When a repacked load does get the app
 * killed, or stalls, LlamaEngine keeps the mapped file for that model instead (loadMarker.ts, isDecodeStall).
 */
export function shouldRepack(f: Pick<MemoryFit, "fileBytes" | "availableBytes">): boolean {
  return f.fileBytes <= f.availableBytes;
}

/** Decode below this rate, for at least STALL_MIN_MS, is a stall (normal on a 6 GB phone: 3.5-6 tok/s for a 4B). */
export const STALL_TOK_PER_SEC = 1;
export const STALL_MIN_MS = 10_000;

/**
 * Whether an answer's writing stalled: with repacked weights in swap, every token waits for them to be
 * decompressed (0.1 tok/s on a Pixel 6a with the 4B, ~1 answer in 6 on long conversations, 2026-10-04).
 */
export function isDecodeStall(t: { predictedTokens: number; predictedMs: number }): boolean {
  if (t.predictedMs < STALL_MIN_MS) return false;
  return (t.predictedTokens * 1000) / t.predictedMs < STALL_TOK_PER_SEC;
}

/** Kept for the system and the app you came from: a quarter of the phone's RAM, at least 2.5 GB. */
export const SYSTEM_RESERVE_FRACTION = 0.25;
export const MIN_SYSTEM_RESERVE_BYTES = 2.5 * GiB;

/**
 * RAM a new model can use: the phone's total minus a reserve for the system, or what the OS says is
 * available right now (ActivityManager.MemoryInfo.availMem ≈ MemAvailable) when that is more.
 *
 * availMem alone read the moment, not the phone: during a video call a 12 GB phone reported 3.6 GB,
 * and every model above ~2.5 GB was labelled slow although it ran well once loaded. Android frees more
 * when a large app asks for it (it stops cached background apps and pages out to zram), so the budget
 * is what the phone can give, and measured speed says whether a model is slow here
 * (src/routing/depth.ts, src/ui/flows/perfBands.ts).
 */
export function availableRamFrom(r: { totalBytes: number; rssBytes: number; availBytes?: number }): number {
  const reserve = Math.max(MIN_SYSTEM_RESERVE_BYTES, r.totalBytes * SYSTEM_RESERVE_FRACTION);
  const budget = Math.max(r.totalBytes - reserve, 0);
  return Math.max(budget, r.availBytes && r.availBytes > 0 ? r.availBytes : 0);
}

export const toGb = (b: number) => (b / GiB).toFixed(1);

/** Human-readable warning for the non-resident verdicts; null when there is nothing to warn about. */
export function describeFit(filename: string, f: MemoryFit): string | null {
  switch (f.verdict) {
    case "resident":
      return null;
    case "streaming":
      return (
        `"${filename}" (${toGb(f.fileBytes)}GB) is larger than the ~${toGb(f.availableBytes)}GB of free RAM. ` +
        `It is a mixture-of-experts model, so only ~${toGb(f.hotWeightBytes)}GB of weights are used per token; ` +
        `the rest streams from storage. Expect slower answers than a model that fits in RAM.`
      );
    case "thrashing":
      return (
        `"${filename}" (${toGb(f.fileBytes)}GB) does not fit in the ~${toGb(f.availableBytes)}GB of free RAM, ` +
        `and it reads ~${toGb(f.hotWeightBytes)}GB of weights per token from storage. It will load, but ` +
        `answers may take minutes. A smaller model is recommended.`
      );
    case "insufficient":
      return (
        `"${filename}" needs ~${toGb(f.anonBytes)}GB of working memory (context cache and buffers) that cannot ` +
        `be streamed from storage, but only ~${toGb(f.availableBytes)}GB is free (of ${toGb(f.totalBytes)}GB). ` +
        `Close other apps, lower the context size, or pick a smaller model.`
      );
  }
}

/**
 * Context window when the caller does not pick one, by device RAM. The KV
 * cache is the one allocation mmap cannot page out: 4GB phones (iPhone 13)
 * get 2048 (jetsam limit, docs/IOS.md), 6GB phones 3072 (Qwen3-4B's KV is
 * 144 KiB/token: 432 MiB instead of 576), larger ones 4096. 3072 still holds
 * ~1.2k tokens of sources + 512 answer + 256 thinking + history.
 */
export function contextSizeForRam(totalRamBytes: number): number {
  if (totalRamBytes <= 0) return 4096;
  if (totalRamBytes <= 4.5 * 1024 ** 3) return 2048;
  if (totalRamBytes <= 6.5 * 1024 ** 3) return 3072;
  return 4096;
}
