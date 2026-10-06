import * as FileSystem from "expo-file-system/legacy";
import { AssetKind, MODEL_CATALOG } from "./manifest";
import { describeModelFile } from "../inference/loadMarker";
import { PersonalityId, DEFAULT_PERSONALITY_ID } from "../constants/personalities";
import { ModelRole, RoutingPreset } from "../routing/types";

export type ThemeId = "campfire" | "moonlight" | "midnight" | "amber" | "frontier";
export type FontScale = "compact" | "standard" | "large";
export type Appearance = "system" | "light" | "dark";
/** Dark until the user picks otherwise (the iOS UI's theme reads it; scheme.ts resolves "system"). */
export const DEFAULT_APPEARANCE: Appearance = "dark";
export type PaletteChoice = "fogueira" | "luar";
export type LanguageId = "en" | "pt";

interface Settings {
  activeModelId: Partial<Record<AssetKind, string>>;
  setupProgress?: SetupProgress;
  hidePromptIdeas?: boolean;
  personalityId?: PersonalityId;
  customSystemPrompt?: string;
  maxTokens?: number;
  hapticsEnabled?: boolean;
  voiceInputEnabled?: boolean;
  autoSummarize?: boolean;
  historyTurnThreshold?: number;
  maxSavedSessions?: number;
  autoGenerateTitles?: boolean;
  deepResearchMode?: boolean;
  themeId?: ThemeId;
  appearance?: Appearance;
  palette?: PaletteChoice;
  fontScale?: FontScale;
  languageId?: LanguageId;
  routingPreset?: RoutingPreset;
  modelRoleAssignments?: Partial<Record<ModelRole, string>>;
  adaptiveRoutingEnabled?: boolean;
  answerQuickFirst?: boolean;
  answerAlwaysComplete?: boolean;
  /** null = explicitly no deep model; undefined = pick automatically (see src/routing/depth.ts). */
  deepModelId?: string | null;
  /** Ids of models the user confirmed to run on a low-RAM phone (CR-1: above the compact size, risk of an OOM kill). */
  largeModelConfirmedIds?: string[];
  /** City each installed 1° places area was downloaded for ("t-N41E012" → "Rome"), to name it in Knowledge. */
  placeTileNames?: Record<string, string>;
  /** CR-2: models whose last load killed the app (cleared by a successful load). */
  loadCrashedIds?: string[];
  /** The last load crash, until the chat shows it once (src/inference/loadGuard.ts consumeLoadCrash). */
  pendingLoadCrash?: StoredLoadCrash | null;
  /** Models whose repacked load killed the app: their next load keeps the mapped file (loadMarker.ts). */
  keepMappedIds?: string[];
  /** Random id created the first time this install shares results (src/eval/shareResults.ts). */
  installId?: string;
  /** The server's id for this phone's sharing key, once it has accepted the key (src/eval/shareResults.ts). */
  shareDeviceId?: string;
  /** The menu's live line (RAM, storage, last speed). On unless turned off in Settings. */
  showLiveStats?: boolean;
}

export interface MemorySettings {
  autoSummarize: boolean;
  historyTurnThreshold: number;
  maxSavedSessions: number;
  autoGenerateTitles: boolean;
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  autoSummarize: true,
  historyTurnThreshold: 6,
  maxSavedSessions: 10,
  autoGenerateTitles: true,
};

const SETTINGS_PATH = `${FileSystem.documentDirectory}settings.json`;
const DEFAULT_SETTINGS: Settings = { activeModelId: {} };
export const DEFAULT_MAX_TOKENS = 512;

// Every read-modify-write runs alone (Loom, CR-4): two interleaved writers (the crash ledger at boot and
// a preference) could each write back the file they read, and one would drop the other's change.
let settingsChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = settingsChain.then(fn, fn);
  settingsChain = run.catch(() => undefined);
  return run;
}

/**
 * CR-3/CR-4: crashes recorded before 822b069 carry the model's file ("models/qwen3-4b-instruct-2507-q4km.gguf")
 * instead of its id, so neither the Models row ("Didn't open here") nor the crash block matched them.
 */
