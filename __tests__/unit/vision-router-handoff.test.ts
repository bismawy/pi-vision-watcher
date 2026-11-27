import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runBatch = vi.fn(async (misses: { hash: string }[]) => {
  const out = new Map<string, string>();
  for (const m of misses) out.set(m.hash, `described-${m.hash}`);
  return out;
});
const describeSingle = vi.fn(async (img: { data: string }) => `single-${img.data}`);

vi.mock("../../src/describer.js", () => ({
  runBatch: (...args: unknown[]) => runBatch(...(args as Parameters<typeof runBatch>)),
  describeSingle: (...args: unknown[]) => describeSingle(...(args as Parameters<typeof describeSingle>)),
}));

vi.mock("../../src/index.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    readConfig: () => ({
      ...(actual.DEFAULT_CONFIG as object),
      enabled: true,
      visionModel: "magpie/remote/agy-cli/gemini-3.8-flash",
      autoHandoff: true,
      handoffModels: [],
      prewarmPastedImages: false,
      asyncClipboardHandoff: false,
    }),
  };
});

import factory from "../../vision-watcher.js";

function makePngBytes(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
    "base64",
  );
}

const setupExtension = () => {
  const handlers: Record<string, (event: any, ctx: any) => Promise<unknown>> = {};
  const commands: Record<string, (args: string, ctx: any) => Promise<unknown>> = {};
  const pi = {
    on: vi.fn((event: string, handler: any) => {
      handlers[event] = handler;
    }),
    registerCommand: vi.fn((name: string, def: { handler: any }) => {
      commands[name] = def.handler;
    }),
    registerMessageRenderer: vi.fn(),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    getActiveTools: () => [],
  };
  factory(pi as any);
  return { pi, handlers, commands };
};

