# Vision Watcher

Intelligent vision watcher. Connected models. Zero workflow interruption.

[![Custom badge](https://shieldcn.dev/badge/pi-%20Packages.svg?variant=outline&size=xs&logo=ri%3APiPiBold)](https://pi.dev/packages/@bismawy/pi-vision-watcher)
[![badge](https://shieldcn.dev/npm/@bismawy/pi-vision-watcher.svg?variant=outline&size=xs)](https://www.npmjs.com/package/@bismawy/pi-vision-watcher)
[![license](https://shieldcn.dev/github/bismawy/pi-vision-watcher/license.svg?variant=outline&size=xs)](https://github.com/bismawy/pi-vision-watcher)

<img src="https://raw.githubusercontent.com/bismawy/pi-vision-watcher/main/assets/banner.webp" alt="Vision Watcher: intelligent vision watcher for text-only coding models in Pi" width="100%">

## Overview

pi-vision-watcher gives text-only pi models vision — images are described in the background by a vision model you pick, watching over text-only coding models without interrupting your workflow.

- Connected-only Picker: `/vision-watcher` shows only vision-capable models from providers where you actually have credentials.
- Batching & Cache: Multiple images across parallel tool calls are batched into one describer request; cached images (SHA-256) are never re-described.
- False-Vision Healing: Aggregator providers sometimes flag text-only models as multimodal, causing HTTP 400s. The extension proactively forces handoff for them and auto-heals `models.json` in-process.
- Thinking Controls: Adjust reasoning effort (`off` – `max`) for reasoning-capable vision models.
- Fallback Chains: Automatically falls back to backup vision models when the primary is rate-limited or down.

## Install

```bash
pi install npm:@bismawy/pi-vision-watcher
```

Run `/vision-watcher` to pick your vision model (or set it directly: `/vision-watcher model openai/gpt-4o`). Handoff is on by default — switch to any text-only model and work as usual.

To test locally without installing:
```bash
pi --extension ./vision-watcher.ts
```

## Shortcuts

| Key | Action |
| --- | --- |
| `space` | Select highlighted model as primary describer (press again to clear) |
| `ctrl+q` · `f2` | Toggle highlighted model in/out of failover chain (marked 🔗, max 3) |
| `ctrl+t` | Walk thinking ladder (`off` → `minimal` → `low` → `medium` → `high` → `xhigh` → `max`) |
| `ctrl+a` | Toggle async paste handoff |
| `enter` · `ctrl+s` | Save configuration (primary describer and chain) |
| `esc` | Cancel and exit picker |

> **Notes:**
> - `ctrl+q` toggles backup models safely; `f2` is also available as a fallback key.
> - While filtering models in search, `space` enters a space character so multi-word queries (e.g. `gemini 3.8`) stay typeable.
> - The detail pane shows live configuration — primary, chain, thinking, and async handoff — so every keypress previews what will be saved.

## Commands

| Command | Action |
| --- | --- |
| `/vision-watcher` | Interactive picker for connected vision models |
| `/vision-watcher model <provider/id>` | Set primary vision describer directly |
| `/vision-watcher status` | View current configuration |
| `/vision-watcher auto <on\|off>` | Toggle automatic handoff (default: `on`) |
| `/vision-watcher add <provider/id>` | Force handoff on a specific model |
| `/vision-watcher remove <provider/id>` | Remove model from forced handoff list |
| `/vision-watcher thinking <level>` | Configure reasoning effort (`off` – `max`) |
| `/vision-watcher timeout <ms>` | Set per-image description timeout (default `45000`) |
| `/vision-watcher prewarm <on\|off>` | Describe pasted images at paste-time (opt-in) |
| `/vision-watcher async <on\|off>` | Inject pasted-image descriptions asynchronously when no matching `read` wins |
| `/vision-watcher clear` | Clear configured vision model |
| `/vision-watcher enable` · `disable` | Toggle extension active state |
| `/vision-watcher help` | List all subcommands |

## Architecture

<details>
<summary><b>Configuration</b> (<code>~/.pi/agent/extensions/pi-vision-watcher.json</code>)</summary>

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

Most fields have sane defaults — `visionModel` is the only one you normally set.

`fallbackModels` is the failover chain: when the primary describer fails (timeout, rate limit, auth), each entry is tried **in order** until one returns a description. The picker caps the chain at 3 entries (`ctrl+q`). Set it from the picker instead of hand-editing the file.

</details>

<details>
<summary><b>Diagnostics & Recovery</b></summary>

- Failed vision calls log with stack traces to `~/.pi/agent/logs/pi-vision-watcher/errors.log` and degrade gracefully to `[Image: description unavailable]`.
- When a model falsely advertises image capability and 400s, the error is captured on `message_end`, `modelOverrides.<model>.input = ["text"]` is written to `models.json`, and the registry refreshes in-process.

</details>

<details>
<summary><b>Components</b></summary>

| File | Role |
| --- | --- |
| `vision-watcher.ts` | Extension entry point, lifecycle hooks, and CLI command handlers |
| `src/vision-model-selector.ts` | Interactive TUI model picker with connected-only filtering |
| `src/describer.ts` | Vision API request orchestration, multi-image batching, and failover chains |
| `src/dataloader.ts` | Batched image loader to prevent redundant parallel requests |
| `src/image.ts` | Image hashing (SHA-256), memory caching, and MIME detection |
| `src/prewarm-editor.ts` | Paste-time image prewarming and async clipboard injection |
| `src/error-log.ts` | Structured logging and error capture |

</details>

<details>
<summary><b>Development</b></summary>

```bash
npm test          # Vitest suite (250+ unit tests)
npm run typecheck # TypeScript checks
npm run lint:dead # Knip dead code analysis
```

</details>

## License

Distributed under the **MIT** license.

## Author

[Bisma](https://github.com/bismawy)
