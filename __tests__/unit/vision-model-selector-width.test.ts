import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { VisionModelSelectorComponent } from "../../src/vision-model-selector.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

const build = () =>
  new VisionModelSelectorComponent(
    theme,
    [{ provider: "provider-with-a-long-name", id: "model-with-a-long-name", name: "Long Vision Model", input: ["text", "image"], reasoning: true }],
    null,
    true,
    "high",
    true,
    () => {},
  );

describe("VisionModelSelectorComponent", () => {
  // 12 is the narrowest width that still fits the box; 8 checks the fallback
  // path that drops the border instead of drawing over the content.
  it.each([8, 12, 20, 40, 60])("never renders wider than %i columns", (width) => {
    const component = build();

    for (const line of component.render(width)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it.each([12, 20, 60])("frames the dialog in a rounded %i-column box", (width) => {
    const lines = build().render(width);

    expect(lines[0]).toMatch(/^╭─+╮$/);
    expect(lines[lines.length - 1]).toMatch(/^╰─+╯$/);
    for (const line of lines) expect(visibleWidth(line)).toBe(width);
    for (const line of lines.slice(1, -1)) {
      expect(line.startsWith("│ ") && line.endsWith(" │")).toBe(true);
    }
  });

  it.each([20, 40, 60])("never renders wider than %i columns with a fallback chain", (width) => {
    const component = new VisionModelSelectorComponent(
      theme,
      [{ provider: "provider-with-a-long-name", id: "model-with-a-long-name", name: "Long Vision Model", input: ["text", "image"], reasoning: true }],
      "provider-with-a-long-name/model-with-a-long-name",
      true,
      "high",
      true,
      () => {},
      ["provider-with-a-long-name/model-with-a-long-name"],
    );

    for (const line of component.render(width)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });
});
