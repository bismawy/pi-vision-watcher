# 👀 pi-vision-watcher

**Give text-only [pi](https://github.com/earendil-works/pi-coding-agent) models vision**

Pick a vision model among your already-connected models; images pasted into pi are described by it and handed to non-vision models as text.

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![npm](https://img.shields.io/npm/v/pi-vision-watcher)](https://www.npmjs.com/package/pi-vision-watcher)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

## What it does

Text-only models ignore or reject images. This extension gives them sight:

- You pick one **describer** (a vision-capable model) via `/vision-handoff`.
- Every image your model receives — pasted, attached, or read via the `read` tool — is described by that describer, and the description text is swapped in before the request reaches the provider.
- **Automatic:** handoff applies to every model that lacks native vision (`/vision-handoff auto off` to stop).
- **Cheap:** images in one turn share **one batched vision call** and are cached per image hash.

The picker lists only **connected models** — those you've authenticated via `/login`, `/better-custom`, or a `models.json` `apiKey` — so the describer you pick is always one you can actually call. 👀 marks vision-capable models.

## Install

```bash
pi install npm:pi-vision-watcher
```

Or from GitHub / npm:

```bash
pi install https://github.com/bismawy/pi-vision-watcher
npm install pi-vision-watcher
```

Then `/reload` or restart pi.

## Usage

| Command | Effect |
|---|---|
| `/vision-handoff` | Open the interactive picker and choose the vision model |
| `/vision-handoff model <provider/id>` | Set the vision model directly |
| `/vision-handoff status` | Show config + whether handoff is active for the current model |
| `/vision-handoff enable` / `disable` | Master switch (keeps your chosen model) |
| `/vision-handoff auto on\|off` | Apply handoff to all non-vision models |
| `/vision-handoff add\|remove <provider/id>` | Force handoff for specific models (e.g. weak vision) |
| `/vision-handoff thinking <off\|minimal\|low\|medium\|high\|xhigh\|max>` | Describer reasoning effort |
| `/vision-handoff prewarm on\|off` | Describe pasted images at paste-time (opt-in, TUI) |
| `/vision-handoff fallback on\|off` | Async injection of pasted-path descriptions |
| `/vision-handoff clear` | Clear the vision model (handoff inactive) |
| `/vision-handoff help` | Full command reference |

## Config

Created automatically at `~/.pi/agent/extensions/pi-vision-handoff.json`:

```json
{
  "enabled": true,
  "visionModel": "openai/gpt-4o",
  "fallbackModels": [],
  "autoHandoff": true,
  "handoffModels": [],
  "thinking": false,
  "thinkingLevel": "medium",
  "cacheMax": 50,
  "maxDescriptionLines": 0
}
```

| Field | Default | Effect |
|---|---|---|
| `visionModel` | `null` | Describer as `provider/id` (`null` = handoff inactive) |
| `fallbackModels` | `[]` | Fallback describers tried in order when the primary fails |
| `autoHandoff` | `true` | Apply handoff to every non-vision model |
| `handoffModels` | `[]` | Extra `provider/id` refs that also receive handoff |
| `thinking` / `thinkingLevel` | `false` / `medium` | Reasoning for the describer (only if the model supports it) |
| `prewarmPastedImages` | `false` | Describe pasted images before you press enter (TUI only) |
| `asyncClipboardHandoff` | `false` | Async pasted-path description fallback |
| `maxTokens` | unset | Cap description output (unset = model's max) |
| `cacheMax` | `50` | Max described images kept in cache per session |
| `maxDescriptionLines` | `0` | Cap description lines (0 = unbounded) |

## Troubleshooting

- A failing describer surfaces as `pi-vision-handoff: image description failed — <reason>`; full detail (with stack/`stopReason`) is in `~/.pi/agent/logs/pi-vision-handoff/errors.log`.
- A failed image degrades to `[Image: description unavailable]` for that turn and is retried next turn — failures are never cached.

## Development

```bash
pnpm install
pnpm test          # Vitest unit tests
pnpm typecheck     # tsc --noEmit
```

## Credits & License

`pi-vision-watcher` is a fork of [pi-vision-handoff](https://github.com/monotykamary/pi-vision-handoff) by [Tom X Nguyen](https://github.com/monotykamary), MIT (see [`LICENSE`](./LICENSE)). Fork changes: the picker lists only connected (authenticated) models, the package is renamed, and the vision-capable badge is 👀. The vision-handoff concept originated in [pi-umans-provider](https://github.com/monotykamary/pi-umans-provider).

MIT.
