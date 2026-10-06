/**
 * On-device evaluation harness: runs the fixed EVAL_SET against one or
 * more configurations (a specific installed model, or adaptive routing)
 * and produces comparable structured results. See docs/EVAL_QUERIES.md
 * for how to run it and read the output.
 *
 * Metrics come from the same sources chat uses — executor.ts's timing and
 * residency, telemetry.ts's peak-RSS sampler — and every query is also
 * written to the persisted execution telemetry (recordExecution), so eval
 * runs show up in the Execution Telemetry screen like any other message.
 */
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { getMemoryInfo } from "ram-monitor";
import { llamaEngine } from "../inference/LlamaEngine";
import { executeRoutingPlan, ExecutableModel, PipelineCallbacks, PipelineResult } from "../routing/executor";
import { classifyTask } from "../routing/classify";
import { runAdaptiveChat } from "../services/adaptiveChat";
import { recordExecution, type ExecutionOutcome } from "../services/executionTelemetry";
import { trackPeakRss } from "../services/telemetry";
import { ModelManager } from "../models/ModelManager";
import { MODEL_CATALOG, CatalogModel } from "../models/manifest";
import { listDiscoveredModels } from "../models/discoveredModels";
import { DEFAULT_MAX_TOKENS, getRoutingPreset } from "../models/settings";
import { DEFAULT_PERSONALITY_ID, getPersonality } from "../constants/personalities";
import { EVAL_SET, EVAL_SET_VERSION, EvalQuery, setVersionOf } from "./evalSet";
import {
  buildFixedModelPlan,
  EvalConfig,
  evalConfigId,
  EvalResultRow,
  evalRowsToCsv,
  evalRowsToJsonl,
  expectedKbHit,
  newEvalRunId,
  tokensPerSecond,
} from "./evalHarness.pure";
import {
  killedRows,
  savedRunIds,
  parseEvalRows,
  parseManifest,
  remainingWork,
  type EvalRunManifest,
} from "./evalResume.pure";

const modelManager = new ModelManager();

// Fixed, not read from the user's settings, so runs on different days or
// devices use the same prompt and budget. Recorded on every row.
const EVAL_PERSONALITY_ID = DEFAULT_PERSONALITY_ID;
const EVAL_MAX_TOKENS = DEFAULT_MAX_TOKENS;

export const EVAL_RESULTS_DIR = `${FileSystem.documentDirectory}eval/`;

/** Every LLM actually on disk: curated catalog entries plus Hugging Face-discovered ones. */
export async function listInstalledEvalModels(): Promise<CatalogModel[]> {
  const discovered = (await listDiscoveredModels()).filter((d) => !MODEL_CATALOG.some((c) => c.filename === d.filename));
  const candidates = [...MODEL_CATALOG.filter((m) => m.kind === "llm"), ...discovered];
  const statuses = await Promise.all(candidates.map((m) => modelManager.statusOf(m)));
  return statuses.filter((s) => s.present).map((s) => s.asset);
}

export interface EvalProgress {
  configIndex: number;
  configCount: number;
  queryIndex: number;
  queryCount: number;
  config: EvalConfig;
  query: EvalQuery;
}

export interface RunEvaluationOptions {
  configs: EvalConfig[];
  queries?: EvalQuery[];
  onProgress?: (p: EvalProgress) => void;
  onRow?: (row: EvalResultRow) => void;
  shouldStop?: () => boolean;
  /**
   * Continue a run the app was closed during (loadLatestRun). `skipKilled` records the answer it
   * died on, and the rest of that model's answers, as failures instead of trying the model again.
   */
  resume?: { manifest: EvalRunManifest; rows: EvalResultRow[]; skipKilled: boolean };
}

export interface EvaluationRun {
  runId: string;
  rows: EvalResultRow[];
  /** Where the JSONL results were saved on the device. */
  savedPath: string;
  stopped: boolean;
}

