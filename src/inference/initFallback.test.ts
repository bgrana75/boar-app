import { describe, it, expect } from "vitest";
import { cpuDeviceNames, initWithCpuFallback, kvBytesPerElem, kvCacheParams } from "./initFallback";

// Plain functions, not vi.fn(): a rejecting vi.fn() fails the test in vitest 5.
function fakeInit(failures: string[]) {
  const calls: any[] = [];
  const init = async (p: any) => {
    calls.push(p);
    const f = failures.shift();
    if (f) throw new Error(f);
    return { id: calls.length };
  };
  return { init, calls };
}
const cpu = async () => ["CPU"];

describe("initWithCpuFallback", () => {
  it("iPhone 13: Metal fails to start, the retry runs on CPU only and says why", async () => {
    const f = fakeInit(["failed to initialize MTL0 backend"]);
    const logs: string[] = [];
    const r = await initWithCpuFallback(f.init, { model: "m.gguf", n_gpu_layers: 0 }, { platform: "ios", cpuDevices: cpu, log: (m) => logs.push(m) });
    expect(f.calls[0]).toMatchObject({ model: "m.gguf", flash_attn_type: "off" });
    expect(f.calls[0].devices).toBeUndefined();
    expect(f.calls[1]).toEqual({ model: "m.gguf", n_gpu_layers: 0, devices: ["CPU"], flash_attn_type: "off" });
    expect(r.backend).toEqual({ kind: "cpu-fallback", reason: "failed to initialize MTL0 backend" });
    expect(r.context).toEqual({ id: 2 });
    expect(logs[0]).toMatch(/retrying on CPU only/);
  });

  it("retries on llama.rn's only JS-visible message, 'Failed to load model' (RNLlamaJSI.cpp)", async () => {
    const f = fakeInit(["Failed to load model"]);
    const r = await initWithCpuFallback(f.init, { model: "m" }, { platform: "ios", cpuDevices: cpu });
    expect(f.calls[1]).toMatchObject({ n_gpu_layers: 0, devices: ["CPU"], flash_attn_type: "off" });
    expect(r.backend).toEqual({ kind: "cpu-fallback", reason: "Failed to load model" });
  });

  it("asks iOS for no flash attention up front; leaves Android's params alone", async () => {
    const ios = fakeInit([]);
    expect((await initWithCpuFallback(ios.init, { model: "m" }, { platform: "ios", cpuDevices: cpu })).backend).toEqual({ kind: "default" });
    expect(ios.calls).toEqual([{ model: "m", flash_attn_type: "off" }]);
    const android = fakeInit([]);
    await initWithCpuFallback(android.init, { model: "m" }, { platform: "android", cpuDevices: cpu });
    expect(android.calls).toEqual([{ model: "m" }]);
  });

  it("does not retry errors a CPU run can't fix, and retries only once", async () => {
    const missing = fakeInit(["model file not found"]);
    await expect(initWithCpuFallback(missing.init, { model: "m" }, { platform: "ios", cpuDevices: cpu })).rejects.toThrow("not found");
    expect(missing.calls).toHaveLength(1);
    const both = fakeInit(["XPC_ERROR_CONNECTION_INTERRUPTED", "Failed to initialize context"]);
    await expect(initWithCpuFallback(both.init, { model: "m" }, { platform: "ios", cpuDevices: cpu })).rejects.toThrow("Failed to initialize context");
    expect(both.calls).toHaveLength(2);
  });
});

describe("cpuDeviceNames", () => {
  it("reads the CPU device name from llama.rn, or falls back to ggml's 'CPU'", async () => {
    expect(
      await cpuDeviceNames(async () => [
        { backend: "Metal", type: "gpu", deviceName: "MTL0" },
        { backend: "CPU", type: "cpu", deviceName: "CPU" },
      ])
    ).toEqual(["CPU"]);
    expect(await cpuDeviceNames(async () => [{ backend: "Metal", type: "gpu", deviceName: "MTL0" }])).toEqual(["CPU"]);
    expect(await cpuDeviceNames(() => Promise.reject(new Error("no")))).toEqual(["CPU"]);
  });
});

describe("8-bit KV cache", () => {
  it("Android: K and V at 8 bits, with the flash attention a quantized V needs", () => {
    expect(kvCacheParams("android")).toEqual({ cache_type_k: "q8_0", cache_type_v: "q8_0", flash_attn_type: "on" });
    expect(kvBytesPerElem(kvCacheParams("android"))).toBeCloseTo(1.0625);
  });

  it("iOS: K only, since flash attention stays off there", () => {
    expect(kvCacheParams("ios")).toEqual({ cache_type_k: "q8_0" });
    expect(kvBytesPerElem(kvCacheParams("ios"))).toBeCloseTo((1.0625 + 2) / 2);
  });

  it("the CPU retry turns flash attention off and so keeps V at 16 bits", async () => {
    const f = fakeInit(["failed to initialize context"]);
    await initWithCpuFallback(f.init, { model: "m.gguf", ...kvCacheParams("android") }, { platform: "android", cpuDevices: cpu });
    expect(f.calls[0]).toMatchObject({ cache_type_k: "q8_0", cache_type_v: "q8_0", flash_attn_type: "on" });
    expect(f.calls[1]).toEqual({ model: "m.gguf", cache_type_k: "q8_0", n_gpu_layers: 0, devices: ["CPU"], flash_attn_type: "off" });
  });

  it("iOS never asks for a quantized V, even if given one", async () => {
    const f = fakeInit([]);
    await initWithCpuFallback(f.init, { model: "m.gguf", cache_type_k: "q8_0", cache_type_v: "q8_0" }, { platform: "ios", cpuDevices: cpu });
    expect(f.calls[0]).toEqual({ model: "m.gguf", cache_type_k: "q8_0", flash_attn_type: "off" });
  });
});
