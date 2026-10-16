import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONTRAST_PAIRS, contrastRatio, DARK_TOKENS, declareTokens, filesWidgetCss, LIGHT_TOKENS } from "../styles.js";

/**
 * Every colour pair the screens print passes WCAG AA in BOTH themes, every
 * token is declared at zero specificity in light and dark, every class is
 * `aifw-`-prefixed, and every control is at least 44 px under 640 px.
 */

describe("palette contrast (WCAG AA)", () => {
  const dark = { ...LIGHT_TOKENS, ...DARK_TOKENS };
  for (const [name, palette] of [
    ["light", LIGHT_TOKENS],
    ["dark", dark],
  ] as const) {
    for (const [fg, bg, min] of CONTRAST_PAIRS) {
      it(`${name}: ${fg} on ${bg} ≥ ${min}:1`, () => {
        expect(contrastRatio(palette[fg]!, palette[bg]!)).toBeGreaterThanOrEqual(min);
      });
    }
  }
});

describe("tokens and classes", () => {
  it("declares the tokens at zero specificity, light and dark", () => {
    const css = filesWidgetCss();
    expect(css).toContain(`:where(.aifw-root) { ${declareTokens(LIGHT_TOKENS)} }`);
    expect(css).toContain(`:where(.aifw-root:not([data-theme="light"])) { ${declareTokens(DARK_TOKENS)} }`);
    expect(css).toContain(`:where(.aifw-root[data-theme="dark"]) { ${declareTokens(DARK_TOKENS)} }`);
  });

  it("prefixes every class aifw-, and uses no colour outside the tokens", () => {
    const css = filesWidgetCss();
    const selectors = css.match(/^[^@{}\n:][^{}\n]*(?=\{)/gm) ?? [];
    for (const selector of selectors) {
      for (const cls of selector.match(/\.[a-z][\w-]*/g) ?? []) expect(cls.startsWith(".aifw-"), `${cls} in "${selector.trim()}"`).toBe(true);
    }
    const bare = css.split("\n").filter((line) => /#[0-9a-f]{3,8}\b/i.test(line) && !line.includes(":where("));
    expect(bare).toEqual([]);
  });

  it("44 px targets under 640 px: buttons, chips and the sort", () => {
    const css = filesWidgetCss();
    expect(css).toContain("@media (max-width: 640px) { .aifw-btn, .aifw-btn-sm { min-height: 44px; } }");
    expect(css).toContain("@media (max-width: 640px) { .aifw-chip { min-height: 44px; } }");
    expect(css).toMatch(/@media \(max-width: 640px\) \{ \.aifw-select \{ min-height: 44px;/);
  });

  it("every class the components use is styled", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const admin = resolve(here, "../admin");
    const sources = [
      ...readdirSync(admin)
        .filter((f) => f.endsWith(".tsx"))
        .map((f) => readFileSync(resolve(admin, f), "utf8")),
      readFileSync(resolve(here, "../ui.tsx"), "utf8"),
    ].join("\n");
    const classAttrs = [...sources.matchAll(/className=\{?[`"]([^`"]*)[`"]/g)].map((m) => m[1] ?? "").join(" ");
    const used = new Set([...classAttrs.matchAll(/(?<![\w-])aifw-[a-z0-9-]+/g)].map((m) => m[0]));
    expect(used.size).toBeGreaterThan(30);
    const css = filesWidgetCss();
    for (const cls of used) {
      if (cls.endsWith("-")) continue;
      expect(css.includes(`.${cls}`), cls).toBe(true);
    }
    for (const tone of ["warn", "error", "info"]) expect(css).toContain(`.aifw-notice-${tone}`);
  });
});
