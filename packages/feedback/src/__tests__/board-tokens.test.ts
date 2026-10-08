import { describe, expect, it } from "vitest";
import {
  CONTRAST_PAIRS,
  DARK_PALETTE,
  LIGHT_PALETTE,
  contrastRatio,
  paletteDeclarations,
} from "../board-tokens";

describe("board palette contrast (WCAG AA)", () => {
  for (const [name, palette] of [
    ["light", LIGHT_PALETTE],
    ["dark", DARK_PALETTE],
  ] as const) {
    for (const [fg, bg, min, where] of CONTRAST_PAIRS) {
      it(`${name}: ${fg} on ${bg} ≥ ${min}:1 (${where})`, () => {
        expect(contrastRatio(palette[fg], palette[bg])).toBeGreaterThanOrEqual(min);
      });
    }
  }

  it("measures the way WCAG does", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    // 0.8.0's ink-faint on white — the value this test exists to keep out.
    expect(contrastRatio("#8494a1", "#ffffff")).toBeLessThan(4.5);
  });

  it("declares every palette entry as an --aib- custom property", () => {
    const css = paletteDeclarations(LIGHT_PALETTE);
    for (const key of Object.keys(LIGHT_PALETTE)) expect(css).toContain(`--aib-${key}:`);
    expect(Object.keys(DARK_PALETTE)).toEqual(Object.keys(LIGHT_PALETTE));
  });
});
