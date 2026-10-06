import { describe, it, expect } from "vitest";
import { createLoadGuard, CrashLedger, describeModelFile, LoadCrash, MarkerStore, toLoadCrash } from "./loadMarker";

function memory() {
  let file: string | null = null;
  const store: MarkerStore = { read: async () => file, write: async (j) => void (file = j), clear: async () => void (file = null) };
  const crashes: LoadCrash[] = [];
  const successes: string[] = [];
  let pending: LoadCrash | null = null;
  let keepMapped: string[] = [];
  const ledger: CrashLedger = {
    recordRepackCrash: async (id) => void keepMapped.push(id),
    takeKeepMapped: async (id) => {
      const had = keepMapped.includes(id);
      keepMapped = keepMapped.filter((k) => k !== id);
      return had;
    },
    recordCrash: async (c) => void (crashes.push(c), (pending = c)),
    recordSuccess: async (id) => void successes.push(id),
    takePending: async () => {
      const c = pending;
      pending = null;
      return c;
    },
  };
  return { store, ledger, crashes, successes, file: () => file, keepMapped: () => keepMapped };
}

describe("load marker (CR-2)", () => {
  const q15 = { filename: "models/q15.gguf", modelId: "qwen2.5-1.5b", label: "Qwen2.5 1.5B" };
  const q4 = { filename: "models/q4.gguf", modelId: "qwen3-4b", label: "Qwen3 4B" };

  it("a load that returns leaves no marker and records the success", async () => {
    const m = memory();
    const g = createLoadGuard(m.store, m.ledger, () => 1000);
    await g.begin(q4, q15);
    expect(JSON.parse(m.file()!)).toMatchObject({ modelId: "qwen3-4b", previous: { modelId: "qwen2.5-1.5b" }, at: 1000 });
    await g.end(q4, true);
    expect(m.file()).toBeNull();
    expect(m.successes).toEqual(["qwen3-4b"]);
    expect(await g.consume()).toBeNull();
  });

  it("a marker left by a killed app is reported once on the next start, with the model to fall back to", async () => {
    const m = memory();
    await createLoadGuard(m.store, m.ledger, () => 1000).begin(q4, q15); // ... OOM kill: end() never runs
    const next = createLoadGuard(m.store, m.ledger); // new process
    const crash = { crashedModelId: "qwen3-4b", crashedLabel: "Qwen3 4B", fallbackModelId: "qwen2.5-1.5b", fallbackLabel: "Qwen2.5 1.5B", at: 1000 };
    expect(await next.consume()).toEqual(crash);
    expect(await next.consume()).toBeNull();
    expect(m.crashes).toEqual([crash]);
    expect(m.file()).toBeNull();
  });

  it("the next load checks for a crash before writing its own marker", async () => {
    const m = memory();
    await createLoadGuard(m.store, m.ledger).begin(q4, q15);
    const next = createLoadGuard(m.store, m.ledger);
    await next.begin(q15, null);
    expect(m.crashes.map((c) => c.crashedModelId)).toEqual(["qwen3-4b"]);
    expect(JSON.parse(m.file()!).modelId).toBe("qwen2.5-1.5b");
  });
});

describe("a repacked load that killed the app", () => {
  const q15 = { filename: "models/q15.gguf", modelId: "qwen2.5-1.5b", label: "Qwen2.5 1.5B" };
  const q4 = { filename: "models/q4.gguf", modelId: "qwen3-4b", label: "Qwen3 4B" };

  it("is not a CR-2 crash: the model loads once more as the mapped file instead of falling back", async () => {
    const m = memory();
    await createLoadGuard(m.store, m.ledger).begin(q4, q15, { repacked: true }); // ... killed while repacking
    const next = createLoadGuard(m.store, m.ledger);
    expect(await next.consume()).toBeNull();
    expect(m.crashes).toEqual([]);
    expect(await next.takeKeepMapped(q4)).toBe(true);
    expect(await next.takeKeepMapped(q4)).toBe(false); // once: the load after that decides from memory again
  });

  it("if the mapped load dies too, that one is a CR-2 crash", async () => {
    const m = memory();
    await createLoadGuard(m.store, m.ledger).begin(q4, q15, { repacked: true });
    const second = createLoadGuard(m.store, m.ledger);
    expect(await second.takeKeepMapped(q4)).toBe(true);
    await second.begin(q4, q15, { repacked: false }); // ... killed again
    expect((await createLoadGuard(m.store, m.ledger).consume())?.crashedModelId).toBe("qwen3-4b");
  });
});

describe("describeModelFile (Prism CR-3: a load without meta)", () => {
  const catalog = [{ id: "qwen3-4b-instruct-2507-q4km", label: "Qwen3-4B-Instruct-2507 (Q4_K_M)", filename: "models/qwen3-4b-instruct-2507-q4km.gguf" }];
  it("the catalog's id and label, by path or by file name", () => {
    expect(describeModelFile("models/qwen3-4b-instruct-2507-q4km.gguf", catalog)).toEqual({ modelId: "qwen3-4b-instruct-2507-q4km", label: "Qwen3-4B-Instruct-2507 (Q4_K_M)" });
    expect(describeModelFile("/var/app/models/qwen3-4b-instruct-2507-q4km.gguf", catalog).modelId).toBe("qwen3-4b-instruct-2507-q4km");
  });
  it("an unknown file: its name without folder and .gguf, and no id", () => {
    expect(describeModelFile("models/My-Model.Q4.gguf", catalog)).toEqual({ label: "My-Model.Q4" });
  });
  it("the crash then carries the model id, so the CR-2 block matches it", () => {
    const meta = { filename: "models/qwen3-4b-instruct-2507-q4km.gguf", ...describeModelFile("models/qwen3-4b-instruct-2507-q4km.gguf", catalog) };
    expect(toLoadCrash({ ...meta, previous: null, at: 1 })).toMatchObject({ crashedModelId: "qwen3-4b-instruct-2507-q4km", crashedLabel: "Qwen3-4B-Instruct-2507 (Q4_K_M)" });
  });
});
