import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  PROBE_COLORS,
  VisionProbeCache,
  getProbeCachePath,
  makeTwoBandPng,
  parseProbeColorAnswer,
  pickProbeColorPair,
  type ProbeCompleteFn,
} from "../../src/probe.js";

function makeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    provider: "magpie",
    id: "remote/devin/swe-2-1",
    name: "SWE-2.1",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:3425/v1",
    input: ["text", "image"],
    reasoning: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 65536,
    ...overrides,
  } as Model<Api>;
}

function makeRegistry(ok = true): Partial<ModelRegistry> {
  return {
    getProvider: () => ({ baseUrl: "http://127.0.0.1:3425/v1" }),
    getApiKeyAndHeaders: vi.fn(async () =>
      ok ? { ok: true as const, apiKey: "test-key", headers: {} } : { ok: false as const, error: "no key" },
    ),
  } as unknown as Partial<ModelRegistry>;
}

function assistantReply(text: string, stopReason: AssistantMessage["stopReason"] = "stop", errorMessage?: string): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "openai-completions",
    provider: "magpie",
    model: "remote/devin/swe-2-1",
    usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

describe("makeTwoBandPng & pickProbeColorPair", () => {
  it("generates a tiny valid PNG with IHDR, IDAT, and IEND chunks", () => {
    const buf = makeTwoBandPng([0, 200, 0], [0, 80, 255]);
    // PNG magic header
    expect(buf.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(buf.includes(Buffer.from("IHDR", "ascii"))).toBe(true);
    expect(buf.includes(Buffer.from("IDAT", "ascii"))).toBe(true);
    expect(buf.includes(Buffer.from("IEND", "ascii"))).toBe(true);
    expect(buf.length).toBeLessThan(200);
  });

  it("always picks two distinct colors", () => {
    for (let i = 0; i < 30; i++) {
      const [top, bottom] = pickProbeColorPair();
      expect(top.name).not.toBe(bottom.name);
    }
  });
});

describe("parseProbeColorAnswer", () => {
  const green = PROBE_COLORS.find((c) => c.name === "green")!;
  const blue = PROBE_COLORS.find((c) => c.name === "blue")!;

  it("matches standard TOP/BOTTOM answers and markdown variants", () => {
    expect(parseProbeColorAnswer("TOP=green, BOTTOM=blue", green, blue)).toBe("match");
    expect(parseProbeColorAnswer("**TOP**: emerald\n**BOTTOM**: navy", green, blue)).toBe("match");
    expect(parseProbeColorAnswer("green and blue", green, blue)).toBe("match");
  });

  it("flags wrong colors and explicit image-unsupported refusals as mismatch", () => {
    expect(parseProbeColorAnswer("TOP=red, BOTTOM=yellow", green, blue)).toBe("mismatch");
    expect(parseProbeColorAnswer("TOP=blue, BOTTOM=green", green, blue)).toBe("mismatch");
    expect(parseProbeColorAnswer("Black", green, blue)).toBe("mismatch");
    expect(parseProbeColorAnswer("Sorry, this model does not support image inputs.", green, blue)).toBe("mismatch");
  });

  it("treats empty or non-color replies as inconclusive", () => {
    expect(parseProbeColorAnswer("", green, blue)).toBe("inconclusive");
    expect(parseProbeColorAnswer("OK", green, blue)).toBe("inconclusive");
  });
});

describe("VisionProbeCache", () => {
  let tmpHome: string;
  let savedAgentDir: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "pi-vw-probe-"));
    savedAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = tmpHome;
  });

  afterEach(() => {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("confirms vision=true on matching 2-band reply and persists across cache instances", async () => {
    // random=0 picks index 0 (red) and offset 1 -> index 1 (green)
    const completeFn = vi.fn<ProbeCompleteFn>(async () => assistantReply("TOP=red, BOTTOM=green"));
    const cache = new VisionProbeCache({ completeFn, random: () => 0 });
    const model = makeModel();
    const reg = makeRegistry();

    const first = await cache.probe(model, reg);
    expect(first?.vision).toBe(true);
    expect(first?.source).toBe("probe");
    expect(completeFn).toHaveBeenCalledTimes(1);
    expect(existsSync(getProbeCachePath())).toBe(true);

    // Second call uses cache without calling completeFn again
    const second = await cache.probe(model, reg);
    expect(second?.vision).toBe(true);
    expect(completeFn).toHaveBeenCalledTimes(1);

    // Fresh instance reloads from disk
    const fresh = new VisionProbeCache({ completeFn, random: () => 0 });
    expect(fresh.get(model.provider, model.id, model.baseUrl)?.vision).toBe(true);
  });

  it("detects silent image-stripping endpoints (HTTP 200 with wrong color guess) as vision=false", async () => {
    const completeFn = vi.fn<ProbeCompleteFn>(async () => assistantReply("TOP=black, BOTTOM=white"));
    const cache = new VisionProbeCache({ completeFn, random: () => 0 });
    const model = makeModel({ id: "remote/silent/model" });

    const res = await cache.probe(model, makeRegistry());
    expect(res?.vision).toBe(false);
    expect(res?.source).toBe("probe");
    expect(cache.get(model.provider, model.id, model.baseUrl)?.vision).toBe(false);
  });

  it("records vision=false when provider returns stopReason=error or throws image-not-supported", async () => {
    const errComplete = vi.fn<ProbeCompleteFn>(async () =>
      assistantReply("", "error", "400: This model does not support image inputs"),
    );
    const cache = new VisionProbeCache({ completeFn: errComplete, random: () => 0 });
    const m1 = makeModel({ id: "remote/err/m1" });
    const r1 = await cache.probe(m1, makeRegistry());
    expect(r1?.vision).toBe(false);

    const throwComplete = vi.fn<ProbeCompleteFn>(async () => {
      throw new Error("400: image input is not supported");
    });
    const cache2 = new VisionProbeCache({ completeFn: throwComplete, random: () => 0 });
    const m2 = makeModel({ id: "remote/err/m2" });
    const r2 = await cache2.probe(m2, makeRegistry());
    expect(r2?.vision).toBe(false);
  });

  it("does NOT cache transient errors, empty length-truncated reasoning replies, or soft quota errors", async () => {
    const cases: ProbeCompleteFn[] = [
      async () => assistantReply("", "error", "HTTP 503 Service Unavailable"),
      async () => assistantReply("", "length"),
      async () => assistantReply("Your credit balance is too low. Please recharge.", "stop"),
      async () => {
        throw new Error("ECONNRESET");
      },
    ];
    for (let i = 0; i < cases.length; i++) {
      const cache = new VisionProbeCache({ completeFn: cases[i], random: () => 0 });
      const m = makeModel({ id: `remote/transient/m${i}` });
      const res = await cache.probe(m, makeRegistry());
      expect(res).toBeNull();
      expect(cache.get(m.provider, m.id, m.baseUrl)).toBeUndefined();
    }
  });

  it("invalidates cache when baseUrl changes and deduplicates concurrent probes", async () => {
    let calls = 0;
    const completeFn: ProbeCompleteFn = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return assistantReply("TOP=red, BOTTOM=green");
    };
    const cache = new VisionProbeCache({ completeFn, random: () => 0 });
    const model = makeModel({ id: "remote/dedup/m1" });
    const reg = makeRegistry();

    const [a, b] = await Promise.all([cache.probe(model, reg), cache.probe(model, reg)]);
    expect(calls).toBe(1);
    expect(a?.vision).toBe(true);
    expect(b?.vision).toBe(true);

    // Different baseUrl invalidates the cached entry
    expect(cache.get(model.provider, model.id, "http://127.0.0.1:9999/v1")).toBeUndefined();

    // delete & clear persist to disk
    expect(cache.delete(model.provider, model.id)).toBe(true);
    expect(cache.get(model.provider, model.id, model.baseUrl)).toBeUndefined();
    cache.record(model.provider, model.id, { vision: false, source: "runtime-error" });
    cache.clear();
    const raw = JSON.parse(readFileSync(getProbeCachePath(), "utf8")) as { models: Record<string, unknown> };
    expect(Object.keys(raw.models)).toHaveLength(0);
  });
});