describe("router-aware vision detection and Turn-1 forwarding", () => {
  let tmpHome: string;
  let savedAgentDir: string | undefined;
  let savedFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "pi-vw-router-"));
    savedAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = tmpHome;
    savedFetch = globalThis.fetch;
    runBatch.mockClear();
    describeSingle.mockClear();
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("filters router text-only models out of /vision-watcher and forwards images on Turn 1 for those models", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: "remote/inception/mercury-3", modalities: { input: ["text"] } },
          { id: "remote/auto/glm-5.3", modalities: { input: ["text"] } },
          {
            id: "remote/enclave/cyberouter/abliterated-large-v2",
            magpie_label: "Abliterated Large v2 (GLM-5.3, uncensored)",
          },
          { id: "remote/agy-cli/gemini-3.8-flash", modalities: { input: ["text", "image"] } },
        ],
      }),
    })) as any;

    const routerModels = [
      {
        provider: "magpie",
        id: "remote/inception/mercury-3",
        name: "Mercury 3",
        baseUrl: "http://127.0.0.1:3425/v1",
        input: ["text", "image"] as ("text" | "image")[],
      },
      {
        provider: "magpie",
        id: "remote/auto/glm-5.3",
        name: "GLM 5.3",
        baseUrl: "http://127.0.0.1:3425/v1",
        input: ["text", "image"] as ("text" | "image")[],
      },
      {
        provider: "magpie",
        id: "remote/enclave/cyberouter/abliterated-large-v2",
        name: "Abliterated Large v2",
        baseUrl: "http://127.0.0.1:3425/v1",
        input: ["text", "image"] as ("text" | "image")[],
      },
      {
        provider: "magpie",
        id: "remote/agy-cli/gemini-3.8-flash",
        name: "Gemini 3.8 Flash",
        baseUrl: "http://127.0.0.1:3425/v1",
        input: ["text", "image"] as ("text" | "image")[],
      },
    ];

    const selectMock = vi.fn(async () => undefined);
    const modelRegistry = {
      getAvailable: () => routerModels,
      find: (p: string, id: string) => routerModels.find((m) => m.provider === p && m.id === id),
      getProvider: () => ({ baseUrl: "http://127.0.0.1:3425/v1" }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }),
    };

    // Active model is mercury-3, falsely marked ["text", "image"] in models.json.
    const activeCtx = {
      mode: "print" as const,
      hasUI: true,
      model: routerModels[0],
      modelRegistry,
      signal: new AbortController().signal,
      ui: { notify: vi.fn(), select: selectMock },
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: "remote/inception/mercury-3", architecture: { input_modalities: ["text"] } },
            { id: "remote/auto/glm-5.3", architecture: { input_modalities: ["text"] } },
            { id: "remote/enclave/cyberouter/abliterated-large-v2", architecture: { input_modalities: ["text"] } },
            { id: "remote/agy-cli/gemini-3.8-flash", architecture: { input_modalities: ["text", "image"] } },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    try {
      const { handlers, commands } = setupExtension();
      await handlers["session_start"]({ type: "session_start", reason: "startup" }, activeCtx);
      await new Promise((r) => setTimeout(r, 10));

      // 1. /vision-watcher picker only lists true vision models (gemini-3.8-flash),
      // excluding mercury-3, glm-5.3, and abliterated-large-v2.
      await commands["vision-watcher"]("", activeCtx);
      expect(selectMock).toHaveBeenCalledWith("Vision model", ["None", "magpie/remote/agy-cli/gemini-3.8-flash"]);

      // 2. User attaches an image while chatting with mercury-3 -> automatically
      // described by gemini-3.8-flash and forwarded as text in context.
      const messages = [
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this screenshot?" },
            { type: "image", data: "QUJD", mimeType: "image/png" },
          ],
        },
      ];
      const ctxResult = (await handlers["context"](
        { type: "context", messages },
        activeCtx,
      )) as { messages: Array<{ content: Array<{ type: string; text?: string }> }> } | undefined;

      expect(runBatch).toHaveBeenCalledTimes(1);
      expect(ctxResult).toBeDefined();
      const outBlocks = ctxResult!.messages[0]!.content;
      expect(outBlocks.some((b) => b.type === "image")).toBe(false);
      expect(outBlocks.some((b) => b.text?.includes("[Image: described-"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("forwards pasted clipboard image paths on Turn 1 in context when asyncClipboardHandoff is false", async () => {
    const pastedPath = join(tmpdir(), `pi-clipboard-turn1-${Date.now()}.png`);
    writeFileSync(pastedPath, makePngBytes());

    try {
      const textModel = { provider: "agent", id: "text-only", input: ["text"] as ("text" | "image")[] };
      const visionModel = { provider: "magpie", id: "remote/agy-cli/gemini-3.8-flash", input: ["text", "image"] as ("text" | "image")[] };
      const ctx = {
        mode: "print" as const,
        hasUI: false,
        model: textModel,
        modelRegistry: {
          getAvailable: () => [textModel, visionModel],
          find: (p: string, id: string) => (p === "magpie" && id === "remote/agy-cli/gemini-3.8-flash" ? visionModel : undefined),
        },
        signal: new AbortController().signal,
        ui: { notify: vi.fn() },
      };

      const { pi, handlers } = setupExtension();
      await handlers["session_start"]({ type: "session_start", reason: "startup" }, ctx);

      const promptText = `Explain this error ${pastedPath}`;
      await handlers["before_agent_start"](
        { type: "before_agent_start", prompt: promptText, images: [] },
        ctx,
      );

      const messages = [{ role: "user", content: [{ type: "text", text: promptText }] }];
      const result = (await handlers["context"](
        { type: "context", messages },
        ctx,
      )) as { messages: Array<{ content: Array<{ type: string; text?: string }> }> } | undefined;

      expect(pi.sendMessage).not.toHaveBeenCalled();
      expect(runBatch).toHaveBeenCalledTimes(1);
      expect(result).toBeDefined();
      const blocks = result!.messages[0]!.content;
      expect(blocks.some((b) => b.text?.includes(pastedPath) && b.text?.includes("[Image: described-"))).toBe(true);
    } finally {
      rmSync(pastedPath, { force: true });
    }
  });

  it("uses the active vision-capable chat model directly without handoff, and hands off only when switched to text-only", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: "remote/agy-cli/gemini-4-hydrogen", modalities: { input: ["text", "image"] } },
          { id: "remote/agy-cli/gemini-3.8-flash", modalities: { input: ["text", "image"] } },
          { id: "remote/inception/mercury-3", modalities: { input: ["text"] } },
        ],
      }),
    })) as any;

    const chatVisionModel = {
      provider: "magpie",
      id: "remote/agy-cli/gemini-4-hydrogen",
      name: "Gemini 4 Hydrogen",
      baseUrl: "http://127.0.0.1:3425/v1",
      input: ["text", "image"] as ("text" | "image")[],
    };
    const describerModel = {
      provider: "magpie",
      id: "remote/agy-cli/gemini-3.8-flash",
      name: "Gemini 3.8 Flash",
      baseUrl: "http://127.0.0.1:3425/v1",
      input: ["text", "image"] as ("text" | "image")[],
    };
    const textOnlyModel = {
      provider: "magpie",
      id: "remote/inception/mercury-3",
      name: "Mercury 3",
      baseUrl: "http://127.0.0.1:3425/v1",
      input: ["text", "image"] as ("text" | "image")[],
    };

    const registry = {
      getAvailable: () => [chatVisionModel, describerModel, textOnlyModel],
      find: (p: string, id: string) =>
        [chatVisionModel, describerModel, textOnlyModel].find((m) => m.provider === p && m.id === id),
      getProvider: () => ({ baseUrl: "http://127.0.0.1:3425/v1" }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }),
    };

    const { handlers } = setupExtension();
    const visionCtx = {
      mode: "print" as const,
      hasUI: false,
      model: chatVisionModel,
      modelRegistry: registry,
      signal: new AbortController().signal,
      ui: { notify: vi.fn() },
    };
    await handlers["session_start"]({ type: "session_start", reason: "startup" }, visionCtx);

    const visionMessages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Check this" },
          { type: "image", data: "VklTSU9OX1RFU1Q=", mimeType: "image/png" },
        ],
      },
    ];
    const directRes = await handlers["context"]({ type: "context", messages: visionMessages }, visionCtx);
    expect(directRes).toBeUndefined();
    expect(runBatch).not.toHaveBeenCalled();

    const textCtx = { ...visionCtx, model: textOnlyModel };
    const handoffRes = (await handlers["context"](
      { type: "context", messages: visionMessages },
      textCtx,
    )) as { messages: Array<{ content: Array<{ type: string; text?: string }> }> } | undefined;
    expect(runBatch).toHaveBeenCalledTimes(1);
    expect(handoffRes?.messages[0]?.content.some((b) => b.text?.includes("[Image: described-"))).toBe(true);
  });

  it("does NOT proactively mutate models.json on session_start/model_select, resets cache on /vision-watcher model, and reports capability source in status", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: "remote/devin/swe-2-1", modalities: { input: ["text", "image"] } },
          { id: "remote/inception/mercury-3", modalities: { input: ["text"] } },
          { id: "remote/agy-cli/gemini-3.8-flash", modalities: { input: ["text", "image"] } },
        ],
      }),
    })) as any;

    const modelsJsonPath = join(tmpHome, "models.json");
    const originalModelsJson = JSON.stringify({ providers: { magpie: { modelOverrides: {} } } }, null, 2);
    writeFileSync(modelsJsonPath, originalModelsJson, "utf8");

    const swe21 = {
      provider: "magpie",
      id: "remote/devin/swe-2-1",
      name: "SWE-2.1 · Devin",
      baseUrl: "http://127.0.0.1:3425/v1",
      input: ["text", "image"] as ("text" | "image")[],
    };
    const mercury = {
      provider: "magpie",
      id: "remote/inception/mercury-3",
      name: "Mercury 3",
      baseUrl: "http://127.0.0.1:3425/v1",
      input: ["text", "image"] as ("text" | "image")[],
    };
    const describer = {
      provider: "magpie",
      id: "remote/agy-cli/gemini-3.8-flash",
      name: "Gemini 3.8 Flash",
      baseUrl: "http://127.0.0.1:3425/v1",
      input: ["text", "image"] as ("text" | "image")[],
    };

    const registry = {
      getAvailable: () => [swe21, mercury, describer],
      find: (p: string, id: string) => [swe21, mercury, describer].find((m) => m.provider === p && m.id === id),
      getProvider: () => ({ baseUrl: "http://127.0.0.1:3425/v1" }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }),
    };

    const notify = vi.fn();
    const { handlers, commands } = setupExtension();
    const ctx = {
      mode: "print" as const,
      hasUI: true,
      model: mercury,
      modelRegistry: registry,
      signal: new AbortController().signal,
      ui: { notify },
    };

    await handlers["session_start"]({ type: "session_start", reason: "startup" }, ctx);
    await handlers["model_select"]({ type: "model_select", model: swe21 }, { ...ctx, model: swe21 });

    // models.json must NOT be mutated by proactive heuristics
    expect(readFileSync(modelsJsonPath, "utf8")).toBe(originalModelsJson);

    // Status reports capability detection source
    await commands["vision-watcher"]("status", { ...ctx, model: mercury });
    const statusMsg = notify.mock.calls.map((c) => String(c[0])).find((s) => s.includes("Capability detection:")) ?? "";
    expect(statusMsg).toContain("text-only (source: router-text-only)");

    // Probe subcommand respects router-text-only and clear resets disk cache
    await commands["vision-watcher"]("probe", { ...ctx, model: mercury });
    expect(notify.mock.calls.some((c) => String(c[0]).includes("router-text-only"))).toBe(true);
    await commands["vision-watcher"]("probe clear", ctx);
    expect(existsSync(join(tmpHome, "cache", "pi-vision-watcher", "capabilities.json"))).toBe(true);

    // Switching/re-setting vision model via /vision-watcher model invalidates description cache
    const makeImgMsg = () => [
      {
        role: "user",
        content: [
          { type: "text", text: "Read this" },
          { type: "image", data: "UkVTRVRfVEVTVA==", mimeType: "image/png" },
        ],
      },
    ];
    await handlers["context"]({ type: "context", messages: makeImgMsg() }, { ...ctx, model: mercury });
    expect(runBatch).toHaveBeenCalledTimes(1);
    // Cache hit before config update
    await handlers["context"]({ type: "context", messages: makeImgMsg() }, { ...ctx, model: mercury });
    expect(runBatch).toHaveBeenCalledTimes(1);
    // Re-setting vision model clears cache so next turn re-describes
    await commands["vision-watcher"]("model magpie/remote/agy-cli/gemini-3.8-flash", { ...ctx, model: mercury });
    await handlers["context"]({ type: "context", messages: makeImgMsg() }, { ...ctx, model: mercury });
    expect(runBatch).toHaveBeenCalledTimes(2);
  });
});
