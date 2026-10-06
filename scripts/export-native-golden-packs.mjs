// Golden outputs of the format-2 pack search (src/rag/wikiPack.ts) for the native port's parity tests.
// Builds small packs with the real builder from the vitest fixtures, runs the TypeScript search on them and writes
// the packs plus the results to android-native/engine/src/test/resources/golden/packs/. Kotlin must match exactly.
//   node scripts/export-native-golden-packs.mjs
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import { zstdDecompressSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";

// packs.ts imports Expo modules: stand-ins over the fixture directory and node:sqlite.
const STUBS = {
  "expo-file-system/legacy": `import { readdirSync, statSync } from "node:fs";
    export const documentDirectory = globalThis.__docs;
    export const readDirectoryAsync = async (u) => readdirSync(u.replace("file://", ""));
    export const getInfoAsync = async (u) => { try { return { exists: true, size: statSync(u.replace("file://", "")).size }; } catch { return { exists: false }; } };`,
  "expo-sqlite": `export const openDatabaseAsync = async (name, opts, dir) => globalThis.__openDb(dir + "/" + name);`,
};
registerHooks({
  resolve(specifier, context, next) {
    if (STUBS[specifier]) return { url: `data:text/javascript,${encodeURIComponent(STUBS[specifier])}`, shortCircuit: true };
    try {
      return next(specifier, context);
    } catch (e) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$|\.json$/.test(specifier)) return next(`${specifier}.ts`, context);
      throw e;
    }
  },
  // wikiPack.ts uses parameter properties, which Node's type stripping can't run: compile .ts with TypeScript.
  load(url, context, next) {
    if (!url.startsWith("file:") || !url.endsWith(".ts")) return next(url, context);
    const source = readFileSync(fileURLToPath(url), "utf8");
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    return { format: "module", source: js, shortCircuit: true };
  },
});

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "android-native/engine/src/test/resources/golden/packs");
const wp = await import(join(root, "src/rag/wikiPack.ts"));
const { nodeSqliteDatabase } = await import(join(root, "src/rag/testing/nodeSqlite.ts"));
const evalSet = await import(join(root, "src/eval/evalSet.ts"));

// The fixture rows live in the vitest files; take them from there so the two never drift.
const filler = (topic) => Array.from({ length: 6 }, (_, i) => `${topic} filler sentence number ${i} about unrelated matters.`).join(" ");
const guide = (page_id, title, sections) => ({
  page_id, title, source: "enwikivoyage", text: [`# ${title}`, "", `${title} is a destination. ${filler(title)}`, "", ...sections].join("\n"),
});
function rowsFrom(file, name) {
  const src = readFileSync(join(root, file), "utf8");
  const at = src.indexOf(`const ${name} = [`);
  const end = src.indexOf("\n  ];", at) >= 0 && name === "voyage" ? src.indexOf("\n  ];", at) : src.indexOf("\n];", at);
  const body = src.slice(at + `const ${name} = `.length, end + (name === "voyage" ? 5 : 3)).replace(/;\s*$/, "");
  return new Function("filler", "guide", `return ${body.replace(/\(([a-z_]+)(?:: [a-z]+(?:\[\])?)\)/g, "($1)").replace(/\((\w+): \w+, (\w+): \w+\)/g, "($1, $2)")};`)(filler, guide);
}

const work = mkdtempSync(join(tmpdir(), "boar-golden-packs-"));
function build(name, shards) {
  const file = join(out, `${name}.sqlite`);
  rmSync(file, { force: true });
  execFileSync(process.execPath, ["scripts/build-wiki-pack.mjs", "--out", file, "--no-embed", "--chunk-chars", "300", "--shards", ...shards], { cwd: root, stdio: "pipe" });
  const db = new DatabaseSync(file);
  db.exec("VACUUM");
  db.close();
  return file;
}
function shard(name, rows) {
  const f = join(work, `${name}.jsonl`);
  writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return f;
}

