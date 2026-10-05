/**
 * Loads a llama.rn context, falling back to CPU once when the GPU backend
 * fails to start. iPhone 13 (integration 90b87dd): llama.rn compiles its
 * Metal shaders at runtime and the flash-attention library dies with
 * XPC_ERROR_CONNECTION_INTERRUPTED -> "failed to initialize MTL0 backend",
 * so initLlama rejects even with n_gpu_layers: 0. Pure (no llama.rn import):
 * LlamaEngine and the embedding engine pass initLlama in.
 */

export interface BackendInitParams {
  n_gpu_layers?: number;
  devices?: string[];
  flash_attn_type?: "auto" | "on" | "off";
  cache_type_k?: KvCacheType;
  cache_type_v?: KvCacheType;
}

/** The KV cache types this app uses (a subset of llama.rn's). */
export type KvCacheType = "f16" | "q8_0";

/**
 * KV cache at 8 bits instead of 16: the one allocation mmap can't page out, halved. On a Pixel 6a (6 GB)
 * the 4B left ~290 MB free with swap full, and answers stalled at 0.1 tok/s while its weights were
 * re-read from storage. llama.cpp needs flash attention for a quantized V cache, so V is 8-bit only
 * where flash attention is on (Android); iOS keeps it off (Metal, see initWithCpuFallback) and gets K only.
 */
export const KV_CACHE_TYPE: KvCacheType = "q8_0";

export function kvCacheParams(platform: string): Pick<BackendInitParams, "cache_type_k" | "cache_type_v" | "flash_attn_type"> {
  return platform === "ios"
    ? { cache_type_k: KV_CACHE_TYPE }
    : { cache_type_k: KV_CACHE_TYPE, cache_type_v: KV_CACHE_TYPE, flash_attn_type: "on" };
}

/** Average bytes per KV element for these cache types (q8_0: 34 bytes per 32 values), for memoryFit. */
export function kvBytesPerElem(p: Pick<BackendInitParams, "cache_type_k" | "cache_type_v">): number {
  const bytes = (t?: KvCacheType) => (t === "q8_0" ? 34 / 32 : 2);
  return (bytes(p.cache_type_k) + bytes(p.cache_type_v)) / 2;
}

/** Without flash attention llama.cpp can't use a quantized V cache: keep V at 16 bits. */
function withFlashAttnOff<P extends BackendInitParams>(p: P): P {
  const out = { ...p, flash_attn_type: "off" as const };
  if (out.cache_type_v && out.cache_type_v !== "f16") delete out.cache_type_v;
  return out;
}

export interface BackendInfo {
  /** "default": the first attempt worked; "cpu-fallback": the retry on CPU only did. */
  kind: "default" | "cpu-fallback";
  /** Native message of the failed first attempt. */
  reason?: string;
}

/**
 * Errors that a CPU-only retry can fix: GPU/Metal backend start-up, or llama.cpp's terse context failure.
 * llama.rn's JSI init (cpp/jsi/RNLlamaJSI.cpp) rejects with only "Failed to load model"; the Metal
 * details go to the native log. A missing file is caught before initLlama, so a corrupt file is
 * the only other cause, and it costs one extra CPU attempt that surfaces the same error.
 */
export const BACKEND_INIT_ERROR = /metal|\bmtl\d*\b|\bgpu\b|backend|xpc_error|flash.?attn|failed to initialize context|failed to load model/i;

/** CPU device names from getBackendDevicesInfo(); ["CPU"] (ggml's name) when they can't be read. */
export async function cpuDeviceNames(
  info: () => Promise<Array<{ backend: string; type: string; deviceName: string }>>
): Promise<string[]> {
  try {
    const names = (await info()).filter((d) => /cpu/i.test(d.type) || /cpu/i.test(d.backend)).map((d) => d.deviceName);
    return names.length ? names : ["CPU"];
  } catch {
    return ["CPU"];
  }
}

export async function initWithCpuFallback<P extends object, C>(
  init: (params: P & BackendInitParams) => Promise<C>,
  params: P & BackendInitParams,
  opts: { platform: string; cpuDevices: () => Promise<string[]>; log?: (message: string) => void }
): Promise<{ context: C; backend: BackendInfo }> {
  // iOS: the library that fails to compile is the flash-attention one; don't ask for it.
  const first: P & BackendInitParams = opts.platform === "ios" ? withFlashAttnOff(params) : params;
  try {
    return { context: await init(first), backend: { kind: "default" } };
  } catch (e: any) {
    const reason = String(e?.message ?? e);
    if (!BACKEND_INIT_ERROR.test(reason)) throw e;
    opts.log?.(`[engine] backend init failed (${reason}); retrying on CPU only`);
    const cpu = withFlashAttnOff({ ...params, n_gpu_layers: 0, devices: await opts.cpuDevices() });
    return { context: await init(cpu), backend: { kind: "cpu-fallback", reason } };
  }
}
