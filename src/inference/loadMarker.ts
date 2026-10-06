/**
 * CR-2: a model load that kills the app (OOM) leaves no JS error behind. A
 * marker is written right before initLlama and cleared after it returns
 * (loaded or failed); a marker found on the next start means the load killed
 * the app. Pure: storage and the settings ledger are injected.
 */

export interface LoadMeta {
  filename: string;
  modelId?: string;
  label?: string;
}

export interface LoadMarker extends LoadMeta {
  /** The model that was loaded before (the one the app falls back to). */
  previous?: LoadMeta | null;
  /** The load repacked the weights into app memory (LlamaEngine, memoryFit.ts shouldRepack). */
  repacked?: boolean;
  at: number;
}

/** What the chat shows once: "<crashed> closed the app ... back to <fallback>". */
export interface LoadCrash {
  crashedModelId: string;
  crashedLabel: string;
  fallbackModelId: string;
  fallbackLabel: string;
  at: number;
}

export interface MarkerStore {
  read(): Promise<string | null>;
  write(json: string): Promise<void>;
  clear(): Promise<void>;
}

/** Where crashes are remembered (settings.ts). */
export interface CrashLedger {
  recordCrash(crash: LoadCrash): Promise<void>;
  recordSuccess(modelId: string): Promise<void>;
  takePending(): Promise<LoadCrash | null>;
  /** A repacked load killed the app: load that model once more without repacking, instead of blocking it. */
  recordRepackCrash(modelId: string): Promise<void>;
  takeKeepMapped(modelId: string): Promise<boolean>;
}

/**
 * Id and label for a model file when the caller passed none (Prism CR-3: the chat's preload passed no
 * meta, so the banner said "models/qwen3-4b-instruct-2507-q4km.gguf closed the app", and the crash was
 * recorded under the filename, which the CR-2 block, by model id, never matched). Catalog or discovered
 * models first; otherwise the file's name without folder and ".gguf".
 */
export function describeModelFile(filename: string, models: Array<{ id: string; label: string; filename: string }>): { modelId?: string; label: string } {
  const base = (f: string) => f.split("/").pop() ?? f;
  const known = models.find((m) => m.filename === filename) ?? models.find((m) => base(m.filename) === base(filename));
  return known ? { modelId: known.id, label: known.label } : { label: base(filename).replace(/\.gguf$/i, "") };
}

export function toLoadCrash(m: LoadMarker): LoadCrash {
  return {
    crashedModelId: m.modelId ?? m.filename,
    crashedLabel: m.label ?? m.modelId ?? m.filename,
    fallbackModelId: m.previous?.modelId ?? m.previous?.filename ?? "",
    fallbackLabel: m.previous?.label ?? m.previous?.modelId ?? m.previous?.filename ?? "",
    at: m.at,
  };
}

export function createLoadGuard(store: MarkerStore, ledger: CrashLedger, now: () => number = Date.now) {
  let checked: Promise<void> | null = null;

  /** Once per process, before any new marker: a marker left over = the last load killed the app. */
  function ensureChecked(): Promise<void> {
    checked ??= (async () => {
      const raw = await store.read().catch(() => null);
      if (!raw) return;
      try {
        const marker = JSON.parse(raw) as LoadMarker;
        // Repacking is what needs the memory (~the file size in app memory at the load's peak, on top of what
        // the phone holds); the same model as a mapped file usually loads. Try that before giving up on it.
        if (marker.repacked) await ledger.recordRepackCrash(marker.modelId ?? marker.filename);
        else await ledger.recordCrash(toLoadCrash(marker));
      } catch (e: any) {
        console.warn("[loadMarker] could not record the crashed load:", e?.message ?? e);
      }
      await store.clear().catch(() => {});
    })();
    return checked;
  }

  return {
    ensureChecked,
    async begin(meta: LoadMeta, previous: LoadMeta | null, opts?: { repacked?: boolean }): Promise<void> {
      await ensureChecked();
      const marker: LoadMarker = { ...meta, previous, at: now(), ...(opts?.repacked ? { repacked: true } : {}) };
      await store.write(JSON.stringify(marker));
    },
    async end(meta: LoadMeta, loaded: boolean): Promise<void> {
      await store.clear();
      if (loaded && meta.modelId) await ledger.recordSuccess(meta.modelId);
    },
    /** Whether this load should keep the mapped file because the last repacked load of the model killed the app. */
    async takeKeepMapped(meta: LoadMeta): Promise<boolean> {
      await ensureChecked();
      return ledger.takeKeepMapped(meta.modelId ?? meta.filename);
    },
    /** The last crash, once: the next call returns null. */
    async consume(): Promise<LoadCrash | null> {
      await ensureChecked();
      return ledger.takePending();
    },
  };
}

export type LoadGuard = ReturnType<typeof createLoadGuard>;
