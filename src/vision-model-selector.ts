/**
 * VisionModelSelectorComponent — an interactive TUI for choosing which model
 * describes images during vision handoff.
 *
 * Uses the same patterns as pi's built-in selectors and pi-hide-providers:
 * - Lists connected (authenticated) models, vision-capable ones first (✦ badge)
 * - A leading "None" row clears the configured vision model
 * - Space selects the highlighted model as the primary describer (toggle)
 * - Ctrl+Enter toggles the highlighted model in/out of the failover chain (max 3)
 * - Ctrl+Shift+R clears the failover chain, Ctrl+Shift+T walks the thinking ladder,
 *   Alt+A / Ctrl+Alt+A toggles async paste handoff, Alt+↑↓ reorders rows
 * - Enter or Ctrl+S saves, Esc / Ctrl+C cancels
 * - The primary is marked ✓, chain members ⇆
 */

import {
  Container,
  type Component,
  fuzzyFilter,
  getKeybindings,
  Input,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { DynamicBorder, keyText } from "@earendil-works/pi-coding-agent";
import { formatModelRef, isVisionModel, THINKING_LEVELS } from "./index.js";

/** Failover chain length cap — three is already far past the point where a
 *  fourth describer would ever be reached. */
export const MAX_FALLBACKS = 3;

/** Key that toggles failover-chain membership.
 *
 *  `ctrl+enter` is the one chord that survives Windows conhost/Windows Terminal,
 *  Linux/X11, macOS, tmux and SSH alike. The previous binding was `ctrl+q`, which
 *  collides with POSIX tty flow control (IXON: ctrl+s freezes / ctrl+q resumes
 *  output before the app sees it), with pi's own `app.message.followUp`, and —
 *  for the reset chord — with VTE's window-level "close terminal" accelerator.
 *
 *  Reset uses `ctrl+shift+r` because R reads as Reset. It is unbound in every
 *  default terminal (VTE, Konsole, Windows Terminal, iTerm2 — kitty is the lone
 *  exception, where it resizes a window) and unbound anywhere in pi. On legacy
 *  7-bit terminals it degrades to plain `ctrl+r`, which the app does not use, so
 *  the worst case is a no-op rather than a wrong action. The old `ctrl+shift+q`
 *  was impossible to type on those terminals: both it and `ctrl+q` emit 0x11. */
const FALLBACK_KEY = Key.ctrl("enter");
const FALLBACK_KEY_HINT = "ctrl+enter";
const REORDER_UP_KEY = Key.alt("up");
const REORDER_DOWN_KEY = Key.alt("down");
/** Hint printed next to the async toggle in the detail pane (and the legend).
 *  `ctrl+alt+a` is the Linux-safe half: AltGr occupies alt+a on intl layouts
 *  (`@`, `ł`), so the selector accepts both chords. */
const ASYNC_KEY_HINT = "[Ctrl+alt+a]";

/** Provider ids that don't title-case cleanly. Everything else falls back to
 *  word-capitalisation (`custom-openrouter-ai` → "Custom Openrouter AI"). */
const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  "openai-codex": "OpenAI Codex",
  anthropic: "Anthropic",
  xai: "xAI",
  github: "GitHub",
  huggingface: "Hugging Face",
  vertex: "Vertex AI",
};

const ACRONYMS = new Set(["ai", "api", "gpt", "llm", "mcp", "cli", "glm"]);

/** Human-readable provider name for the detail pane. */
export function providerLabel(provider: string): string {
  const known = PROVIDER_LABELS[provider];
  if (known) return known;
  return provider
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) =>
      ACRONYMS.has(word.toLowerCase())
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

interface DisplayItem {
  /** "provider/id", or null for the synthetic "None" row. */
  ref: string | null;
  provider: string;
  modelId: string;
  modelName: string;
  vision: boolean;
  /** Whether the model declares reasoning (thinking) support. */
  reasoning: boolean;
  none?: boolean;
}

