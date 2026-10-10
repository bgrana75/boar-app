import { describe, expect, it } from "vitest";
import { followUpSearch, searchWithFollowUp } from "./followUp";

const after = (question: string) => ({
  turns: [
    { role: "user" as const, text: question },
    { role: "assistant" as const, text: "An answer about it." },
  ],
});

describe("followUpSearch", () => {
  it("searches a question that points back together with the previous question", () => {
    expect(followUpSearch("What did he publish?", after("Who proposed the theory of evolution by natural selection?"))).toEqual({
      direct: "Who proposed the theory of evolution by natural selection? What did he publish?",
      previous: "Who proposed the theory of evolution by natural selection?",
    });
  });

  it("does the same in Portuguese", () => {
    expect(followUpSearch("O que ele publicou?", after("Quem propôs a teoria da evolução?")).direct).toContain("Quem propôs");
  });

  it("borrows the previous topic for a short question only as a fallback", () => {
    expect(followUpSearch("What are the side effects?", after("How do vaccines work?"))).toEqual({
      fallback: "How do vaccines work? What are the side effects?",
    });
  });

  it("never borrows for a question that names its own subject", () => {
    expect(followUpSearch("What is the capital of Australia?", after("Compare the French Revolution and the Industrial Revolution."))).toEqual({});
  });

  it("leaves a longer self-contained question alone", () => {
    expect(followUpSearch("How does the immune system respond to a new virus infection?", after("How do vaccines work?"))).toEqual({});
  });

  it("never takes the current question as the previous one", () => {
    const history = {
      turns: [
        { role: "user" as const, text: "Who proposed the theory of evolution?" },
        { role: "assistant" as const, text: "Charles Darwin." },
        { role: "user" as const, text: "What did he publish?" },
      ],
    };
    expect(followUpSearch("What did he publish?", history).direct).toBe("Who proposed the theory of evolution? What did he publish?");
  });

  it("does nothing without an earlier question", () => {
    expect(followUpSearch("What did he publish?", { turns: [] })).toEqual({});
    expect(followUpSearch("What did he publish?")).toEqual({});
  });

  it("does not read 'the' or 'there' inside other words as pointing back", () => {
    expect(followUpSearch("How does photosynthesis work in theory?", after("How do vaccines work?")).direct).toBeUndefined();
  });

  it("reads 'there' as pointing back only as a place, not in 'is there' or 'there are'", () => {
    const prev = after("How do vaccines work?");
    expect(followUpSearch("Is there an effective treatment for malaria in adults?", prev)).toEqual({});
    expect(followUpSearch("Are there any side effects?", prev)).toEqual({ fallback: "How do vaccines work? Are there any side effects?" });
    expect(followUpSearch("There's a cure?", prev)).toEqual({ fallback: "How do vaccines work? There's a cure?" });
    for (const q of ["What happened there?", "Were they there last week?", "There?"]) expect(followUpSearch(q, prev).direct).toBe(`How do vaccines work? ${q}`);
  });

  it("counts a name as the first word as the question's own subject, but not an opening word", () => {
    const prev = after("Who proposed the theory of evolution by natural selection?");
    for (const q of ["Australia capital?", "EIP-1559?", "Canberra?", "«Darwin» books?"]) expect(followUpSearch(q, prev)).toEqual({});
    for (const q of ["What are his books?", "Summarize the books", "Quais são os livros?", "What's the date?"]) expect(followUpSearch(q, prev)).not.toEqual({});
  });
});

describe("searchWithFollowUp", () => {
  const history = after("How do vaccines work?");

  it("keeps what the question alone found", async () => {
    const seen: string[] = [];
    const r = await searchWithFollowUp("What are the side effects?", history, async (t) => (seen.push(t), ["chunk"]));
    expect(r).toEqual({ chunks: ["chunk"], searchedFor: "What are the side effects?" });
    expect(seen).toHaveLength(1);
  });

  it("retries with the previous question when the short one finds nothing", async () => {
    const seen: string[] = [];
    const r = await searchWithFollowUp("What are the side effects?", history, async (t) => (seen.push(t), t.includes("vaccines") ? ["vaccine side effects"] : []));
    expect(r.chunks).toEqual(["vaccine side effects"]);
    expect(r.searchedFor).toBe("How do vaccines work? What are the side effects?");
    expect(seen).toEqual(["What are the side effects?", "How do vaccines work? What are the side effects?"]);
  });

  it("searches a question that points back combined, once, when that finds sources", async () => {
    const seen: string[] = [];
    const r = await searchWithFollowUp("What did he publish?", after("Who proposed evolution?"), async (t) => (seen.push(t), ["darwin"]));
    expect(seen).toEqual(["Who proposed evolution? What did he publish?"]);
    expect(r.searchedFor).toBe("Who proposed evolution? What did he publish?");
  });

  it("falls back to the previous question alone, still compressing against the combined words", async () => {
    const seen: string[] = [];
    const r = await searchWithFollowUp("What did he publish?", after("Who proposed evolution?"), async (t) =>
      (seen.push(t), t === "Who proposed evolution?" ? ["Evolution article"] : [])
    );
    expect(seen).toEqual(["Who proposed evolution? What did he publish?", "Who proposed evolution?"]);
    expect(r).toEqual({ chunks: ["Evolution article"], searchedFor: "Who proposed evolution? What did he publish?" });
  });
});
