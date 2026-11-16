import { describe, expect, it, vi } from "vitest";
import {
  fetchRouterCapabilities,
  isDirectVendorBaseUrl,
  parseRouterModelsPayload,
  RouterCapabilityCache,
  routerModelsUrls,
} from "../../src/router.js";

describe("parseRouterModelsPayload", () => {
  it("parses Magpie modalities.input and label metadata", () => {
    const map = parseRouterModelsPayload({
      data: [
        {
          id: "remote/auto/glm-5.3",
          display_name: "GLM 5.3",
          magpie_label: "GLM 5.3 · routing group · Remote",
          modalities: { input: ["text"] },
        },
        {
          id: "remote/agy-cli/gemini-3.8-flash",
          display_name: "Gemini 3.8 Flash",
          modalities: { input: ["text", "image"] },
        },
        {
          id: "remote/enclave/cyberouter/abliterated-large-v2",
          magpie_label: "Abliterated Large v2 (GLM-5.3, uncensored)",
        },
      ],
    });

    expect(map.get("remote/auto/glm-5.3")).toEqual({
      id: "remote/auto/glm-5.3",
      vision: false,
      label: "GLM 5.3 · routing group · Remote · GLM 5.3",
    });
    expect(map.get("remote/agy-cli/gemini-3.8-flash")?.vision).toBe(true);
    expect(map.get("remote/enclave/cyberouter/abliterated-large-v2")).toEqual({
      id: "remote/enclave/cyberouter/abliterated-large-v2",
      vision: undefined,
      label: "Abliterated Large v2 (GLM-5.3, uncensored)",
    });
  });

  it("parses OpenRouter / 9router / omnirouter architecture and LiteLLM flags", () => {
    const map = parseRouterModelsPayload({
      data: [
        { id: "9r/text-a", architecture: { input_modalities: ["text"] } },
        { id: "9r/vis-b", architecture: { input_modalities: ["text", "image"] } },
        { id: "omni/mod-text", architecture: { modality: "text->text" } },
        { id: "omni/mod-vis", architecture: { modality: "text+image->text" } },
        { id: "litellm/vis", supports_vision: true },
        { id: "litellm/text", supports_vision: false },
        { id: "cap/text", capabilities: { vision: false } },
      ],
    });

    expect(map.get("9r/text-a")?.vision).toBe(false);
    expect(map.get("9r/vis-b")?.vision).toBe(true);
    expect(map.get("omni/mod-text")?.vision).toBe(false);
    expect(map.get("omni/mod-vis")?.vision).toBe(true);
    expect(map.get("litellm/vis")?.vision).toBe(true);
    expect(map.get("litellm/text")?.vision).toBe(false);
    expect(map.get("cap/text")?.vision).toBe(false);
  });

  it("handles top-level arrays and invalid payloads safely", () => {
    const map = parseRouterModelsPayload([{ id: "m1", input: ["text"] }]);
    expect(map.get("m1")?.vision).toBe(false);
    expect(parseRouterModelsPayload(null).size).toBe(0);
    expect(parseRouterModelsPayload("bad").size).toBe(0);
  });
});

describe("isDirectVendorBaseUrl / routerModelsUrls", () => {
  it("skips well-known direct vendor hosts and keeps local/proxy routers", () => {
    expect(isDirectVendorBaseUrl("https://api.openai.com/v1")).toBe(true);
    expect(isDirectVendorBaseUrl("https://api.anthropic.com")).toBe(true);
    expect(isDirectVendorBaseUrl("http://127.0.0.1:3425/v1")).toBe(false);
    expect(isDirectVendorBaseUrl("http://localhost:20128/v1")).toBe(false);
    expect(isDirectVendorBaseUrl("https://omnirouter.internal/v1")).toBe(false);
  });

  it("builds candidate /models URLs without doubling /v1", () => {
    expect(routerModelsUrls("http://127.0.0.1:3425/v1/")).toEqual(["http://127.0.0.1:3425/v1/models"]);
    expect(routerModelsUrls("http://localhost:20128")).toEqual([
      "http://localhost:20128/models",
      "http://localhost:20128/v1/models",
    ]);
  });
});

describe("fetchRouterCapabilities", () => {
  it("falls back to /v1/models when /models returns 404 and degrades cleanly on network failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: "m1", modalities: { input: ["text"] } }] }),
      });

    const out = await fetchRouterCapabilities("http://localhost:20128", { Authorization: "Bearer k" }, 500, fetchMock as any);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.get("m1")?.vision).toBe(false);

    const failingFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const empty = await fetchRouterCapabilities("http://127.0.0.1:3425/v1", undefined, 500, failingFetch as any);
    expect(empty.size).toBe(0);
  });
});

describe("RouterCapabilityCache", () => {
  it("deduplicates concurrent refreshes, forwards auth headers, and skips direct vendor URLs", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: "mercury-3", modalities: { input: ["text"] } },
          { id: "gemini-3.8-flash", modalities: { input: ["text", "image"] } },
        ],
      }),
    }));
    const cache = new RouterCapabilityCache({ fetchImpl: fetchMock as any, timeoutMs: 500 });
    const registry = {
      getAvailable: () => [
        { provider: "magpie", id: "mercury-3", baseUrl: "http://127.0.0.1:3425/v1" },
        { provider: "openai", id: "gpt-4o", baseUrl: "https://api.openai.com/v1" },
      ],
      getProvider: () => undefined,
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey: "secret-key", headers: { "X-Test": "1" } })),
    } as any;

    await Promise.all([cache.refreshProviders(registry), cache.refreshProviders(registry)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as any[])[1].headers).toMatchObject({
      Authorization: "Bearer secret-key",
      "X-Test": "1",
    });
    expect(cache.get("magpie", "mercury-3")?.vision).toBe(false);
    expect(cache.get("magpie", "gemini-3.8-flash")?.vision).toBe(true);
    expect(cache.get("openai", "gpt-4o")).toBeUndefined();
  });
});
