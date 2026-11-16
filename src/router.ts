/**
 * Router capability discovery for OpenAI-compatible routing proxies (Magpie,
 * 9router, omnirouter, OpenRouter, LiteLLM, etc.).
 *
 * Proxy entries in `models.json` frequently mark every model with
 * `input: ["text", "image"]` (or omit `input` altogether), even when the
 * router's own `/models` endpoint knows which models are text-only. Querying
 * `/models` with a short timeout lets pi-vision-watcher distinguish
 * vision-capable vs. text-only models automatically for both `/vision-watcher`
 * and active-model handoff.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/** Per-model capability metadata parsed from a router's `/models` endpoint. */
export interface RouterModelCapability {
  id: string;
  /** `true` = explicitly supports image input; `false` = explicitly text-only;
   *  `undefined` = omitted or unparseable. */
  vision?: boolean;
  /** Display name / router label / description used for false-vision heuristics
   *  on aliased models (e.g. `"Abliterated Large v2 (GLM-5.3, uncensored)"`). */
  label?: string;
}

const DIRECT_VENDOR_HOSTS = new Set([
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "api.deepseek.com",
  "api.groq.com",
  "api.mistral.ai",
  "api.x.ai",
  "api.cerebras.ai",
  "api.together.xyz",
  "api.fireworks.ai",
  "api.minimax.io",
  "api.moonshot.cn",
  "api.moonshot.ai",
  "open.bigmodel.cn",
  "api.z.ai",
  "dashscope.aliyuncs.com",
  "dashscope-intl.aliyuncs.com",
]);

const DEFAULT_TIMEOUT_MS = 1_500;
const DEFAULT_TTL_MS = 5 * 60_000;

function firstStringArray(...candidates: unknown[]): string[] | undefined {
  for (const c of candidates) {
    if (!Array.isArray(c)) continue;
    const strings = c.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
    if (strings.length > 0) return strings;
  }
  return undefined;
}

function firstBoolean(...candidates: unknown[]): boolean | undefined {
  for (const c of candidates) {
    if (typeof c === "boolean") return c;
  }
  return undefined;
}

function extractEntryVision(entry: Record<string, unknown>): boolean | undefined {
  const modalities = entry.modalities as Record<string, unknown> | undefined;
  const architecture = entry.architecture as Record<string, unknown> | undefined;
  const capabilities = entry.capabilities as Record<string, unknown> | undefined;

  const inputMods = firstStringArray(
    modalities?.input,
    architecture?.input_modalities,
    entry.input_modalities,
    capabilities?.input_modalities,
    entry.input,
  );
  if (inputMods) {
    return inputMods.some((m) => /^(?:image|vision|multimodal)$/i.test(m.trim()));
  }

  if (typeof architecture?.modality === "string" && architecture.modality.trim()) {
    const [inputSide] = architecture.modality.split("->");
    return /\bimage\b/i.test(inputSide ?? architecture.modality);
  }

  return firstBoolean(
    entry.supports_vision,
    capabilities?.vision,
    capabilities?.image,
    capabilities?.multimodal,
    entry.vision,
  );
}

function extractEntryLabel(entry: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const raw of [entry.magpie_label, entry.display_name, entry.name]) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    parts.push(trimmed);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** Parse a router `/models` JSON payload into a map keyed by model id. */
export function parseRouterModelsPayload(payload: unknown): Map<string, RouterModelCapability> {
  const out = new Map<string, RouterModelCapability>();
  let list: unknown;
  if (Array.isArray(payload)) {
    list = payload;
  } else if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    list = Array.isArray(obj.data) ? obj.data : Array.isArray(obj.models) ? obj.models : undefined;
  }
  if (!Array.isArray(list)) return out;

  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.id !== "string" || !entry.id.trim()) continue;
    const id = entry.id.trim();
    const vision = extractEntryVision(entry);
    const label = extractEntryLabel(entry);
    out.set(id, { id, vision, label });
  }
  return out;
}

/** True when `baseUrl` points at a well-known direct cloud vendor API whose
 *  built-in Pi catalog already carries accurate capabilities. */
export function isDirectVendorBaseUrl(baseUrl: string | undefined | null): boolean {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return DIRECT_VENDOR_HOSTS.has(host);
  } catch {
    return false;
  }
}

/** Candidate `/models` URLs for an OpenAI-compatible `baseUrl`. */
export function routerModelsUrls(baseUrl: string): string[] {
  const clean = baseUrl.trim().replace(/\/+$/, "");
  if (!clean) return [];
  if (/\/v\d+(?:[a-z0-9]*)?$/i.test(clean)) return [`${clean}/models`];
  return [`${clean}/models`, `${clean}/v1/models`];
}

