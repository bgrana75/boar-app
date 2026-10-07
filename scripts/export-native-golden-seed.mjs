// Golden output of the corpus seeding (src/rag/seedCorpus.ts) for the native port: the real seedKnowledgeBaseIfEmpty
// on a node:sqlite knowledge base with the bundled corpus and the standard corpus pack, the embedder replaced by a
// recorder. The chunk ids, rows and embedding inputs must match, or an upgraded install would re-index everything.
//   node scripts/export-native-golden-seed.mjs
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, copyFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import ts from "typescript";

const STUBS = {
  "expo-file-system/legacy": `import { readFileSync, statSync } from "node:fs";
    export const documentDirectory = globalThis.__docs;
    export const getInfoAsync = async (u) => { try { return { exists: true, size: statSync(u.replace("file://", "")).size }; } catch { return { exists: false }; } };
    export const readAsStringAsync = async (u) => readFileSync(u.replace("file://", ""), "utf8");`,
  "expo-sqlite": `export const openDatabaseAsync = async () => globalThis.__openDb();`,
  "./packs": `export const closePack = async () => {};`,
  "./embed": `export const embeddingEngine = { embed: async (t) => { globalThis.__embedded.push(t); return new Float32Array([t.length, 1, 0, 0]); } };`,
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
  load(url, context, next) {
    if (url.startsWith("file:") && url.endsWith(".json")) {
      return { format: "module", source: `export default ${readFileSync(fileURLToPath(url), "utf8")};`, shortCircuit: true };
    }
    if (!url.startsWith("file:") || !url.endsWith(".ts")) return next(url, context);
    const source = readFileSync(fileURLToPath(url), "utf8");
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, resolveJsonModule: true, esModuleInterop: true } }).outputText;
    return { format: "module", source: js, shortCircuit: true };
  },
});

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "android-native/engine/src/test/resources/golden");
const docs = mkdtempSync(join(tmpdir(), "boar-golden-seed-"));
mkdirSync(join(docs, "corpus"));
copyFileSync(join(root, "assets/corpus/corpus-standard.json"), join(docs, "corpus/corpus-standard.json"));
globalThis.__docs = `file://${docs}/`;
globalThis.__embedded = [];
const { nodeSqliteDatabase } = await import(join(root, "src/rag/testing/nodeSqlite.ts"));
const dbFile = join(docs, "kb.sqlite");
globalThis.__openDb = () => nodeSqliteDatabase(dbFile);
const db = await import(join(root, "src/rag/db.ts"));
// A retired seed chunk from an older version, which seeding removes.
await db.insertChunk({ chunkId: "app-grapheneos", docId: "app-grapheneos", title: "GrapheneOS", body: "old" }, new Float32Array([1, 0]));
const seed = await import(join(root, "src/rag/seedCorpus.ts"));
await seed.seedKnowledgeBaseIfEmpty();
const raw = (await db.getDb()).raw ?? null;
const rows = await (await db.getDb()).getAllAsync("SELECT chunk_id, doc_id, title, body, source FROM chunks ORDER BY rowid");
const first = globalThis.__embedded.length;
await seed.seedKnowledgeBaseIfEmpty();
const second = globalThis.__embedded.length - first;
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "seed.json"), JSON.stringify({ rows, embedded: globalThis.__embedded.slice(0, first), secondRunEmbedded: second }, null, 0) + "\n");
console.log(`${rows.length} chunks, ${first} embedded, second run embedded ${second} -> seed.json`);
rmSync(docs, { recursive: true, force: true });
