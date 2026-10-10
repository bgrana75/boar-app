// Golden outputs of the follow-up search rule (src/routing/followUp.ts) for the native port's parity test. The
// Kotlin port (FollowUp.kt) must reproduce them exactly.
//   node scripts/export-native-golden-followup.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (e) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$|\.json$/.test(specifier)) return next(`${specifier}.ts`, context);
      throw e;
    }
  },
});

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "android-native/engine/src/test/resources/golden");
const { followUpSearch, searchWithFollowUp } = await import(join(root, "src/routing/followUp.ts"));

// Real questions: every eval question the native app ships, then the conversation runs' questions (#72), then edge cases.
const evalSets = JSON.parse(readFileSync(join(root, "android-native/app/src/main/assets/boar-data/eval-set.json"), "utf8"));
const queries = [];
(function walk(v) {
  if (Array.isArray(v)) v.forEach(walk);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (k === "query" && typeof x === "string" ? queries.push(x) : walk(x));
})(evalSets);
if (queries.length < 20) throw new Error(`only ${queries.length} eval questions found`);
const conversation = [
  "How do vaccines work?", "What are the side effects?", "Who proposed the theory of evolution by natural selection?",
  "What did he publish?", "Compare the French Revolution and the Industrial Revolution.", "What is the capital of Australia?",
];
const edge = [
  "", "   ", "Is it safe?", "What's its capital?", "Hehe", "theory of everything", "THEY said so", "the end", "There?",
  "Tell me about Australia", "\"Darwin\" books?", "«Quem» é ele?", "E isso funciona?", "Quais são os efeitos colaterais?",
  "O que ele publicou?", "Who is she?", "why", "And then?", "How about EIP-1559?", "More details", "Itself?", "it's fine",
  "Him", "Write 3 examples", "what about 2024", "and the side effects", "Ela é casada?", "Ícone?", "Ozone layer", "  that one  ",
  // CodeRabbit on #80: existential "there", and a name as the first word.
  "Is there an effective treatment for malaria in adults?", "Are there any side effects?", "There's a cure?", "there are many",
  "What happened there?", "Were they there last week?", "Is it there?", "Australia capital?", "EIP-1559?", "Canberra?",
  "«Darwin» books?", "Summarize the effects", "Há cura?", "What’s the dose?", "Quais são os livros?", "NATO members?",
];
const all = [...new Set([...queries, ...conversation, ...edge])];

// Histories: none, the previous question, a history already holding the current question, assistant-only, blank turns.
const histories = (q, i) => {
  const prev = all[(i * 7 + 3) % all.length];
  return [
    undefined,
    { turns: [] },
    { turns: [{ role: "user", text: prev }, { role: "assistant", text: "An answer." }] },
    { turns: [{ role: "user", text: prev }, { role: "assistant", text: "A." }, { role: "user", text: q }] },
    { turns: [{ role: "assistant", text: "Hello, ask me anything." }] },
    { turns: [{ role: "user", text: "   " }, { role: "user", text: `  ${prev}  ` }, { role: "assistant", text: "B." }] },
  ];
};

const plans = [];
const runs = [];
for (const [i, q] of all.entries()) {
  for (const history of histories(q, i)) {
    const plan = followUpSearch(q, history);
    plans.push({ query: q, history: history ?? null, plan });
    // searchWithFollowUp with a stand-in search that finds something only for the texts in `finds`.
    const texts = [q, plan.direct, plan.previous, plan.fallback].filter(Boolean);
    for (const finds of [[], ...texts.map((t) => [t])]) {
      const calls = [];
      const r = await searchWithFollowUp(q, history, async (text) => {
        calls.push(text);
        return finds.includes(text) ? [`hit:${text}`] : [];
      });
      runs.push({ query: q, history: history ?? null, finds, calls, chunks: r.chunks, searchedFor: r.searchedFor });
    }
  }
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "followup.json"), JSON.stringify({ plans, runs }));
const kinds = plans.reduce((m, p) => ((m[p.plan.direct ? "direct" : p.plan.fallback ? "fallback" : "none"]++), m), { direct: 0, fallback: 0, none: 0 });
console.log(`followup.json: ${all.length} questions, ${plans.length} plans (${JSON.stringify(kinds)}), ${runs.length} searches`);