export interface VisionModelSelectorResult {
  /** The selected "provider/id", or null if the user picked "None" / cancelled. */
  ref: string | null;
  /** True if the user cancelled (esc) — config should not change. */
  cancelled: boolean;
  /** Thinking on/off chosen in the picker. */
  thinking: boolean;
  /** Thinking effort chosen in the picker. */
  thinkingLevel: ThinkingLevel;
  /** Whether pasted paths should be injected if no matching read wins. */
  asyncClipboardHandoff: boolean;
  /** The failover chain, in list order. Enter/ctrl+s saves it together with
   *  the primary selection — the picker edits both in one screen. */
  fallbackModels: string[];
}

export class VisionModelSelectorComponent implements Component {
  private theme: Theme;
  private done: (result: VisionModelSelectorResult) => void;

  private allItems: DisplayItem[];
  private filteredItems: DisplayItem[];
  private selectedIndex = 0;
  private readonly maxVisible = 10;
  private searchInput: Input;
  private listContainer: Container;
  private footerText: Text;

  private currentRef: string | null;
  private thinking: boolean;
  private thinkingLevel: ThinkingLevel;
  private asyncClipboardHandoff: boolean;
  /** Fallback-chain membership, toggled in-place with {@link FALLBACK_KEY}. */
  private fallbacks: Set<string>;
  /** Transient hint (e.g. chain cap hit), rendered in the detail pane. */
  private notice: string | null = null;

  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor(
    theme: Theme,
    allModels: Array<{
      provider: string;
      id: string;
      name: string;
      input?: ("text" | "image")[];
      reasoning?: boolean;
    }>,
    currentRef: string | null,
    currentThinking: boolean,
    currentThinkingLevel: ThinkingLevel,
    currentAsyncClipboardHandoff: boolean,
    done: (result: VisionModelSelectorResult) => void,
    currentFallbacks: string[] = [],
  ) {
    this.theme = theme;
    this.done = done;
    this.currentRef = currentRef;
    this.thinking = currentThinking;
    this.thinkingLevel = currentThinkingLevel;
    this.asyncClipboardHandoff = currentAsyncClipboardHandoff;
    this.fallbacks = new Set(currentFallbacks);
    this.allItems = this.buildItems(allModels);
    this.filteredItems = this.allItems;

    const startIdx = this.allItems.findIndex((i) => i.ref === currentRef);
    this.selectedIndex = startIdx >= 0 ? startIdx : 0;

    // A bare `> ` gives no hint that this line filters the list, so the field
    // carries an inline placeholder until something is typed.
    this.searchInput = new Input({
      placeholder: "type to filter models…",
      placeholderStyle: (text) => this.theme.fg("muted", text),
    });
    this.listContainer = new Container();
    this.footerText = new Text(this.getFooterText(), 0, 0);

    this.searchInput.onSubmit = () => this.save();

    this.updateList();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    lines.push(...new DynamicBorder((s) => this.theme.fg("accent", s)).render(width));
    lines.push(
      truncateToWidth(
        this.theme.fg("accent", this.theme.bold("Vision Watcher")),
        width,
        "",
      ),
    );
    lines.push(
      ...wrapTextWithAnsi(
        this.theme.fg(
          "muted",
          "Pick a vision-capable model to describe images for text-only models.",
        ),
        width,
      ),
    );
    lines.push("");
    // Indented to the list's two-column gutter: at column 0 the field reads as
    // a stray line rather than as the thing the list is filtered by.
    lines.push(
      ...this.searchInput
        .render(Math.max(1, width - 2))
        .map((line) => `  ${line}`),
    );
    lines.push("");
    lines.push(...this.listContainer.render(width));
    lines.push("");
    lines.push(...this.detailLines(width));
    lines.push("");
    lines.push(...this.footerText.render(width));
    lines.push(...new DynamicBorder((s) => this.theme.fg("accent", s)).render(width));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  handleInput(data: string): void {
    const kb = getKeybindings();

    if (kb.matches(data, "tui.select.up")) {
      if (this.filteredItems.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === 0
          ? this.filteredItems.length - 1
          : this.selectedIndex - 1;
      this.updateList();
      return;
    }

    if (kb.matches(data, "tui.select.down")) {
      if (this.filteredItems.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === this.filteredItems.length - 1
          ? 0
          : this.selectedIndex + 1;
      this.updateList();
      return;
    }

    // Reorder the highlighted model inside the list. The failover chain is
    // tried in list order, so moving a row is how you change which fallback
    // runs first. Only meaningful on the unfiltered list (the filter is a
    // view, not an ordering); skip edits that would cross the pinned None row.
    if (matchesKey(data, REORDER_UP_KEY) || matchesKey(data, REORDER_DOWN_KEY)) {
      if (this.searchInput.getValue()) return;
      const item = this.filteredItems[this.selectedIndex];
      if (item?.ref) this.moveItem(item.ref, matchesKey(data, REORDER_DOWN_KEY) ? 1 : -1);
      return;
    }

    // Confirming saves the configuration. When a filter query is typed, Enter
    // ALSO adopts the highlighted model as the primary describer — the search
    // field has already consumed every `space`, so without this the highlighted
    // model could never be picked while filtering and the stale primary would
    // be saved silently.
    if (kb.matches(data, "tui.select.confirm") || matchesKey(data, Key.ctrl("s"))) {
      if (this.searchInput.getValue()) {
        const item = this.filteredItems[this.selectedIndex];
        if (item) this.selectPrimary(item.ref);
      }
      this.save();
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.finish(true);
      return;
    }

    if (matchesKey(data, Key.ctrl("c"))) {
      if (this.searchInput.getValue()) {
        this.searchInput.setValue("");
        this.refresh();
      } else {
        this.finish(true);
      }
      return;
    }

    // Space selects the highlighted model as the primary describer; pressing it
    // again on the same model clears it back to "None". While a filter query is
    // present, space is left to the search input so multi-word queries like
    // "gemini 3.8" stay typeable.
    if ((data === " " || matchesKey(data, Key.space)) && !this.searchInput.getValue()) {
      const item = this.filteredItems[this.selectedIndex];
      if (item) this.selectPrimary(item.ref);
      return;
    }

    // Toggles the highlighted model in/out of the failover chain — a per-row
    // flag rather than a separate screen, so the primary and the chain are
    // chosen together. Intercepted before the search input (like the other ctrl
    // shortcuts) so the key never lands in the filter text. See
    // {@link FALLBACK_KEY} for why it isn't ctrl+f.
    if (matchesKey(data, "ctrl+shift+r")) {
      this.clearFallbacks();
      return;
    }

    if (matchesKey(data, FALLBACK_KEY)) {
      const item = this.filteredItems[this.selectedIndex];
      if (item?.ref) this.toggleFallback(item.ref);
      return;
    }

    // alt+a on Windows/macOS, ctrl+alt+a on Linux where AltGr takes alt+a
    // (intl layouts: `@`, `ł`). `ctrl+a` is the editor's cursorLineStart (Home)
    // and GNU Screen / tmux's command prefix, so it cannot be repurposed here.
    // Intercepted before the search input so it never lands in the filter text.
    if (matchesKey(data, Key.alt("a")) || matchesKey(data, Key.ctrlAlt("a"))) {
      this.asyncClipboardHandoff = !this.asyncClipboardHandoff;
      this.updateList();
      return;
    }

    // ctrl+t walks the whole thinking ladder (off → minimal → … → max → off) so
    // one key covers on/off *and* effort — no separate shift+tab binding.
    // Intercepted before the search input so it never lands in the filter text.
    // `ctrl+t` is readline transpose-chars and pi's app.thinking.toggle (tool
    // output); the ladder gets its own chord instead so both stay usable.
    if (matchesKey(data, Key.ctrlShift("t"))) {
      this.cycleThinking();
      this.updateList();
      return;
    }

    this.searchInput.handleInput(data);
    this.refresh();
  }

  invalidate(): void {
    this.searchInput.invalidate();
    this.listContainer.invalidate();
    this.footerText.invalidate();
  }

  // Internal helpers

  private buildItems(
    allModels: Array<{
      provider: string;
      id: string;
      name: string;
      input?: ("text" | "image")[];
      reasoning?: boolean;
    }>,
  ): DisplayItem[] {
    const items: DisplayItem[] = [
      {
        ref: null,
        provider: "",
        modelId: "none",
        modelName: "None — disable vision handoff",
        vision: false,
        reasoning: false,
        none: true,
      },
    ];

    const make = (m: {
      provider: string;
      id: string;
      name: string;
      input?: ("text" | "image")[];
      reasoning?: boolean;
    }): DisplayItem => ({
      ref: formatModelRef(m.provider, m.id),
      provider: m.provider,
      modelId: m.id,
      modelName: m.name || m.id,
      vision: isVisionModel(m),
      reasoning: !!m.reasoning,
    });

    // Only vision-capable models are listed — a text-only model can't describe
    // images, so it would only produce "[Image: description unavailable]" errors.
    const visionModels = allModels.filter((m) => isVisionModel(m)).map(make);
    return [...items, ...visionModels];
  }

  private getFooterText(): string {
    const totalCount = this.allItems.length - 1; // exclude the None row
    const count = this.searchInput.getValue()
      ? `${this.filteredItems.length - 1} matches`
      : `${totalCount} models`;

    // One legend line: the count carries the accent colour so it is the first
    // thing the eye lands on, while the keys stay dim so they do not compete
    // with the picker itself. The chords need roughly 120 columns, which wraps
    // gracefully; the async and reorder keys are hinted beside the state they
    // toggle (and in the README) instead of bloating this strip.
    const confirm = keyText("tui.select.confirm");
    const legend = [
      `[${confirm.charAt(0).toUpperCase()}${confirm.slice(1)}] Done`,
      "[Space] Vision",
      "[Ctrl+enter] Fallback",
      "[Ctrl+shift+r] Reset",
      "[Ctrl+shift+t] Think",
      "[Esc] Cancel",
    ].join("  ");

    return `${this.theme.fg("dim", "  ")}${this.theme.fg("accent", count)}${this.theme.fg("dim", ` · ${legend}`)}`;
  }

  /** Move `ref` one row up/down in the display list. The None row is pinned at
   *  index 0; no move may cross it or run off either end. */
  private moveItem(ref: string, delta: number): void {
    const from = this.allItems.findIndex((i) => i.ref === ref);
    const to = from + delta;
    if (from <= 0 || to <= 0 || to >= this.allItems.length) return;
    const [item] = this.allItems.splice(from, 1);
    this.allItems.splice(to, 0, item!);
    this.filteredItems = this.allItems;
    this.selectedIndex = to;
    this.updateList();
  }

  private clearFallbacks(): void {
    if (this.fallbacks.size === 0) return;
    this.fallbacks.clear();
    this.notice = null;
    this.updateList();
  }

  /** Toggle a model's membership in the fallback chain, preserving list order
   *  (the chain is tried in order, so the config array must be deterministic
   *  rather than Set-iteration order). */
  private toggleFallback(ref: string): void {
    if (this.fallbacks.has(ref)) {
      this.fallbacks.delete(ref);
      this.notice = null;
    } else if (this.fallbacks.size >= MAX_FALLBACKS) {
      this.notice = `max ${MAX_FALLBACKS} fallbacks — remove one first (${FALLBACK_KEY_HINT})`;
    } else {
      this.fallbacks.add(ref);
      this.notice = null;
    }
    this.updateList();
  }

  /** Space toggles the primary describer; picking the current one again clears
   *  it (same as the None row), so one key both sets and unsets. */
  private selectPrimary(ref: string | null): void {
    this.currentRef = this.currentRef === ref ? null : ref;
    this.notice = null;
    this.updateList();
  }

  /** Fallback refs in list order (models the picker didn't show — e.g. one that
   *  is no longer resolvable — are appended so a config value can't be
   *  silently dropped just by opening the picker). */
  private orderedFallbacks(): string[] {
    const shown = this.allItems
      .map((i) => i.ref)
      .filter((r): r is string => !!r && this.fallbacks.has(r));
    const unshown = [...this.fallbacks].filter((r) => !shown.includes(r));
    return [...shown, ...unshown];
  }

  private refresh(): void {
    const query = this.searchInput.getValue();
    this.filteredItems = query
      ? fuzzyFilter(
          this.allItems,
          query,
          (i) => `${i.provider} ${i.modelId} ${i.ref ?? "none"} ${i.modelName}`,
        )
      : this.allItems;
    this.selectedIndex = Math.min(
      this.selectedIndex,
      Math.max(0, this.filteredItems.length - 1),
    );
    this.updateList();
  }

  private updateList(): void {
    this.listContainer.clear();

    if (this.filteredItems.length === 0) {
      this.listContainer.addChild(
        new Text(this.theme.fg("muted", "  No matching models"), 0, 0),
      );
    }

    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(this.maxVisible / 2),
        this.filteredItems.length - this.maxVisible,
      ),
    );
    const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);

    for (let i = startIndex; i < endIndex; i++) {
      const item = this.filteredItems[i];
      if (!item) continue;

      const isSelected = i === this.selectedIndex;
      const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";

      let label: string;
      if (item.none) {
        label = this.theme.fg("warning", item.modelName);
      } else {
        const labelled = isSelected
          ? this.theme.fg("accent", item.modelId)
          : item.modelId;
        const badge = item.vision ? this.theme.fg("success", " ✦") : this.theme.fg("muted", " ·");
        const providerBadge = this.theme.fg("muted", ` [${item.provider}]`);
        label = `${labelled}${providerBadge}${badge}`;
      }

      const current = item.ref === this.currentRef && item.ref !== null
        ? this.theme.fg("success", " ✓")
        : item.none && this.currentRef === null
          ? this.theme.fg("success", " ✓")
          : "";
      // Fallback marker — distinct from the primary's ✓ so a model can visibly
      // be both the primary and a fallback (Sonnet as primary, Gemini as the
      // chain behind it).
      const fallbackMark =
        item.ref && this.fallbacks.has(item.ref)
          ? this.theme.fg("warning", " ⇆")
          : "";

      this.listContainer.addChild(new Text(`${prefix}${label}${current}${fallbackMark}`, 0, 0));
    }

    if (startIndex > 0 || endIndex < this.filteredItems.length) {
      this.listContainer.addChild(
        new Text(
          this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredItems.length})`),
          0, 0,
        ),
      );
    }

    this.footerText.setText(this.getFooterText());
  }

  private itemByRef(ref: string): DisplayItem | undefined {
    return this.allItems.find((i) => i.ref === ref);
  }

  /** "Gemini 3.8 Flash (Antigravity)", or the raw ref when it isn't in the
   *  registry right now (stale config) so it stays visible instead of blank. */
  private refLabel(ref: string): string {
    const item = this.itemByRef(ref);
    if (!item) return ref;
    const provider = providerLabel(item.provider);
    // Model display names often already carry the vendor — "Gemini 3.8 Flash
    // (Antigravity)" would otherwise come out as "… (Antigravity) (Antigravity)".
    return item.modelName.toLowerCase().includes(provider.toLowerCase())
      ? item.modelName
      : `${item.modelName} (${provider})`;
  }

  /** The detail pane summarises the *configuration* (primary, failover chain
   *  and toggles) rather than the highlighted row, so each space / ctrl+enter
   *  press shows exactly what will be saved.
   *
   *  Built per frame rather than cached in a child component because the
   *  label/value split only pays off once the width is known: a long fallback
   *  chain then wraps under its own value instead of spilling to column 0. */
  private detailLines(width: number): string[] {
    const out: string[] = [];

    // The label — including the symbol, when it has one — wears the same
    // colour as the badge/marker it explains, so the two read as one legend
    // instead of as prose that happens to contain a glyph. The space before
    // `:` keeps the dim label and the symbol grid aligned with the labels
    // below (`Thinking:`, `Async …:`) which have no symbol.
    const label = (text: string, symbol: string, color: ThemeColor) =>
      `${this.theme.fg("dim", `  ${text} `)}${this.theme.fg(color, symbol)}${this.theme.fg("dim", " : ")}`;

    const value = (labelText: string, text: string) => {
      const indent = " ".repeat(2 + visibleWidth(labelText));
      const wrapped = wrapTextWithAnsi(
        text,
        Math.max(8, width - visibleWidth(indent)),
      );
      out.push(`${labelText}${wrapped[0] ?? ""}`);
      for (const extra of wrapped.slice(1)) out.push(indent + extra);
    };

    // Free-standing sentence (warning / transient notice), hanging-indented
    // under its own `⚠`/first word.
    const note = (text: string) => {
      const indent = "    ";
      wrapTextWithAnsi(text, Math.max(8, width - indent.length)).forEach(
        (part, i) => out.push(i === 0 ? part : indent + part),
      );
    };

    value(
      label("Vision-capable", "✦", "success"),
      this.currentRef
        ? this.refLabel(this.currentRef)
        : this.theme.fg("muted", "none — vision watcher disabled"),
    );

    const chain = this.orderedFallbacks();
    value(
      label("Fallback", "⇆", "warning"),
      chain.length
        ? `${this.theme.fg("success", "on")} - ${chain.map((r) => this.refLabel(r)).join(", ")}`
        : this.theme.fg("muted", "off"),
    );

    value(
      this.theme.fg("dim", "  Thinking: "),
      this.thinking
        ? this.theme.fg("success", `on (${this.thinkingLevel})`)
        : this.theme.fg("muted", "off"),
    );

    value(
      this.theme.fg("dim", "  Async pasted-path fallback: "),
      `${this.theme.fg(
        this.asyncClipboardHandoff ? "success" : "muted",
        this.asyncClipboardHandoff ? "on" : "off",
      )}${this.theme.fg("dim", `  ${ASYNC_KEY_HINT}`)}`,
    );

    // The warning follows the *highlighted* row: it answers "what happens if I
    // pick this model", which is also how you'd notice it while browsing.
    const highlighted = this.filteredItems[this.selectedIndex];
    if (this.thinking && highlighted && !highlighted.none && !highlighted.reasoning) {
      note(
        this.theme.fg(
          "warning",
          `  ⚠ ${highlighted.modelId} declares no reasoning — thinking will be ignored`,
        ),
      );
    }

    if (this.notice) note(this.theme.fg("warning", `  ${this.notice}`));

    return out;
  }

  private save(): void {
    this.done({
      ref: this.currentRef,
      cancelled: false,
      thinking: this.thinking,
      thinkingLevel: this.thinkingLevel,
      asyncClipboardHandoff: this.asyncClipboardHandoff,
      fallbackModels: this.orderedFallbacks(),
    });
  }

  private finish(cancelled: boolean): void {
    this.done({
      ref: null,
      cancelled,
      thinking: this.thinking,
      thinkingLevel: this.thinkingLevel,
      asyncClipboardHandoff: this.asyncClipboardHandoff,
      fallbackModels: this.orderedFallbacks(),
    });
  }

  /** Walk the thinking ladder with one key: off → minimal → low → medium →
   *  high → xhigh → max → off → minimal → …
   *
   *  A single index over off + {@link THINKING_LEVELS} so the cycle always
   *  advances. Keeping a separate "remembered level" while off turns the tail
   *  into a two-position toggle once you reach max (off → max → off → max). */
  private cycleThinking(): void {
    const ladder = THINKING_LEVELS.length + 1; // position 0 = off
    const current = this.thinking
      ? THINKING_LEVELS.indexOf(this.thinkingLevel) + 1
      : 0;
    const next = (Math.max(current, 0) + 1) % ladder;
    this.thinking = next > 0;
    if (next > 0) this.thinkingLevel = THINKING_LEVELS[next - 1]!;
  }
}
