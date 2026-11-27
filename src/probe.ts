/**
 * Universal runtime vision capability probe + disk-backed capability cache.
 *
 * Instead of relying on hardcoded model-name regexes (which break as new
 * multimodal models ship in existing families — e.g. SWE-2.1, GLM-5.3-Flash,
 * DeepSeek-V4.1-Flash) or trusting aggregator `/models` metadata blindly,
 * this module verifies whether a model endpoint actually sees images by sending
 * a tiny generated 2-band color PNG (~101 bytes) once per `provider/id + baseUrl`
 * and caching the confirmed result on disk.
 *
 * Why a 2-band color PNG instead of a 1x1 HTTP-400 check:
 *   1. Some proxies/models silently drop `image_url` blocks and still return
 *      HTTP 200; checking two distinct randomized colors (30 ordered pairs)
 *      catches silent strippers while keeping random-guess probability ~3%.
 *   2. Reasoning models spend output tokens in `reasoning_content`, so the
 *      probe requests `maxTokens: 512` with `reasoning: undefined` (thinking
 *      off) and treats empty `length`-truncated replies as inconclusive rather
 *      than falsely marking the model text-only.
 *   3. Transient failures (429, 503, timeouts, auth errors, soft quota text)
 *      return `null` and are NEVER cached.
 */

import type { Api, AssistantMessage, Context, ImageContent, Model, SimpleStreamOptions, TextContent } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import {
  assistantErrorText,
  formatModelRef,
  isImageNotSupportedError,
  isSoftProviderErrorText,
} from "./index.js";

const CACHE_SUBPATH = join("cache", "pi-vision-watcher", "capabilities.json");

/** Default TTL for cached runtime vision probe results (14 days). */
export const DEFAULT_PROBE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Default per-probe timeout (ms). Kept short so a slow endpoint degrades
 *  cleanly without stalling a turn. */
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/** Output budget for the probe. High enough that reasoning models that ignore
 *  `reasoning: undefined` still have room for the 4-word answer after brief
 *  internal reasoning. */
const PROBE_MAX_TOKENS = 512;

export interface ProbeColor {
  name: string;
  rgb: readonly [number, number, number];
  pattern: RegExp;
}

export const PROBE_COLORS: readonly ProbeColor[] = [
  { name: "red", rgb: [220, 20, 20], pattern: /\b(?:red|crimson|scarlet|merah)\b/i },
  { name: "green", rgb: [20, 185, 20], pattern: /\b(?:green|lime|emerald|hijau)\b/i },
  { name: "blue", rgb: [20, 80, 235], pattern: /\b(?:blue|navy|azure|biru)\b/i },
  { name: "yellow", rgb: [245, 220, 20], pattern: /\b(?:yellow|gold|kuning)\b/i },
  { name: "purple", rgb: [150, 20, 210], pattern: /\b(?:purple|violet|magenta|ungu)\b/i },
  { name: "orange", rgb: [245, 130, 20], pattern: /\b(?:orange|amber|oranye|jingga)\b/i },
];

const ANY_COLOR_WORD_RE =
  /\b(?:red|crimson|scarlet|green|lime|emerald|blue|navy|azure|yellow|gold|purple|violet|magenta|orange|amber|black|white|gray|grey|brown|pink|cyan|teal|merah|hijau|biru|kuning|ungu|oranye|hitam|putih)\b/i;

export type ProbeResultSource = "probe" | "runtime-error";

export interface ProbeCacheEntry {
  vision: boolean;
  source: ProbeResultSource;
  baseUrl?: string;
  checkedAt: number;
  detail?: string;
}

export type ProbeCompleteFn = (
  model: Model<Api>,
  modelRegistry: Partial<ModelRegistry>,
  context: Context,
  options: SimpleStreamOptions,
) => Promise<AssistantMessage>;

/** Path to the disk capability cache:
 *  `~/.pi/agent/cache/pi-vision-watcher/capabilities.json` (respects `$PI_CODING_AGENT_DIR`). */
