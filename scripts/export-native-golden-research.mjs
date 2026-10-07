// Golden outputs of Deep Research (src/services/orchestrator.ts) and the parts of src/routing/context.ts it uses
// (onTopic, compressContext, mergeSources) for the native port. The orchestrator runs for real with the model and
// retrieval replaced by recorders: every stage's prompt, settings and canned reply, and every retrieval's chunks,
// are saved so the Kotlin test can replay them and require the same prompts, sources and answer.
//   node scripts/export-native-golden-research.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import ts from "typescript";

const STUBS = {
  "../inference/LlamaEngine": `export const llamaEngine = {
    hasEmbeddedChatTemplate: () => true,
    generate: (opts) => globalThis.__generate(opts),
  };`,
  "../rag/retrieve": `export const retrieve = (q, k) => globalThis.__retrieve(q, k);`,
};
registerHooks({
  resolve(specifier, context, next) {
    if (STUBS[specifier] && context.parentURL?.endsWith("/services/orchestrator.ts")) {
      return { url: `data:text/javascript,${encodeURIComponent(STUBS[specifier])}`, shortCircuit: true };
    }
    try {
      return next(specifier, context);
    } catch (e) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$|\.json$/.test(specifier)) return next(`${specifier}.ts`, context);
      throw e;
    }
  },
  // Type-only imports without "type" (ConversationHistory) need TypeScript's compiler, not Node's type stripping.
  load(url, context, next) {
    if (!url.startsWith("file:") || !url.endsWith(".ts")) return next(url, context);
    const source = readFileSync(fileURLToPath(url), "utf8");
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    return { format: "module", source: js, shortCircuit: true };
  },
});

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "android-native/engine/src/test/resources/golden");
const ctx = await import(join(root, "src/routing/context.ts"));
const orch = await import(join(root, "src/services/orchestrator.ts"));
const evalSet = JSON.parse(readFileSync(join(root, "android-native/app/src/main/assets/boar-data/eval-set.json"), "utf8"));
const corpus = JSON.parse(readFileSync(join(root, "assets/corpus/corpus.json"), "utf8"));
const docs = corpus.map((d, i) => ({ chunkId: `seed:${i}`, docId: `seed:${d.title}`, title: d.title, body: d.body, source: d.source, score: 1, matchType: "lexical" }));

