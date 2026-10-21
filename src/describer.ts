/**
 * The vision describer calls a vision-capable model through its registered
 * provider stream, falling back to pi-ai's `completeSimple()` for built-ins.
 *
 * `completeSimple` (not `complete`) is the path that translates the `reasoning`
 * ThinkingLevel into each provider's `reasoningEffort`/budget. `complete()` →
 * `stream()` reads only the pre-translated `reasoningEffort` field and silently
 * drops a bare `reasoning`, so the describer's thinking setting would be a no-op
 * through `complete()` — the bug this swap fixes. The agent loop, SDK, and
 * compaction all route thinking through `completeSimple`/`streamSimple` for the
 * same reason.
 *
 * Two entry points:
 *   - {@link runBatch}: ONE batched call describing N images at once (the
 *     dataloader's dispatch path). The model is asked to emit one delimited
 *     `<<<IMAGE k>>> … <<<END>>>` section per image so the response can be
 *     split back into per-image descriptions.
 *   - {@link describeSingle}: one call for one image (no delimiters). The
 *     robust per-image fallback used when a batched response couldn't be split.
 *
 * Resource lifetimes (fetch interceptor, timeout timer, turn-abort wire) are
 * managed with the `using` keyword via the {@link Disposable} guards in
 * `dispose.ts`, replacing the manual `try`/`finally` cleanup the old code
 * carried. Disposing is lexical and exception-safe: a thrown `completeSimple()`
 * still tears down the timer, uninstalls the interceptor, and detaches the
 * abort listener.
 */

import type {
  Api,
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingLevel,
} from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  batchUserPrompt,
  DEFAULT_USER_PROMPT_PREFIX,
  DEFAULT_VISION_PROMPT,
  describeTimeoutMs,
  formatModelRef,
  markDescriptionTruncated,
  parseBatchedDescriptions,
  type ExtractedImage,
  type VisionHandoffConfig,
} from "./index.js";
import { appendVisionError } from "./error-log.js";
import {
  buildUsageRecord,
  describeAls,
  EMPTY_ENERGY_CAPTURE,
  type DescribeContext,
  type VisionHandoffEnergyCapture,
  type VisionHandoffUsageRecord,
} from "./usage.js";
import { imageHash } from "./image.js";
import { abortWireGuard, fetchInterceptorGuard, timeoutGuard, type AbortWire } from "./dispose.js";

/** Tokens reserved for the describer's input so the requested output budget
 *  can't exceed the model's context window. The describer's input is bounded —
 *  one (or a few) image(s) plus a short prompt — so a fixed reserve keeps the
 *  math simple while leaving generous room for the image + prompt tokens.
 *  Providers reject a request when `inputTokens + maxTokens > contextWindow`
 *  (e.g. a model whose declared maxTokens equals its full context window), so
 *  this clamp prevents that 400 without meaningfully limiting a high-output
 *  model (e.g. 262144 context − 8192 reserve = 253952 output budget). */
const INPUT_RESERVE_TOKENS = 8192;

/** Resolve the `maxTokens` to pass to `completeSimple()` for a describer call.
 *
 *  - A configured `cfg.maxTokens` wins (explicit cost/latency cap), clamped to
 *    fit the context window.
 *  - Otherwise use the vision model's declared max output (`model.maxTokens`),
 *    clamped so `maxTokens + INPUT_RESERVE_TOKENS <= contextWindow` — i.e. the
 *    requested output can't exceed the context window minus a reserve for the
 *    input. This is the real fix for models whose declared `maxTokens` equals
 *    their full `contextWindow` (which providers reject with any non-empty
 *    input): we cap at `contextWindow − reserve` instead.
 *  - If the model declares no usable max (`maxTokens <= 0`) and no cap is
 *    configured, return `undefined` so the provider applies its own default. */
export function resolveMaxTokens(
  cfg: VisionHandoffConfig,
  visionModel: Model<Api>,
): number | undefined {
  const ctx = visionModel.contextWindow > 0 ? visionModel.contextWindow : Number.POSITIVE_INFINITY;
  const cap = ctx - INPUT_RESERVE_TOKENS;
  const requested = cfg.maxTokens ?? (visionModel.maxTokens > 0 ? visionModel.maxTokens : undefined);
  if (requested === undefined) return undefined;
  // Clamp to the context-window-derived ceiling; never below 1.
  return Math.max(1, Math.min(requested, cap));
}