async function runOne(
  runId: string,
  config: EvalConfig,
  q: EvalQuery,
  models: Map<string, ExecutableModel>,
  routingPreset: string | undefined,
  shouldStop: () => boolean
): Promise<EvalResultRow> {
  const systemPrompt = getPersonality(EVAL_PERSONALITY_ID).systemPrompt;
  const peakRss = trackPeakRss(() => {
    try {
      return getMemoryInfo().rssBytes;
    } catch {
      return 0;
    }
  });
  const start = performance.now();
  let tokensGenerated = 0;
  const callbacks: PipelineCallbacks = {
    onToken: () => {
      tokensGenerated += 1;
    },
    shouldStop,
  };

  let result: PipelineResult | undefined;
  let taskType = classifyTask(q.query);
  let modelId = config.kind === "model" ? config.modelId : undefined;
  let errorMessage: string | undefined;

  try {
    const input = { query: q.query, systemPrompt };
    if (config.kind === "model") {
      const plan = buildFixedModelPlan(q.query, config.modelId, EVAL_MAX_TOKENS);
      result = await executeRoutingPlan(plan, input, (id) => models.get(id), callbacks);
    } else {
      const adaptive = await runAdaptiveChat(input, EVAL_MAX_TOKENS, callbacks);
      result = adaptive;
      taskType = adaptive.taskType;
      modelId = adaptive.plan.steps.find((s) => s.type === "generate")?.modelId;
    }
  } catch (e: any) {
    errorMessage = e?.message ?? String(e);
  }
  const totalLatencyMs = performance.now() - start;
  const peakRssBytes = peakRss.stop();

  const answer = result?.answer ?? "";
  const outcome: ExecutionOutcome = errorMessage
    ? "failure"
    : result!.stopped
      ? "cancelled"
      : answer.trim().length > 0
        ? "success"
        : "failure";
  if (outcome === "failure" && !errorMessage) {
    errorMessage = result?.warnings.join("; ") || "empty answer";
  }
  const retrievedTitles = result?.citations.map((c) => c.title) ?? [];

  const metrics = {
    modelId,
    taskType,
    adaptiveRoutingUsed: config.kind === "adaptive",
    reasonCodes: result?.plan.reasonCodes,
    retrievalUsed: result ? result.citations.length > 0 : undefined,
    modelSwitches: result?.modelSwitches,
    crossMessageModelSwitch: result?.crossMessageModelSwitch,
    modelResidency: result?.modelResidency,
    modelLoadMs: result?.modelLoadMs,
    ttftMs: result?.ttftMs,
    generationLatencyMs: result?.generationLatencyMs,
    totalLatencyMs,
    tokensGenerated,
    tokPerSec: tokensPerSecond(tokensGenerated, result?.generationLatencyMs),
    peakRssBytes,
    outcome,
    errorMessage,
  };

  recordExecution(metrics).catch(() => {});

  return {
    ...metrics,
    runId,
    evalSetVersion: setVersionOf(q),
    retrievalMs: result?.retrievalMs,
    contextTokensBefore: result?.contextTokensBefore,
    contextTokensAfter: result?.contextTokensAfter,
    promptTokens: result?.engineTimings?.promptTokens,
    promptMs: result?.engineTimings?.promptMs,
    cachedTokens: result?.engineTimings?.cachedTokens,
    predictedTokens: result?.engineTimings?.predictedTokens,
    predictedMs: result?.engineTimings?.predictedMs,
    configId: evalConfigId(config),
    configLabel: config.label,
    routingPreset,
    personalityId: EVAL_PERSONALITY_ID,
    maxTokens: EVAL_MAX_TOKENS,
    queryId: q.id,
    category: q.category,
    query: q.query,
    answer,
    promptFormat: result?.promptFormat,
    retrievedTitles,
    expectedKbTitles: q.expectedKbTitles,
    expectedKbHit: expectedKbHit(q.expectedKbTitles, retrievedTitles),
    timedOut: result?.timedOut ?? false,
    createdAt: Date.now(),
  };
}

const runPaths = (runId: string) => ({
  rows: `${EVAL_RESULTS_DIR}${runId}.jsonl`,
  manifest: `${EVAL_RESULTS_DIR}${runId}.run.json`,
});

