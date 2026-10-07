// Writes the data the native Android app shares with the TypeScript engine (android-native/) as JSON
// assets, so both read one source of truth until the cutover: the model and corpus catalog, the setup
// tiers and the storage/RAM budgets, the answer styles (personalities) and the evaluation set. Node 24 imports the .ts files directly.
//   node scripts/export-native-data.mjs          # write
//   node scripts/export-native-data.mjs --check  # exit 1 if the assets are out of date
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "android-native/app/src/main/assets/boar-data");

const manifest = await import(join(root, "src/models/manifest.ts"));
const personalities = await import(join(root, "src/constants/personalities.ts"));
const evalSet = await import(join(root, "src/eval/evalSet.ts"));
const suggestions = await import(join(root, "src/ui-android/chat/suggestions.ts"));
// settings.ts imports Expo modules: its default token cap is read from the source.
const defaultMaxTokens = Number(/export const DEFAULT_MAX_TOKENS = (\d+);/.exec(readFileSync(join(root, "src/models/settings.ts"), "utf8"))[1]);

const files = {
  "catalog.json": {
    storageBudgetBytes: manifest.STORAGE_BUDGET_BYTES,
    ramBudgetBytes: manifest.RAM_BUDGET_BYTES,
    models: manifest.MODEL_CATALOG,
    tiers: manifest.TIERS,
  },
  "personalities.json": {
    personalities: personalities.PERSONALITIES,
    defaultId: personalities.DEFAULT_PERSONALITY_ID,
    maxTokensOptions: personalities.MAX_TOKENS_OPTIONS,
    defaultMaxTokens,
  },
  // The empty chat's suggested questions: which were validated per model and language, and where their answers come from.
  "suggestions.json": {
    validation: suggestions.SUGGESTION_VALIDATION,
    sources: suggestions.SUGGESTION_SOURCES,
    minSuggestions: suggestions.MIN_SUGGESTIONS,
  },
  // The device evaluation's questions (scripts/eval-device.mjs sends ids and categories, the app holds the set).
  "eval-set.json": {
    evalSet: evalSet.EVAL_SET.map((q) => ({ ...q, setVersion: evalSet.setVersionOf(q) })),
    extraSets: evalSet.VITALIK_SET.map((q) => ({ ...q, setVersion: evalSet.setVersionOf(q) })),
  },
};

const check = process.argv.includes("--check");
let stale = 0;
mkdirSync(out, { recursive: true });
for (const [name, data] of Object.entries(files)) {
  const path = join(out, name);
  const text = JSON.stringify(data, null, 2) + "\n";
  if (check) {
    if (!existsSync(path) || readFileSync(path, "utf8") !== text) {
      console.error(`out of date: ${path} (run node scripts/export-native-data.mjs)`);
      stale++;
    }
  } else {
    writeFileSync(path, text);
    console.log(`wrote ${path}`);
  }
}
process.exit(stale ? 1 : 0);
