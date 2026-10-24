import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { boxEdge, boxRow, softPainter, VisionModelSelectorComponent } from "../../src/vision-model-selector.js";

const id = (s: string) => s;

describe("softPainter", () => {
  it("prefers a declared accentSoft colour without calling fg on it", () => {
    const fg = vi.fn((_c: string, t: string) => t);
    const style = vi.fn((t: string, o: { fg: unknown }) => "<" + JSON.stringify(o.fg) + ">" + t);
    const declared = { kind: "oklch", l: 0.9, c: 0.01, h: 10 };
    const paint = softPainter({ fg, bold: id, style, colors: { accentSoft: declared } } as any, "borderAccent", "accent");
    paint("x");
    expect(style).toHaveBeenCalledWith("x", { fg: declared });
    expect(fg).not.toHaveBeenCalled();
  });

  it("derives the soft tier from borderAccent: L 0.82, chroma x0.18, hue kept", () => {
    const style = vi.fn((t: string) => t);
    const th = { fg: vi.fn(), bold: id, style, colors: { borderAccent: { kind: "oklch", l: 0.5, c: 0.2, h: 250 } } };
    softPainter(th as any, "borderAccent", "accent")("x");
    const fg = ((style.mock.calls[0] as unknown[])[1] as { fg: { kind: string; l: number; c: number; h: number } }).fg;
    expect(fg.kind).toBe("oklch");
    expect(fg.l).toBe(0.82);
    expect(fg.c).toBeCloseTo(0.036, 10);
    expect(fg.h).toBe(250);
    expect(th.fg).not.toHaveBeenCalled();
  });

  it("falls back to an official token when the theme has no colors/style", () => {
    const fg = vi.fn((c: string, t: string) => c + ":" + t);
    const paint = softPainter({ fg, bold: id } as any, "borderAccent", "accent");
    expect(() => paint("x")).not.toThrow();
    expect(paint("x")).toBe("accent:x");
    expect(fg.mock.calls.every(([c]) => c !== "accentSoft")).toBe(true);
  });
});

describe("rounded frame helpers", () => {
  it("draws rounded edges and degrades at narrow widths", () => {
    expect(boxEdge("╭", "╮", 6, id)).toBe("╭────╮");
    expect(boxEdge("╭", "╮", 2, id)).toBe("╭╮");
    expect(boxEdge("╭", "╮", 1, id)).toBe("");
  });

  it("keeps content inside width - 4 and pads to the wall", () => {
    const row = boxRow("abcdefghijklmnop", 10, id);
    expect(row.replace(/\u001b\[[0-9;]*m/g, "")).toBe("│ abcdef │");
    expect(visibleWidth(row)).toBe(10);
    expect(visibleWidth(boxRow("a", 10, id))).toBe(10);
    expect(boxRow("", 6, id)).toBe("│    │");
    expect(boxRow("abc", 3, id)).toBe("");
  });
});

describe("VisionModelSelectorComponent arnative look", () => {
  const models = [{ provider: "p", id: "a", name: "a", input: ["text", "image"], reasoning: false }];
  const tagged = {
    fg: (c: string, t: string) => "<" + c + ">" + t + "</" + c + ">",
    bold: (t: string) => "<b>" + t + "</b>",
    style: (t: string) => "<soft>" + t + "</soft>",
    colors: {
      accent: { kind: "oklch", l: 0.6, c: 0.2, h: 30 },
      borderAccent: { kind: "oklch", l: 0.6, c: 0.2, h: 30 },
    },
  };

  it("wraps every rendered line in the rounded frame within width", () => {
    const plain = { fg: (_c: string, t: string) => t, bold: id };
    for (const width of [20, 40, 80]) {
      const c = new VisionModelSelectorComponent(plain as any, models as any, "p/a", false, "medium", false, () => {});
      const lines = c.render(width);
      expect(lines[0]!.startsWith("╭")).toBe(true);
      expect(lines.at(-1)!.startsWith("╰")).toBe(true);
      for (const line of lines.slice(1, -1)) expect(line.startsWith("│ ")).toBe(true);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("keeps the marker accent and paints only the label soft + bold", () => {
    const c = new VisionModelSelectorComponent(tagged as any, models as any, "p/a", false, "medium", false, () => {});
    const row = c.render(400).find((l) => l.includes("→"))!;
    expect(row).toContain("<accent>→ </accent>");
    expect(row).toContain("<soft><b>p/a</b></soft>");
    expect(row).not.toContain("<accent>a</accent>");
  });
});
