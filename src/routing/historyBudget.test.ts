import { describe, expect, it } from "vitest";
import { budgetHistory, leadSentences } from "./historyBudget";

const longAnswer = (topic: string) =>
  Array.from({ length: 40 }, (_, i) => `Sentence ${i + 1} about ${topic} explains one more detail of it.`).join(" ");

describe("leadSentences", () => {
  it("keeps short text as is", () => {
    expect(leadSentences("Canberra is the capital.", 80)).toBe("Canberra is the capital.");
  });

  it("cuts a long answer to its opening sentences within the budget", () => {
    const out = leadSentences(longAnswer("vaccines"), 40);
    expect(out.startsWith("Sentence 1 about vaccines")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    expect(Math.ceil(out.length / 4)).toBeLessThanOrEqual(42);
  });

  it("cuts a single over-long sentence by characters", () => {
    const out = leadSentences("word ".repeat(200).trim() + ".", 10);
    expect(out.length).toBeLessThanOrEqual(42);
  });
});

describe("budgetHistory", () => {
  it("keeps questions whole and shortens earlier answers", () => {
    const turns = [
      { role: "user" as const, text: "How do vaccines work?" },
      { role: "assistant" as const, text: longAnswer("vaccines") },
    ];
    const out = budgetHistory(turns);
    expect(out[0]).toEqual(turns[0]);
    expect(out[1].text.length).toBeLessThan(turns[1].text.length);
  });

  it("drops the oldest turns once the budget is spent, newest first", () => {
    const turns = ["vaccines", "evolution", "revolutions"].flatMap((t) => [
      { role: "user" as const, text: `Tell me about ${t}.` },
      { role: "assistant" as const, text: longAnswer(t) },
    ]);
    const out = budgetHistory(turns, { budgetTokens: 90, answerTokens: 40 });
    expect(out[out.length - 1].text).toContain("revolutions");
    expect(out.some((t) => t.text.includes("vaccines"))).toBe(false);
    expect(out.reduce((n, t) => n + Math.ceil(t.text.length / 4), 0)).toBeLessThanOrEqual(90);
  });

  it("always keeps the latest exchange, even over budget", () => {
    const turns = [
      { role: "user" as const, text: "q ".repeat(300) },
      { role: "assistant" as const, text: longAnswer("x") },
    ];
    expect(budgetHistory(turns, { budgetTokens: 10 })).toHaveLength(2);
  });

  it("is a no-op for an empty history", () => {
    expect(budgetHistory([])).toEqual([]);
  });
});
