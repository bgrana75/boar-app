// Writes the data the native Android app shares with the TypeScript engine (android-native/) as JSON
// assets, so both read one source of truth until the cutover: the model and corpus catalog, the setup
// tiers and the storage/RAM budgets, and the answer styles (personalities). Node 24 imports the .ts files directly.
//   node scripts/export-native-data.mjs          # write
//   node scripts/export-native-data.mjs --check  # exit 1 if the assets are out of date
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "android-native/app/src/main/assets/boar-data");

const manifest = await import(join(root, "src/models/manifest.ts"));
const personalities = await import(join(root, "src/constants/personalities.ts"));
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