/**
 * Written whole to "<path>.tmp", then moved over the old file, so a kill mid-write can't leave a
 * torn file. A kill between the two steps leaves the complete .tmp, which readSaved falls back to.
 */
async function saveAtomically(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await FileSystem.writeAsStringAsync(tmp, content);
  await FileSystem.deleteAsync(path, { idempotent: true });
  await FileSystem.moveAsync({ from: tmp, to: path });
}

async function readSaved(path: string): Promise<string> {
  return FileSystem.readAsStringAsync(path).catch(() => FileSystem.readAsStringAsync(`${path}.tmp`).catch(() => ""));
}

async function saveManifest(m: EvalRunManifest): Promise<void> {
  await saveAtomically(runPaths(m.runId).manifest, JSON.stringify(m));
}

async function saveRows(runId: string, rows: EvalResultRow[]): Promise<void> {
  await saveAtomically(runPaths(runId).rows, evalRowsToJsonl(rows));
}

/** The run this session is executing, so the screen doesn't offer to "continue" it. */
let activeRunId: string | null = null;

export interface SavedRun {
  manifest: EvalRunManifest;
  rows: EvalResultRow[];
  savedPath: string;
}

/** The newest run saved on the phone, unless it is the one running now. */
export async function loadLatestRun(): Promise<SavedRun | null> {
  const files = await FileSystem.readDirectoryAsync(EVAL_RESULTS_DIR).catch(() => [] as string[]);
  for (const runId of savedRunIds(files)) {
    const paths = runPaths(runId);
    const manifest = parseManifest(await readSaved(paths.manifest));
    if (!manifest) continue;
    if (manifest.runId === activeRunId) return null;
    const rows = parseEvalRows(await readSaved(paths.rows));
    return { manifest, rows, savedPath: paths.rows };
  }
  return null;
}

/** Ends an unfinished run with what it has, the model it died on counted as failed. */
export async function keepFinishedRows(saved: SavedRun): Promise<EvaluationRun> {
  const rows = [...saved.rows, ...killedRows(saved.manifest, saved.rows, EVAL_SET)];
  await saveRows(saved.manifest.runId, rows);
  await saveManifest({ ...saved.manifest, inFlight: undefined, endedAt: Date.now(), stopped: true });
  return { runId: saved.manifest.runId, rows, savedPath: saved.savedPath, stopped: true };
}

export async function markRunShared(runId: string): Promise<void> {
  const path = runPaths(runId).manifest;
  const manifest = parseManifest(await FileSystem.readAsStringAsync(path).catch(() => ""));
  if (manifest) await saveManifest({ ...manifest, sharedAt: Date.now() });
}

export async function discardRun(runId: string): Promise<void> {
  const paths = runPaths(runId);
  const all = [paths.rows, paths.manifest].flatMap((p) => [p, `${p}.tmp`]);
  await Promise.all(all.map((p) => FileSystem.deleteAsync(p, { idempotent: true })));
}

/**
 * Runs every query for the first config, then every query for the next,
 * so each model is loaded once per config rather than per query (the
 * first query of each config therefore carries the load cost — see
 * modelResidency/modelLoadMs). No conversation history: each query is
 * answered on its own.
 *
 * Each answer is saved as it finishes (evalResume.pure.ts), so a run the
 * app is closed during can be continued instead of started over.
 */
export async function runEvaluation(options: RunEvaluationOptions): Promise<EvaluationRun> {
  if (options.resume && options.resume.manifest.evalSetVersion !== EVAL_SET_VERSION) {
    throw new Error(`This run used question set v${options.resume.manifest.evalSetVersion}, and this app has v${EVAL_SET_VERSION}: keep or discard it`);
  }
  const manifest: EvalRunManifest = options.resume
    ? { ...options.resume.manifest }
    : {
        runId: newEvalRunId(),
        evalSetVersion: EVAL_SET_VERSION,
        configs: options.configs,
        queryIds: (options.queries ?? EVAL_SET).map((q) => q.id),
        startedAt: Date.now(),
      };
  activeRunId = manifest.runId;
  try {
    return await executeRun(manifest, options);
  } finally {
    activeRunId = null;
  }
}

