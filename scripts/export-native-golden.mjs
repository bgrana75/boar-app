// Golden outputs of the TypeScript engine for the native port's parity tests (android-native/engine/src/test).
// The Kotlin port must reproduce these exactly. Node 24 imports the .ts files directly.
//   node scripts/export-native-golden.mjs          # write
//   node scripts/export-native-golden.mjs --check  # exit 1 if out of date
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";

// The engine's .ts files import each other without extensions ("./pure"), as the bundler allows: retry with ".ts".
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
const pure = await import(join(root, "src/rag/pure.ts"));
const evalSet = await import(join(root, "src/eval/evalSet.ts"));
const compress = await import(join(root, "src/rag/compress.ts"));
const explain = await import(join(root, "src/rag/explain.ts"));
const dedupe = await import(join(root, "src/rag/dedupe.ts"));
const ids = await import(join(root, "src/rag/identifiers.ts"));
const pt = await import(join(root, "src/rag/ptLexicon.ts"));
const lexicon = JSON.parse(readFileSync(join(root, "assets/lexicon/pt-en.json"), "utf8"));
const corpus = JSON.parse(readFileSync(join(root, "assets/corpus/corpus.json"), "utf8"));

const questions = [
  ...evalSet.EVAL_SET.map((q) => q.query),
  ...evalSet.VITALIK_SET.map((q) => q.query),
  "Which signature algorithms are quantum resistant?",
  "tell me something",
  "What causes viruses, cases and boxes?",
  "Qual é a diferença entre pandemia e epidemia?",
  "Café, naïve résumé — Ångström units",
  'black holes AND "event horizon" NOT -stars*',
  "",
  "hey",
  "Compare the French Revolution with the Industrial Revolution and explain their causes, effects, leaders, dates, places, economics and legacies",
];

const chunk = (id, title, score, extra = {}) => ({ chunkId: id, docId: `d-${id}`, title, body: `${title} body text.`, score, matchType: "lexical", ...extra });
const lexical = [chunk("a", "Vaccine", 12.5), chunk("b", "Vaccine", 9.1), chunk("c", "Immune system", 7.0), chunk("d", "Vaccine", 6.0), chunk("e", "Rome", 1.2)];
const semantic = [
  { ...chunk("c", "Immune system", 0.81, { matchType: "semantic", similarity: 0.81 }) },
  { ...chunk("f", "Antibody", 0.77, { matchType: "semantic", similarity: 0.77 }) },
  { ...chunk("a", "Vaccine", 0.74, { matchType: "semantic", similarity: 0.74 }) },
  { ...chunk("g", "Name", 0.69, { matchType: "semantic", similarity: 0.69 }) },
];

const history = { summary: "  We talked about seasons.  ", turns: [{ role: "user", text: "What is a season?" }, { role: "assistant", text: "A part of the year." }] };
const promptChunks = [chunk("s1", "Season", 1), chunk("s2", "Axial tilt", 0.5)];

