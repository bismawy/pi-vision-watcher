<div align="center">

# pi-vision-watcher

Give text-only [pi](https://github.com/earendil-works/pi-coding-agent) models vision — images are described by a vision model you pick, then handed off to text-only coding models without interrupting your workflow.

[pi package](https://pi.dev/packages/@bismawy/pi-vision-watcher) · [npm](https://www.npmjs.com/package/@bismawy/pi-vision-watcher) · [Issues](https://github.com/bismawy/pi-vision-watcher/issues)

![npm](https://img.shields.io/npm/v/@bismawy/pi-vision-watcher)
![license](https://img.shields.io/badge/license-MIT-green)

</div>

<img src="assets/screenshot.webp" alt="pi-vision-watcher" width="100%">

## What it does

Paste an image, attach a file, or have the agent `read` one — pi-vision-watcher describes it in the background with your chosen vision model and feeds the description to whatever text-only model you're using (DeepSeek, local models, etc.).

- **Connected-only picker:** `/vision-watcher` shows only vision-capable models from providers where you actually have credentials.
- **Batching & cache:** multiple images across parallel tool calls are batched into one describer request; cached images (SHA-256) are never re-described.
- **False-vision healing:** aggregator providers sometimes flag text-only models as multimodal, causing HTTP 400s. The extension proactively forces handoff for them and auto-heals `models.json` in-process.
- **Thinking controls:** adjust reasoning effort (`off` – `max`) for reasoning-capable vision models.
- **Fallback chains:** automatically falls back to backup vision models when the primary is rate-limited or down.

## Install

```bash
pi install npm:@bismawy/pi-vision-watcher
```

Then run `/vision-watcher` to pick your vision model (or set it directly: `/vision-watcher model openai/gpt-4o`). Handoff is on by default — just switch to any text-only model and work as usual.

## Commands

| Command | Action |
| :--- | :--- |
| `/vision-watcher` | Interactive picker for connected vision models |
| `/vision-watcher model <provider/id>` | Set primary vision describer directly |
| `/vision-watcher status` | View current configuration |
| `/vision-watcher auto <on\|off>` | Toggle automatic handoff (default: `on`) |
| `/vision-watcher add <provider/id>` | Force handoff on a specific model |
| `/vision-watcher remove <provider/id>` | Remove model from forced handoff list |
| `/vision-watcher thinking <level>` | Configure reasoning effort |
| `/vision-watcher timeout <ms>` | Set the base per-image description timeout (default `45000`) |
| `/vision-watcher prewarm <on\|off>` | Describe pasted images at paste-time (opt-in) |
| `/vision-watcher async <on\|off>` | Inject pasted-image descriptions asynchronously when no matching `read` wins (alias: `fallback`) |
| `/vision-watcher clear` | Clear the configured vision model |
| `/vision-watcher enable` / `disable` | Toggle extension active state |
| `/vision-watcher help` | List all subcommands |

`async` is the async *clipboard* fallback and has nothing to do with the
`fallbackModels` failover chain.

In the picker:

| Key | Action |
|---|---|
| `space` | Select the highlighted model as the primary describer (press again to clear) |
| `ctrl+q` | Toggle the highlighted model in/out of the failover chain (marked 🔁, max 3). Not a mnemonic, and that's on purpose: `ctrl+f` is pi's find-text (bound since pi 0.85), `alt+f` is editor word-right, and `ctrl+alt+f` never survives Windows conhost/Windows Terminal. pi 0.85 also binds `ctrl+q` to `app.message.followUp`, which is inert while a picker is open — if it ever double-fires, `f2` is the free fallback (unbound in 0.84 and 0.85) |
| `ctrl+t` | Walk the thinking ladder: off → minimal → low → medium → high → xhigh → max → off → … |
| `ctrl+a` | Toggle async paste handoff |
| `enter` / `ctrl+s` | Save (primary **and** chain together) |
| `esc` | Cancel |

The detail pane always shows the current configuration — primary, chain,
thinking, async handoff — so every keypress shows exactly what will be saved.
`space` is left to the search box while a filter query is present, so multi-word
searches like `gemini 3.8` stay typeable.

## How it works

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

`fallbackModels` is the failover chain: when the primary describer fails (timeout,
rate limit, auth), each entry is tried **in order** — fallback 1 fails, fallback 2
runs, and so on until one returns a description. The picker caps the chain at 3
entries (`ctrl+q`). Set it from the picker instead of hand-editing the file.

</details>

<details>
<summary><b>Diagnostics & recovery</b></summary>

- Failed vision calls log with stack traces to `~/.pi/agent/logs/pi-vision-watcher/errors.log` and degrade gracefully to `[Image: description unavailable]`.
- When a model falsely advertises image capability and 400s, the error is captured on `message_end`, `modelOverrides.<model>.input = ["text"]` is written to `models.json`, and the registry refreshes in-process.

</details>

<details>
<summary><b>Development</b></summary>

```bash
bun install
bun run test          # Vitest suite (240+ unit tests)
bun run typecheck
bun run lint:dead
```

</details>

## License

Distributed under the **MIT** license.

## Developer

Developed and maintained by [Bisma](https://github.com/bismawy).
