import { describe, expect, it } from "vitest";
import { schedulingAdminCss } from "../admin/styles.js";
import { CONTRAST_PAIRS, contrastRatio, DARK_TOKENS, declareTokens, LIGHT_TOKENS, schedulingWidgetCss } from "../styles.js";

/**
 * Every colour pair the widget prints passes WCAG AA in BOTH themes (4.5:1 for
 * text; 3:1 for borders, the focus ring and crew stripes), and every token the
 * contract names is declared, at zero specificity, in light and in dark.
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
    "ground", "surface", "ink", "muted", "faint", "line", "line-strong", "accent", "accent-strong", "accent-soft", "on-accent",
    "ok", "ok-soft", "warn", "warn-soft", "danger", "danger-soft", "on-danger", "focus", "radius", "radius-sm", "shadow", "font",
    "pending", "pending-soft", "progress", "progress-soft", "done", "done-soft", "inactive",
    "crew-1", "crew-2", "crew-3", "crew-4", "crew-5", "crew-6", "crew-7", "crew-8",
  ];

  it("declares every token the contract names", () => {
    for (const name of NAMES) expect(Object.keys(LIGHT_TOKENS)).toContain(name);
    const colours = Object.keys(LIGHT_TOKENS).filter((k) => LIGHT_TOKENS[k]!.startsWith("#"));
    // Every colour has a dark value too: one bare light-only colour is a rule nobody re-tests at night.
    for (const name of colours) expect(DARK_TOKENS[name], name).toMatch(/^#/);
  });

  it("declares them at zero specificity, with dark from the OS unless pinned light, and when pinned dark", () => {
    const css = schedulingWidgetCss();
    expect(css).toContain(`:where(.aisw-root) { ${declareTokens(LIGHT_TOKENS)} }`);
    expect(css).toContain(`@media (prefers-color-scheme: dark) {\n  :where(.aisw-root:not([data-theme="light"])) { ${declareTokens(DARK_TOKENS)} }`);
    expect(css).toContain(`:where(.aisw-root[data-theme="dark"]) { ${declareTokens(DARK_TOKENS)} }`);
  });

  it("prefixes every class rule aisw-, and never hides the honeypot with display:none", () => {
    for (const css of [schedulingWidgetCss(), schedulingAdminCss()]) {
      const selectors = css.match(/^[^@{}\n:][^{}\n]*(?=\{)/gm) ?? [];
      for (const selector of selectors) {
        for (const cls of selector.match(/\.[a-z][\w-]*/g) ?? []) expect(cls.startsWith(".aisw-"), `${cls} in "${selector.trim()}"`).toBe(true);
      }
    }
    expect(schedulingWidgetCss()).toMatch(/\.aisw-hp \{ position: absolute; left: -10000px;/);
    expect(schedulingWidgetCss()).not.toMatch(/\.aisw-hp[^}]*display:\s*none/);
  });

  it("uses no colour outside the tokens in component rules", () => {
    for (const css of [schedulingWidgetCss(), schedulingAdminCss()]) {
      const rules = css.split("\n").filter((line) => !line.includes("--aisw-") || line.includes("var("));
      const bare = rules.filter((line) => /#[0-9a-f]{3,8}\b/i.test(line) && !line.includes(":where("));
      expect(bare).toEqual([]);
    }
  });
});