async function executeRun(
  manifest: EvalRunManifest,
  { queries = EVAL_SET, onProgress, onRow, shouldStop = () => false, resume }: RunEvaluationOptions
): Promise<EvaluationRun> {
  const { runId } = manifest;
  const rows: EvalResultRow[] = resume ? [...resume.rows] : [];
  const residentBefore = llamaEngine.getModelInfo()?.filename ?? null;

  // An explicitly selected model is always measured in its own instruction
  // format: the chat template shipped in its GGUF, falling back to the plain
  // prompt only if the file has none. Not the catalog's usesChatTemplate
  // flag, which is a live-chat setting (Phi and Qwen-7B are off there).
  const installed = await listInstalledEvalModels();
  const models = new Map<string, ExecutableModel>(
    installed.map((m) => [m.id, { id: m.id, filename: m.filename, usesChatTemplate: "if-embedded" }])
  );
  const routingPreset = manifest.configs.some((c) => c.kind === "adaptive") ? await getRoutingPreset() : undefined;

  await FileSystem.makeDirectoryAsync(EVAL_RESULTS_DIR, { intermediates: true }).catch(() => {});
  if (resume?.skipKilled) {
    for (const row of killedRows(manifest, rows, queries)) {
      rows.push(row);
      onRow?.(row);
    }
  }
  manifest.inFlight = undefined;
  await saveRows(runId, rows);
  await saveManifest(manifest);

  const work = remainingWork(manifest, rows, queries);
  console.log(`[EVAL] run ${runId} ${resume ? "resumed" : "start"} — set v${EVAL_SET_VERSION}, ${manifest.queryIds.length} queries x ${manifest.configs.length} configs, ${work.length} to go`);
  let stopped = false;
  try {
    for (const { config, query } of work) {
      if (shouldStop()) {
        stopped = true;
        break;
      }
      const configId = evalConfigId(config);
      onProgress?.({
        configIndex: manifest.configs.findIndex((c) => evalConfigId(c) === configId),
        configCount: manifest.configs.length,
        queryIndex: manifest.queryIds.indexOf(query.id),
        queryCount: manifest.queryIds.length,
        config,
        query,
      });
      // Written before the answer starts: if Android kills the app during it, nothing after runs.
      manifest.inFlight = { configId, queryId: query.id };
      await saveManifest(manifest);
      const row = await runOne(runId, config, query, models, config.kind === "adaptive" ? routingPreset : undefined, shouldStop);
      rows.push(row);
      await saveRows(runId, rows);
      console.log(`[EVAL] ${JSON.stringify(row)}`);
      onRow?.(row);
    }
  } finally {
    // Leave chat on the model it had before the run, not the last one evaluated.
    const residentAfter = llamaEngine.getModelInfo()?.filename ?? null;
    if (residentBefore && residentAfter !== residentBefore) {
      await llamaEngine.load(residentBefore).catch((e) => console.warn("[EVAL] could not restore previous model:", e?.message ?? e));
    }
  }

  const savedPath = runPaths(runId).rows;
  await saveManifest({ ...manifest, inFlight: undefined, endedAt: Date.now(), stopped });
  console.log(`[EVAL] run ${runId} ${stopped ? "stopped" : "done"} — ${rows.length} rows saved to ${savedPath}`);
  return { runId, rows, savedPath, stopped };
}

/** Hands results to the OS share sheet, same as exportExecutionTelemetry. */
export async function exportEvalResults(run: Pick<EvaluationRun, "runId" | "rows">, format: "jsonl" | "csv"): Promise<void> {
  const content = format === "jsonl" ? evalRowsToJsonl(run.rows) : evalRowsToCsv(run.rows);
  const path = `${FileSystem.cacheDirectory}${run.runId}.${format}`;
  await FileSystem.writeAsStringAsync(path, content);
  if (!(await Sharing.isAvailableAsync())) throw new Error("Sharing isn't available on this device");
  await Sharing.shareAsync(path, {
    mimeType: format === "jsonl" ? "application/x-ndjson" : "text/csv",
    dialogTitle: "Export evaluation results",
  });
}
