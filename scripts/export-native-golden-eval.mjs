// Golden outputs of the device evaluation protocol (src/eval/deviceEvalRequest.pure.ts, evalHarness.pure.ts) for the
// native port: request parsing and its errors, model matching, config and query resolution, run ids.
//   node scripts/export-native-golden-eval.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import ts from "typescript";

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (e) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$|\.json$/.test(specifier)) return next(`${specifier}.ts`, context);
      throw e;
    }
  },
  // Type-only imports without "type" (EvalQuestion) need TypeScript's own compiler, not Node's type stripping.
  load(url, context, next) {
    if (!url.startsWith("file:") || !url.endsWith(".ts")) return next(url, context);
    const source = readFileSync(fileURLToPath(url), "utf8");
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    return { format: "module", source: js, shortCircuit: true };
  },
});

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "android-native/engine/src/test/resources/golden");
const req = await import(join(root, "src/eval/deviceEvalRequest.pure.ts"));
const harness = await import(join(root, "src/eval/evalHarness.pure.ts"));
const sets = JSON.parse(readFileSync(join(root, "android-native/app/src/main/assets/boar-data/eval-set.json"), "utf8"));
const catalog = JSON.parse(readFileSync(join(root, "android-native/app/src/main/assets/boar-data/catalog.json"), "utf8"));
const llms = catalog.models.filter((m) => m.kind === "llm").map((m) => ({ id: m.id, label: m.label }));

const requests = [
  {}, [], "x", { requestId: "" }, { requestId: "Bad_ID" }, { requestId: "a".repeat(65) }, { requestId: "ok-1" },
  { requestId: "r1", adaptive: "yes" }, { requestId: "r1", adaptive: null }, { requestId: "r1", adaptive: true },
  { requestId: "r1", pipeline: "fast" }, { requestId: "r1", pipeline: "legacy" }, { requestId: "r1", pipeline: "answer" },
  { requestId: "r1", answerAnyway: true }, { requestId: "r1", questions: [], install: {} },
  { requestId: "r1", pipeline: "answer", answerAnyway: "no" }, { requestId: "r1", pipeline: "answer", evalSetVersion: "dataset v2" },
  { requestId: "r1", pipeline: "answer", evalSetVersion: "dataset-v2.1" }, { requestId: "r1", confirmLargeModels: 1 },
  { requestId: "r1", models: "qwen" }, { requestId: "r1", models: ["qwen", ""] }, { requestId: "r1", models: ["  qwen3-4b  "] },
  { requestId: "r1", models: [null] }, { requestId: "r1", queries: ["greeting-1", " factual "] }, { requestId: "r1", queries: [] },
  { requestId: "r1", models: null },
];
const parse = requests.map((r) => {
  const text = JSON.stringify(r);
  try {
    const p = req.parseEvalRequest(text);
    return { text, ok: { requestId: p.requestId, models: p.models ?? null, adaptive: p.adaptive ?? null, queries: p.queries ?? null, pipeline: p.pipeline ?? null } };
  } catch (e) {
    return { text, error: e.message };
  }
});

// Installed sets: everything in the catalog, one model, and look-alikes that make fragments ambiguous.
const installedSets = [llms, llms.slice(0, 1), llms.filter((m) => /qwen/i.test(m.id)), []];
const selectors = [[], ["qwen3-4b"], ["qwen"], ["Qwen3-4B-Instruct-2507"], ["qwen3-4b", "qwen3-4b"], ["nope"], ["phi"], llms.slice(0, 2).map((m) => m.id), ["QWEN-2.5"]];
const queryFilters = [undefined, ["greeting-1"], ["factual"], ["vitalik"], ["greeting-1", "vitalik-about-x"], ["nope", "factual"]];
const resolve = [];
for (const [ii, installed] of installedSets.entries()) {
  for (const models of selectors) {
    for (const adaptive of [undefined, true]) {
      for (const queries of queryFilters) {
        const request = { requestId: "r", models: models.length ? models : undefined, adaptive, queries };
        const r = req.resolveEvalRequest(request, installed, sets.evalSet, "Adaptive (balanced)", sets.extraSets);
        resolve.push({
          installed: ii, models, adaptive: adaptive ?? null, queries: queries ?? null,
          out: r.ok ? { configs: r.configs.map((c) => ({ id: harness.evalConfigId(c), label: c.label })), queries: r.queries.map((q) => q.id) } : { error: r.error },
        });
      }
    }
  }
}
const misc = {
  runIds: [0, 1791317254163, 1700000000001].map((t) => ({ t, id: harness.newEvalRunId(t) })),
  kbHit: [[[], []], [["A"], []], [["A"], ["A", "B"]], [["A", "B"], ["A"]]].map(([e, r]) => ({ e, r, out: harness.expectedKbHit(e, r) })),
  tps: [[0, 100], [10, 0], [10, 1000], [55, 7502.3], [3, undefined]].map(([t, ms]) => ({ t, ms: ms ?? null, out: harness.tokensPerSecond(t, ms) ?? null })),
  plan: [true, false].map((retrieve) => {
    const q = retrieve ? "How do vaccines work?" : "hey, what's up?";
    return { retrieve, codes: harness.buildFixedModelPlan(q, "m1", 512).reasonCodes };
  }),
  installedSets,
};
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "device-eval.json"), JSON.stringify({ parse, resolve, misc }, null, 1) + "\n");
console.log(`${parse.length} requests, ${resolve.length} resolutions -> device-eval.json`);
