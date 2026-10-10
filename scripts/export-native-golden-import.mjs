// Golden output of document import (src/services/documentImporter.ts) for the native port: the real importDocuments
// with the picker, files, database and embedder replaced by recorders, on sample files of every text kind.
//   node scripts/export-native-golden-import.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import ts from "typescript";

const STUBS = {
  "expo-document-picker": `export const getDocumentAsync = async () => ({ canceled: true });`,
  "expo-file-system/legacy": `export const readAsStringAsync = async (u) => globalThis.__files[u]; export const cacheDirectory = "file:///cache/";`,
  "expo-sharing": `export const isAvailableAsync = async () => false; export const shareAsync = async () => {};`,
  "expo-pdf-text-extract": `export const extractText = async () => "";`,
  "../rag/embed": `export const embeddingEngine = { embed: async (t) => { globalThis.__embedded.push(t); return new Float32Array([1]); } };`,
  "../rag/db": `export const insertChunk = async (c) => { globalThis.__chunks.push(c); };
    export const createCustomCollection = async (c) => { globalThis.__collections.push(c); };
    export const deleteCustomCollection = async () => {}; export const setCustomCollectionActive = async () => {};
    export const listCustomCollections = async () => globalThis.__collections.map((c) => ({ ...c, active: true }));
    export const getCollectionDocs = async () => [];`,
  "./pickerCache": `export const discardPickerCopies = async () => {};`,
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
    if (!url.startsWith("file:") || !url.endsWith(".ts")) return next(url, context);
    const source = readFileSync(fileURLToPath(url), "utf8");
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    return { format: "module", source: js, shortCircuit: true };
  },
});

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "android-native/engine/src/test/resources/golden");
const imp = await import(join(root, "src/services/documentImporter.ts"));
const corpus = JSON.parse(readFileSync(join(root, "assets/corpus/corpus.json"), "utf8"));
const long = corpus.slice(0, 6).map((d) => `# ${d.title}\n\n${d.body}`).join("\n\n");
const samples = [
  ["notes.txt", "Water boils at 100 °C at sea level.\nThe access hours are 8 to 17."],
  ["Field Guide.md", long],
  ["prices.csv", "item,price,unit\nwater,2,litre\n\nrice, 5 ,kg\r\nbeans,4,kg"],
  ["pack.json", JSON.stringify(corpus.slice(10, 14).map((d, i) => (i === 1 ? { title: d.title, body: d.body } : d)))],
  ["config.json", JSON.stringify({ a: 1, b: [1, 2] }, null, 2)],
  ["broken.json", "[{\"title\": 1, \"body\": \"x\"}]"],
  ["empty.txt", "   \n  "],
  ["NO_EXTENSION", "Just text without an extension."],
];
const runs = [];
for (const [files, name] of [[samples.map((s) => s[0]), "My docs"], [["Field Guide.md"], "Guia de Campo: Edição 2!"]]) {
  globalThis.__files = Object.fromEntries(samples.map(([n, t]) => [`file:///pick/${n}`, t]));
  globalThis.__embedded = []; globalThis.__chunks = []; globalThis.__collections = [];
  const assets = files.map((n) => ({ name: n, uri: `file:///pick/${n}`, size: Buffer.byteLength(globalThis.__files[`file:///pick/${n}`]) }));
  await imp.importDocuments(assets, name);
  runs.push({ name, files: assets.map((a) => ({ name: a.name, size: a.size, text: globalThis.__files[a.uri] })), collection: globalThis.__collections[0], chunks: globalThis.__chunks, embedded: globalThis.__embedded });
}
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "import.json"), JSON.stringify(runs, null, 1) + "\n");
console.log(runs.map((r) => `${r.name}: ${r.chunks.length} chunks, ${r.collection.docCount} docs`).join("; "));
