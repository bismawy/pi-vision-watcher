/**
 * VisionModelSelectorComponent — an interactive TUI for choosing which model
 * describes images during vision handoff.
 *
 * Uses the same patterns as pi's built-in selectors and pi-hide-providers:
 * - Lists connected (authenticated) vision-capable models as bare `provider/id` refs
 * - A leading "None" row clears the configured vision model
 * - Space selects the highlighted model as the primary describer (toggle)
 * - Tab toggles the highlighted model in/out of the failover chain (max 3)
 * - Ctrl+Shift+R clears the failover chain, Shift+Tab walks the thinking ladder,
 *   Alt+A / Ctrl+Alt+A toggles async paste handoff, Alt+↑↓ reorders rows
 * - Enter or Ctrl+S saves, Esc / Ctrl+C cancels
 * - The primary and chain members are named in a note column, not a checkbox:
 *   a single-choice list has nothing to check
 */

import {
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
import { keyText } from "@earendil-works/pi-coding-agent";
import { formatModelRef, isVisionModel, THINKING_LEVELS } from "./index.js";

/** Failover chain length cap — three is already far past the point where a
 *  fourth describer would ever be reached. */
export const MAX_FALLBACKS = 3;

type OklchLike = { kind?: string; l?: number; c?: number; h?: number };
type ThemeLike = Pick<Theme, "fg" | "bold"> & {
  colors?: Readonly<Record<string, OklchLike>>;
  style?(text: string, options: { fg: OklchLike }): string;
};

// pi >=1.2 rejects custom theme tokens (accentSoft), so the arnative soft tier is
// derived from an official token with the theme generator's recipe: L 0.82,
// chroma x 0.18, hue kept. Older runtimes without colors/style keep fallback.
const SOFT_L = 0.82;
const SOFT_CHROMA_SCALE = 0.18;

export function softPainter(th: ThemeLike, base: ThemeColor, fallback: ThemeColor): (text: string) => string {
  const style = th.style?.bind(th);
  const declared = th.colors?.accentSoft;
  if (style && declared?.kind === "oklch") return (t) => style(t, { fg: declared });
  const c = th.colors?.[base];
  if (style && c?.kind === "oklch") {
    const fg = { kind: "oklch", l: SOFT_L, c: (c.c ?? 0) * SOFT_CHROMA_SCALE, h: c.h ?? 0 };
    return (t) => style(t, { fg });
  }
  return (t) => th.fg(fallback, t);
}

export function boxEdge(left: string, right: string, width: number, paint: (s: string) => string): string {
  return width < 2 ? "" : paint(left + "─".repeat(width - 2) + right);
}

// Truncate before wrapping so a long row never pushes the right wall out of the frame.
export function boxRow(content: string, width: number, paint: (s: string) => string): string {
  if (width < 4) return "";
  const inner = truncateToWidth(content, width - 4, "");
  const pad = " ".repeat(Math.max(0, width - 4 - visibleWidth(inner)));
  return paint("│") + " " + inner + pad + " " + paint("│");
}

/** Key that toggles failover-chain membership.
 *
 *  Tab is one byte (0x09) on every terminal and OS, and no terminal, window manager
 *  or multiplexer binds it. The search input has no Tab handler, and this chord is
 *  intercepted before the input. ctrl+enter (1.1.0) maximises the window in some
 *  terminals, and without the kitty keyboard protocol it cannot be told from enter.
 *  ctrl+f is Search in herdr. The older ctrl+q hit POSIX tty flow control (IXON)
 *  and pi's app.message.followUp; ctrl+shift+q hit VTE's close-terminal accelerator.
 *
 *  Reset is `r` now that letters are free (the field owns text only while `/`
 *  opened it). `ctrl+shift+r` stays as an alias for muscle memory; it is unbound
 *  in every default terminal except kitty, where it resizes a window. */
const FALLBACK_KEY = "tab";
const FALLBACK_KEY_HINT = "tab";
const REORDER_UP_KEY = Key.alt("up");
const REORDER_DOWN_KEY = Key.alt("down");
/** Legend hints. A bare letter is free because letters are only text while `/`
 *  owns the field. The old chords stay as aliases for muscle memory: `alt+a`
 *  (Windows/macOS) and `ctrl+alt+a` (Linux, where AltGr takes `alt+a` on intl
 *  layouts), and `ctrl+shift+r` for reset. */
const ASYNC_KEY_HINT = "[A]";
const RESET_KEY_HINT = "[R]";

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

/** One rendered list row kept in parts: the note column is dropped from the tail
 *  at render time when the frame is narrow, so a note never gets cut mid-word. */
interface ListRow {
  kind: "row";
  /** "-> " (selected) or two spaces, already painted. */
  prefix: string;
  /** The row label, already painted. */
  label: string;
  /** Same label without paint, for the column width. */
  labelText: string;
  /** Painted role marker: `✓ primary` in accent, `✓ fallback 1` in the primary
   *  tone, or null when the row is neither. */
  role: string | null;
  /** Painted `(thinking off)` / `(no thinking)` in dim, or null. */
  detail: string | null;
}

/** A painted line with no columns: the ↑/↓ counts and the empty-list notice. */
interface ListLine {
  kind: "line";
  text: string;
}

type ListEntry = ListRow | ListLine;

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
  /** Session thinking level; the frame follows it like Pi's own editor border. */
  private readonly borderLevel?: Parameters<Theme["getThinkingBorderColor"]>[0];
  private theme: Theme;
  private done: (result: VisionModelSelectorResult) => void;

  private allItems: DisplayItem[];
  private filteredItems: DisplayItem[];
  private selectedIndex = 0;
  private readonly maxVisible = 10;
  private searchInput: Input;
  /** List rows kept in parts: the note column is padded and thinned at render
   *  time because how much room a note gets depends on the frame width. */
  private listEntries: ListEntry[] = [];

  private currentRef: string | null;
  private thinking: boolean;
  private thinkingLevel: ThinkingLevel;
  private asyncClipboardHandoff: boolean;
  /** Fallback-chain membership, toggled in-place with {@link FALLBACK_KEY}. */
  private fallbacks: Set<string>;
  /** Whether `/` has handed the keyboard to the filter field. Idle, the line is a
   *  dim prompt (like every arnative screen), so letters stay commands; typing,
   *  every printable key is text. `/`, Enter or Esc leave typing and keep the
   *  query, so the keys act on the rows it matched. */
  private typing = false;
  /** Transient hint (e.g. chain cap hit), rendered above the legend. */
  private notice: string | null = null;

  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    // The field owns the cursor only while typing; idle it is a dim prompt line,
    // so pi focusing the component must not paint a fake cursor into it.
    this.searchInput.focused = value && this.typing;
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
    borderLevel?: Parameters<Theme["getThinkingBorderColor"]>[0],
  ) {
    this.borderLevel = borderLevel;
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
      prompt: this.theme.fg("accent", "> "),
      placeholder: "Type to filter models…",
      placeholderStyle: (text) => this.theme.fg("muted", text),
    });
    this.searchInput.onSubmit = () => this.save();

    this.updateList();
  }

  render(width: number): string[] {
    // The user asked for the frame to follow the session thinking level, like Pi's editor border;
    // the soft tier only applies when no level or no thinking-border API is available.
    const thinkingBorder = this.borderLevel ? this.theme.getThinkingBorderColor?.(this.borderLevel) : undefined;
    const border = thinkingBorder ?? softPainter(this.theme, "borderAccent", "accent");
    const body = this.bodyLines(Math.max(1, width - 4)).flatMap((line) => line.split("\n"));
    return [
      boxEdge("╭", "╮", width, border),
      ...body.map((line) => boxRow(line, width, border)),
      boxEdge("╰", "╯", width, border),
    ];
  }

  private bodyLines(width: number): string[] {
    const lines: string[] = [];
    lines.push(this.theme.fg("accent", this.theme.bold("Vision Watcher")));
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
    lines.push(...this.summaryLines(width));
    lines.push("");
    // Filter line, arnative style: idle it is a dim prompt the eye reads as a
    // field but the keyboard does not own, so `/` starts typing and every
    // letter stays a command until then. Flush with the wall: boxRow supplies
    // the one-space pad.
    lines.push(...this.filterLine(width));
    lines.push("");
    lines.push(...this.renderList(width));
    lines.push("");
    lines.push(...this.noteLines(width));
    lines.push(...this.legendLines(width));
    return lines;
  }

  /** The idle prompt carries the kept query, so a filter that is no longer
   *  being typed still shows what it matches. */
  private filterLine(width: number): string[] {
    if (this.typing) return this.searchInput.render(Math.max(1, width));
    const query = this.searchInput.getValue();
    const shown = query
      ? this.theme.fg("text", query)
      : this.theme.fg("dim", "Type to filter models…");
    return [this.theme.fg("borderMuted", "> ") + shown];
  }

  /** The configuration spelled out in model names: the primary, the failover
   *  chain in the order it is tried, and the thinking level. With 70 rows the
   *  picked models scroll out of the window, so this header is what answers
   *  "which models am I actually using" without hunting them down one by one.
   *  Labels share one column, arnative status-panel style, and a long row wraps
   *  under its own value instead of spilling to column 0. */
  private summaryLines(width: number): string[] {
    const labels = {
      primary: "Primary",
      fallback: "Fallback",
      thinking: "Thinking",
    };
    const col = Math.max(...Object.values(labels).map((l) => visibleWidth(l)));

    const row = (labelText: string, body: string, color: ThemeColor = "text") => {
      const head = this.theme.fg("dim", labelText + " ".repeat(col - visibleWidth(labelText)));
      const indent = " ".repeat(col + 3); // label column + " · "
      const wrapped = wrapTextWithAnsi(body, Math.max(8, width - indent.length));
      const out = [head + this.theme.fg("dim", " · ") + this.theme.fg(color, wrapped[0] ?? "")];
      for (const extra of wrapped.slice(1)) out.push(indent + this.theme.fg(color, extra));
      return out;
    };

    const chain = this.currentRef ? this.chainBehindPrimary() : [];
    // Every value uses the same colour. A dim label next to a bright value read
    // as "only the primary is real"; the label column is chrome, the value is
    // the fact. An absent value (no primary) stays muted so it cannot be
    // mistaken for a model name.
    const out: string[] = [];
    out.push(
      ...row(
        labels.primary,
        this.currentRef ? this.refLabel(this.currentRef) : "none — vision watcher off",
        this.currentRef ? "text" : "muted",
      ),
    );
    if (chain.length) {
      out.push(...row(labels.fallback, chain.map((r) => this.refLabel(r)).join(" → ")));
    }
    out.push(...row(labels.thinking, this.thinking ? this.thinkingLevel : "off"));
    return out;
  }

  /** Warnings under the list (highlighted row can't think; a refused chain add),
   *  the way arnative floats a warn line above its legend. */
  private noteLines(width: number): string[] {
    const out: string[] = [];
    const highlighted = this.filteredItems[this.selectedIndex];
    if (this.thinking && highlighted && !highlighted.none && !highlighted.reasoning) {
      out.push(
        ...wrapTextWithAnsi(
          this.theme.fg(
            "warning",
            `Warning: ${highlighted.modelId} declares no reasoning, so thinking will be ignored`,
          ),
          width,
        ),
      );
    }
    if (this.notice) {
      out.push(...wrapTextWithAnsi(this.theme.fg("warning", this.notice), width));
    }
    return out.length ? [...out, ""] : [];
  }

  handleInput(data: string): void {
    const kb = getKeybindings();

    // The filter owns the keyboard only while `/` has handed it over.
    if (this.searchKey(data)) return;

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
    // again on the same model clears it back to "None". Typing already owns the
    // key (searchKey runs first), so a kept query does not steal it back.
    if ((data === " " || matchesKey(data, Key.space)) && !this.typing) {
      const item = this.filteredItems[this.selectedIndex];
      if (item) this.selectPrimary(item.ref);
      return;
    }

    // Toggles the highlighted model in/out of the failover chain — a per-row
    // flag rather than a separate screen, so the primary and the chain are
    // chosen together. Intercepted before the search input (like the other ctrl
    // shortcuts) so the key never lands in the filter text. See
    // {@link FALLBACK_KEY} for why it isn't ctrl+f.
    // `r` is Reset; `ctrl+shift+r` stays as the older chord.
    if (data === "r" || data === "R" || matchesKey(data, "ctrl+shift+r")) {
      this.clearFallbacks();
      return;
    }

    if (matchesKey(data, FALLBACK_KEY)) {
      const item = this.filteredItems[this.selectedIndex];
      if (item?.ref) this.toggleFallback(item.ref);
      return;
    }

    // `a` is Async; alt+a and ctrl+alt+a stay as aliases. `ctrl+a` is the
    // editor's cursorLineStart (Home) and GNU Screen / tmux's command prefix, so
    // it is left alone. Intercepted before the search input so the key never
    // lands in the filter text.
    if (
      data === "a" ||
      data === "A" ||
      matchesKey(data, Key.alt("a")) ||
      matchesKey(data, Key.ctrlAlt("a"))
    ) {
      this.asyncClipboardHandoff = !this.asyncClipboardHandoff;
      this.updateList();
      return;
    }

    // shift+tab walks the whole thinking ladder (off, minimal ... max, off). It is one
    // sequence (ESC [ Z) on every terminal and is pi's own app.thinking.cycle, so the
    // meaning carries over. ctrl+shift+t opened a new tab in Windows Terminal and GNOME
    // Terminal and is pi's app.session.tree. Intercepted before the search input.
    if (matchesKey(data, "shift+tab")) {
      this.cycleThinking();
      this.updateList();
      return;
    }

    // Nothing else is a command: a stray letter must not type into a filter
    // the user has not opened (that is what `/` is for).
  }

  /** Hand `data` to the filter while typing. Outside typing only `/` starts;
   *  while typing `/`, Enter and Esc stop typing and KEEP the query, so the
   *  rows it matched stay filtered and the commands act on them. Arrows stay
   *  navigation even while typing, so a match is reachable without leaving the
   *  field. Ctrl+C drops the query and the field together. */
  private searchKey(data: string): boolean {
    if (!this.typing) {
      if (data !== "/") return false;
      this.setTyping(true);
      return true;
    }
    if (data === "/" || matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
      this.setTyping(false);
      return true;
    }
    if (matchesKey(data, Key.ctrl("c"))) {
      this.searchInput.setValue("");
      this.setTyping(false);
      this.refresh();
      return true;
    }
    if (matchesKey(data, "up") || matchesKey(data, "down")) return false;
    const before = this.searchInput.getValue();
    this.searchInput.handleInput(data);
    if (this.searchInput.getValue() !== before) {
      this.selectedIndex = 0;
      this.refresh();
    } else {
      this.updateList();
    }
    return true;
  }

  private setTyping(typing: boolean): void {
    this.typing = typing;
    this.searchInput.focused = typing;
    this.updateList();
  }

  invalidate(): void {
    this.searchInput.invalidate();
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

  /** The legend, packed greedily into rows that fit the frame: a truncated
   *  legend advertises keys nobody can read, and a key is never worth splitting.
   *  The count opens the first row the way arnative prints `34/44 picked · …`.
   *  Toggle state sits beside the key that owns it (`[c] Session cost`), so the
   *  screen needs no status panel. */
  private legendLines(width: number): string[] {
    const totalCount = this.allItems.length - 1; // exclude the None row
    // The None row is not a model, and a filter can drop it, so count the rows
    // that name one instead of subtracting a row that may not be there.
    const count = this.searchInput.getValue()
      ? `${this.filteredItems.filter((i) => !i.none).length} matches`
      : `${totalCount} models`;
    const confirm = keyText("tui.select.confirm");
    const keys = [
      "[Space] Primary",
      "[Tab] Fallback",
      "[Shift+tab] Think",
      `${ASYNC_KEY_HINT} Async ${this.asyncClipboardHandoff ? "on" : "off"}`,
      "[/] Filter",
      `${RESET_KEY_HINT} Reset`,
      `[${confirm.charAt(0).toUpperCase()}${confirm.slice(1)}] Save`,
      "[Esc] Cancel",
    ];

    // The count sits in front of the first row, so the first row's budget is
    // narrower than the frame by exactly that prefix.
    const prefix = `${count} · `;
    const rows: string[] = [];
    let row = "";
    for (const key of keys) {
      const next = row ? `${row}  ${key}` : key;
      const budget = rows.length === 0 ? width - visibleWidth(prefix) : width;
      if (row && visibleWidth(next) > budget) {
        rows.push(row);
        row = key;
      } else {
        row = next;
      }
    }
    if (row) rows.push(row);

    // No prefix: boxRow's own pad is the one space, exactly like the providers
    // legend row. The count takes the accent so it is the first thing the eye
    // lands on; the keys stay dim so they do not compete with the list.
    return rows.map((line, index) =>
      index === 0
        ? `${this.theme.fg("accent", count)}${this.theme.fg("dim", ` · ${line}`)}`
        : this.theme.fg("dim", line),
    );
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

  private itemByRef(ref: string): DisplayItem | undefined {
    return this.allItems.find((i) => i.ref === ref);
  }

  /** "Gemini 3.8 Flash (Antigravity)", or the raw ref when the model is not in
   *  the registry right now (stale config), so it stays visible instead of blank. */
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

  /** The models behind the primary, in the order they are tried. The primary is
   *  excluded: it is tried first, so it is not a numbered fallback even when the
   *  config lists it in the chain. */
  private chainBehindPrimary(): string[] {
    return this.orderedFallbacks().filter((r) => r !== this.currentRef);
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
    this.listEntries = [];
    const chain = this.chainBehindPrimary();

    if (this.filteredItems.length === 0) {
      this.listEntries.push({ kind: "line", text: this.theme.fg("muted", "No matching models") });
    }

    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(this.maxVisible / 2),
        this.filteredItems.length - this.maxVisible,
      ),
    );
    const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);

    // Hidden rows are announced like the providers list, never silently cut: the
    // ↑ count sits above the window, the ↓ count below it.
    if (startIndex > 0) {
      this.listEntries.push({ kind: "line", text: this.theme.fg("dim", `↑ ${startIndex} more`) });
    }

    for (let i = startIndex; i < endIndex; i++) {
      const item = this.filteredItems[i];
      if (!item) continue;

      const isSelected = i === this.selectedIndex;
      const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
      const labelText = this.rowLabel(item);

      let label: string;
      if (item.none) {
        label = this.theme.fg("warning", labelText);
      } else {
        // Providers style: the bare `provider/id` ref, no badges — unselected
        // rows sit in muted, the highlighted row takes the soft tier in bold.

        // The primary keeps the accent even when it is not highlighted, so the
        // picked model is visible without reading the note column.
        label = isSelected
          ? softPainter(this.theme, "accent", "accent")(this.theme.bold(labelText))
          : item.ref === this.currentRef
            ? this.theme.fg("accent", labelText)
            : this.theme.fg("muted", labelText);
      }

      // No checkbox: the choice is single, so the row states its role instead
      // (`✓ primary`, `✓ fallback 1`) and the fact follows in parentheses.
      const isPrimary = item.ref !== null && item.ref === this.currentRef;
      // Numbered among the models behind the primary: the primary is tried
      // first, so it is not `fallback 1` even when the config lists it first.
      const chainIndex = isPrimary || !item.ref ? -1 : chain.indexOf(item.ref);
      // The None row counts as picked when nothing is, so it carries the
      // "(no handoff)" fact the way a picked row carries its own.
      const isPicked = item.none ? this.currentRef === null : isPrimary || chainIndex >= 0;
      const role = isPrimary
        ? this.theme.fg("accent", "✓ primary")
        : chainIndex >= 0
          ? this.tone(`✓ fallback ${chainIndex + 1}`)
          : null;
      this.listEntries.push({
        kind: "row",
        prefix,
        label,
        labelText,
        role,
        // The parenthetical belongs to a picked row: on every other row it would
        // repeat `(no thinking)` down the whole list.
        detail: isPicked ? this.rowDetail(item, isPrimary) : null,
      });
    }

    if (endIndex < this.filteredItems.length) {
      this.listEntries.push({
        kind: "line",
        text: this.theme.fg("dim", `↓ ${this.filteredItems.length - endIndex} more`),
      });
    }
  }

  /** One row, hug-style: the ref, then `✓ primary`, then `(thinking off)`.
   *  No column padding, so the marker sits right after the ref instead of
   *  drifting right with the longest ref in the registry. The fact is worth more
   *  than the ref tail, so a narrow frame truncates the ref first (down to 12
   *  columns, then drops the parenthetical, then the marker). */
  private renderList(width: number): string[] {
    return this.listEntries.map((entry) => {
      if (entry.kind === "line") return truncateToWidth(entry.text, width, "");

      const head = entry.prefix;
      const fixed = visibleWidth(head);
      const labelWidth = visibleWidth(entry.label);
      const tail = [entry.role, entry.detail].filter(Boolean).join(" ");
      const tailWidth = tail ? visibleWidth(tail) + 1 : 0;

      // Everything fits: ref, role, fact.
      if (fixed + labelWidth + tailWidth <= width) {
        return truncateToWidth(`${head}${entry.label}${tail ? ` ${tail}` : ""}`, width, "");
      }
      // Keep the role and the fact, cut the ref tail.
      if (tail && width - fixed - tailWidth >= 12) {
        const shown = truncateToWidth(entry.label, width - fixed - tailWidth, "…");
        return `${head}${shown} ${tail}`;
      }
      // Keep the role only.
      const roleWidth = entry.role ? visibleWidth(entry.role) + 1 : 0;
      if (entry.role && width - fixed - roleWidth >= 12) {
        const shown = truncateToWidth(entry.label, width - fixed - roleWidth, "…");
        return `${head}${shown} ${entry.role}`;
      }
      return truncateToWidth(`${head}${entry.label}${entry.role ? ` ${entry.role}` : ""}`, width, "");
    });
  }

  /** The plain label a row renders before paint and padding. */
  private rowLabel(item: DisplayItem): string {
    return item.none ? "None" : item.ref!;
  }

  /** What the row means right now, in the note column: its role (primary, chain
   *  position) and whether thinking can do anything for it. Both are facts an
   *  arnative row would state instead of hiding in a side panel. */
  /** The fact in parentheses after the role. It belongs to the primary (the
   *  model that will actually be asked) and to any model that cannot think at
   *  all, so the row says that without opening a detail panel. */
  private rowDetail(item: DisplayItem, isPrimary: boolean): string | null {
    if (item.none) {
      return this.currentRef === null ? this.theme.fg("dim", "(no handoff)") : null;
    }
    const fact = !item.reasoning
      ? "no thinking"
      : isPrimary
        ? this.thinking
          ? `thinking ${this.thinkingLevel}`
          : "thinking off"
        : null;
    return fact ? this.theme.fg("dim", `(${fact})`) : null;
  }

  /** The arnative primary tone for a chain marker. pi's theme tokens have no
   *  `primary` slot, so use the theme's own when it declares one and fall back
   *  to `warning`, the same warm hue in every built-in theme. */
  private tone(text: string): string {
    try {
      return this.theme.fg("primary" as ThemeColor, text);
    } catch {
      return this.theme.fg("warning", text);
    }
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
