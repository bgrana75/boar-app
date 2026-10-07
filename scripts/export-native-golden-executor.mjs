// Golden outputs of the adaptive-routing executor (src/routing/executor.ts executeRoutingPlan, src/routing/verify.ts)
// for the native port. Real plans from routing-plan.json run through the real executor with recording stand-ins for
// the engine (resident model, loads, generations) and retrieval; the Kotlin test replays the same replies and requires
// the same loads, prompts, settings and results.
//   node scripts/export-native-golden-executor.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import ts from "typescript";

const STUBS = {
  "../inference/LlamaEngine": `export const llamaEngine = {
    getModelInfo: () => (globalThis.__resident ? { filename: globalThis.__resident } : null),
    load: async (filename) => { globalThis.__loads.push(filename); globalThis.__resident = filename; },
    hasEmbeddedChatTemplate: () => globalThis.__template,
    generate: (opts) => globalThis.__generate(opts),
  };`,
  "../rag/retrieve": `export const retrieve = (q, k) => globalThis.__retrieve(q, k);`,
};
registerHooks({
  resolve(specifier, context, next) {
    if (STUBS[specifier] && context.parentURL?.endsWith("/routing/executor.ts")) {
      return { url: `data:text/javascript,${encodeURIComponent(STUBS[specifier])}`, shortCircuit: true };
    }
    try {
      return next(specifier, context);
    } catch (e) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$|\.json$/.test(specifier)) return next(`${specifier}.ts`, context);
      throw e;
    }
  },
  load(url, context, next) {
    if (!url.startsWith("file:") || !url.endsWith(".ts")) return next(url, context);
    const source = readFileSync(fileURLToPath(url), "utf8");
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    return { format: "module", source: js, shortCircuit: true };
  },
});

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "android-native/engine/src/test/resources/golden");
const exec = await import(join(root, "src/routing/executor.ts"));
const ctx = await import(join(root, "src/routing/context.ts"));
const plans = JSON.parse(readFileSync(join(out, "routing-plan.json"), "utf8")).adaptive;
const corpus = JSON.parse(readFileSync(join(root, "assets/corpus/corpus.json"), "utf8"));
const docs = corpus.map((d, i) => ({ chunkId: `seed:${i}`, docId: `seed:${d.title}`, title: d.title, body: d.body, source: d.source, score: 1, matchType: "lexical" }));
const fake = (q, k) => {
  const qt = new Set(ctx.tokenizeTerms(q));
  return docs
    .map((c, i) => ({ c, i, n: ctx.tokenizeTerms(`${c.title} ${c.body.slice(0, 400)}`).filter((t) => qt.has(t)).length }))
    .filter((x) => x.n > 0).sort((a, b) => b.n - a.n || a.i - b.i).slice(0, k).map((x) => ({ ...x.c, score: x.n }));
};

// Distinct plans, each with the first query that produced it.
const seen = new Map();
for (const s of plans) {
  const key = JSON.stringify(s.plan.steps);
  if (!seen.has(key)) seen.set(key, s);
}
const verdicts = ["SUPPORTED. Every claim is in [1].", "  unsupported: the evidence says otherwise", "Partial — only the first claim.", "I think it is fine.", ""];
const cases = [];
let v = 0;
for (const s of seen.values()) {
  const modelIds = [...new Set(s.plan.steps.map((st) => st.modelId).filter(Boolean))];
  const first = modelIds[0];
  for (const resident of [null, first ? `models/${first}.gguf` : null, "models/other.gguf"]) {
    for (const template of [true, false]) {
      for (const missing of [null, first]) {
        if (missing && resident) continue;
        globalThis.__resident = resident;
        globalThis.__loads = [];
        globalThis.__template = template;
        const calls = [];
        const retrievals = [];
        globalThis.__retrieve = async (q, k) => { const r = fake(q, k); retrievals.push({ query: q, k, chunks: r }); return r; };
        globalThis.__generate = async (opts) => {
          const verify = opts.temperature === 0.2;
          const reply = verify ? verdicts[v++ % verdicts.length] : `Answer for ${s.query.slice(0, 30)} [1].`;
          calls.push({ messages: opts.messages ?? null, prompt: opts.prompt ?? null, nPredict: opts.nPredict, temperature: opts.temperature ?? 0.7, stop: opts.stop ?? null, reply });
          opts.onToken?.(reply);
          return reply;
        };
        const resolveModel = (id) => (id === missing ? undefined : { id, filename: `models/${id}.gguf`, usesChatTemplate: "if-embedded" });
        const input = { query: s.query, systemPrompt: "You are Boar.", styleReminder: s.query.length % 2 ? "Keep it short." : undefined };
        const r = await exec.executeRoutingPlan(s.plan, input, resolveModel, {});
        cases.push({
          plan: s.plan, input: { query: input.query, systemPrompt: input.systemPrompt, styleReminder: input.styleReminder ?? null },
          resident, template, missing, calls, retrievals, loads: globalThis.__loads,
          result: {
            answer: r.answer, citations: r.citations.map((c) => c.chunkId + " | " + c.body), verification: r.verification,
            warnings: r.warnings, stepsExecuted: r.stepsExecuted, modelSwitches: r.modelSwitches, crossMessageModelSwitch: r.crossMessageModelSwitch,
            modelResidency: r.modelResidency ?? null, promptFormat: r.promptFormat ?? null, stopped: r.stopped,
            contextTokensBefore: r.contextTokensBefore ?? null, contextTokensAfter: r.contextTokensAfter ?? null,
          },
        });
      }
    }
  }
}
const parse = verdicts.concat(["SUPPORTED", "partially", "UNSUPPORTEDLY", "x".repeat(300), "  Supported but long " + "y".repeat(250)]).map((t) => ({ t, out: exec.parseVerificationVerdict(t) }));
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "executor.json"), JSON.stringify({ cases, parse }, null, 1) + "\n");
console.log(`${seen.size} distinct plans, ${cases.length} executions -> executor.json`);