// Stand-in retrieval: corpus passages sharing the most content words with the query (ties by corpus order).
const fake = (q, k) => {
  const qt = new Set(ctx.tokenizeTerms(q));
  return docs
    .map((c, i) => ({ c, i, n: ctx.tokenizeTerms(`${c.title} ${c.body.slice(0, 400)}`).filter((t) => qt.has(t)).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .slice(0, k)
    .map((x) => ({ ...x.c, score: x.n }));
};

const questions = [
  ...evalSet.evalSet.map((q) => q.query), ...evalSet.extraSets.map((q) => q.query),
  "Why did the Industrial Revolution start in Britain?", "Compare the Silk Road and the Age of Discovery as trade routes.",
  "Como o efeito estufa afeta o clima?", "What happened in 1906?", "Tell me about Vitalik Buterin and Ethereum.",
];

// onTopic and compressContext on each question's stand-in retrieval, at three budgets. Besides the research
// questions: questions built from corpus titles, long ones (coverage near the 0.75 line) and short ones.
const titled = docs.filter((_, i) => i % 6 === 0).flatMap((d, i) => {
  const words = d.body.split(/\s+/).filter((w) => w.length > 5).slice(0, 6).join(" ");
  return [`What was ${d.title}?`, `How did ${d.title} relate to ${words}?`, ...(i % 3 === 0 ? [d.title, `${d.title} in 1906`] : [])];
});
const topic = [];
for (const [ti, q] of [...questions, ...titled].entries()) {
  const chunks = fake(q, 8);
  const budget = [150, 300, 600][ti % 3];
  const compressed = ctx.compressContext(q, chunks, { tokenBudget: budget });
  topic.push({
    query: q, budget,
    chunkIds: chunks.map((c) => c.chunkId),
    onTopic: chunks.map((c) => ctx.onTopic(q, c)),
    compressed: compressed.chunks.map((c) => ({ chunkId: c.chunkId, body: c.body, relevance: c.relevance ?? null })),
    keptIndices: compressed.keptIndices, tokensBefore: compressed.tokensBefore, tokensAfter: compressed.tokensAfter,
  });
}

// Canned decompositions that exercise the line parser: numbering, bullets, short lines, too many, none usable.
const decompositions = [
  (q) => `1. What is the background of: ${q}\n2. What are the main causes behind it?\n3) What are the practical implications today?`,
  (q) => `- Technical analysis of ${q}\n* Counter-arguments to consider here\n\nok\n- Fourth line that should be dropped by the limit\n- Fifth`,
  () => `short\nno\n`,
  (q) => `   How does it work in detail?   \n\n${q.slice(0, 40)} and its history?`,
];
const research = [];
for (const [qi, q] of questions.entries()) {
  const calls = [];
  const retrievals = [];
  let n = 0;
  globalThis.__retrieve = async (sq, k) => {
    const r = fake(sq, k);
    retrievals.push({ query: sq, k, chunks: r });
    return r;
  };
  globalThis.__generate = async (opts) => {
    const msgs = opts.messages;
    const reply = n === 0 ? decompositions[qi % decompositions.length](q) : `Reply ${n} to the stage, citing [1] and [${n + 1}].`;
    calls.push({ system: msgs[0].content, user: msgs[1].content, nPredict: opts.nPredict, temperature: opts.temperature, reply });
    n++;
    opts.onToken?.(reply);
    return reply;
  };
  const system = qi % 3 === 0 ? undefined : qi % 3 === 1 ? "You are Boar, a concise offline research assistant." : "   ";
  const history = qi % 2 === 0 ? undefined : { summary: "  We talked about history.  ", turns: [] };
  const language = qi % 5 === 0 ? "Responda em português do Brasil." : undefined;
  const r = await orch.runDeepResearch(q, system, history, 512, undefined, undefined, undefined, { answerLanguage: language });
  research.push({
    query: q, system: system ?? null, summary: history?.summary ?? null, language: language ?? null, calls, retrievals,
    subQuestions: r.subQuestions, answer: r.answer,
    citations: r.citations.map((c) => ({ chunkId: c.chunkId, body: c.body, relevance: c.relevance ?? null })),
    fullCitations: r.fullCitations.map((c) => c.chunkId),
  });
}
// Edge cases real passages never reach (checked to separate the variants): a passage whose opening sentence fits
// with its title but not with the sentence that matched (context.ts keeps the opening alone; compress.ts skips it),
// and a source covering exactly 0.7 of a 10-word question (under MIN_TERM_COVERAGE).
const opening = { chunkId: "e1", docId: "e1", title: "Doc", body: "Zeta opens with a long sentence about unrelated matters that keeps going for quite a while here. Alpha beta are here.", score: 1, matchType: "lexical" };
const fruit = { chunkId: "e2", docId: "e2", title: "Orchard notes", body: "Growers keep figs, kiwis and cherries apart. Dates need heat; apples, lemons and grapes need water.", score: 1, matchType: "lexical" };
for (const [q, chunks, budget] of [["alpha beta", [opening], 26], ["alpha beta", [opening], 30], ["how do apples bananas cherries dates figs grapes kiwis lemons mangos nectarines", [fruit], 600]]) {
  const compressed = ctx.compressContext(q, chunks, { tokenBudget: budget });
  topic.push({
    query: q, budget, chunks, chunkIds: chunks.map((c) => c.chunkId), onTopic: chunks.map((c) => ctx.onTopic(q, c)),
    compressed: compressed.chunks.map((c) => ({ chunkId: c.chunkId, body: c.body, relevance: c.relevance ?? null })),
    keptIndices: compressed.keptIndices, tokensBefore: compressed.tokensBefore, tokensAfter: compressed.tokensAfter,
  });
}
const merge = ctx.mergeSources([[docs[0], docs[1]], [docs[1], docs[2]], [], [docs[2], docs[0], docs[3]]]);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "research.json"), JSON.stringify({ topic, research, merge: { sources: merge.sources.map((c) => c.chunkId), indexMaps: merge.indexMaps } }, null, 1) + "\n");
console.log(`${topic.length} topic cases, ${research.length} research runs -> research.json`);
