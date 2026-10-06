// Golden outputs of the answer path's text helpers (thinking split, inline bullets, citation cleanup, task
// requests) for the native port's parity tests. The Kotlin port must reproduce them exactly.
//   node scripts/export-native-golden-answer.mjs
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
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
const thinking = await import(join(root, "src/services/thinking.ts"));
const format = await import(join(root, "src/services/answerFormat.ts"));
const citations = await import(join(root, "src/services/citations.ts"));
const task = await import(join(root, "src/inference/format.ts"));

// Every string literal of the modules' own tests, then real model answers from local eval runs, then edge cases.
const literals = (file) =>
  [...readFileSync(join(root, file), "utf8").matchAll(/"((?:[^"\\\n]|\\.){2,})"|`((?:[^`\\]|\\.){2,})`/g)]
    .map((m) => { try { return JSON.parse(`"${(m[1] ?? m[2]).replace(/\n/g, "\\n")}"`); } catch { return null; } })
    .filter((s) => s !== null);
const fromTests = [
  ...literals("src/services/thinking.test.ts"),
  ...literals("src/services/answerFormat.test.ts"),
  ...literals("src/services/citations.test.ts"),
];
const answers = [];
// This checkout's runs, plus older ones in a sibling checkout when present (read only).
for (const evalDir of [join(root, "eval-results"), join(root, "../boar_app/eval-results")]) {
  if (!existsSync(evalDir)) continue;
  for (const day of readdirSync(evalDir)) {
    const dir = join(evalDir, day);
    if (!existsSync(dir) || !readdirSync(dir).length) continue;
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
      for (const line of readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean)) {
        try { const a = JSON.parse(line).answer; if (a) answers.push(a); } catch {}
      }
    }
  }
}
const edge = [
  "", " ", "<think>", "<thi", "<|chan", "<|channel>thought", "<think></think>", "<think>  </think>Answer",
  "<think>reasoning here", "reasoning only</think> the answer", "Before <think>x</think> after",
  "<|channel>thought plan<channel|>Final.", "<|channel>thought still going", "plain answer with no markers",
  "\n\n<think>\nstep 1\nstep 2\n</think>\n\nThe answer is 42.", "<think>a</think>b<think>c</think>d",
  "Takeaway. - Point one. - Point two.", "One - two - three.", "Steps: 1. Drop. 2. Cover. 3. Hold on.",
  "Intro: - 1. Drop to the ground. - 2. Take cover. - 3. Hold on.", "Only one. - bullet.", "A.  -  B. - C",
  "Line one.\nSecond: - a. - b. - c.", "Done! 10. Ten. 11. Eleven.", "x. 123. too many digits. 4. ok",
  "The sky is blue [1]. Grass is green [2][3].", "Cited [n] and [N] and [1].", "Bad [7] and good [1] .",
  "Text [0] here.", "Text [99999999999999999999999] here.", "Text ,, then ;; and , ; ,", "a  b \t c",
  "Answer.\n\nReferences:\n[1] Wikipedia", "Answer.\n**Sources:** [1], [2]\nmore", "References: at the start",
  "Answer.\n__Source__: none", "Answer.\nsource: x\n\nmore\nlines", "Answer [1] .\nSources : list",
  "Ends with space before punctuation ! And ? here .", "Tab\tbefore\t,comma",
];
const texts = [...new Set([...fromTests, ...answers, ...edge])];

const data = {
  thinking: texts.map((t) => ({ in: t, out: thinking.splitThinking(t) })),
  bullets: texts.map((t) => ({ in: t, out: format.splitInlineBullets(t) })),
  citations: texts.flatMap((t) => [null, 0, 1, 2, 3].map((n) => ({ in: t, n, out: citations.cleanCitations(t, n ?? undefined) }))),
  task: [true, false].map((tpl) => ({ tpl, out: task.taskRequest("Instruction.", "Input text.", "Verdict:", tpl) })),
};
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "answer-text.json"), JSON.stringify(data, null, 1) + "\n");
console.log(`${texts.length} texts (${fromTests.length} from tests, ${answers.length} real answers) -> answer-text.json`);