mkdirSync(out, { recursive: true });
const packs = {
  mini: build("mini", ["src/rag/testing/fixtures/pq-wiki.jsonl", "src/rag/testing/fixtures/mini-wiki.jsonl"]),
  sources: build("sources", [shard("sources", rowsFrom("src/rag/wikiPack.sources.test.ts", "rows"))]),
  dest: build("dest", [shard("dest", rowsFrom("src/rag/wikiPack.destination.test.ts", "rows"))]),
  voyage: build("voyage", [shard("voyage", rowsFrom("src/rag/wikiPack.destination.test.ts", "voyage"))]),
};
rmSync(work, { recursive: true, force: true });
for (const name of Object.keys(packs)) rmSync(join(out, `${name}.sqlite.json`), { force: true });

const testQueries = [...new Set(
  ["wikiPack.test.ts", "wikiPack.pq.test.ts", "wikiPack.sources.test.ts", "wikiPack.destination.test.ts"]
    .flatMap((f) => [...readFileSync(join(root, "src/rag", f), "utf8").matchAll(/"([^"\n]{8,160}\?)"/g)].map((m) => m[1])),
)];
const queries = [
  ...testQueries,
  ...evalSet.EVAL_SET.map((q) => q.query),
  "burn scald what to do", "Earthquake Plate tectonics", "How to treat a burn", "O que fazer com uma queimadura?",
  "Como tratar queimaduras?", "stop", "What is ERC20?", "BIP32 wallets", "Hotels in Tokyo near Tokyo Station",
  "Victoria, British Columbia: where do tourists stay?", "Compare the French Revolution and the Industrial Revolution.",
];

const hitOut = (h) => ({ ...h, url: h.url ?? null, license: h.license ?? null });
const cases = [];
const helpers = { titleCandidates: {}, isTravel: {}, instructionShare: {}, sectionKind: {}, matchTerm: {}, action: {} };
for (const q of queries) {
  helpers.titleCandidates[q] = wp.titleCandidates(q);
  helpers.isTravel[q] = wp.isTravelQuestion(q);
  helpers.action[q] = wp.ACTION_INTENT.test(q);
}
for (const [name, file] of Object.entries(packs)) {
  const pack = await wp.WikiPack.open(nodeSqliteDatabase(file), (b) => new Uint8Array(zstdDecompressSync(b)));
  for (const q of queries) {
    const stems = await pack.stems(q);
    const named = await pack.titlesInQuestion(q, stems);
    const r = await pack.searchDetailed(q);
    cases.push({ pack: name, query: q, stems, named, terms: pack.queryTerms(stems), hits: r.hits.map(hitOut) });
    for (const s of stems) helpers.matchTerm[s.stem] = wp.matchTerm(s.stem);
    for (const h of r.hits) {
      helpers.instructionShare[h.text] = wp.instructionShare(h.text);
      helpers.sectionKind[h.section] = wp.sectionKind(h.section);
    }
  }
  if (name === "mini") {
    for (const [q, opts] of [
      ["What is a black hole?", { titles: ["Black hole"], k: 4 }],
      ["Where do photons stay stuck eternally?", { expandTo: ["Black hole"], minHits: 1 }],
      ["What is a black hole?", { action: true }],
      ["What is a black hole and how does one form?", { explain: true, k: 3 }],
    ]) {
      const { expandTo, ...rest } = opts;
      const r = await pack.searchDetailed(q, expandTo ? { ...rest, expand: async () => expandTo } : rest);
      cases.push({ pack: name, query: q, opts, hits: r.hits.map(hitOut) });
    }
    const id = await pack.resolveTitle("black hole");
    const a = await pack.article(id);
    helpers.article = { title: "black hole", id, articleTitle: a.title, text: a.text, sections: [0, 40, 300, 600, 900, a.text.length - 1].map((s) => [s, wp.sectionAt(a.text, s)]) };
    helpers.resolve = await Promise.all(["black hole", "Black Hole", "holes black", "Quantum computing", "Post quantum", "nothing here at all"].map(async (t) => [t, (await pack.resolveTitle(t)) ?? null]));
  }
}
// Format-1 packs (scripts/build-knowledge-pack.mjs): FTS5 + int8 vectors. The vectors here are word hashes, so
// cosine follows word overlap, enough to exercise the semantic floor and ordering.
const DIMS = 384;
function hashVec(text) {
  const v = new Float32Array(DIMS);
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    let h = 2166136261;
    for (const ch of w) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
    v[h % DIMS] += 1;
    v[(h >>> 9) % DIMS] -= 0.5;
  }
  return v;
}
const int8 = (v) => {
  const max = Math.max(1e-9, ...v.map(Math.abs));
  return new Uint8Array(Int8Array.from(v, (x) => Math.round((x / max) * 127)).buffer);
};
const docs = mkdtempSync(join(tmpdir(), "boar-golden-f1-"));
mkdirSync(join(docs, "corpus"));
const f1 = join(out, "format1.sqlite");
rmSync(f1, { force: true });
{
  const db = new DatabaseSync(f1);
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE chunks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, source TEXT NOT NULL, scale REAL NOT NULL, vec BLOB NOT NULL);
    CREATE VIRTUAL TABLE chunks_fts USING fts5(title, body, content='chunks', content_rowid='id');`);
  const ins = db.prepare("INSERT INTO chunks (id, title, body, source, scale, vec) VALUES (?, ?, ?, ?, ?, ?)");
  let id = 0;
  for (const f of ["src/rag/testing/fixtures/mini-wiki.jsonl", "src/rag/testing/fixtures/pq-wiki.jsonl"]) {
    for (const line of readFileSync(join(root, f), "utf8").split("\n").filter(Boolean)) {
      const a = JSON.parse(line);
      for (const para of a.text.split(/\n\n+/).filter((p) => !p.startsWith("#") && p.length > 40)) {
        ins.run(++id, a.title, para, `Wikipedia — https://en.wikipedia.org/wiki/${a.title}`, 1, int8(hashVec(`${a.title} ${para}`)));
      }
    }
  }
  db.exec("INSERT INTO chunks_fts (chunks_fts) VALUES ('rebuild')");
  const { MODEL_CATALOG } = await import(join(root, "src/models/manifest.ts"));
  const sha = MODEL_CATALOG.find((m) => m.kind === "embedding" && m.required).sha256;
  for (const [k, v] of Object.entries({ format: "boar-knowledge-pack", formatVersion: 1, dims: DIMS, embeddingModelSha256: sha })) {
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(k, String(v));
  }
  db.exec("VACUUM");
  db.close();
}
writeFileSync(join(docs, "corpus/fixture.sqlite"), readFileSync(f1));
globalThis.__docs = `file://${docs}/`;
globalThis.__openDb = (path) => nodeSqliteDatabase(path);
const packsTs = await import(join(root, "src/rag/packs.ts"));
const format1 = [];
for (const q of queries) {
  const vec = hashVec(q);
  for (const limit of [5, 12]) {
    const r = await packsTs.searchPacks(q, vec, limit);
    format1.push({ query: q, limit, ...r });
  }
}
rmSync(docs, { recursive: true, force: true });
const chunkCases = cases.flatMap((c) => c.hits).slice(0, 120).map((h, i) => ({ packId: i % 2 ? "crypto" : "wiki", hit: h, chunk: packsTs.packHitToChunk(i % 2 ? "crypto" : "wiki", { ...h, url: h.url ?? undefined, license: h.license ?? undefined }) }));
const urls = [
  ["Quantum cryptography", "enwiki", "https://en.wikipedia.org/wiki/Quantum cryptography"],
  ["x", "usgov", "https://en.wikipedia.org/wiki/Diffie%E2%80%93Hellman_key_exchange"],
  ["x", "usgov", "https://www.ready.gov/some page"],
  ["x", "usgov", "https://example.org/a%2Fb?q=1&r=á#frag"],
  ["x", "usgov", "https://example.org/bad%zz path"],
  ["x", "usgov", "https://example.org/%E2%82"],
  ["Diffie–Hellman key exchange", "enwiki", null],
  ["São Paulo", "enwikivoyage", null],
  ["C++ (programming language)", "enwikibooks", null],
  ["Rock & Roll's \"best\"? 100%", "eips", null],
  ["Emoji 🐗 boar", "enwiki", null],
].map(([title, source, url]) => ({ title, source, url, out: packsTs.articleUrl(title, source, url ?? undefined) }));
writeFileSync(join(out, "format1.json"), JSON.stringify({ format1, chunkCases, urls }, null, 1) + "\n");

writeFileSync(join(out, "packs.json"), JSON.stringify({ cases, helpers }, null, 1) + "\n");
console.log(`${cases.length} cases over ${Object.keys(packs).length} packs -> ${out}`);
