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
const TAB = "\t";
const CTRL_SHIFT_R = "\x1b[114;6u";
const SHIFT_TAB = "\x1b[Z";
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
  it("states each row's role and thinking in a note column", () => {
    const { text } = build({ currentRef: "p/a", thinking: true, level: "high" });
    const row = (ref: string) => text().split("\n").find((l) => l.includes(` ${ref}`))!;
    expect(row("p/a")).toContain("primary");
    expect(row("p/a")).toContain("thinking high");
    expect(row("p/b")).not.toContain("primary");
  });

  it("names the picked models in the header, so no hunt through the list", () => {
    const { text } = build({
      currentRef: "p/a",
      fallbacks: ["p/b", "p/c"],
      thinking: true,
      level: "high",
    });
    const lines = text().split(String.fromCharCode(10));
    const line = (label: string) => lines.find((l) => l.includes(label))!;
    // Model names, not refs: the header is what a user reads without scanning.
    expect(line("Primary")).toContain("A (P)");
    expect(line("Fallback")).toContain("B (P) → C (P)");
    expect(line("Thinking")).toContain("high");
  });

  it("says handoff is off when nothing is picked", () => {
    const { text } = build({ currentRef: null, thinking: true });
    expect(text()).toContain("none — vision watcher off");
  });

  it("does not print the primary twice when it is also a chain member", () => {
    const { text } = build({ currentRef: "p/a", fallbacks: ["p/a", "p/b"] });
    const lines = text().split(String.fromCharCode(10));
    const fallback = lines.find((l) => l.includes("Fallback"))!;
    expect(fallback).toContain("B (P)");
    expect(fallback).not.toContain("A (P)");
    // The row says "primary", not "primary · fallback 1".
    const row = lines.find((l) => l.includes(" p/a"))!;
    expect(row).toContain("primary");
    expect(row).not.toContain("fallback");
  });

  it("marks a model without reasoning instead of silently ignoring thinking", () => {
    const noReasoning = [{ provider: "p", id: "plain", name: "plain", input: ["text", "image"] as const }];
    const component = new VisionModelSelectorComponent(
      theme,
      noReasoning as any,
      "p/plain",
      true,
      "high",
      false,
      vi.fn(),
    );
    const row = component.render(100).find((l) => l.includes(" p/plain"))!;
    expect(row).toContain("no thinking");
  });

  it("tells the None row what no choice means", () => {
    const row = (text: string) => text.split("\n").find((l) => l.includes("None"))!;
    expect(row(build().text())).toContain("no handoff");
    expect(row(build({ currentRef: "p/a" }).text())).not.toContain("no handoff");
  });

  it("orders the fallback chain in the note column", () => {
    const { text } = build({ currentRef: "p/a", fallbacks: ["p/b", "p/c"] });
    const rows = text().split("\n");
    expect(rows.find((l) => l.includes(" p/b"))).toContain("fallback 1");
    expect(rows.find((l) => l.includes(" p/c"))).toContain("fallback 2");
    // No checkbox: the note column is the only place a row states its role.
    expect(rows.find((l) => l.includes(" p/a"))).toContain("primary");
    expect(rows.find((l) => l.includes(" p/a"))).not.toContain("[ ]");
    expect(rows.find((l) => l.includes(" p/a"))).not.toContain("fallback");
  });

  it("space selects the highlighted model as the primary", () => {
    const { component, done, text } = build({ currentRef: null });
    component.handleInput(DOWN); // None → p/a
    component.handleInput(SPACE);
    expect(text().split("\n").find((l) => l.includes(" p/a"))).toContain("primary");
    component.handleInput(ENTER);
    expect(done.mock.calls[0][0].ref).toBe("p/a");
  });

  it("space toggles the primary back off when it is already selected", () => {
    const { component, done, text } = build({ currentRef: "p/a" });
    component.handleInput(SPACE);
    expect(text().split("\n").find((l) => l.includes("None"))).toContain("no handoff");
    component.handleInput(ENTER);
    expect(done.mock.calls[0][0].ref).toBeNull();
  });

  it("types a space into the filter instead of toggling the primary", () => {
    const { component, done, text } = build({ currentRef: "p/a" });
    component.handleInput("/"); // open the filter
    component.handleInput("b");
    component.handleInput(SPACE); // part of the query, not a command
    // The live field wraps the cursor in escapes, so compare the plain text.
    const plain = text()
      .replace(/\u001b_[^\u0007]*\u0007/g, "")
      .replace(/\u001b\[[0-9;]*m/g, "");
    expect(plain).toContain("> b ");
    component.handleInput("\x03"); // ctrl+c drops the query
    component.handleInput(ENTER);
    expect(done.mock.calls[0][0].ref).toBe("p/a");
  });

  it("enter stops typing and a second enter adopts the match", () => {
    const { component, done } = build({ currentRef: "p/a" });
    component.handleInput("/");
    component.handleInput("b"); // p/b is the first match
    component.handleInput(ENTER); // leaves typing, keeps the query
    component.handleInput(ENTER); // adopt + save
    expect(done.mock.calls[0][0].ref).toBe("p/b");
  });

  it("keeps letters out of the filter until `/` opens it", () => {
    const { component, text } = build({ currentRef: "p/a" });
    component.handleInput("b");
    expect(text()).toContain("> Type to filter models…");
    component.handleInput("/");
    component.handleInput("b");
    expect(text()).toContain("> b");
  });

  it("adds chain members with tab and caps the chain", () => {
    const { component, done, text } = build({ currentRef: "p/a" });
    for (let i = 0; i < MAX_FALLBACKS; i++) {
      component.handleInput(TAB);
      component.handleInput(DOWN);
    }
    // One more than the cap — refused, with a hint.
    component.handleInput(TAB);
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

  it("toggles async with a and resets the chain with r", () => {
    const { component, done, text } = build({ currentRef: "p/a", fallbacks: ["p/b", "p/c"] });
    const legend = () => text().split(String.fromCharCode(10)).find((l) => l.includes("Async"))!;
    expect(legend()).toContain("[A] Async off");
    component.handleInput("a");
    expect(legend()).toContain("[A] Async on");
    component.handleInput("a");
    expect(legend()).toContain("[A] Async off");

    component.handleInput("r");
    component.handleInput(ENTER);
    expect(done.mock.calls[0][0].fallbackModels).toEqual([]);
  });

  it("keeps a and r as text while the filter owns the keyboard", () => {
    const { component, done, text } = build({ currentRef: "p/a", fallbacks: ["p/b"] });
    component.handleInput("/");
    component.handleInput("a");
    component.handleInput("r");
    expect(text()).toContain("> ar");
    component.handleInput(ENTER); // stop typing, keep the query
    component.handleInput(ENTER); // save
    expect(done.mock.calls[0][0].fallbackModels).toEqual(["p/b"]);
  });

  it("toggles a chain member back out", () => {
    const { component, done } = build({ currentRef: "p/a", fallbacks: ["p/a", "p/b"] });
    component.handleInput(TAB); // drop p/a
    component.handleInput(ENTER);
    expect(done.mock.calls[0][0].fallbackModels).toEqual(["p/b"]);
  });

  it("keeps chain order and preserves unresolvable refs", () => {
    const { component, done } = build({ currentRef: "p/a", fallbacks: ["ghost/model", "p/b"] });
    component.handleInput(ENTER);
    expect(done.mock.calls[0][0].fallbackModels).toEqual(["p/b", "ghost/model"]);
  });

  it("resets all fallbacks with ctrl+shift+r", () => {
    const { component, done } = build({ currentRef: "p/a", fallbacks: ["ghost/model", "p/b", "p/c"] });
    component.handleInput(CTRL_SHIFT_R);
    component.handleInput(ENTER);
    expect(done.mock.calls[0][0].fallbackModels).toEqual([]);
  });

  it("reorders the highlighted row with alt+up/alt+down", () => {
    const { component, text } = build();
    component.handleInput(DOWN); // None → p/a
    component.handleInput(DOWN); // p/a → p/b
    component.handleInput(ALT_UP); // p/b before p/a
    expect(text().indexOf(" p/b")).toBeLessThan(text().indexOf(" p/a"));
    component.handleInput(ALT_DOWN); // back to start
    expect(text().indexOf(" p/a")).toBeLessThan(text().indexOf(" p/b"));
  });

  it("never reorders the pinned None row", () => {
    const { component, text } = build();
    component.handleInput(DOWN); // None → p/a
    component.handleInput(ALT_UP); // would cross None
    const rows = text().split("\n").filter((l) => l.includes(" p/"));
    expect(rows[0]).toContain(" p/a");
  });

  it("leaves alt+up/alt+down alone while a filter is active", () => {
    const { component, text } = build();
    component.handleInput("/");
    component.handleInput("b");
    component.handleInput(ENTER); // stop typing, keep the filter
    component.handleInput(ALT_DOWN);
    expect(text().indexOf(" p/a")).toBeLessThan(text().indexOf(" p/b"));
  });

  it("counts only models, even when the filter drops the None row", () => {
    const { component, text } = build({ currentRef: "p/a" });
    component.handleInput("/");
    component.handleInput("c"); // only p/c matches, None does not
    const legend = text().split(String.fromCharCode(10)).find((l) => l.includes("matches"))!;
    expect(legend).toContain("1 matches");
  });

  it("packs the legend into rows that fit, count first and no key split", () => {
    const { text, component } = build();
    const lines = text().split(String.fromCharCode(10));
    const flat = (line: string) => line.replace(/^│ | +│$/g, "").replace(/\s+/g, " ");
    const first = lines.find((l) => l.includes("4 models"))!;
    expect(flat(first).startsWith("4 models · [Space] Primary")).toBe(true);

    const keys = [
      "[Space] Primary",
      "[Tab] Fallback",
      "[Shift+tab] Think",
      "[A] Async off",
      "[/] Filter",
      "[R] Reset",
      "[Enter] Save",
      "[Esc] Cancel",
    ];
    const legend = lines
      .filter((l) => keys.some((k) => l.includes(k)) || l.includes("4 models"))
      .map(flat)
      .join(" ");
    for (const key of keys) expect(legend).toContain(key);
    // Every legend row fits the frame, so a key is never cut in half.
    for (const row of component.render(100)) {
      expect(visibleWidth(row)).toBeLessThanOrEqual(100);
    }
  });

  it("truncates a long row instead of wrapping into the frame", () => {
    const long = Array.from({ length: 3 }, (_, i) => ({
      provider: "p",
      id: `model-with-a-long-name-${i}`,
      name: "Long Vision Model",
      input: ["text", "image"] as const,
      reasoning: true,
    }));
    const component = new VisionModelSelectorComponent(
      theme,
      long as any,
      "p/model-with-a-long-name-0",
      true,
      "high",
      false,
      vi.fn(),
    );
    // One line per model: a wrapped row would add a line starting mid-word and
    // break the box grammar, even though each line would still fit the frame.
    const rows = component.render(40).filter((l) => l.includes("p/model-"));
    expect(rows).toHaveLength(3);
    for (const line of component.render(40)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
  });

  it("announces hidden rows with ↑ above the list and ↓ below it", () => {
    const many = Array.from({ length: 16 }, (_, i) => ({
      provider: "p",
      id: `m${i}`,
      name: `m${i}`,
      input: ["text", "image"] as const,
      reasoning: true,
    }));
    const done = vi.fn();
    // Cursor mid-list (m8, the 9th of 17 rows) so the window scrolls and both
    // ends hide rows: 4 above, 3 below.
    const component = new VisionModelSelectorComponent(theme, many as any, "p/m8", false, "medium", false, done);
    const lines = component.render(80);
    const up = lines.findIndex((l) => l.includes("↑ 4 more"));
    const down = lines.findIndex((l) => l.includes("↓ 3 more"));
    const firstRow = lines.findIndex((l) => l.includes("p/m"));
    const lastRow = lines.map((l) => l.includes("p/m") || l.includes("→ ")).lastIndexOf(true);
    expect(up).toBeGreaterThanOrEqual(0);
    expect(up).toBeLessThan(firstRow);
    expect(down).toBeGreaterThan(lastRow);
  });

  it("walks the thinking ladder with shift+tab and wraps without sticking", () => {
    const { component, text } = build({ currentRef: "p/a", level: "medium" });
    const thinking = () => {
      const row = text().split("\n").find((l) => l.includes(" p/a"))!;
      return row.includes("thinking off") ? "off" : /thinking (\w+)/.exec(row)![1];
    };
    expect(thinking()).toBe("off");
    // The ladder always advances through every level and back to off — it must
    // not degenerate into off → max → off once the tail is reached.
    for (const expected of [
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "off",
      "minimal",
    ]) {
      component.handleInput(SHIFT_TAB);
      expect(thinking()).toBe(expected);
    }
  });

  it("toggles the chain with tab", () => {
    const { component, done } = build({ currentRef: "p/a" });
    component.handleInput(TAB);
    component.handleInput(ENTER);
    expect(done.mock.calls[0][0].fallbackModels).toEqual(["p/a"]);
  });

  it("ignores ctrl+enter now that tab owns the chain", () => {
    const { component, done } = build({ currentRef: "p/a" });
    component.handleInput("\x1b[13;5u");
    component.handleInput(ENTER);
    expect(done.mock.calls[0][0].fallbackModels).toEqual([]);
  });

  it("ignores ctrl+shift+t now that shift+tab owns the thinking ladder", () => {
    const { component, text } = build({ currentRef: "p/a", level: "medium" });
    component.handleInput("\x1b[116;6u");
    const row = text().split("\n").find((l) => l.includes(" p/a"))!;
    expect(row).toContain("thinking off");
  });

  it("toggles async paste handoff with alt+a and ctrl+alt+a", () => {
    for (const key of [ALT_A, CTRL_ALT_A]) {
      const { component, text } = build();
      expect(text()).toContain("Async off");
      component.handleInput(key);
      expect(text()).toContain("Async on");
    }
  });


  it("labels the filter field and keeps it in the list gutter", () => {
    const { component } = build();
    const idle = component.render(100).find((l) => l.includes("Type to filter models"));
    expect(idle).toBeDefined();
    // One-space gutter: the idle prompt, the rows and the legend all sit one
    // pad in from the wall, like the providers model list.
    expect(idle!.startsWith("│ > ")).toBe(true);
    component.handleInput("/");
    // The live field draws pi-tui's cursor inside the placeholder, so match the
    // gutter rather than the text.
    const live = component.render(100).find((l) => l.includes("│ > "));
    expect(live).toBeDefined();
    expect(component.render(100).filter((l) => l.includes("filter models")).length).toBe(1);
  });

  it("hugs the ref with a coloured role marker and a dim fact", () => {
    // A theme stub that paints its colour into the text and has no `primary`
    // slot, the way pi's own tokens behave, so the fallback tone is exercised.
    const t = {
      fg: (color: string, text: string) => {
        if (color === "primary") throw new Error("Unknown theme color: primary");
        return `<${color}>${text}</>`;
      },
      bold: (s: string) => s,
    } as any;
    const component = new VisionModelSelectorComponent(
      t,
      models as any,
      "p/a",
      true,
      "high",
      false,
      vi.fn(),
      ["p/a", "p/b"],
    );
    const rows = component.render(120);
    const row = (ref: string) => rows.find((l) => l.includes(ref))!;
    expect(row("p/a")).toContain("<accent>✓ primary</>");
    expect(row("p/a")).toContain("<dim>(thinking high)</>");
    expect(row("p/b")).toContain("<warning>✓ fallback 1</>");
    // The primary is tried first, so it never reads as a chain member.
    expect(row("p/a")).not.toContain("fallback");
    // Hug, not a column: one space between the ref and the marker.
    expect(row("p/a")).toContain("</> <accent>✓ primary</>");
  });
});
