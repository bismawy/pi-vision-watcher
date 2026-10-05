import { describe, expect, it, vi } from "vitest";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  MAX_FALLBACKS,
  providerLabel,
  VisionModelSelectorComponent,
} from "../../src/vision-model-selector.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

const models = ["a", "b", "c", "d"].map((id) => ({
  provider: "p",
  id,
  name: id.toUpperCase(),
  input: ["text", "image"] as const,
  reasoning: true,
}));

const DOWN = "\x1b[B";
const ENTER = "\r";
const SPACE = " ";
const CTRL_ENTER = "\x1b[13;5u";
const CTRL_SHIFT_R = "\x1b[114;6u";
const CTRL_SHIFT_T = "\x1b[116;6u";
const ALT_UP = "\x1b[1;3A";
const ALT_DOWN = "\x1b[1;3B";
const ALT_A = "\x1ba";
const CTRL_ALT_A = "\x1b[97;7u";

function build(opts: {
  currentRef?: string | null;
  fallbacks?: string[];
  thinking?: boolean;
  level?: ThinkingLevel;
} = {}) {
  const done = vi.fn();
  const component = new VisionModelSelectorComponent(
    theme,
    models as any,
    opts.currentRef ?? null,
    opts.thinking ?? false,
    opts.level ?? "medium",
    false,
    done,
    opts.fallbacks ?? [],
  );
  return { component, done, text: () => component.render(100).join("\n") };
}

