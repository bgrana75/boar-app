// Golden outputs of the conversation history budget (src/routing/historyBudget.ts) for the native port's parity
// test. The Kotlin port (HistoryBudget.kt) must reproduce them exactly.
//   node scripts/export-native-golden-history.mjs
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
const { budgetHistory, leadSentences } = await import(join(root, "src/routing/historyBudget.ts"));

// Real prose: the bundled corpus passages stand in for answers (abbreviations, decimals, quotes, newlines).
const corpus = JSON.parse(readFileSync(join(root, "assets/corpus/corpus.json"), "utf8"));
const docs = (Array.isArray(corpus) ? corpus : corpus.documents ?? corpus.docs ?? Object.values(corpus)).filter((d) => d && typeof d === "object");
const passages = docs
  .map((d) => ({ title: String(d.title ?? ""), body: String(d.body ?? d.text ?? d.content ?? "") }))
  .filter((d) => d.title && d.body)
  .slice(0, 60);
if (passages.length < 20) throw new Error(`only ${passages.length} corpus passages found; check the corpus format`);

const edge = [
  "", " ", "One short answer.", "Yes.", "U.S. law, e.g. the 1st Amendment, applies. It was ratified in 1791.",
  "Pi is about 3.14159. It never ends.", "Line one\nLine two\n\nLine three.", "\"Quoted.\" Then more. (A note.) End.",
  "x".repeat(900), `${"word ".repeat(200)}.`, "Ção é ótimo. Árvore cresce! Ele disse: “Sim.” Fim.", "   padded answer.   ",
  "First sentence is fine. " + "y".repeat(500) + ". Last.",
];

// leadSentences on every passage and edge case, at several caps.
const lead = [];
for (const text of [...passages.map((p) => p.body), ...edge]) {
  for (const maxTokens of [0, 1, 10, 40, 80, 200]) lead.push({ text, maxTokens, out: leadSentences(text, maxTokens) });
}

// Conversations: alternating questions and answers of varied lengths, at the default and a tight budget.
const chats = [];
for (let n = 0; n < 12; n++) {
  const turns = [];
  for (let i = 0; i < 1 + (n % 8); i++) {
    const p = passages[(n * 5 + i * 3) % passages.length];
    turns.push({ role: "user", text: `What is ${p.title}?` });
    turns.push({ role: "assistant", text: p.body.slice(0, 200 + ((n * 97 + i * 131) % 1800)) });
  }
  chats.push(turns);
}
chats.push([], [{ role: "user", text: "Only a question" }], [{ role: "assistant", text: edge[4] }]);
chats.push([{ role: "user", text: "q".repeat(3000) }, { role: "assistant", text: "a".repeat(3000) }]);
chats.push([...Array(8)].map((_, i) => ({ role: i % 2 ? "assistant" : "user", text: i % 2 ? edge[(i * 3) % edge.length] || "." : `Question ${i}` })));
const budget = [];
for (const turns of chats) {
  budget.push({ turns, opts: {}, out: budgetHistory(turns) });
  budget.push({ turns, opts: { budgetTokens: 100, answerTokens: 20 }, out: budgetHistory(turns, { budgetTokens: 100, answerTokens: 20 }) });
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "history-budget.json"), JSON.stringify({ lead, budget }));
console.log(`history-budget.json: ${lead.length} leadSentences cases, ${budget.length} budgetHistory cases`);
