import { describe, expect, it } from "vitest";
import { tenancyAdminCss } from "../admin/styles.js";
import { CONTRAST_PAIRS, contrastRatio, DARK_TOKENS, declareTokens, LIGHT_TOKENS, tenancyWidgetCss } from "../styles.js";

/**
 * Every colour pair the widget prints passes WCAG AA in BOTH themes (4.5:1 for
 * text; 3:1 for borders and the focus ring), and every token the contract
 * names (booking's set) is declared, at zero specificity, in light and dark.
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

describe("tokens", () => {
  const NAMES = [
    "ground", "surface", "ink", "muted", "faint", "line", "line-strong", "accent", "accent-strong", "accent-soft", "on-accent",
    "ok", "ok-soft", "warn", "warn-soft", "danger", "danger-soft", "on-danger", "focus", "radius", "radius-sm", "shadow", "font",
  ];

  it("declares every token the contract names, and every colour has a dark value", () => {
    for (const name of NAMES) expect(Object.keys(LIGHT_TOKENS)).toContain(name);
    const colours = Object.keys(LIGHT_TOKENS).filter((k) => LIGHT_TOKENS[k]!.startsWith("#"));
    for (const name of colours) expect(DARK_TOKENS[name], name).toMatch(/^#/);
  });

  it("declares them at zero specificity, dark from the OS unless pinned light, and when pinned dark", () => {
    const css = tenancyWidgetCss();
    expect(css).toContain(`:where(.aitw-root) { ${declareTokens(LIGHT_TOKENS)} }`);
    expect(css).toContain(`@media (prefers-color-scheme: dark) {\n  :where(.aitw-root:not([data-theme="light"])) { ${declareTokens(DARK_TOKENS)} }`);
    expect(css).toContain(`:where(.aitw-root[data-theme="dark"]) { ${declareTokens(DARK_TOKENS)} }`);
  });

  it("prefixes every class rule aitw-", () => {
    for (const css of [tenancyWidgetCss(), tenancyAdminCss()]) {
      const selectors = css.match(/^[^@{}\n:][^{}\n]*(?=\{)/gm) ?? [];
      expect(selectors.length).toBeGreaterThan(20);
      for (const selector of selectors) {
        for (const cls of selector.match(/\.[a-z][\w-]*/g) ?? []) expect(cls.startsWith(".aitw-"), `${cls} in "${selector.trim()}"`).toBe(true);
      }
    }
  });

  it("uses no colour outside the tokens in component rules", () => {
    for (const css of [tenancyWidgetCss(), tenancyAdminCss()]) {
      const rules = css.split("\n").filter((line) => !line.includes("--aitw-") || line.includes("var("));
      const bare = rules.filter((line) => /#[0-9a-f]{3,8}\b/i.test(line) && !line.includes(":where("));
      expect(bare).toEqual([]);
    }
  });

  it("gives every button and menu item a 44px target, and respects reduced motion", () => {
    const css = tenancyWidgetCss();
    for (const cls of ["aitw-btn", "aitw-switcher-btn", "aitw-menu-item", "aitw-input", "aitw-dialog-close"]) {
      const rule = css.match(new RegExp(`\\.${cls} \\{[^}]*\\}`))?.[0] ?? "";
      expect(rule, cls).toMatch(/min-height: 44px/);
    }
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("outline: 2px solid var(--aitw-focus)");
  });
});