const data = {
  lexical: questions.map((q) => ({ q, out: pure.buildLexicalQuery(q) })),
  required: [0, 1, 2, 3, 4, 5, 6, 7, 8, 12].map((n) => ({ n, out: pure.requiredTermMatches(n) })),
  fuse: [3, 4, 10].map((k) => ({ topK: k, lexical, semantic, out: pure.fuseRetrievalResults(structuredClone(lexical), structuredClone(semantic), k) })),
  gate: { in: pure.fuseRetrievalResults(structuredClone(lexical), structuredClone(semantic), 10), out: pure.gateByRelevance(pure.fuseRetrievalResults(structuredClone(lexical), structuredClone(semantic), 10)) },
  cosine: [
    { a: [1, 0, 0], b: [1, 0, 0], out: pure.cosineSimilarity(new Float32Array([1, 0, 0]), new Float32Array([1, 0, 0])) },
    { a: [0.3, -0.2, 0.9], b: [0.1, 0.4, 0.8], out: pure.cosineSimilarity(new Float32Array([0.3, -0.2, 0.9]), new Float32Array([0.1, 0.4, 0.8])) },
    { a: [0, 0, 0], b: [1, 2, 3], out: pure.cosineSimilarity(new Float32Array([0, 0, 0]), new Float32Array([1, 2, 3])) },
  ],
  cosineInt8: [
    { q: [0.3, -0.2, 0.9, 0.05], v: [12, -40, 127, -128], out: pure.cosineSimilarityInt8(new Float32Array([0.3, -0.2, 0.9, 0.05]), new Uint8Array(new Int8Array([12, -40, 127, -128]).buffer)) },
  ],
  prompts: [
    { args: ["Why do we have seasons?", promptChunks, undefined, undefined, undefined] },
    { args: ["Why do we have seasons?", [], "You are terse.", history, "Keep it short."] },
    { args: ["hi", promptChunks, "  ", { summary: "", turns: [] }, "  "] },
  ].map(({ args }) => ({
    query: args[0], chunks: args[1], systemPrompt: args[2] ?? null, history: args[3] ?? null, style: args[4] ?? null,
    prompt: pure.assemblePrompt(...args),
    messages: pure.assembleChatMessages(...args),
  })),
  prefix: [undefined, "You are terse."].map((s) => ({ systemPrompt: s ?? null, out: pure.answerPromptPrefix(s) })),
};

// Compression on real corpus passages: for each question, the passages whose title shares a content word with it.
const docs = (Array.isArray(corpus) ? corpus : corpus.documents ?? corpus.docs ?? Object.values(corpus)).filter((d) => d && d.title && d.body);
const passagesFor = (q) => {
  const words = new Set((pure.buildLexicalQuery(q)?.terms ?? []).flatMap((t) => t.forms));
  return docs.filter((d) => d.title.toLowerCase().split(/[^a-z0-9]+/).some((w) => words.has(w))).slice(0, 4)
    .map((d, i) => ({ chunkId: `c${i}-${d.id ?? d.title}`, docId: String(d.id ?? d.title), title: d.title, body: d.body, score: 1 - i * 0.1, matchType: "lexical" }));
};
const tricky = { chunkId: "t1", docId: "t1", title: "EIP-4844: Shard Blob Transactions", score: 1, matchType: "lexical",
  body: "## Overview\nProto-danksharding adds blobs.  The U.S. agency e.g. reviewed it at 3.5 GB per day. It ships\nwith KZG commitments, as in the paper (Dr. Smith et al.). Lists:\nRSA\nDSA\nECDSA\n\nAfter that – a new paragraph begins. Café crème costs 2 €. “Quoted.” Next one?! Yes." };
data.compress = [
  ...questions.filter(Boolean).map((q) => ({ q, chunks: passagesFor(q) })).filter((c) => c.chunks.length > 0),
  { q: "What is EIP-4844 and how do blobs work?", chunks: [tricky] },
].flatMap(({ q, chunks }) => [
  { q, chunks, taskType: "lookup", out: compress.compressForAnswer(q, chunks, "lookup") },
  { q, chunks, taskType: "explanation", out: compress.compressForAnswer(q, chunks, "explanation") },
]);
data.compressPinned = { q: "What is EIP-4844?", chunks: [...passagesFor("vaccine immune system"), tricky], pinned: ["t1"],
  out: compress.compressContext("What is EIP-4844?", [...passagesFor("vaccine immune system"), tricky], { tokenBudget: 200, pinned: new Set(["t1"]) }) };
data.sentences = [tricky.body, ...docs.slice(0, 40).map((d) => d.body)].map((t) => ({ t, out: compress.splitSentences(t) }));

