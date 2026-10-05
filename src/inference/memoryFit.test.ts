import { describe, it, expect } from "vitest";
import {
  availableRamFrom,
  shouldRepack,
  REPACK_HEADROOM_BYTES,
  describeFit,
  estimateMemoryFit,
  expertFractionOf,
  kvCacheBytes,
  parseGgufShape,
} from "./memoryFit";

const GiB = 1024 ** 3;

// Header values as llama.rn's loadLlamaModelInfo returns them (every value a string).
const QWEN3_30B_A3B = {
  "general.architecture": "qwen3moe",
  "qwen3moe.block_count": "48",
  "qwen3moe.embedding_length": "2048",
  "qwen3moe.attention.head_count": "32",
  "qwen3moe.attention.head_count_kv": "4",
  "qwen3moe.attention.key_length": "128",
  "qwen3moe.attention.value_length": "128",
  "qwen3moe.feed_forward_length": "6144",
  "qwen3moe.expert_count": "128",
  "qwen3moe.expert_used_count": "8",
  "qwen3moe.expert_feed_forward_length": "768",
  "qwen3moe.vocab_size": "151936",
};

const QWEN25_1_5B = {
  "general.architecture": "qwen2",
  "qwen2.block_count": "28",
  "qwen2.embedding_length": "1536",
  "qwen2.attention.head_count": "12",
  "qwen2.attention.head_count_kv": "2",
  "qwen2.feed_forward_length": "8960",
};

const QWEN25_7B = {
  "general.architecture": "qwen2",
  "qwen2.block_count": "28",
  "qwen2.embedding_length": "3584",
  "qwen2.attention.head_count": "28",
  "qwen2.attention.head_count_kv": "4",
  "qwen2.feed_forward_length": "18944",
};

describe("parseGgufShape", () => {
  it("reads a MoE header", () => {
    const s = parseGgufShape(QWEN3_30B_A3B)!;
    expect(s).toMatchObject({ arch: "qwen3moe", nLayer: 48, nHeadKv: 4, expertCount: 128, expertUsedCount: 8, expertFf: 768, nVocab: 151936 });
  });

  it("derives head width and treats missing expert keys as dense", () => {
    const s = parseGgufShape(QWEN25_1_5B)!;
    expect(s.keyLength).toBe(128);
    expect(s.valueLength).toBe(128);
    expect(s.expertCount).toBe(0);
  });

  it("takes the max of a per-layer array", () => {
    const s = parseGgufShape({ ...QWEN25_1_5B, "qwen2.attention.head_count_kv": "[0, 2, 2, 4]" })!;
    expect(s.nHeadKv).toBe(4);
  });

  it("returns null without the essentials", () => {
    expect(parseGgufShape(null)).toBeNull();
    expect(parseGgufShape({ "general.architecture": "llama" })).toBeNull();
    expect(parseGgufShape({ "qwen2.block_count": "28" })).toBeNull();
  });
});

describe("expertFractionOf / kvCacheBytes", () => {
  it("puts ~95% of a Qwen3-30B-A3B in routed experts and ~3B params active", () => {
    const s = parseGgufShape(QWEN3_30B_A3B)!;
    const f = expertFractionOf(s);
    expect(f).toBeGreaterThan(0.92);
    expect(f).toBeLessThan(0.97);
    // Active share = shared part + 8/128 of the experts ≈ 3.3B / 30.5B.
    const active = 1 - f + f * (8 / 128);
    expect(active).toBeGreaterThan(0.09);
    expect(active).toBeLessThan(0.13);
  });

  it("is 0 for dense models", () => {
    expect(expertFractionOf(parseGgufShape(QWEN25_7B)!)).toBe(0);
  });

  it("sizes the f16 KV cache from the header", () => {
    // 48 layers x 4096 ctx x 4 kv heads x (128+128) x 2 bytes = 384 MiB.
    expect(kvCacheBytes(parseGgufShape(QWEN3_30B_A3B)!, 4096)).toBe(384 * 1024 ** 2);
  });
});