/** Resolve the `reasoning` (thinking) level to pass to `completeSimple()`, or
 *  `undefined` to leave thinking off.
 *
 *  - Returns `undefined` when thinking is disabled in config.
 *  - Returns `undefined` when the vision model doesn't declare reasoning
 *    support (`model.reasoning === false`) — sending a `reasoning` level to a
 *    non-reasoning model would be ignored at best and rejected at worst.
 *  - Otherwise returns the configured {@link VisionHandoffConfig.thinkingLevel}.
 *
 *  Mirrors pi core's `createSummarizationOptions` guard so the describer's
 *  thinking behaviour matches the rest of pi. */
export function resolveReasoning(
  cfg: VisionHandoffConfig,
  visionModel: Model<Api>,
): ThinkingLevel | undefined {
  if (!cfg.thinking) return undefined;
  if (!visionModel.reasoning) return undefined;
  return cfg.thinkingLevel;
}

/** Small config snapshot embedded in every error-log entry — the fields most
 *  relevant to troubleshooting a describer failure (a bad maxTokens clamp, a
 *  reasoning level the model rejects, etc.). */
function configSnapshot(cfg: VisionHandoffConfig): {
  maxTokens?: number;
  thinking: boolean;
  thinkingLevel: string;
} {
  return { maxTokens: cfg.maxTokens, thinking: cfg.thinking, thinkingLevel: cfg.thinkingLevel };
}

/** Complete through the provider registered in Pi's model registry when one
 * supplies a custom stream. The post-0.80 ModelRuntime keeps extension streams
 * out of pi-ai's deprecated global compatibility registry, so calling
 * completeSimple() directly cannot resolve custom API ids such as `makora`.
 * The optional access preserves compatibility with older ModelRegistry versions,
 * which registered custom streams globally and do not expose the config getter. */
const NEURALWATT_CONVERSATION_HEADER = "x-nw-conversation-id";

