import { describe, expect, it } from "vitest";
import { ANSWER_TIME_BUDGET_S, MIN_ANSWER_WORDS, RECENT_MS, answerLength, currentSpeed, lengthInstruction } from "./answerLength";

describe("answerLength", () => {
  it("lets a fast model use the user's max tokens", () => {
    // Qwen2.5-1.5B on a Pixel 6a: ~15 tok/s, 90 s would allow 1,350 tokens.
    expect(answerLength({ maxTokens: 512, tokPerSec: 15 })).toEqual({ tokens: 512, words: 310, limit: "max" });
  });

  it("shortens the answer on a slow model so it ends within the time budget", () => {
    // Qwen3-4B on the same phone: ~4 tok/s, cut at ~450 tokens by the 120 s timeout.
    const r = answerLength({ maxTokens: 512, tokPerSec: 4 });
    expect(r).toEqual({ tokens: 4 * ANSWER_TIME_BUDGET_S, words: 220, limit: "time" });
  });

  it("uses only the max tokens for a model never measured on this phone", () => {
    expect(answerLength({ maxTokens: 512 })).toEqual({ tokens: 512, words: 310, limit: "max" });
    expect(answerLength({ maxTokens: 512, tokPerSec: 0 }).limit).toBe("max");
  });

  it("never asks for fewer than the minimum words", () => {
    expect(answerLength({ maxTokens: 512, tokPerSec: 0.5 }).words).toBe(MIN_ANSWER_WORDS);
  });
});

describe("answerLength on a hot phone", () => {
  it("leaves room for the first word: a slow start gets a shorter answer", () => {
    // Pixel 6a, answer 5 of a conversation: 2.5 tok/s and 31.6 s to the first word; with 90 s of
    // writing it was cut at 120 s. 120 - 31.6 - 15 = 73.4 s of writing -> 183 tokens, done by ~105 s.
    const r = answerLength({ maxTokens: 512, tokPerSec: 2.5, ttftMs: 31_600 });
    expect(r.tokens).toBe(183);
    expect(r.limit).toBe("time");
    expect(31.6 + r.tokens / 2.5).toBeLessThan(120);
  });

  it("never plans less than the minimum writing time", () => {
    expect(answerLength({ maxTokens: 512, tokPerSec: 4, ttftMs: 100_000 }).tokens).toBe(4 * 30);
  });

  it("caps writing at the budget when the first word is quick", () => {
    expect(answerLength({ maxTokens: 512, tokPerSec: 4, ttftMs: 2_000 }).tokens).toBe(4 * ANSWER_TIME_BUDGET_S);
  });
});

describe("currentSpeed", () => {
  const now = 10_000_000;
  const rec = (createdAt: number, tokPerSec: number, ttftMs: number, extra = {}) => ({ modelId: "m", createdAt, tokPerSec, ttftMs, tokensGenerated: 200, outcome: "success", ...extra });

  it("uses the latest recent answer of this model", () => {
    const records = [rec(now - 60_000, 4.9, 8_000), rec(now - 10_000, 2.5, 31_600), rec(now - 5_000, 9, 1_000, { modelId: "other" })];
    expect(currentSpeed(records, "m", now, 4.2)).toEqual({ tokPerSec: 2.5, ttftMs: 31_600 });
  });

  it("falls back to the typical speed when the latest answer is old", () => {
    expect(currentSpeed([rec(now - RECENT_MS - 1, 2.5, 31_600)], "m", now, 4.2)).toEqual({ tokPerSec: 4.2 });
  });

  it("skips failed and very short answers", () => {
    const records = [rec(now - 60_000, 4.9, 8_000), rec(now - 1_000, 0.1, 40_000, { tokensGenerated: 9 }), rec(now - 500, 1, 1, { outcome: "failure" })];
    expect(currentSpeed(records, "m", now, 4.2)).toEqual({ tokPerSec: 4.9, ttftMs: 8_000 });
  });

  it("returns nothing without a model", () => {
    expect(currentSpeed([], undefined, now, 4.2)).toEqual({});
  });
});

describe("lengthInstruction", () => {
  it("states the target and asks for a complete answer", () => {
    expect(lengthInstruction(220)).toBe("Keep the whole answer under about 220 words, and finish it.");
  });
});