// Portuguese and English questions against the real lexicon.
const ptQuestions = [
  "Por que temos estações do ano?", "O que é o efeito estufa?", "Qual a diferença entre fusão e fissão nuclear?",
  "O que causa os terremotos?", "Como funciona uma vacina?", "O que é uma monção?", "Quem foi Napoleão Bonaparte?",
  "Como tratar uma picada de cobra?", "O que fazer em caso de hipotermia?", "Qual a capital da Austrália?",
  "Restaurantes veganos em São Paulo", "Como se forma um buraco negro?", "O que é a Revolução Industrial?",
  "Quais são os sintomas da desidratação?", "O que é o Ethereum e como funciona o EIP-1559?", "Fahrenheit para Celsius",
  "Por que o céu é azul?", "Como purificar água na natilha?", "O que é Tbilisi?", "Viagem para a Geórgia",
  "What is the capital of Australia?", "Why do we have seasons?", "Is São Paulo safe at night?", "Medellín travel tips",
  "O que é romã?", "Roma antiga", "vacinas e sistema imunológico", "como funciona", "o que é", "",
];
data.ptLexicon = ptQuestions.map((q) => ({ q, looksPt: pt.looksPortuguese(q), names: pt.englishNamesIn(q, lexicon), key: pt.normalizeKey(q) }));
data.singularsPt = ["estações", "monções", "vacinas", "animais", "papéis", "fuzis", "nuvens", "flores", "luzes", "casa", "mês"].map((w) => ({ w, out: pt.singularsPt(w) }));
data.identifiers = ["What is EIP-1559?", "erc20 vs ERC 721 and bip-0032", "EIP 4844 and EIP-4844 again", "PEIP-12", "no ids here", "BIP32 seeds"]
  .map((q) => ({ q, out: ids.identifiersIn(q) }));
data.titleHasId = [["EIP-1559: Fee market change", "EIP-1559"], ["BIP 32", "BIP-32"], ["ERC20 token", "ERC-20"], ["EIP-15590", "EIP-1559"], ["BIP-0032", "BIP-32"]]
  .map(([t, id]) => ({ t, id, out: ids.titleHasIdentifier(t, id) }));
data.explainIntent = [...questions, ...ptQuestions].map((q) => ({ q, out: explain.EXPLAIN_INTENT.test(q) }));
const ex = (id, title, body, score) => ({ chunkId: id, docId: id, title, body, score, matchType: "lexical" });
data.explaining = {
  q: "Why do earthquakes happen at plate boundaries?",
  items: [ex("1", "Plate tectonics", "Plate tectonics is a scientific theory.", 9), ex("2", "Earthquake", "An earthquake shakes the ground.", 8),
    ex("3", "Plate tectonics", "Earthquakes happen where plates meet at a boundary.", 7), ex("4", "Plate tectonics", "Boundaries move slowly.", 6)],
};
data.explaining.out = explain.explainingFirst(data.explaining.items, pure.buildLexicalQuery(data.explaining.q).terms);
const lead = docs[0];
data.dedupe = [
  [ex("a", lead.title, lead.body, 2), ex("b", lead.title.toUpperCase(), lead.body + " Extra sentence.", 1)],
  [ex("a", "Vaccine", "A vaccine trains the immune system.", 2), ex("b", "Vaccine", "Vaccines were invented by Jenner in 1796.", 1)],
  [ex("a", "Season", "Short", 2), ex("b", "Season", "short", 1)],
  docs.slice(0, 8).map((d, i) => ex(String(i), d.title, d.body, 8 - i)),
].map((chunks) => ({ chunks, out: dedupe.dedupeArticleCopies(chunks).map((c) => c.chunkId) }));
data.containedShare = docs.slice(0, 10).map((d, i) => ({ a: d.body, b: docs[(i + 1) % 10].body.slice(0, 200) + " " + d.body.slice(0, 300), out: dedupe.containedShare(d.body, docs[(i + 1) % 10].body.slice(0, 200) + " " + d.body.slice(0, 300)) }));

const check = process.argv.includes("--check");
mkdirSync(out, { recursive: true });
const path = join(out, "rag-pure.json");
const text = JSON.stringify(data, null, 1) + "\n";
if (check) {
  if (!existsSync(path) || readFileSync(path, "utf8") !== text) { console.error(`out of date: ${path}`); process.exit(1); }
} else {
  writeFileSync(path, text);
  console.log(`wrote ${path} (${data.lexical.length} questions)`);
}
