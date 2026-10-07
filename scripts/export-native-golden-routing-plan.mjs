// Golden outputs of adaptive-routing planning (src/routing/profiles.ts, router.ts, defaultModel.ts,
// src/models/compatibility.ts, and the planning half of src/services/adaptiveChat.ts) for the native port's parity
// tests. runAdaptiveChat runs for real with its device/settings/executor dependencies replaced by stubs, so the
// recorded profiles and plan are exactly what the app computes for each (query, installed models, preset, role
// assignments, active model, RAM, max tokens). The Kotlin port (team.sopa.boar.engine.routing) must reproduce them.
//   node scripts/export-native-golden-routing-plan.mjs          # write
//   node scripts/export-native-golden-routing-plan.mjs --check  # exit 1 if out of date
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fileUrl = (p) => pathToFileURL(join(root, p)).href;

// adaptiveChat's native/Expo dependencies, replaced by recorders; profiles and router are the real modules, wrapped
// so the profiles passed to planRoute are recorded too.
const STUBS = {
  "../models/ModelManager": `export class ModelManager { async statusAll() { return globalThis.__statuses; } }`,
  "../models/settings": `
    export const getRoutingPreset = async () => globalThis.__preset;
    export const getModelRoleAssignments = async () => globalThis.__overrides;
    export const getActiveModelId = async () => globalThis.__activeId;`,
  "ram-monitor": `export const getDeviceTotalRamBytes = () => {
    if (globalThis.__ram === "throw") throw new Error("no RAM readout");
    return globalThis.__ram;
  };`,
  "../routing/executor": `export const executeRoutingPlan = async (plan) => { globalThis.__plan = plan; return {}; };`,
  "../routing/profiles": `import * as p from ${JSON.stringify(fileUrl("src/routing/profiles.ts"))};
    export const buildModelProfiles = (...a) => (globalThis.__profiles = p.buildModelProfiles(...a));`,
};
registerHooks({
  resolve(specifier, context, next) {
    if (STUBS[specifier] && context.parentURL?.endsWith("/services/adaptiveChat.ts")) {
      return { url: `data:text/javascript,${encodeURIComponent(STUBS[specifier])}`, shortCircuit: true };
    }
    try {
      return next(specifier, context);
    } catch (e) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$|\.json$/.test(specifier)) return next(`${specifier}.ts`, context);
      throw e;
    }
  },
  // Type-only imports without "type" (CatalogModel, ModelProfile) need TypeScript's compiler, not type stripping.
  load(url, context, next) {
    if (!url.startsWith("file:") || !url.endsWith(".ts")) return next(url, context);
    const source = readFileSync(fileURLToPath(url), "utf8");
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    return { format: "module", source: js, shortCircuit: true };
  },
});

const outFile = join(root, "android-native/engine/src/test/resources/golden/routing-plan.json");
const { runAdaptiveChat } = await import(join(root, "src/services/adaptiveChat.ts"));
const { planRoute } = await import(join(root, "src/routing/router.ts"));
const { computeCompatibility } = await import(join(root, "src/models/compatibility.ts"));
const dm = await import(join(root, "src/routing/defaultModel.ts"));
const { MODEL_CATALOG } = await import(join(root, "src/models/manifest.ts"));
const evalSet = JSON.parse(readFileSync(join(root, "android-native/app/src/main/assets/boar-data/eval-set.json"), "utf8"));

// The exported catalog the Kotlin side reads must be the manifest this script runs on.
const exported = JSON.parse(readFileSync(join(root, "android-native/app/src/main/assets/boar-data/catalog.json"), "utf8"));
for (const m of MODEL_CATALOG) {
  const e = exported.models.find((x) => x.id === m.id);
  if (!e || e.sizeBytes !== m.sizeBytes || JSON.stringify(e.capabilities ?? null) !== JSON.stringify(m.capabilities ?? null)) {
    throw new Error(`catalog.json is stale for ${m.id}: run scripts/export-native-data.mjs`);
  }
}

