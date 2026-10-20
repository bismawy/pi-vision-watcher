import { describe, expect, it, vi } from "vitest";
import { VisionModelSelectorComponent } from "../../src/vision-model-selector.js";

const models = [{ provider: "p", id: "a", name: "A", input: ["text", "image"], reasoning: true }] as any;
const plain = (_c: string, t: string) => t;

function build(theme: any, borderLevel?: string) {
  return new VisionModelSelectorComponent(theme, models, null, false, "medium", false, () => {}, [], borderLevel as any);
}

describe("selector frame border", () => {
  it("paints the frame with the session thinking border", () => {
    const getThinkingBorderColor = vi.fn(() => (s: string) => "<T>" + s);
    const lines = build({ fg: plain, bold: (t: string) => t, getThinkingBorderColor }, "high").render(60);
    expect(getThinkingBorderColor).toHaveBeenCalledWith("high");
    expect(lines[0]!.startsWith("<T>╭")).toBe(true);
    expect(lines[lines.length - 1]!.startsWith("<T>╰")).toBe(true);
  });

  it("never probes accentSoft through fg", () => {
    const fg = vi.fn(plain);
    build({ fg, bold: (t: string) => t }).render(60);
    expect(fg.mock.calls.some(([c]) => c === "accentSoft")).toBe(false);
  });
});