/** Fetch and parse `/models` from a router `baseUrl`. Never throws; returns an
 *  empty map on network, timeout, auth, or parse failure. */
export async function fetchRouterCapabilities(
  baseUrl: string,
  headers?: Record<string, string>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, RouterModelCapability>> {
  const urls = routerModelsUrls(baseUrl);
  for (const url of urls) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json", ...headers },
        signal: ac.signal,
      });
      if (!res.ok) continue;
      const json = (await res.json()) as unknown;
      return parseRouterModelsPayload(json);
    } catch {
      // Offline router, timeout, or non-JSON response: try next candidate or degrade.
    } finally {
      clearTimeout(timer);
    }
  }
  return new Map();
}

interface CacheEntry {
  baseUrl: string;
  fetchedAt: number;
  models: Map<string, RouterModelCapability>;
}

/** Session-scoped cache of router `/models` capabilities keyed by provider id. */
export class RouterCapabilityCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options?: { ttlMs?: number; timeoutMs?: number; fetchImpl?: typeof fetch }) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options?.fetchImpl ?? fetch;
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }

  get(provider: string | undefined, modelId: string | undefined): RouterModelCapability | undefined {
    if (!provider || !modelId) return undefined;
    return this.entries.get(provider)?.models.get(modelId);
  }

  hasFresh(provider: string | undefined): boolean {
    if (!provider) return false;
    const entry = this.entries.get(provider);
    return !!entry && Date.now() - entry.fetchedAt < this.ttlMs;
  }

  /** Refresh router capabilities for all (or specific) router providers in
   *  `modelRegistry`. Concurrent refreshes for the same provider share one
   *  request; failures degrade cleanly without throwing. */
  async refreshProviders(
    modelRegistry: Partial<ModelRegistry> | undefined | null,
    options?: { providers?: string[]; force?: boolean },
  ): Promise<void> {
    if (!modelRegistry?.getAvailable) return;
    const targetSet = options?.providers ? new Set(options.providers) : null;
    const force = options?.force ?? false;

    const byProvider = new Map<string, { baseUrl: string; sampleModel: Model<Api> }>();
    for (const model of modelRegistry.getAvailable()) {
      if (!model.provider) continue;
      if (targetSet && !targetSet.has(model.provider)) continue;
      if (byProvider.has(model.provider)) continue;
      const providerCfg = modelRegistry.getProvider?.(model.provider);
      const baseUrl = model.baseUrl || providerCfg?.baseUrl;
      if (!baseUrl || isDirectVendorBaseUrl(baseUrl)) continue;
      byProvider.set(model.provider, { baseUrl, sampleModel: model });
    }

    const tasks: Promise<void>[] = [];
    for (const [provider, { baseUrl, sampleModel }] of byProvider) {
      const existing = this.entries.get(provider);
      const fresh = existing && existing.baseUrl === baseUrl && Date.now() - existing.fetchedAt < this.ttlMs;
      if (!force && fresh) continue;

      const pending = this.inflight.get(provider);
      if (pending) {
        tasks.push(pending);
        continue;
      }

      const task = (async () => {
        try {
          const headers = await resolveRequestHeaders(modelRegistry, sampleModel);
          const models = await fetchRouterCapabilities(baseUrl, headers, this.timeoutMs, this.fetchImpl);
          this.entries.set(provider, { baseUrl, fetchedAt: Date.now(), models });
        } finally {
          this.inflight.delete(provider);
        }
      })();
      this.inflight.set(provider, task);
      tasks.push(task);
    }

    await Promise.allSettled(tasks);
  }
}

async function resolveRequestHeaders(
  modelRegistry: Partial<ModelRegistry>,
  sampleModel: Model<Api>,
): Promise<Record<string, string> | undefined> {
  if (!modelRegistry.getApiKeyAndHeaders) return undefined;
  try {
    const auth = await modelRegistry.getApiKeyAndHeaders(sampleModel);
    if (!auth?.ok) return undefined;
    const headers: Record<string, string> = {};
    if (auth.headers) {
      for (const [k, v] of Object.entries(auth.headers)) {
        if (typeof v === "string") headers[k] = v;
      }
    }
    if (auth.apiKey && !Object.keys(headers).some((k) => k.toLowerCase() === "authorization")) {
      headers.Authorization = `Bearer ${auth.apiKey}`;
    }
    return Object.keys(headers).length > 0 ? headers : undefined;
  } catch {
    return undefined;
  }
}
