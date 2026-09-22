import { describe, expect, it, vi } from "vitest";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
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
const CTRL_Q = "\x11";
const CTRL_SHIFT_Q = "\x1b[113;6u";
const CTRL_T = "\x14";

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
    expect(text()).toContain("Vision-capable (👀): A (P)");
    expect(text()).toContain("Fallback (🔁): off");
    expect(text()).toContain("Thinking: off");
    expect(text()).toContain("Async pasted-path fallback: off");
    // Old highlighted-row label is gone.
    expect(text()).not.toContain("Model Name:");
  });

  it("lists the chain with names and marks its rows 🔁", () => {
    const { text } = build({ currentRef: "p/a", fallbacks: ["p/b", "p/c"] });
    const rendered = text();
    expect(rendered).toContain("Fallback (🔁): on - B (P), C (P)");
    const rows = rendered.split("\n");
    expect(rows.find((l) => l.includes(" b [p]"))).toContain("🔁");
    expect(rows.find((l) => l.includes(" c [p]"))).toContain("🔁");
    expect(rows.find((l) => l.includes(" a [p]"))).not.toContain("🔁");
    expect(rows.find((l) => l.includes(" a [p]"))).toContain("✓");
  });

  it("space selects the highlighted model as the primary", () => {
    const { component, done, text } = build({ currentRef: null });
    component.handleInput(DOWN); // None → p/a
    component.handleInput(SPACE);
    expect(text()).toContain("Vision-capable (👀): A (P)");
    component.handleInput(ENTER);
    expect(done.mock.calls[0][0].ref).toBe("p/a");
  });

  it("space toggles the primary back off when it is already selected", () => {
    const { component, done, text } = build({ currentRef: "p/a" });
    component.handleInput(SPACE);
    expect(text()).toContain("none — vision handoff disabled");
    component.handleInput(ENTER);
    expect(done.mock.calls[0][0].ref).toBeNull();
  });

  it("leaves space to the search input while a filter is active", () => {
    const { component, text } = build({ currentRef: "p/a" });
    component.handleInput("b"); // filter query
    component.handleInput(SPACE);
    expect(text()).toContain("Vision-capable (👀): A (P)");
  });

  it("adds chain members with ctrl+q and caps the chain", () => {
    const { component, done, text } = build({ currentRef: "p/a" });
    for (let i = 0; i < MAX_FALLBACKS; i++) {
      component.handleInput(CTRL_Q);
      component.handleInput(DOWN);
    }
    // One more than the cap — refused, with a hint.
    component.handleInput(CTRL_Q);
    expect(text()).toContain(`max ${MAX_FALLBACKS} fallbacks`);
    component.handleInput(ENTER);
    expect(done.mock.calls[0][0].fallbackModels).toEqual(["p/a", "p/b", "p/c"]);
  });

  it("leaves ctrl+f and ctrl+alt+f alone", () => {
    for (const key of ["\x06", "\x1b\x06"]) {
      const { component, done } = build({ currentRef: "p/a" });
      component.handleInput(key);
      component.handleInput(ENTER);
      expect(done.mock.calls[0][0].fallbackModels).toEqual([]);
    }
  });

  it("toggles a chain member back out", () => {
    const { component, done } = build({ currentRef: "p/a", fallbacks: ["p/a", "p/b"] });
    component.handleInput(CTRL_Q); // drop p/a
    component.handleInput(ENTER);
    expect(done.mock.calls[0][0].fallbackModels).toEqual(["p/b"]);
  });

  it("keeps chain order and preserves unresolvable refs", () => {
    const { component, done } = build({ currentRef: "p/a", fallbacks: ["ghost/model", "p/b"] });
    component.handleInput(ENTER);
    expect(done.mock.calls[0][0].fallbackModels).toEqual(["p/b", "ghost/model"]);
  });

  it("resets all fallbacks with ctrl+shift+q", () => {
    const { component, done, text } = build({ currentRef: "p/a", fallbacks: ["ghost/model", "p/b", "p/c"] });
    component.handleInput(CTRL_SHIFT_Q);
    component.handleInput(ENTER);
    expect(done.mock.calls[0][0].fallbackModels).toEqual([]);
  });

  it("renders the updated footer format", () => {
    const { text } = build();
    const normalized = text().replace(/\s*\n\s*/g, " ");
    expect(normalized).toContain(
      "enter = done | space = vision models | ctrl+q = fallback models | ctrl+shift+q = reset fallbacks models | ctrl+t = thinking | ctrl+a = async fallback | esc = cancel | total 4 models.",
    );
  });

  it("walks the thinking ladder with ctrl+t and wraps without sticking", () => {
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
      component.handleInput(CTRL_T);
      expect(thinking()).toBe(expected);
    }
  });

  it("toggles the chain with ctrl+q", () => {
    const { component, done } = build({ currentRef: "p/a" });
    component.handleInput(CTRL_Q);
    component.handleInput(ENTER);
    expect(done.mock.calls[0][0].fallbackModels).toEqual(["p/a"]);
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
    expect(rendered).toContain("Vision-capable (👀): Gemini 3.8 Flash (Antigravity)");
    expect(rendered).not.toContain("(Antigravity) (Antigravity)");
  });

  it("labels providers for the detail pane", () => {
    expect(providerLabel("antigravity")).toBe("Antigravity");
    expect(providerLabel("openai")).toBe("OpenAI");
    expect(providerLabel("xai")).toBe("xAI");
    expect(providerLabel("custom-openrouter-ai")).toBe("Custom Openrouter AI");
  });
});