// Every string literal of the routing tests (all fair queries).
function literals(file) {
  const src = readFileSync(join(root, file), "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true);
  const out = [];
  const visit = (n) => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && !ts.isImportDeclaration(n.parent)) out.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const GiB = 1024 ** 3;
const TASK_QUERIES = {
  greeting: "hey, what's up?",
  conversation: "what's your name?",
  chat: "Tell me about black holes",
  lookup: "What is the capital of Australia?",
  research: "Why did the Roman Empire fall?",
  summarize: "Summarize the history of Portugal",
  compare: "Compare the Nile and the Amazon",
  calculate: "calculate 12 * 7",
  extract: "list all the planets",
  translate: "translate good morning to French",
  code: "write a code to sort a list",
  unknown: "   ",
};
const queries = [
  ...new Set([
    ...Object.values(TASK_QUERIES),
    ...evalSet.evalSet.map((q) => q.query),
    ...evalSet.extraSets.map((q) => q.query),
    ...["router", "profiles", "defaultModel", "classify"].flatMap((m) => literals(`src/routing/${m}.test.ts`)),
  ]),
];

// A Hugging Face pick with no curated roles but its own estimates (fractional, to check they pass through untouched),
// and one with a fractional size.
const EXTRA_MODELS = [
  { id: "hf-custom-3b", kind: "llm", label: "hf-custom-3b", filename: "models/hf-custom-3b.gguf", sizeBytes: 1931234567, sha256: "", sourceUrl: "", license: "MIT", description: "", required: false, capabilities: { roles: [], estimatedMemoryMb: 2212.5, estimatedTokensPerSecond: 9.75 } },
  { id: "hf-tiny-fast", kind: "llm", label: "hf-tiny-fast", filename: "models/hf-tiny-fast.gguf", sizeBytes: 470000001, sha256: "", sourceUrl: "", license: "MIT", description: "", required: false, capabilities: { roles: ["fast", "verifier"] } },
];
const byId = new Map([...MODEL_CATALOG, ...EXTRA_MODELS].map((m) => [m.id, m]));
const Q15 = "qwen2.5-1.5b-instruct-q4km", Q4 = "qwen3-4b-instruct-2507-q4km", Q7 = "qwen2.5-7b-instruct-q4km";
const PHI = "phi-3.5-mini-instruct-q4km", LFM = "lfm2.5-8b-a1b-q4km", GEMMA = "gemma-4-e4b-it-q4_0", BGE = "bge-small-en-v1.5-q8";

// Installed sets: [present ids, extra (non-catalog) models listed]. Statuses always list the whole catalog.
const MODEL_SETS = {
  none: [[], []],
  small: [[Q15, BGE], []],
  large: [[Q4, BGE], []],
  xl: [[Q7], []],
  several: [[Q15, Q4, Q7, PHI, BGE], []],
  all: [MODEL_CATALOG.map((m) => m.id), []],
  uncurated: [[LFM, GEMMA], []],
  embeddingOnly: [[BGE], []],
  hf: [[Q15, "hf-custom-3b", "hf-tiny-fast"], ["hf-custom-3b", "hf-tiny-fast"]],
  hfOnly: [["hf-custom-3b"], ["hf-custom-3b"]],
};
const OVERRIDES = [
  {},
  { reasoning: Q7, verifier: PHI },
  { fast: Q4, general: Q15 },
  { verifier: "not-installed", general: "" },
  { verifier: Q7, reasoning: Q7, fast: GEMMA },
  { embedding: BGE, general: LFM },
];
const ACTIVE = [null, Q15, Q4, GEMMA, "", "missing-model", "hf-custom-3b"];
// Whole bytes, as the RAM readout gives them (7.3 / 10.7 GiB: what 8 / 12 GB phones report).
const RAMS = [0, "throw", 3 * GiB, 3.8e9, 4 * GiB, 6 * GiB, Math.floor(7.3 * GiB), 8 * GiB, Math.floor(10.7 * GiB), 12 * GiB, 16 * GiB];
const PRESETS = ["simple", "balanced", "research", "custom"];
const MAX_TOKENS = [512, 1024, 100, 64, 200];

const normProfile = (p) => ({
  modelId: p.modelId, role: p.role, enabled: p.enabled, userOverride: p.userOverride,
  estimatedMemoryMb: p.estimatedMemoryMb ?? null, estimatedTokensPerSecond: p.estimatedTokensPerSecond ?? null,
  compatibilityStatus: p.compatibilityStatus,
});
const normPlan = (plan) => ({
  steps: plan.steps.map((s) => ({ id: s.id, type: s.type, modelId: s.modelId ?? null, required: s.required, maxTokens: s.maxTokens ?? null, timeoutMs: s.timeoutMs ?? null })),
  selectedModelIds: plan.selectedModelIds,
  estimatedCost: plan.estimatedCost,
  fallbackPolicy: plan.fallbackPolicy,
  reasonCodes: plan.reasonCodes,
});

const must = (i) => {
  if (i < 0) throw new Error("role assignments must be one of OVERRIDES");
  return i;
};
async function adaptive({ query, set, reversed, preset, overrides, activeId, ram, maxTokens }) {
  const [present, extras] = MODEL_SETS[set];
  let statuses = [...MODEL_CATALOG, ...extras.map((id) => byId.get(id))].map((m) => ({ asset: m, present: present.includes(m.id) }));
  if (reversed) statuses = statuses.reverse();
  Object.assign(globalThis, { __statuses: statuses, __preset: preset, __overrides: overrides, __activeId: activeId, __ram: ram, __plan: undefined, __profiles: undefined });
  const res = await runAdaptiveChat({ query }, maxTokens);
  return {
    query, set, reversed, preset, overrides: must(OVERRIDES.indexOf(overrides)), activeId, ram: ram === "throw" ? null : ram, maxTokens,
    taskType: res.taskType, profiles: globalThis.__profiles.map(normProfile), plan: normPlan(globalThis.__plan), modelUsed: res.modelUsed?.id ?? null,
  };
}

const adaptiveCases = [];
let k = 0;
// Every behavior-relevant task type × preset × installed set × role assignments; the rest rotates.
for (const taskType of ["greeting", "conversation", "chat", "lookup", "research", "compare", "calculate"]) {
  for (const preset of PRESETS) for (const set of Object.keys(MODEL_SETS)) for (const overrides of OVERRIDES) {
    k++;
    adaptiveCases.push(await adaptive({
      query: TASK_QUERIES[taskType], set, reversed: k % 5 === 0, preset, overrides,
      activeId: ACTIVE[k % ACTIVE.length], ram: RAMS[k % RAMS.length], maxTokens: MAX_TOKENS[k % MAX_TOKENS.length],
    }));
  }
}
// Every query, with the rest rotating.
for (const query of queries) {
  k++;
  const preset = PRESETS[k % PRESETS.length];
  const sets = Object.keys(MODEL_SETS);
  adaptiveCases.push(await adaptive({
    query, set: sets[k % sets.length], reversed: k % 3 === 0, preset, overrides: OVERRIDES[k % OVERRIDES.length],
    activeId: ACTIVE[(k * 3) % ACTIVE.length], ram: RAMS[(k * 7) % RAMS.length], maxTokens: MAX_TOKENS[k % MAX_TOKENS.length],
  }));
}
// RAM sweep on the installed sets that carry sizes: compatibility at every RAM.
for (const set of ["several", "all", "hf"]) for (const ram of RAMS) for (const preset of ["balanced", "research"]) {
  adaptiveCases.push(await adaptive({ query: TASK_QUERIES.lookup, set, reversed: false, preset, overrides: OVERRIDES[0], activeId: Q15, ram, maxTokens: 512 }));
}

// planRoute directly, for the branches adaptiveChat never takes (low power, retrieval/verification off, a latency
// budget, disabled or duplicate profiles).
const prof = (role, modelId, enabled = true) => ({ modelId, role, enabled, userOverride: false, compatibilityStatus: "unknown" });
const PROFILE_SETS = [
  [],
  [prof("fast", Q15)],
  [prof("general", Q4), prof("fast", Q15)],
  [prof("reasoning", Q7), prof("general", PHI), prof("verifier", PHI), prof("embedding", BGE)],
  [prof("reasoning", Q7), prof("verifier", Q7)],
  [prof("reasoning", "", false), prof("general", "", false), prof("verifier", Q15)],
  [prof("general", "", false), prof("fast", "", false)],
  [prof("embedding", BGE), prof("verifier", PHI, false)],
  [prof("reasoning", Q7, false), prof("general", Q4), prof("verifier", PHI)],
];
const FLAGS = [
  { lowPower: false, allowRetrieval: true, retrievalAvailable: true, hasKb: true, allowVerification: true },
  { lowPower: true, allowRetrieval: true, retrievalAvailable: true, hasKb: true, allowVerification: true },
  { lowPower: false, allowRetrieval: false, retrievalAvailable: true, hasKb: true, allowVerification: true },
  { lowPower: false, allowRetrieval: true, retrievalAvailable: true, hasKb: true, allowVerification: false },
  { lowPower: false, allowRetrieval: true, retrievalAvailable: false, hasKb: true, allowVerification: true },
  { lowPower: false, allowRetrieval: true, retrievalAvailable: true, hasKb: false, allowVerification: true },
];
const DEVICE = [undefined, { lowPowerMode: false }, { batteryLevel: 0.1 }];
const planCases = [];
for (const taskType of Object.keys(TASK_QUERIES)) for (const preset of PRESETS) for (const [pi, profiles] of PROFILE_SETS.entries()) {
  k++;
  for (const f of [FLAGS[0], FLAGS[1 + (k % (FLAGS.length - 1))]]) {
    const latency = k % 4 === 0 ? 30000 : undefined;
    const maxTokens = [512, 300, 100, 1000, 128, 257][k % 6];
    const deviceState = f.lowPower ? { lowPowerMode: true } : DEVICE[k % DEVICE.length];
    const plan = planRoute({
      taskType, query: TASK_QUERIES[taskType], hasLocalKnowledgeBase: f.hasKb, retrievalAvailable: f.retrievalAvailable,
      availableModels: profiles, preset, deviceState,
      budget: { maxTokens, maxTotalLatencyMs: latency, allowVerification: f.allowVerification, allowRetrieval: f.allowRetrieval },
    });
    planCases.push({ taskType, preset, profileSet: pi, ...f, lowPower: deviceState?.lowPowerMode ?? null, maxTokens, latency: latency ?? null, plan: normPlan(plan) });
  }
}

// rankAnswerModels: candidate sets from a fixed pseudo-random generator, at every RAM of interest.
let seed = 12345;
const rnd = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
const FITS = [undefined, "resident", "streaming", "thrashing", "insufficient"];
const TPS = [undefined, undefined, 2.5, 5.99, 6, 6.01, 12, 18];
const SIZES = [undefined, 0.5e9, 1.0e9, 1.1e9, 1.100000001e9, 1.5e9, 1.6e9, 1.6000001e9, 2.5e9, 4.68e9, 5.15e9];
const RANK_RAMS = [0, 3 * GiB, 3.8e9, 4.5 * GiB, 4.5 * GiB + 1, 6 * GiB, 8 * GiB, 12 * GiB];
const rankCases = [];
for (let i = 0; i < 400; i++) {
  const n = rnd(6);
  const candidates = [];
  for (let j = 0; j < n; j++) {
    const tierRoll = rnd(5);
    const answerTier = tierRoll === 0 ? "default" : tierRoll === 1 ? "compact" : undefined;
    candidates.push({ id: `m${j % 4}`, answerTier, fit: FITS[rnd(FITS.length)], sizeBytes: SIZES[rnd(SIZES.length)], tokPerSec: TPS[rnd(TPS.length)] });
  }
  rankCase(candidates, RANK_RAMS[i % RANK_RAMS.length]);
}
// Structured: every default-tier × compact-tier × others combination at four RAM sizes.
// 6 and 6.01 tok/s sit on the 6 tok/s line.
const DEF = [null, { fit: "resident" }, { fit: "resident", tokPerSec: 5 }, { fit: "thrashing" }, { fit: "streaming", tokPerSec: 7 }, { fit: "resident", tokPerSec: 6.01 }];
const COMPACT = [null, { fit: "resident" }, { fit: "insufficient" }, { fit: "resident", tokPerSec: 3 }];
const OTHERS = [
  [],
  [{ sizeBytes: 2.5e9, tokPerSec: 10, fit: "resident" }, { sizeBytes: 1e9, tokPerSec: 8 }],
  [{ tokPerSec: 12 }, { sizeBytes: 0.5e9, tokPerSec: 4 }, { sizeBytes: 0.7e9, fit: "resident" }],
  [{ sizeBytes: 1.5e9, fit: "thrashing" }, { sizeBytes: 1.05e9, tokPerSec: 6.5, fit: "streaming" }],
  [{ sizeBytes: 0.9e9, tokPerSec: 6.01 }, { sizeBytes: 0.8e9, tokPerSec: 6, fit: "resident" }],
];
for (const d of DEF) for (const c of COMPACT) for (const o of OTHERS) for (const ram of [0, 3 * GiB, 4.5 * GiB + 1, 8 * GiB]) {
  const candidates = [
    ...o.map((x, j) => ({ id: `other-${j}`, ...x })),
    ...(c ? [{ id: "compact", answerTier: "compact", sizeBytes: 986048768, ...c }] : []),
    ...(d ? [{ id: "default", answerTier: "default", sizeBytes: 2497281120, ...d }] : []),
  ];
  rankCase(candidates, ram);
}
function rankCase(candidates, ram) {
  const r = dm.rankAnswerModels(candidates, ram);
  rankCases.push({
    candidates: candidates.map((c) => ({ id: c.id, answerTier: c.answerTier ?? null, fit: c.fit ?? null, sizeBytes: c.sizeBytes ?? null, tokPerSec: c.tokPerSec ?? null })),
    ram, pick: r.pick, ranked: r.ranked,
    tooBigForLowRam: candidates.map((c) => dm.tooBigForLowRam(c, ram)),
    tooBigForAutoPick: candidates.map((c) => dm.tooBigForAutoPick(c, ram)),
    isCompact: candidates.map((c) => dm.isCompactModel(c)),
  });
}

// computeCompatibility at the thresholds' edges and the real catalog sizes.
const compatCases = [];
for (const size of [...SIZES.filter(Boolean), ...MODEL_CATALOG.map((m) => m.sizeBytes)]) {
  for (const ram of [-1, 0, 1, 2 * GiB, 3 * GiB, 3.8e9, 4 * GiB, 6 * GiB, 8 * GiB, 12 * GiB, 16 * GiB, Math.ceil((size * 1.15) / 0.65), Math.floor((size * 1.15) / 0.65), Math.ceil((size * 1.15) / 0.9), Math.floor((size * 1.15) / 0.9)]) {
    compatCases.push({ size, ram, out: computeCompatibility(size, ram) });
  }
}

const golden = {
  extraModels: EXTRA_MODELS.map(({ id, sizeBytes, capabilities }) => ({ id, sizeBytes, capabilities })),
  // Statuses list the whole catalog (catalog.json order) then the set's extra models, reversed when "reversed".
  modelSets: Object.fromEntries(Object.entries(MODEL_SETS).map(([name, [present, extras]]) => [name, { present, extras }])),
  overrides: OVERRIDES,
  profileSets: PROFILE_SETS.map((ps) => ps.map((p) => ({ modelId: p.modelId, role: p.role, enabled: p.enabled }))),
  adaptive: adaptiveCases,
  planRoute: planCases,
  rankAnswerModels: rankCases,
  compatibility: compatCases,
};
const text = JSON.stringify(golden) + "\n";
if (process.argv.includes("--check")) {
  const same = existsSync(outFile) && readFileSync(outFile, "utf8") === text;
  console.log(same ? "routing-plan.json is up to date" : "routing-plan.json is out of date");
  process.exit(same ? 0 : 1);
}
writeFileSync(outFile, text);
console.log(`wrote ${outFile}: ${adaptiveCases.length} adaptive, ${planCases.length} planRoute, ${rankCases.length} rankAnswerModels, ${compatCases.length} compatibility`);