export function getProbeCachePath(): string {
  return join(getAgentDir(), CACHE_SUBPATH);
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const tag = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tag, data])), 0);
  return Buffer.concat([len, tag, data, crc]);
}

/** Generate a minimal valid 8-bit RGB PNG split horizontally into a top band
 *  and bottom band. Pure Node stdlib (`node:zlib`), ~101 bytes at 32x32. */
export function makeTwoBandPng(
  topRgb: readonly [number, number, number],
  bottomRgb: readonly [number, number, number],
  width = 32,
  height = 32,
): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 2; // RGB
  const rowBytes = 1 + width * 3;
  const raw = Buffer.alloc(rowBytes * height);
  const splitY = Math.floor(height / 2);
  for (let y = 0; y < height; y++) {
    const offset = y * rowBytes;
    const [r, g, b] = y < splitY ? topRgb : bottomRgb;
    raw[offset] = 0; // filter type None
    for (let x = 0; x < width; x++) {
      raw[offset + 1 + x * 3] = r;
      raw[offset + 2 + x * 3] = g;
      raw[offset + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Pick two distinct colors from {@link PROBE_COLORS}. */
export function pickProbeColorPair(random: () => number = Math.random): [ProbeColor, ProbeColor] {
  const n = PROBE_COLORS.length;
  const firstIdx = Math.floor(Math.max(0, Math.min(0.999999, random())) * n);
  const offset = 1 + Math.floor(Math.max(0, Math.min(0.999999, random())) * (n - 1));
  const secondIdx = (firstIdx + offset) % n;
  return [PROBE_COLORS[firstIdx]!, PROBE_COLORS[secondIdx]!];
}

export type ProbeAnswerVerdict = "match" | "mismatch" | "inconclusive";

/** Evaluate a probe text reply against the expected top/bottom colors.
 *  - `"match"`: both top and bottom colors match in the right order.
 *  - `"mismatch"`: explicit cannot-see-image refusal, or a color guess that
 *    disagrees with the generated image (catches silent image-stripping proxies).
 *  - `"inconclusive"`: empty or non-color response (do not cache). */
export function parseProbeColorAnswer(
  text: string,
  expectedTop: ProbeColor,
  expectedBottom: ProbeColor,
): ProbeAnswerVerdict {
  const cleaned = text.replace(/\*\*/g, "").trim();
  if (!cleaned) return "inconclusive";
  if (isImageNotSupportedError(cleaned)) return "mismatch";

  const topMatch = /\btop\s*(?:half|band|color)?\s*[:=\-]\s*([a-z]+)/i.exec(cleaned);
  const bottomMatch = /\bbottom\s*(?:half|band|color)?\s*[:=\-]\s*([a-z]+)/i.exec(cleaned);
  if (topMatch && bottomMatch) {
    const topOk = expectedTop.pattern.test(topMatch[1]!);
    const botOk = expectedBottom.pattern.test(bottomMatch[1]!);
    return topOk && botOk ? "match" : "mismatch";
  }

  // Fallback for models that omit TOP=/BOTTOM= labels and reply e.g. "green, blue"
  const topHit = expectedTop.pattern.exec(cleaned);
  const botHit = expectedBottom.pattern.exec(cleaned);
  if (topHit && botHit && topHit.index < botHit.index) {
    return "match";
  }
  if (ANY_COLOR_WORD_RE.test(cleaned)) {
    return "mismatch";
  }
  return "inconclusive";
}

async function defaultProbeComplete(
  model: Model<Api>,
  modelRegistry: Partial<ModelRegistry>,
  context: Context,
  options: SimpleStreamOptions,
): Promise<AssistantMessage> {
  const provider = modelRegistry.getRegisteredProviderConfig?.(model.provider);
  if (provider?.streamSimple && provider.api === model.api) {
    return provider.streamSimple(model, context, options).result();
  }
  return completeSimple(model, context, options);
}

interface DiskCacheShape {
  version: 1;
  models: Record<string, ProbeCacheEntry>;
}

/** Disk-persisted runtime vision capability cache with in-flight deduplication. */
export class VisionProbeCache {
  private loadedPath: string | null = null;
  private entries = new Map<string, ProbeCacheEntry>();
  private readonly inflight = new Map<string, Promise<ProbeCacheEntry | null>>();
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly completeFn: ProbeCompleteFn;
  private readonly random: () => number;

  constructor(options?: {
    ttlMs?: number;
    timeoutMs?: number;
    completeFn?: ProbeCompleteFn;
    random?: () => number;
  }) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_PROBE_TTL_MS;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.completeFn = options?.completeFn ?? defaultProbeComplete;
    this.random = options?.random ?? Math.random;
  }

  private ensureLoaded(): void {
    const path = getProbeCachePath();
    if (this.loadedPath === path) return;
    this.loadedPath = path;
    this.entries.clear();
    if (!existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DiskCacheShape>;
      const models = parsed?.models;
      if (!models || typeof models !== "object") return;
      for (const [ref, entry] of Object.entries(models)) {
        if (
          entry &&
          typeof entry === "object" &&
          typeof entry.vision === "boolean" &&
          typeof entry.checkedAt === "number" &&
          (entry.source === "probe" || entry.source === "runtime-error")
        ) {
          this.entries.set(ref, entry);
        }
      }
    } catch {
      // Corrupt or unreadable cache — start clean.
    }
  }

  private persist(): void {
    const path = getProbeCachePath();
    this.loadedPath = path;
    try {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const payload: DiskCacheShape = {
        version: 1,
        models: Object.fromEntries(this.entries.entries()),
      };
      writeFileSync(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
    } catch {
      // Best-effort persistence: never break a turn on disk error.
    }
  }

  /** Clear in-memory mirror so the next read reloads from disk. */
  resetMemory(): void {
    this.loadedPath = null;
    this.entries.clear();
    this.inflight.clear();
  }

  /** Look up a fresh cached capability entry for `provider/id`. Returns
   *  `undefined` when missing, expired, or when `baseUrl` changed. */
  get(
    provider: string | undefined,
    modelId: string | undefined,
    baseUrl?: string,
  ): ProbeCacheEntry | undefined {
    if (!provider || !modelId) return undefined;
    this.ensureLoaded();
    const ref = formatModelRef(provider, modelId);
    const entry = this.entries.get(ref);
    if (!entry) return undefined;
    if (Date.now() - entry.checkedAt > this.ttlMs) return undefined;
    if (baseUrl && entry.baseUrl && entry.baseUrl !== baseUrl) return undefined;
    return entry;
  }

  /** Record a confirmed capability result and persist to disk. */
  record(provider: string, modelId: string, entry: Omit<ProbeCacheEntry, "checkedAt"> & { checkedAt?: number }): ProbeCacheEntry {
    this.ensureLoaded();
    const ref = formatModelRef(provider, modelId);
    const full: ProbeCacheEntry = {
      ...entry,
      checkedAt: entry.checkedAt ?? Date.now(),
    };
    this.entries.set(ref, full);
    this.persist();
    return full;
  }

  /** Remove one cached entry (e.g. before a manual re-probe). */
  delete(provider: string, modelId: string): boolean {
    this.ensureLoaded();
    const ref = formatModelRef(provider, modelId);
    const removed = this.entries.delete(ref);
    if (removed) this.persist();
    return removed;
  }

  /** Remove all cached entries from memory and disk. */
  clear(): void {
    this.ensureLoaded();
    this.entries.clear();
    this.inflight.clear();
    this.persist();
  }

  /** Run a live 2-band PNG vision probe against `model` (deduplicated per
   *  model). Persists confirmed `vision: true` or `vision: false` results;
   *  returns `null` without caching on transient/inconclusive errors. */
  async probe(
    model: Model<Api>,
    modelRegistry: Partial<ModelRegistry> | undefined | null,
    options?: { force?: boolean; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<ProbeCacheEntry | null> {
    if (!model?.provider || !model?.id || !model?.api) return null;
    const providerCfg = modelRegistry?.getProvider?.(model.provider);
    const baseUrl = model.baseUrl || providerCfg?.baseUrl;

    if (!options?.force) {
      const cached = this.get(model.provider, model.id, baseUrl);
      if (cached) return cached;
    }

    if (!modelRegistry?.getApiKeyAndHeaders) return null;

    const inflightKey = `${formatModelRef(model.provider, model.id)}@${baseUrl ?? ""}`;
    const existing = this.inflight.get(inflightKey);
    if (existing) return existing;

    const task = this.executeProbe(model, modelRegistry, baseUrl, options?.signal, options?.timeoutMs ?? this.timeoutMs)
      .finally(() => {
        this.inflight.delete(inflightKey);
      });
    this.inflight.set(inflightKey, task);
    return task;
  }

  private async executeProbe(
    model: Model<Api>,
    modelRegistry: Partial<ModelRegistry>,
    baseUrl: string | undefined,
    parentSignal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<ProbeCacheEntry | null> {
    let auth: Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>;
    try {
      auth = await modelRegistry.getApiKeyAndHeaders!(model);
    } catch {
      return null;
    }
    if (!auth?.ok || !auth.apiKey) return null;
    const headers: Record<string, string> | undefined = auth.headers
      ? Object.fromEntries(
          Object.entries(auth.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        )
      : undefined;

    const [topColor, bottomColor] = pickProbeColorPair(this.random);
    const pngBase64 = makeTwoBandPng(topColor.rgb, bottomColor.rgb).toString("base64");

    const promptText =
      "This image has a TOP half color and a BOTTOM half color. " +
      "Reply ONLY as: TOP=<color>, BOTTOM=<color> " +
      "(use basic English color names: red, green, blue, yellow, purple, orange).";
    const context: Context = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: promptText } satisfies TextContent,
            { type: "image", data: pngBase64, mimeType: "image/png" } satisfies ImageContent,
          ],
          timestamp: Date.now(),
        },
      ],
    };

    // Expose `"image"` on the probe clone so pi-ai adapters actually send the
    // image block instead of stripping it client-side before the endpoint sees it.
    const probeModel: Model<Api> = { ...model, input: ["text", "image"] };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onParentAbort = () => controller.abort();
    if (parentSignal) {
      if (parentSignal.aborted) {
        clearTimeout(timer);
        return null;
      }
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }

    try {
      const response = await this.completeFn(probeModel, modelRegistry, context, {
        apiKey: auth.apiKey,
        headers,
        signal: controller.signal,
        maxTokens: PROBE_MAX_TOKENS,
        reasoning: undefined,
        sessionId: `pi-vision-watcher-probe:${model.provider}:${model.id}`,
      });

      if (response.stopReason === "error") {
        const errText = assistantErrorText(response);
        if (isImageNotSupportedError(errText)) {
          return this.record(model.provider, model.id, {
            vision: false,
            source: "probe",
            baseUrl,
            detail: `rejected image: ${errText.slice(0, 140)}`,
          });
        }
        return null;
      }
      if (response.stopReason === "aborted") return null;

      const text = response.content
        .filter((b): b is TextContent => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();

      if (!text) return null;
      if (isSoftProviderErrorText(text)) return null;

      const verdict = parseProbeColorAnswer(text, topColor, bottomColor);
      if (verdict === "match") {
        return this.record(model.provider, model.id, {
          vision: true,
          source: "probe",
          baseUrl,
          detail: `verified ${topColor.name}/${bottomColor.name}`,
        });
      }
      if (verdict === "mismatch") {
        return this.record(model.provider, model.id, {
          vision: false,
          source: "probe",
          baseUrl,
          detail: `expected ${topColor.name}/${bottomColor.name}, got "${text.slice(0, 80)}"`,
        });
      }
      return null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isImageNotSupportedError(msg)) {
        return this.record(model.provider, model.id, {
          vision: false,
          source: "probe",
          baseUrl,
          detail: `rejected image: ${msg.slice(0, 140)}`,
        });
      }
      return null;
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    }
  }
}
