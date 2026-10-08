import { describe, expect, it } from "vitest";
import { CONTRAST_PAIRS, DARK_PALETTE, LIGHT_PALETTE, contrastRatio, paletteDeclarations } from "../ui-tokens.js";
import { audienceCss } from "../ui.js";

describe("audience palette contrast (WCAG AA)", () => {
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
    expect(contrastRatio("#8494a1", "#ffffff")).toBeLessThan(4.5);
  });

  it("declares every palette entry as an --aiu- custom property, in both themes", () => {
    const css = paletteDeclarations(LIGHT_PALETTE);
    for (const key of Object.keys(LIGHT_PALETTE)) expect(css).toContain(`--aiu-${key}:`);
    expect(Object.keys(DARK_PALETTE)).toEqual(Object.keys(LIGHT_PALETTE));
  });

  it("every colour in the stylesheet resolves through a token (no bare hex a theme forgets)", () => {
    const rules = audienceCss.replace(/--aiu-[\w-]+:\s*#[0-9a-f]{6};/gi, "");
    expect(rules.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([]);
    // Every var() the sheet reads is a declared token.
    const used = new Set([...audienceCss.matchAll(/var\(--aiu-([\w-]+)\)/g)].map((m) => m[1]));
    for (const name of used) expect(Object.keys(LIGHT_PALETTE), `--aiu-${name}`).toContain(name);
  });

  it("tokens and base styles sit at zero specificity; forced colours are handled", () => {
    expect(audienceCss).toContain(":where(.aiu-root) { --aiu-surface:");
    expect(audienceCss).toContain("@media (forced-colors: active)");
    expect(audienceCss).toContain("@media (prefers-color-scheme: dark)");
  });
});