describe("estimateMemoryFit", () => {
  const device12 = { totalRamBytes: 12 * GiB, availableRamBytes: 7 * GiB };

  it("loads a small dense model resident", () => {
    const fit = estimateMemoryFit({ fileBytes: 1.0 * GiB, nCtx: 4096, shape: parseGgufShape(QWEN25_1_5B), ...device12 });
    expect(fit.verdict).toBe("resident");
    expect(describeFit("qwen.gguf", fit)).toBeNull();
  });

  it("lets an 11GB MoE stream on a 12GB phone instead of refusing it (the old check threw here)", () => {
    const fileBytes = 11 * GiB;
    // Old rule, for the record: 11 * 1.15 = 12.65GB > available → throw.
    expect(fileBytes * 1.15 > device12.availableRamBytes).toBe(true);
    const fit = estimateMemoryFit({ fileBytes, nCtx: 4096, shape: parseGgufShape(QWEN3_30B_A3B), ...device12 });
    expect(fit.verdict).toBe("streaming");
    expect(fit.hotWeightBytes).toBeLessThan(1.5 * GiB);
    expect(fit.anonBytes).toBeLessThan(1.5 * GiB);
    expect(describeFit("qwen3-30b.gguf", fit)).toMatch(/mixture-of-experts/);
  });

  it("warns but does not refuse a dense model bigger than free RAM", () => {
    const fit = estimateMemoryFit({ fileBytes: 9 * GiB, nCtx: 4096, shape: parseGgufShape(QWEN25_7B), ...device12 });
    expect(fit.verdict).toBe("thrashing");
    expect(describeFit("big-dense.gguf", fit)).toMatch(/minutes/);
  });

  it("refuses only when KV + buffers alone exceed available RAM", () => {
    const fit = estimateMemoryFit({
      fileBytes: 1 * GiB,
      nCtx: 131072,
      shape: parseGgufShape(QWEN25_7B),
      totalRamBytes: 8 * GiB,
      availableRamBytes: 3 * GiB,
    });
    // 28 x 131072 x 4 x 256 x 2 = 7GiB of KV.
    expect(fit.kvCacheBytes).toBe(7 * GiB);
    expect(fit.verdict).toBe("insufficient");
    expect(describeFit("x.gguf", fit)).toMatch(/cannot be streamed/);
  });

  it("scales KV with the element size (q8_0 cache roughly halves it)", () => {
    const shape = parseGgufShape(QWEN25_7B);
    const f16 = estimateMemoryFit({ fileBytes: GiB, nCtx: 8192, shape, ...device12 });
    const q8 = estimateMemoryFit({ fileBytes: GiB, nCtx: 8192, shape, kvBytesPerElem: 1.0625, ...device12 });
    expect(q8.kvCacheBytes / f16.kvCacheBytes).toBeCloseTo(0.53, 2);
  });

  it("falls back to file-size heuristics without a header, honoring an expert hint", () => {
    const dense = estimateMemoryFit({ fileBytes: 11 * GiB, nCtx: 4096, shape: null, ...device12 });
    expect(dense.fromMetadata).toBe(false);
    expect(dense.verdict).toBe("thrashing");
    const moe = estimateMemoryFit({ fileBytes: 11 * GiB, nCtx: 4096, shape: null, expertFractionHint: 0.95, ...device12 });
    expect(moe.verdict).toBe("streaming");
  });
});

describe("availableRamFrom", () => {
  it("is the total minus a quarter kept for the system, not the RAM free at the moment", () => {
    // The 12 GB phone that reported 3.6 GB free during a video call.
    expect(availableRamFrom({ totalBytes: 12 * GiB, rssBytes: GiB, availBytes: 3.6 * GiB })).toBe(9 * GiB);
    // 8 GB: the 2.5 GB minimum is more than a quarter.
    expect(availableRamFrom({ totalBytes: 8 * GiB, rssBytes: GiB, availBytes: 0 })).toBe(5.5 * GiB);
  });
  it("keeps at least 2.5 GB for the system on small phones", () => {
    expect(availableRamFrom({ totalBytes: 4 * GiB, rssBytes: GiB })).toBe(1.5 * GiB);
    expect(availableRamFrom({ totalBytes: 2 * GiB, rssBytes: GiB })).toBe(0);
  });
  it("uses what the OS reports when that is more", () => {
    expect(availableRamFrom({ totalBytes: 12 * GiB, rssBytes: GiB, availBytes: 10 * GiB })).toBe(10 * GiB);
  });
});

describe("shouldRepack", () => {
  const GiB = 1024 ** 3;
  // Pixel 6a: 5.46 GiB total -> availableRamFrom budget ~2.96 GiB.
  const budget = availableRamFrom({ totalBytes: 5.46 * GiB, rssBytes: 0, availBytes: 2.8 * GiB });

  it("keeps the 4B as the mapped file on a 6 GB phone", () => {
    expect(shouldRepack({ fileBytes: 2.33 * GiB, anonBytes: 0.8 * GiB, availableBytes: budget })).toBe(false);
  });

  it("repacks the 1.5B on the same phone (fast prompt reading, room to spare)", () => {
    expect(shouldRepack({ fileBytes: 0.92 * GiB, anonBytes: 0.45 * GiB, availableBytes: budget })).toBe(true);
  });

  it("repacks the 4B on a 12 GB phone", () => {
    const big = availableRamFrom({ totalBytes: 11.6 * GiB, rssBytes: 0, availBytes: 6 * GiB });
    expect(shouldRepack({ fileBytes: 2.33 * GiB, anonBytes: 0.8 * GiB, availableBytes: big })).toBe(true);
  });

  it("never repacks a model that has to stream from storage", () => {
    expect(shouldRepack({ fileBytes: 11 * GiB, anonBytes: 0.6 * GiB, availableBytes: 8.7 * GiB })).toBe(false);
  });

  it("needs the headroom, not just a fit", () => {
    expect(shouldRepack({ fileBytes: 2 * GiB, anonBytes: 0.5 * GiB, availableBytes: 2.5 * GiB + REPACK_HEADROOM_BYTES - 1 })).toBe(false);
  });
});