function crashedIds(ids: string[] | undefined): string[] {
  return [...new Set((ids ?? []).map((id) => (/\.gguf$/i.test(id) ? (describeModelFile(id, MODEL_CATALOG).modelId ?? id) : id)))];
}

/**
 * Once per process: rewrite such file entries as ids, and withdraw the low-RAM confirmation the crash
 * should have withdrawn (it was looked up by file, so the model counted as confirmed after the crash).
 */
let crashIdsMigrated: Promise<void> | null = null;
function migrateCrashIds(): Promise<void> {
  crashIdsMigrated ??= serialized(async () => {
    const s = await readSettings();
    const legacy = (s.loadCrashedIds ?? []).filter((id) => /\.gguf$/i.test(id));
    if (!legacy.length) return;
    const ids = crashedIds(legacy);
    s.loadCrashedIds = crashedIds(s.loadCrashedIds);
    s.largeModelConfirmedIds = (s.largeModelConfirmedIds ?? []).filter((id) => !ids.includes(id));
    await writeSettings(s);
  }).catch(() => undefined);
  return crashIdsMigrated;
}

/**
 * The file's text as last read or written (null = no file), so a getter costs a JSON.parse instead of
 * two native FS calls (perf audit #34: ~20 reads at boot, 3 per question). Only this module touches
 * SETTINGS_PATH and every write goes through writeSettings/clearSettings, so it can't go stale
 * in-process. Callers get a fresh parse, so mutating the result (read-modify-write) is safe.
 */
let cached: { raw: string | null } | null = null;
/** Bumped by every write: a read that started before it must not store the older text. */
let cacheGeneration = 0;

/** Tests that change the mocked file behind the module's back. */
export function resetSettingsCache(): void {
  cached = null;
  cacheGeneration++;
}

