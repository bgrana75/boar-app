import { describe, expect, it } from "vitest";
import { ANSWER_TIME_BUDGET_S, MIN_ANSWER_WORDS, answerLength, lengthInstruction } from "./answerLength";

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

describe("lengthInstruction", () => {
  it("states the target and asks for a complete answer", () => {
    expect(lengthInstruction(220)).toBe("Keep the whole answer under about 220 words, and finish it.");
  });
});
