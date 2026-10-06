import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The Edge Functions run on Deno and have their own tests (deno test, see supabase/README.md); android-native
    // holds the llama.cpp submodule, whose web UI ships its own tests.
    exclude: [...configDefaults.exclude, "supabase/functions/**", "android-native/**"],
  },
});
