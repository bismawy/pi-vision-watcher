# 👁️ pi-vision-watcher

**Give text-only [pi](https://github.com/earendil-works/pi-coding-agent) models vision**

Describe images using an authenticated vision model of your choice, then seamlessly hand off the text descriptions to non-vision models.

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![npm](https://img.shields.io/npm/v/@bismawy/pi-vision-watcher)](https://www.npmjs.com/package/@bismawy/pi-vision-watcher)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

---

## The Problem

Some of the best coding models are text-only. When you attach a screenshot, diagram, or UI mock, they either ignore it or fail the request entirely. Switching models just to read an image interrupts your workflow.

## The Solution

`pi-vision-watcher` bridges this gap automatically:
- **Interactive Picker:** Pick any vision model from your authenticated providers with `/vision-watcher`.
- **Automatic Handoff:** Whenever a non-vision model receives an image (via paste, attachment, or the `read` tool), the image is described behind the scenes and swapped for rich descriptive text before reaching the model.
- **Batched & Cached:** Uses a DataLoader pattern so multiple images in a turn coalesce into a **single batched vision request**, cached by SHA-256 hash.

---

## ✨ Features

- 🎯 **Connected-Only Model Picker** — `/vision-watcher` filters out unconfigured providers, showing only models you actually have credentials for (`/login`, `models.json`, or environment variables). Vision-capable models are highlighted with 👁️.
- ⚡ **DataLoader Batching** — Multiple images from parallel `read` calls or multi-image attachments merge into ONE batched vision call during the tool-result phase, eliminating latency bottlenecks.
- 🧠 **Thinking & Reasoning Support** — Configure reasoning effort (`/vision-watcher thinking <level>`) for reasoning-capable vision models (e.g. OpenAI o-series, Claude, DeepSeek).
- 🔄 **Fallback Chains** — Specify backup vision models that automatically take over if your primary describer is unavailable or encounters rate limits.
- 🚀 **Paste-Time Prewarm (Opt-in)** — Describe pasted images the moment the path lands in the prompt editor before you even press Enter.
- 📬 **Async Clipboard Fallback (Opt-in)** — Races direct reads against asynchronous description delivery to prevent stalling.
- 💾 **LRU Hash Caching** — Prevents duplicate calls for identical images across conversation turns.
- 🛡️ **Graceful Degradation** — Never crashes your agent turn. If a description fails, a clean `[Image: description unavailable]` placeholder is provided and logged to `~/.pi/agent/logs/pi-vision-watcher/errors.log`.

---

## 📦 Install

```bash
pi install npm:@bismawy/pi-vision-watcher
```

Alternatively, install directly from GitHub:

```bash
pi install git:github.com/bismawy/pi-vision-watcher
```

Then run `/reload` in Pi (or restart Pi).

---

## 🎮 Usage

### Interactive Commands

| Command | Description |
|---|---|
| `/vision-watcher` | Open the interactive TUI picker to select your vision model |
| `/vision-watcher model <provider/id>` | Set the vision describer model directly |
| `/vision-watcher status` | View active configuration and handoff status |
| `/vision-watcher enable` / `disable` | Toggle extension on or off |
| `/vision-watcher auto on` / `off` | Toggle automatic handoff for all non-vision models |
| `/vision-watcher add <provider/id>` | Force handoff for a specific model (e.g. weak vision models) |
| `/vision-watcher remove <provider/id>` | Remove model from forced handoff list |
| `/vision-watcher thinking <level>` | Set describer thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) |
| `/vision-watcher timeout <ms>` | Set the base per-image description timeout in ms (default 45000) |
| `/vision-watcher prewarm on` / `off` | Enable paste-time prewarming in TUI editor |
| `/vision-watcher fallback on` / `off` | Enable async pasted-path description injection |
| `/vision-watcher clear` | Clear configured vision model |
| `/vision-watcher help` | Display full command reference |

---

## ⚙️ Configuration

Configuration is stored at `~/.pi/agent/extensions/pi-vision-watcher.json`:

```json
{
  "enabled": true,
  "visionModel": "openai/gpt-4o",
  "fallbackModels": [],
  "autoHandoff": true,
  "handoffModels": [],
  "thinking": false,
  "thinkingLevel": "medium",
  "describeTimeoutMs": 45000,
  "prewarmPastedImages": false,
  "asyncClipboardHandoff": false,
  "maxTokens": null,
  "cacheMax": 50,
  "maxDescriptionLines": 0
}
```

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Master switch for vision handoff. |
| `visionModel` | `null` | Primary describer as `provider/id` (`null` = handoff inactive). |
| `fallbackModels` | `[]` | List of fallback `provider/id` models tried in order if primary fails. |
| `autoHandoff` | `true` | Automatically apply handoff to all models lacking native vision. |
| `handoffModels` | `[]` | Additional models forced to receive handoff even if vision-capable. |
| `thinking` / `thinkingLevel` | `false` / `"medium"` | Reasoning effort for vision models that support thinking. |
| `describeTimeoutMs` | `45000` | Base per-image timeout in ms before failing over to fallback models. |
| `prewarmPastedImages` | `false` | Describe images immediately upon pasting into the prompt. |
| `asyncClipboardHandoff` | `false` | Asynchronous injection fallback for pasted image paths. |
| `maxTokens` | `null` | Output token cap for descriptions (`null` = model default). |
| `cacheMax` | `50` | Maximum number of described images cached per session. |
| `maxDescriptionLines` | `0` | Truncate description lines (`0` = unbounded). |

---

## 🔍 Troubleshooting & Logs

- **Error Logs:** Detailed failure traces, timestamps, and config snapshots are recorded in `~/.pi/agent/logs/pi-vision-watcher/errors.log`.
- **Transient Retries:** Failed descriptions are never cached permanently — the next turn automatically re-attempts description generation.

---

## 🛠️ Development

```bash
pnpm install
pnpm test          # Run Vitest unit tests
pnpm typecheck     # Run TypeScript type check
```

---

## 📜 Credits & License

`pi-vision-watcher` is inspired by and forked from [`pi-vision-handoff`](https://github.com/monotykamary/pi-vision-handoff) by [Tom X Nguyen](https://github.com/monotykamary) (originating from the concept in `pi-umans-provider`).

**Key Enhancements:**
- Filters picker to only authenticated/connected models.
- Added thinking & reasoning controls for modern reasoning vision models.
- Multi-model fallback chain support.
- Streamlined settings and UI badging.

Released under the [MIT License](./LICENSE).
