import { describe, expect, it } from "vitest";
import { estimatorAdminCss } from "../admin/styles.js";
import { BRAND_TOKEN_NAMES, brandStyle, CONTRAST_PAIRS, contrastRatio, DARK_TOKENS, declareTokens, estimatorWidgetCss, LIGHT_TOKENS } from "../styles.js";

/**
 * Every colour pair the widget prints passes WCAG AA in BOTH themes (4.5:1 for
 * text; 3:1 for borders and the focus ring), and every token the contract
 * names (9.2) is declared, at zero specificity, in light and in dark.
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

  it("measures the way WCAG does", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#8494a1", "#ffffff")).toBeLessThan(4.5);
  });
});

describe("tokens", () => {
  const NAMES = [
    "ground", "surface", "ink", "muted", "faint", "line", "line-strong", "accent", "accent-strong", "accent-soft", "accent-ink", "on-accent",
    "ok", "ok-soft", "warn", "warn-soft", "danger", "danger-soft", "on-danger", "focus", "radius", "radius-sm", "shadow", "shadow-lg", "scrim", "font",
  ];

  it("declares every token the contract names, and a dark value for every colour", () => {
    expect(Object.keys(LIGHT_TOKENS).sort()).toEqual([...NAMES].sort());
    const colours = Object.keys(LIGHT_TOKENS).filter((k) => LIGHT_TOKENS[k]!.startsWith("#"));
    for (const name of colours) expect(DARK_TOKENS[name], name).toMatch(/^#/);
  });

  it("declares them at zero specificity, with dark from the OS unless pinned light, and when pinned dark", () => {
    const css = estimatorWidgetCss();
    expect(css).toContain(`:where(.aiew-root) { ${declareTokens(LIGHT_TOKENS)} }`);
    expect(css).toContain(`@media (prefers-color-scheme: dark) {\n  :where(.aiew-root:not([data-theme="light"])) { ${declareTokens(DARK_TOKENS)} }`);
    expect(css).toContain(`:where(.aiew-root[data-theme="dark"]) { ${declareTokens(DARK_TOKENS)} }`);
  });

  it("the business's colour: both themes' sets inline, picked by the same theme rules, after the base palette", () => {
    const css = estimatorWidgetCss();
    const light = css.indexOf(":where(.aiew-root[data-brand]) {");
    const darkOs = css.indexOf(':where(.aiew-root[data-brand]:not([data-theme="light"]))');
    const darkPinned = css.indexOf(':where(.aiew-root[data-brand][data-theme="dark"])');
    expect(light).toBeGreaterThan(css.indexOf(':where(.aiew-root[data-theme="dark"])'));
    expect(darkOs).toBeGreaterThan(light);
    expect(darkPinned).toBeGreaterThan(darkOs);
    for (const name of BRAND_TOKEN_NAMES) expect(css).toContain(`--aiew-${name}: var(--aiew-bl-${name});`);
    const style = brandStyle("#7C3AED");
    expect(Object.keys(style)).toHaveLength(BRAND_TOKEN_NAMES.length * 2);
    expect(style["--aiew-bl-accent"]).toBe("#7c3aed");
    expect(style["--aiew-bd-accent"]).toBe("#7c3aed");
    expect(brandStyle("red")).toEqual({});
    expect(brandStyle(null)).toEqual({});
  });

  it("prefixes every class rule aiew-, never hides the honeypot with display:none, and has no 0.1 'aie-' rules or font shorthand", () => {
    for (const css of [estimatorWidgetCss(), estimatorAdminCss()]) {
      const selectors = css.match(/^[^@{}\n:][^{}\n]*(?=\{)/gm) ?? [];
      for (const selector of selectors) {
        for (const cls of selector.match(/\.[a-z][\w-]*/g) ?? []) expect(cls.startsWith(".aiew-"), `${cls} in "${selector.trim()}"`).toBe(true);
      }
      expect(css).not.toMatch(/\.aie-/);
      expect(css).not.toMatch(/\bfont:\s*\d/);
    }
    expect(estimatorWidgetCss()).toMatch(/\.aiew-hp \{ position: absolute; left: -10000px;/);
    expect(estimatorWidgetCss()).not.toMatch(/\.aiew-hp[^}]*display:\s*none/);
  });

  it("uses no colour outside the tokens in component rules", () => {
    for (const css of [estimatorWidgetCss(), estimatorAdminCss()]) {
      const rules = css.split("\n").filter((line) => !line.includes("--aiew-") || line.includes("var("));
      const bare = rules.filter((line) => /#[0-9a-f]{3,8}\b/i.test(line) && !line.includes(":where("));
      expect(bare).toEqual([]);
    }
  });

  it("prints the quote clean: light colours, no buttons", () => {
    const css = estimatorWidgetCss();
    const print = css.slice(css.indexOf("@media print"));
    expect(print).toContain(".aiew-no-print, .aiew-root .aiew-btn, .aiew-fab { display: none !important; }");
    expect(print).toContain(declareTokens(LIGHT_TOKENS));
  });

  it("every tap target the widget draws is at least 44px", () => {
    const css = estimatorWidgetCss() + estimatorAdminCss();
    for (const cls of [".aiew-btn {", ".aiew-chip {", ".aiew-stepper-btn {", ".aiew-input {", ".aiew-dialog-close {", ".aiew-filter {", ".aiew-tab {"]) {
      const start = css.indexOf("\n" + cls);
      expect(start, cls).toBeGreaterThan(-1);
      const rule = css.slice(start, css.indexOf("}", start));
      expect(rule, cls).toMatch(/min-height: 44px|width: 44px; min-height: 44px/);
    }
  });
});