function parseSettings(raw: string | null): Settings {
  return raw == null ? { ...DEFAULT_SETTINGS } : { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
}

async function readSettings(): Promise<Settings> {
  try {
    if (cached) return parseSettings(cached.raw);
    const generation = cacheGeneration;
    const info = await FileSystem.getInfoAsync(SETTINGS_PATH);
    const raw = info.exists ? await FileSystem.readAsStringAsync(SETTINGS_PATH) : null;
    const settings = parseSettings(raw);
    if (generation === cacheGeneration) cached = { raw };
    return settings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function writeSettings(s: Settings): Promise<void> {
  const raw = JSON.stringify(s);
  cacheGeneration++;
  cached = null;
  await FileSystem.writeAsStringAsync(SETTINGS_PATH, raw);
  cached = { raw };
}

/** Deletes the settings file outright (used by appReset.ts) — next read falls back to defaults. */
export async function clearSettings(): Promise<void> {
  return serialized(async () => {
    cacheGeneration++;
    cached = null;
    await FileSystem.deleteAsync(SETTINGS_PATH, { idempotent: true });
    cached = { raw: null };
  });
}

/** The user's chosen model for this kind, or null to fall back to the default. */
export async function getActiveModelId(kind: AssetKind): Promise<string | null> {
  const s = await readSettings();
  return s.activeModelId[kind] ?? null;
}

export async function setActiveModelId(kind: AssetKind, id: string): Promise<void> {
  return serialized(async () => {
    const s = await readSettings();
    s.activeModelId[kind] = id;
    await writeSettings(s);
  });
}

/** The server's id for this phone's hardware sharing key; undefined until a share registers it. */
export async function getShareDeviceId(): Promise<string | undefined> {
  return (await readSettings()).shareDeviceId;
}

export async function setShareDeviceId(id: string | undefined): Promise<void> {
  return serialized(async () => {
    const s = await readSettings();
    s.shareDeviceId = id;
    await writeSettings(s);
  });
}

/** The menu's live stats line (RAM in use, BOAR's storage, the last answer's speed). */
export async function getShowLiveStats(): Promise<boolean> {
  const s = await readSettings();
  return s.showLiveStats ?? true;
}

export async function setShowLiveStats(show: boolean): Promise<void> {
  return serialized(async () => {
    const s = await readSettings();
    s.showLiveStats = show;
    await writeSettings(s);
  });
}

/** "Don't show again" preference for the prompt-ideas onboarding carousel. */
export async function getHidePromptIdeas(): Promise<boolean> {
  const s = await readSettings();
  return s.hidePromptIdeas ?? false;
}

export async function setHidePromptIdeas(hide: boolean): Promise<void> {
  return serialized(async () => {
    const s = await readSettings();
    s.hidePromptIdeas = hide;
    await writeSettings(s);
  });
}

export async function getPersonalityId(): Promise<PersonalityId> {
  const s = await readSettings();
  return s.personalityId ?? DEFAULT_PERSONALITY_ID;
}

export async function setPersonalityId(id: PersonalityId): Promise<void> {
  return serialized(async () => {
    const s = await readSettings();
    s.personalityId = id;
    await writeSettings(s);
  });
}

export async function getCustomSystemPrompt(): Promise<string> {
  const s = await readSettings();
  return s.customSystemPrompt ?? "";
}

export async function setCustomSystemPrompt(prompt: string): Promise<void> {
  return serialized(async () => {
    const s = await readSettings();
    s.customSystemPrompt = prompt;
    await writeSettings(s);
  });
}

export async function getMaxTokens(): Promise<number> {
  const s = await readSettings();
  return s.maxTokens ?? DEFAULT_MAX_TOKENS;
}

export async function setMaxTokens(maxTokens: number): Promise<void> {
  return serialized(async () => {
    const s = await readSettings();
    s.maxTokens = maxTokens;
    await writeSettings(s);
  });
}

export async function getHapticsEnabled(): Promise<boolean> {
  const s = await readSettings();
  return s.hapticsEnabled ?? true;
}

export async function setHapticsEnabled(enabled: boolean): Promise<void> {
  return serialized(async () => {
    const s = await readSettings();
    s.hapticsEnabled = enabled;
    await writeSettings(s);
  });
}

/** Whether the chat shows the microphone button. */
export async function getVoiceInputEnabled(): Promise<boolean> {
  const s = await readSettings();
  // On by default, as the original UI: the mic uses on-device recognition (Android 12+), and the
  // network recognizer only after the user accepts it (src/voice/voicePolicy.ts). Off in Settings › Input.
  return s.voiceInputEnabled ?? true;
}

export async function setVoiceInputEnabled(enabled: boolean): Promise<void> {
  return serialized(async () => {
    const s = await readSettings();
    s.voiceInputEnabled = enabled;
    await writeSettings(s);
  });
}

export async function getMemorySettings(): Promise<MemorySettings> {
  const s = await readSettings();
  return {
    autoSummarize: s.autoSummarize ?? DEFAULT_MEMORY_SETTINGS.autoSummarize,
    historyTurnThreshold: s.historyTurnThreshold ?? DEFAULT_MEMORY_SETTINGS.historyTurnThreshold,
    maxSavedSessions: s.maxSavedSessions ?? DEFAULT_MEMORY_SETTINGS.maxSavedSessions,
    autoGenerateTitles: s.autoGenerateTitles ?? DEFAULT_MEMORY_SETTINGS.autoGenerateTitles,
  };
}

export async function setMemorySettings(patch: Partial<MemorySettings>): Promise<void> {
  return serialized(async () => {
    const s = await readSettings();
    Object.assign(s, patch);
    await writeSettings(s);
  });
}

/**
 * "Deep Research Mode" — a sequential multi-pass pipeline over the same
 * single model (decompose -> research sub-questions -> synthesize), not
 * multiple models running concurrently. See src/services/orchestrator.ts.
 */
export async function getDeepResearchMode(): Promise<boolean> {
  const s = await readSettings();
  return s.deepResearchMode ?? false;
}

export async function setDeepResearchMode(enabled: boolean): Promise<void> {
  return serialized(async () => {
    const s = await readSettings();
    s.deepResearchMode = enabled;
    await writeSettings(s);
  });
}

export async function getThemeId(): Promise<ThemeId> {
  const s = await readSettings();
  // Ocean, Amber and Matrix are no longer offered: a saved one becomes Campfire.
  return s.themeId === "moonlight" ? "moonlight" : "campfire";
}

export async function setThemeId(theme: ThemeId): Promise<void> {
  return serialized(async () => {
    const s = await readSettings();
    s.themeId = theme;
    await writeSettings(s);
  });
}

export async function getAppearance(): Promise<Appearance> {
  const s = await readSettings();
  return s.appearance ?? DEFAULT_APPEARANCE;
}

export async function setAppearance(appearance: Appearance): Promise<void> {
  return serialized(async () => {
    const s = await readSettings();
    s.appearance = appearance;
    await writeSettings(s);
  });
}

export async function getPaletteChoice(): Promise<PaletteChoice> {
  const s = await readSettings();
  return s.palette ?? "fogueira";
}

export async function setPaletteChoice(palette: PaletteChoice): Promise<void> {
  return serialized(async () => {
    const s = await readSettings();
    s.palette = palette;
    await writeSettings(s);
  });
}

export async function getFontScale(): Promise<FontScale> {
  const s = await readSettings();
  return s.fontScale ?? "standard";
}

export async function setFontScale(scale: FontScale): Promise<void> {
  return serialized(async () => {
    const s = await readSettings();
    s.fontScale = scale;
    await writeSettings(s);
  });
}

/** The UI language for a BCP 47 locale: Portuguese for any pt-* locale, English otherwise. */
export function languageForLocale(locale: string | undefined): LanguageId {
  return locale?.toLowerCase().startsWith("pt") ? "pt" : "en";
}

function deviceLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}

/** The saved choice, or the device's language until the user picks one. Local only, no network. */
export async function getLanguageId(): Promise<LanguageId> {
  const s = await readSettings();
  return s.languageId ?? languageForLocale(deviceLocale());
}

export async function setLanguageId(language: LanguageId): Promise<void> {
  return serialized(async () => {
    const s = await readSettings();
    s.languageId = language;
    await writeSettings(s);
  });
}

/**
 * Default preset when nothing's been explicitly set. `getRoutingPreset()`
 * has exactly one caller right now (`src/services/adaptiveChat.ts`'s
 * `runAdaptiveChat`, Phase 9) — it's read only when the separate
 * `adaptiveRoutingEnabled` flag is on (the default), so this is the preset
 * every user gets unless they turn adaptive routing off.
 *
 * Temporarily `"balanced"` (not `"simple"`) for real-device Phase 9
 * testing: `"simple"` only ever declares a `general` role slot (see
 * routing/profiles.ts's PRESET_DEFINITIONS), so with it, turning on
 * Adaptive Routing alone — with no preset picker UI yet to change this —
 * would never actually exercise any model switching, just silently
 * resolve to the same single model every time. `"balanced"` is the
 * smallest preset that unlocks the `fast` role, without inventing a new
 * preset or touching the routing rules themselves (router.ts/classify.ts/
 * profiles.ts are unchanged). Revert to `"simple"` (or replace with a real
 * picker UI) once real-device testing no longer needs this.
 */
export async function getRoutingPreset(): Promise<RoutingPreset> {
  const s = await readSettings();
  return s.routingPreset ?? "balanced";
}

export async function setRoutingPreset(preset: RoutingPreset): Promise<void> {
  return serialized(async () => {
    const s = await readSettings();
    s.routingPreset = preset;
    await writeSettings(s);
  });
}

export async function getModelRoleAssignments(): Promise<Partial<Record<ModelRole, string>>> {
  const s = await readSettings();
  return s.modelRoleAssignments ?? {};
}

export async function setModelRoleAssignment(role: ModelRole, modelId: string | undefined): Promise<void> {
  return serialized(async () => {
    const s = await readSettings();
    const assignments = { ...(s.modelRoleAssignments ?? {}) };
    if (modelId) {
      assignments[role] = modelId;
    } else {
      delete assignments[role];
    }
    s.modelRoleAssignments = assignments;
    await writeSettings(s);
  });
}

/**
 * Phase 9 (docs/ADAPTIVE_ROUTING.md) — wires planRoute()/executeRoutingPlan()
 * into ordinary chat (Deep Research Mode is unaffected either way, see
 * src/services/orchestrator.ts). Off by default: a real, reversible
 * feature flag, not a default-on behavior change, until real-device
 * testing passes. ChatScreen.tsx falls back to the existing fixed-active-
 * model path whenever this is off OR whenever the adaptive path throws for
 * any reason — a routing failure must never leave the user without a
 * response.
 */
export async function getAdaptiveRoutingEnabled(): Promise<boolean> {
  const s = await readSettings();
  return s.adaptiveRoutingEnabled ?? true;
}

export async function setAdaptiveRoutingEnabled(enabled: boolean): Promise<void> {
  return serialized(async () => {
    const s = await readSettings();
    s.adaptiveRoutingEnabled = enabled;
    await writeSettings(s);
  });
}

/**
 * Layered answers (docs/ADAPTIVE_ROUTING.md). Two independent toggles:
 * - answerQuickFirst: show the instant source snippet first (and let it be
 *   the whole answer for a confident lookup). Migrates from the old
 *   adaptiveRoutingEnabled flag.
 * - answerAlwaysComplete: always run the complete (deep) answer. Replaces
 *   Deep Research Mode, and migrates from it.
 * The model the user picked ("Use") always writes the fast answer; routing
 * picks the depth, never overrides that model.
 */
export interface AnswerSettings {
  quickFirst: boolean;
  alwaysComplete: boolean;
  deepModelId: string | null | undefined;
  /** Models the user confirmed for a low-RAM phone; anything else above the compact size is never chosen there. */
  largeModelConfirmedIds?: string[];
  /** Models whose last load killed the app: not loaded again unless confirmed after the crash. */
  loadCrashedIds?: string[];
}

export async function getAnswerSettings(): Promise<AnswerSettings> {
  await migrateCrashIds();
  const s = await readSettings();
  return {
    quickFirst: s.answerQuickFirst ?? s.adaptiveRoutingEnabled ?? true,
    alwaysComplete: s.answerAlwaysComplete ?? s.deepResearchMode ?? false,
    deepModelId: s.deepModelId,
    largeModelConfirmedIds: s.largeModelConfirmedIds ?? [],
    loadCrashedIds: crashedIds(s.loadCrashedIds),
  };
}

/** City names of installed places areas, by tile id ("t-N41E012" → "Rome"). */
export async function getPlaceTileNames(): Promise<Record<string, string>> {
  return (await readSettings()).placeTileNames ?? {};
}

/** Names tiles after a city (a string) or forgets them (null). */
export async function setPlaceTileNames(patch: Record<string, string | null>): Promise<void> {
  return serialized(async () => {
    const s = await readSettings();
    const names = { ...(s.placeTileNames ?? {}) };
    for (const [id, name] of Object.entries(patch)) {
      if (name) names[id] = name;
      else delete names[id];
    }
    s.placeTileNames = names;
    await writeSettings(s);
  });
}

export async function getLargeModelConfirmedIds(): Promise<string[]> {
  return (await readSettings()).largeModelConfirmedIds ?? [];
}

/** Models whose last load killed the app (Models screen: "Didn't open here"). */
export async function getLoadCrashedIds(): Promise<string[]> {
  await migrateCrashIds();
  return crashedIds((await readSettings()).loadCrashedIds);
}

/** Same shape as src/inference/loadMarker.ts LoadCrash (kept here to avoid an import cycle). */
export interface StoredLoadCrash {
  crashedModelId: string;
  crashedLabel: string;
  fallbackModelId: string;
  fallbackLabel: string;
  at: number;
}

/**
 * A load killed the app (CR-2): remember it, and withdraw the user's low-RAM
 * confirmation for that model so it is not loaded again on its own (crash loop).
 */
export async function recordLoadCrash(crash: StoredLoadCrash): Promise<void> {
  return serialized(async () => {
    const s = await readSettings();
    s.loadCrashedIds = [...new Set([...(s.loadCrashedIds ?? []), crash.crashedModelId])];
    s.largeModelConfirmedIds = (s.largeModelConfirmedIds ?? []).filter((id) => id !== crash.crashedModelId);
    s.pendingLoadCrash = crash;
    await writeSettings(s);
  });
}

export async function recordLoadSuccess(modelId: string): Promise<void> {
  return serialized(async () => {
    const s = await readSettings();
    const ids = crashedIds(s.loadCrashedIds);
    if (!ids.includes(modelId)) return;
    s.loadCrashedIds = ids.filter((id) => id !== modelId);
    await writeSettings(s);
  });
}

/**
 * A load with repacked weights killed the app: the next load of that model keeps the mapped file instead
 * (no repack copy in app memory), and the model stays usable. Not a CR-2 crash: if that load dies too, it is.
 */
export async function recordRepackCrash(modelId: string): Promise<void> {
  return serialized(async () => {
    const s = await readSettings();
    s.keepMappedIds = [...new Set([...(s.keepMappedIds ?? []), modelId])];
    await writeSettings(s);
  });
}

/** Whether this model's next load keeps the mapped file, once: the load after it decides from memory again. */
export async function takeKeepMapped(modelId: string): Promise<boolean> {
  return serialized(async () => {
    const s = await readSettings();
    if (!(s.keepMappedIds ?? []).includes(modelId)) return false;
    s.keepMappedIds = (s.keepMappedIds ?? []).filter((id) => id !== modelId);
    await writeSettings(s);
    return true;
  });
}

/** The pending crash notice, once. */
export async function takePendingLoadCrash(): Promise<StoredLoadCrash | null> {
  return serialized(async () => {
    const s = await readSettings();
    const crash = s.pendingLoadCrash ?? null;
    if (crash) {
      s.pendingLoadCrash = null;
      await writeSettings(s);
    }
    return crash;
  });
}

/** The UI's "run it anyway" on a low-RAM phone (Loom's confirmation). */
export async function confirmLargeModel(id: string): Promise<void> {
  return serialized(async () => {
    const s = await readSettings();
    s.largeModelConfirmedIds = [...new Set([...(s.largeModelConfirmedIds ?? []), id])];
    await writeSettings(s);
  });
}

export async function setAnswerSettings(patch: Partial<AnswerSettings>): Promise<void> {
  return serialized(async () => {
    const s = await readSettings();
    if (patch.quickFirst !== undefined) s.answerQuickFirst = patch.quickFirst;
    if (patch.alwaysComplete !== undefined) s.answerAlwaysComplete = patch.alwaysComplete;
    if ("deepModelId" in patch) s.deepModelId = patch.deepModelId;
    await writeSettings(s);
  });
}

/** Where first-run setup was, so a recreated Activity (font size change) or a killed process resumes there. */
export interface SetupProgress {
  /** 2 since the model got its own step (1 welcome, 2 model, 3 knowledge, 4 download and index); absent = 1. */
  flow?: 2;
  step: 1 | 2 | 3 | 4;
  packageId: string;
  travelRegionId?: string;
  answerTier?: "default" | "compact";
  /** The trip chosen in step 2 (label + catalog ids), so a remounted screen keeps it (Ledger FS-1). */
  trip?: { label: string; assetIds: string[] };
  /** The user picked these; absent = still the automatic recommendation, which may be recomputed. */
  packageChosen?: boolean;
  answerChosen?: boolean;
}

export async function getSetupProgress(): Promise<SetupProgress | null> {
  const s = await readSettings();
  return s.setupProgress ?? null;
}

export async function setSetupProgress(progress: SetupProgress | null): Promise<void> {
  return serialized(async () => {
    const s = await readSettings();
    if (progress) s.setupProgress = progress;
    else delete s.setupProgress;
    await writeSettings(s);
  });
}