describe("VisionModelSelectorComponent", () => {
  it("summarises the configuration in the detail pane", () => {
    const { text } = build({ currentRef: "p/a" });
    expect(text()).toContain("Vision-capable ✦ : A (P)");
    expect(text()).toContain("Fallback ⇆ : off");
    expect(text()).toContain("Thinking: off");
    expect(text()).toContain("Async pasted-path fallback: off");
    // Old highlighted-row label is gone.
    expect(text()).not.toContain("Model Name:");
  });

  it("lists the chain with names and marks its rows ⇆", () => {
    const { text } = build({ currentRef: "p/a", fallbacks: ["p/b", "p/c"] });
    const rendered = text();
    expect(rendered).toContain("Fallback ⇆ : on - B (P), C (P)");
    const rows = rendered.split("\n");
    expect(rows.find((l) => l.includes(" b [p]"))).toContain("⇆");
    expect(rows.find((l) => l.includes(" c [p]"))).toContain("⇆");
    expect(rows.find((l) => l.includes(" a [p]"))).not.toContain("⇆");
    expect(rows.find((l) => l.includes(" a [p]"))).toContain("✓");
  });

  it("space selects the highlighted model as the primary", () => {
    const { component, done, text } = build({ currentRef: null });
    component.handleInput(DOWN); // None → p/a
    component.handleInput(SPACE);
    expect(text()).toContain("Vision-capable ✦ : A (P)");
    component.handleInput(ENTER);
    expect(done.mock.calls[0][0].ref).toBe("p/a");
  });

  it("space toggles the primary back off when it is already selected", () => {
    const { component, done, text } = build({ currentRef: "p/a" });
    component.handleInput(SPACE);
    expect(text()).toContain("none — vision watcher disabled");
    component.handleInput(ENTER);
    expect(done.mock.calls[0][0].ref).toBeNull();
  });

  it("leaves space to the search input while a filter is active", () => {
    const { component, text } = build({ currentRef: "p/a" });
    component.handleInput("b"); // filter query
    component.handleInput(SPACE);
    expect(text()).toContain("Vision-capable ✦ : A (P)");
  });

  it("adopts the highlighted match with enter while a filter is active", () => {
    const { component, done } = build({ currentRef: "p/a" });
    component.handleInput("b"); // query matches only p/b
    component.handleInput(DOWN);
    component.handleInput(ENTER);
    expect(done.mock.calls[0][0].ref).toBe("p/b");
  });

  it("adds chain members with ctrl+enter and caps the chain", () => {
    const { component, done, text } = build({ currentRef: "p/a" });
    for (let i = 0; i < MAX_FALLBACKS; i++) {
      component.handleInput(CTRL_ENTER);
      component.handleInput(DOWN);
    }
    // One more than the cap — refused, with a hint.
    component.handleInput(CTRL_ENTER);
    expect(text()).toContain(`max ${MAX_FALLBACKS} fallbacks`);
    component.handleInput(ENTER);
    expect(done.mock.calls[0][0].fallbackModels).toEqual(["p/a", "p/b", "p/c"]);
  });

  it("leaves ctrl+f and ctrl+alt+f alone", () => {
    for (const key of ["\x06", "\x1b\x06", "\x11", "\x13"]) {
      const { component, done } = build({ currentRef: "p/a" });
      component.handleInput(key);
      component.handleInput(ENTER);
      expect(done.mock.calls[0][0].fallbackModels).toEqual([]);
    }
  });

  it("toggles a chain member back out", () => {
    const { component, done } = build({ currentRef: "p/a", fallbacks: ["p/a", "p/b"] });
    component.handleInput(CTRL_ENTER); // drop p/a
    component.handleInput(ENTER);
    expect(done.mock.calls[0][0].fallbackModels).toEqual(["p/b"]);
  });

  it("keeps chain order and preserves unresolvable refs", () => {
    const { component, done } = build({ currentRef: "p/a", fallbacks: ["ghost/model", "p/b"] });
    component.handleInput(ENTER);
    expect(done.mock.calls[0][0].fallbackModels).toEqual(["p/b", "ghost/model"]);
  });

  it("resets all fallbacks with ctrl+shift+r", () => {
    const { component, done, text } = build({ currentRef: "p/a", fallbacks: ["ghost/model", "p/b", "p/c"] });
    component.handleInput(CTRL_SHIFT_R);
    component.handleInput(ENTER);
    expect(done.mock.calls[0][0].fallbackModels).toEqual([]);
  });

  it("reorders the highlighted row with alt+up/alt+down", () => {
    const { component, text } = build();
    component.handleInput(DOWN); // None → p/a
    component.handleInput(DOWN); // p/a → p/b
    component.handleInput(ALT_UP); // p/b before p/a
    expect(text()).toContain("Fallback ⇆ : off");
    expect(text().indexOf(" b [p]")).toBeLessThan(text().indexOf(" a [p]"));
    component.handleInput(ALT_DOWN); // back to start
    expect(text().indexOf(" a [p]")).toBeLessThan(text().indexOf(" b [p]"));
  });

  it("never reorders the pinned None row", () => {
    const { component, text } = build();
    component.handleInput(DOWN); // None → p/a
    component.handleInput(ALT_UP); // would cross None
    const rows = text().split("\n").filter((l) => l.includes(" [p]"));
    expect(rows[0]).toContain(" a [p]");
  });

  it("leaves alt+up/alt+down alone while a filter is active", () => {
    const { component, text } = build();
    component.handleInput("b");
    component.handleInput(ALT_DOWN);
    expect(text().indexOf(" a [p]")).toBeLessThan(text().indexOf(" b [p]"));
  });

  it("renders the footer legend with the count first", () => {
    const { text } = build();
    // Whitespace is flattened: the real renderer wraps this line at narrow
    // widths, which collapses the double spaces between legend entries.
    const flat = text().replace(/\s+/g, " ");
    expect(flat).toContain(
      "4 models · [Enter] Done [Space] Vision [Ctrl+enter] Fallback [Ctrl+shift+r] Reset [Ctrl+shift+t] Think [Esc] Cancel",
    );
  });

  it("walks the thinking ladder with ctrl+shift+t and wraps without sticking", () => {
    const { component, text } = build({ level: "medium" });
    const thinking = () => /Thinking: (on \(\w+\)|off)/.exec(text())?.[1];
    expect(thinking()).toBe("off");
    // The ladder always advances through every level and back to off — it must
    // not degenerate into off → max → off once the tail is reached.
    for (const expected of [
      "on (minimal)",
      "on (low)",
      "on (medium)",
      "on (high)",
      "on (xhigh)",
      "on (max)",
      "off",
      "on (minimal)",
    ]) {
      component.handleInput(CTRL_SHIFT_T);
      expect(thinking()).toBe(expected);
    }
  });

  it("toggles the chain with ctrl+enter", () => {
    const { component, done } = build({ currentRef: "p/a" });
    component.handleInput(CTRL_ENTER);
    component.handleInput(ENTER);
    expect(done.mock.calls[0][0].fallbackModels).toEqual(["p/a"]);
  });

  it("toggles async paste handoff with alt+a and ctrl+alt+a", () => {
    for (const key of [ALT_A, CTRL_ALT_A]) {
      const { component, text } = build();
      expect(text()).toContain("Async pasted-path fallback: off");
      component.handleInput(key);
      expect(text()).toContain("Async pasted-path fallback: on");
    }
  });

  it("prints the async chord beside the async state", () => {
    const { text } = build();
    const flat = text().replace(/\s+/g, " ");
    expect(flat).toContain("Async pasted-path fallback: off [Ctrl+alt+a]");
  });

  it("does not repeat a provider the model name already carries", () => {
    const done = vi.fn();
    const component = new VisionModelSelectorComponent(
      theme,
      [
        {
          provider: "antigravity",
          id: "gemini-3.8-flash",
          name: "Gemini 3.8 Flash (Antigravity)",
          input: ["text", "image"],
          reasoning: true,
        },
      ] as any,
      "antigravity/gemini-3.8-flash",
      false,
      "medium",
      false,
      done,
      [],
    );
    const rendered = component.render(100).join("\n");
    expect(rendered).toContain("Vision-capable ✦ : Gemini 3.8 Flash (Antigravity)");
    expect(rendered).not.toContain("(Antigravity) (Antigravity)");
  });

  it("labels the filter field and keeps it in the list's gutter", () => {
    const { component } = build();
    const field = component.render(100).find((l) => l.includes("filter models"));
    expect(field).toBeDefined();
    // Two-space gutter, same as the rows and the detail pane.
    expect(field!.startsWith("  > ")).toBe(true);
  });

  it("wraps a long detail value under its own label", () => {
    const done = vi.fn();
    const component = new VisionModelSelectorComponent(
      theme,
      models as any,
      "p/a",
      false,
      "medium",
      false,
      done,
      ["p/a", "p/b", "p/c", "p/d"],
    );
    const rows = component.render(40);
    const start = rows.findIndex((l) => l.includes("Fallback ⇆ :"));
    expect(start).toBeGreaterThan(-1);
    // "Fallback ⇆ : " is 14 columns -> the value starts at 16, and so do its
    // continuation lines (they used to spill back to column 0).
    expect(rows[start + 1]!.startsWith(" ".repeat(16))).toBe(true);
    for (const row of rows.slice(start, start + 4)) {
      expect(visibleWidth(row)).toBeLessThanOrEqual(40);
    }
  });

  it("labels providers for the detail pane", () => {
    expect(providerLabel("antigravity")).toBe("Antigravity");
    expect(providerLabel("openai")).toBe("OpenAI");
    expect(providerLabel("xai")).toBe("xAI");
    expect(providerLabel("custom-openrouter-ai")).toBe("Custom Openrouter AI");
  });
});