function isolateVisionRequest(
  model: Model<Api>,
  options: SimpleStreamOptions,
): SimpleStreamOptions {
  // Stable per-model identity (not randomUUID): every describer call shares the
  // same system prompt (DEFAULT_VISION_PROMPT), so a stable session id lets the
  // provider's prompt cache reuse that prefix across calls (cacheRead/cacheWrite
  // > 0) instead of re-billing it every turn. Still distinct from the main
  // agent's conversation id (the inherited header we replace), so unrelated
  // image prompts never become the main agent's newest cache lineage. A
  // per-model id keeps different vision models (fallback chains) on separate
  // lineages.
  const sessionId = `pi-vision-watcher:${model.provider}:${model.id}`;
  const headers = { ...(options.headers ?? {}) };
  const inheritedConversationHeader = Object.keys(headers).find(
    (name) => name.toLowerCase() === NEURALWATT_CONVERSATION_HEADER,
  );

  if (inheritedConversationHeader) {
    headers[inheritedConversationHeader] = sessionId;
  } else if (model.provider.toLowerCase() === "neuralwatt") {
    headers["X-NW-Conversation-ID"] = sessionId;
  }

  return {
    ...options,
    sessionId,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

export async function completeVisionModel(
  model: Model<Api>,
  modelRegistry: ModelRegistry,
  context: Context,
  options: SimpleStreamOptions,
): Promise<AssistantMessage> {
  const isolatedOptions = isolateVisionRequest(model, options);
  const provider = modelRegistry.getRegisteredProviderConfig?.(model.provider);
  if (provider?.streamSimple && provider.api === model.api) {
    return provider.streamSimple(model, context, isolatedOptions).result();
  }
  return completeSimple(model, context, isolatedOptions);
}

/** Dependencies the describer can't own itself (held by the engine). */
export interface DescriberDeps {
  /** Report a usage+energy record for one real describer call (cache hits emit none). */
  reportUsage(record: VisionHandoffUsageRecord): void;
  /** Set the most-recent describer failure message (surfaced to the user by the engine).
   *  Pass `null` to clear before a fresh attempt. */
  setLastError(msg: string | null): void;
  /** Record the model ref ACTUALLY attempted for the latest describer call.
   *  Differs from `config.visionModel` when a failover fallback ran — the
   *  warning must name the model that failed, not the configured primary.
   *  Optional so older callers/tests compile unchanged. */
  setAttemptedModel?(ref: string): void;
}

/** The result of a batched describer call: per-image raw descriptions keyed by hash. */
export type BatchResult = Map<string, string>;

/** Describe N images with ONE batched `completeSimple()` call and split the response
 *  back into per-image descriptions. Returns a map keyed by image hash; an
 *  image whose section failed to parse is omitted (the caller treats omission
 *  as "description unavailable"). On a genuine call failure (auth, abort,
 *  empty) the map is empty and `deps.setLastError` records the reason.
 *
 *  A failed delimiter-parse is a failed BATCH, not a failed description: the
 *  unparsed images fall back to parallel single-image calls (no delimiters to
 *  cooperate with), so the common cooperative case stays one call while an
 *  uncooperative model still gets every image described. */
export async function runBatch(
  misses: { img: ExtractedImage; hash: string }[],
  userPrompt: string,
  visionModel: Model<Api>,
  modelRegistry: ModelRegistry,
  cfg: VisionHandoffConfig,
  deps: DescriberDeps,
  turnSignal?: AbortSignal,
): Promise<BatchResult> {
  const out: BatchResult = new Map();
  // Parse and fallback run inside callVision's try so a throw there is logged as
  // a batch failure and the partially filled map is still returned.
  await callVision(
    misses.map((m) => m.img),
    misses.map((m) => m.hash),
    "batch",
    userPrompt,
    visionModel,
    modelRegistry,
    cfg,
    deps,
    (text, truncated) => fillBatch(out, text, truncated, misses, userPrompt, visionModel, modelRegistry, cfg, deps, turnSignal),
    turnSignal,
  );
  return out;
}

async function fillBatch(
  out: BatchResult,
  text: string,
  truncated: boolean,
  misses: { img: ExtractedImage; hash: string }[],
  userPrompt: string,
  visionModel: Model<Api>,
  modelRegistry: ModelRegistry,
  cfg: VisionHandoffConfig,
  deps: DescriberDeps,
  turnSignal?: AbortSignal,
): Promise<void> {
  const parsed = parseBatchedDescriptions(text, misses.length);
  for (let i = 0; i < misses.length; i++) {
    const d = parsed[i];
    if (d) out.set(misses[i].hash, d);
  }
  // stopReason length = the batch response was cut off mid-stream. Only the
  // highest-index parsed section can be partial (earlier ones ended with their
  // END marker), so mark that one. It is NOT re-described: a single call for
  // the same complex image would likely hit the same limit.
  if (truncated) {
    for (let i = misses.length - 1; i >= 0; i--) {
      const h = misses[i].hash;
      const d = out.get(h);
      if (d) {
        out.set(h, markDescriptionTruncated(d));
        break;
      }
    }
  }
  // A failed delimiter-parse is a failed batching, not a failed description:
  // describe each unparsed image with its own single-image call, in parallel.
  const unparsed = misses.filter((m) => !out.has(m.hash));
  if (unparsed.length > 0) {
    const fallbacks = await Promise.all(
      unparsed.map((m) => describeSingle(m.img, userPrompt, visionModel, modelRegistry, cfg, deps, turnSignal)),
    );
    for (let i = 0; i < unparsed.length; i++) {
      const d = fallbacks[i];
      if (d) out.set(unparsed[i].hash, d);
    }
  }
}

// Describe a single image with one completeSimple() call and return the RAW
// description (no envelope). Returns null on any genuine failure (auth,
// abort/error, empty) so the caller only caches UNAVAILABLE when a real
// describer attempt failed.
export async function describeSingle(
  img: ExtractedImage,
  userPrompt: string,
  visionModel: Model<Api>,
  modelRegistry: ModelRegistry,
  cfg: VisionHandoffConfig,
  deps: DescriberDeps,
  turnSignal?: AbortSignal,
): Promise<string | null> {
  // stopReason length = token limit hit before the model finished. The partial
  // text is still useful but must not pass as complete.
  return callVision(
    [img],
    [imageHash(img.mimeType, img.data)],
    "single",
    userPrompt,
    visionModel,
    modelRegistry,
    cfg,
    deps,
    (text, truncated) => (truncated ? markDescriptionTruncated(text) : text),
    turnSignal,
  );
}

// One vision-model call shared by runBatch and describeSingle: auth, abort and
// timeout guards, usage reporting, and failure logging. Returns null on any
// genuine failure (auth, abort/error, empty, throw) after deps.setLastError
// records the reason; a user cancel stays silent.
async function callVision<T>(
  images: ExtractedImage[],
  hashes: string[],
  phase: "batch" | "single",
  userPrompt: string,
  visionModel: Model<Api>,
  modelRegistry: ModelRegistry,
  cfg: VisionHandoffConfig,
  deps: DescriberDeps,
  finish: (text: string, truncated: boolean) => T | Promise<T>,
  turnSignal?: AbortSignal,
): Promise<T | null> {
  const attemptedModel = formatModelRef(visionModel.provider, visionModel.id);
  deps.setAttemptedModel?.(attemptedModel);
  const n = images.length;
  const base = { phase, visionModel: cfg.visionModel, attemptedModel, imageHashes: hashes, imageCount: n };
  const auth = await modelRegistry.getApiKeyAndHeaders(visionModel);
  if (!auth.ok || !auth.apiKey) {
    const reason = !auth.ok ? auth.error : 'No API key for vision model "' + attemptedModel + '"';
    deps.setLastError(reason);
    appendVisionError({ ...base, reason, config: configSnapshot(cfg) });
    return null;
  }

  const prefix = cfg.userPromptPrefix ?? DEFAULT_USER_PROMPT_PREFIX;
  const systemPrompt = cfg.prompt ?? DEFAULT_VISION_PROMPT;
  const content: (TextContent | ImageContent)[] = [
    { type: "text", text: batchUserPrompt(n, userPrompt, prefix) },
    ...images.map((img) => ({ type: "image", data: img.data, mimeType: img.mimeType } satisfies ImageContent)),
  ];
  const userMessage: Message = { role: "user", content, timestamp: Date.now() };
  const timeoutMs = describeTimeoutMs(n, cfg.describeTimeoutMs);
  const maxTokens = resolveMaxTokens(cfg, visionModel);
  const reasoning = resolveReasoning(cfg, visionModel);
  const controller = new AbortController();
  let timedOut = false;
  using fetchGuard = fetchInterceptorGuard();
  using timer = timeoutGuard(timeoutMs, () => {
    timedOut = true;
    controller.abort();
  });
  using abortWire = abortWireGuard(turnSignal, controller);

  const describeCtx: DescribeContext = { energyReader: undefined };
  try {
    const response = await describeAls.run(describeCtx, async () =>
      completeVisionModel(
        visionModel,
        modelRegistry,
        { systemPrompt, messages: [userMessage] },
        { apiKey: auth.apiKey, headers: auth.headers, signal: controller.signal, maxTokens, reasoning },
      ),
    );
    const capture = await readCapture(describeCtx);
    const record = buildUsageRecord(response, capture, visionModel, hashes[0], n > 1 ? hashes : undefined);
    if (record) deps.reportUsage(record);
    if (response.stopReason === "aborted" || response.stopReason === "error") {
      const reason = setStopReasonError(deps, response.stopReason, response.errorMessage, abortWire, timedOut, timeoutMs);
      if (reason) {
        appendVisionError({
          ...base,
          reason,
          stopReason: response.stopReason,
          timedOut,
          timeoutMs,
          errorMessage: response.errorMessage,
          config: configSnapshot(cfg),
        });
      }
      return null;
    }
    const text = response.content
      .filter((c): c is TextContent => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
    if (!text) {
      const reason = "vision model returned an empty description";
      deps.setLastError(reason);
      appendVisionError({ ...base, reason, config: configSnapshot(cfg) });
      return null;
    }
    return await finish(text, response.stopReason === "length");
  } catch (err) {
    const userAborted = abortWire.userAborted();
    const reason = timedOut
      ? "describer timed out after " + timeoutMs / 1000 + "s"
      : err instanceof Error
        ? err.message
        : String(err);
    deps.setLastError(reason);
    // A deliberate user cancel is not worth logging (no-warn-on-user-abort contract).
    if (!userAborted) {
      appendVisionError({
        ...base,
        reason,
        timedOut,
        timeoutMs,
        errorStack: err instanceof Error ? err.stack : undefined,
        config: configSnapshot(cfg),
      });
    }
    return null;
  } finally {
    // The using guards release the fetch interceptor, timer, and abort wire.
    // Only the energy tee needs an explicit swallow: it rejects when the main
    // stream aborts.
    describeCtx.energyReader?.catch(() => {});
  }
}

/** Read the energy tee for a describer call, if one was captured. Returns the
 *  empty capture when there is no reader (non-Neuralwatt models) or the tee
 *  aborted with the main stream. */
async function readCapture(describeCtx: DescribeContext): Promise<VisionHandoffEnergyCapture> {
  if (!describeCtx.energyReader) return EMPTY_ENERGY_CAPTURE;
  try {
    return await describeCtx.energyReader;
  } catch {
    return EMPTY_ENERGY_CAPTURE;
  }
}

/** Translate a non-OK stopReason into a user-facing failure message, unless the
 *  abort came from the user cancelling the turn (then stay silent — no warning
 *  for a deliberate cancel). Returns the message that was set (so the caller
 *  can log it), or null when the abort was a user cancel / nothing was set. */
function setStopReasonError(
  deps: DescriberDeps,
  stopReason: string,
  errorMessage: string | undefined,
  abortWire: AbortWire,
  timedOut: boolean,
  timeoutMs: number,
): string | null {
  if (abortWire.userAborted()) return null; // user cancelled the turn — no warning
  if (timedOut) {
    const reason = `describer timed out after ${timeoutMs / 1000}s`;
    deps.setLastError(reason);
    return reason;
  }
  const reason = `vision model returned stopReason "${stopReason}"${errorMessage ? ": " + errorMessage : ""}`;
  deps.setLastError(reason);
  return reason;
}
