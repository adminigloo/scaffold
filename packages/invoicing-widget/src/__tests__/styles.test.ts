import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  brandTokens,
  CONTRAST_PAIRS,
  contrastRatio,
  DARK_TOKENS,
  declareTokens,
  invoicingAdminCss,
  invoicingWidgetCss,
  LIGHT_TOKENS,
} from "../styles.js";

/**
 * Every colour pair the widget prints passes WCAG AA in BOTH themes, any
 * colour an owner picks as `accentColor` keeps its pairs AA, every token is
 * declared at zero specificity, and every class is `aiiw-`-prefixed.
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

describe("the business's colour (accentColor)", () => {
  const colours = ["#1f7a3a", "#ffd400", "#ffffff", "#000000", "#c2410c", "#7c3aed", "#00b3b3", "#808080", "#e11d48", "#0ea5e9"];
  for (const colour of colours) {
    for (const theme of ["light", "dark"] as const) {
      it(`${colour} in ${theme}`, () => {
        const palette = { ...(theme === "dark" ? { ...LIGHT_TOKENS, ...DARK_TOKENS } : LIGHT_TOKENS), ...brandTokens(colour, theme) };
        for (const [fg, bg, min] of CONTRAST_PAIRS) {
          if (![fg, bg].some((n) => n.startsWith("accent") || n === "on-accent" || n === "focus")) continue;
          expect(contrastRatio(palette[fg]!, palette[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(min);
        }
      });
    }
  }
});

describe("tokens and classes", () => {
  it("declares the tokens at zero specificity, light and dark", () => {
    const css = invoicingWidgetCss();
    expect(css).toContain(`:where(.aiiw-root) { ${declareTokens(LIGHT_TOKENS)} }`);
    expect(css).toContain(`:where(.aiiw-root:not([data-theme="light"])) { ${declareTokens(DARK_TOKENS)} }`);
    expect(css).toContain(`:where(.aiiw-root[data-theme="dark"]) { ${declareTokens(DARK_TOKENS)} }`);
    for (const name of Object.keys(LIGHT_TOKENS).filter((k) => LIGHT_TOKENS[k]!.startsWith("#"))) {
      expect(DARK_TOKENS[name], name).toMatch(/^#/);
    }
  });

  it("prefixes every class aiiw-, and uses no colour outside the tokens", () => {
    for (const css of [invoicingWidgetCss(), invoicingAdminCss()]) {
      const selectors = css.match(/^[^@{}\n:][^{}\n]*(?=\{)/gm) ?? [];
      for (const selector of selectors) {
        for (const cls of selector.match(/\.[a-z][\w-]*/g) ?? []) expect(cls.startsWith(".aiiw-"), `${cls} in "${selector.trim()}"`).toBe(true);
      }
      const bare = css.split("\n").filter((line) => /#[0-9a-f]{3,8}\b/i.test(line) && !line.includes(":where(") && !line.includes("--aiiw-"));
      expect(bare).toEqual([]);
    }
  });

  it("every class the components use is styled", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = ["../admin/InvoicesLedger.tsx", "../admin/InvoiceEditor.tsx", "../InvoiceView.tsx", "../ui.tsx"]
      .map((file) => readFileSync(resolve(here, file), "utf8"))
      .join("\n");
    const classAttrs = [...source.matchAll(/className=\{?[`"]([^`"]*)[`"]/g)].map((m) => m[1] ?? "").join(" ");
    const used = new Set([...classAttrs.matchAll(/(?<![\w-])aiiw-[a-z0-9-]+/g)].map((m) => m[0]));
    expect(used.size).toBeGreaterThan(30);
    const css = invoicingWidgetCss() + invoicingAdminCss();
    for (const cls of used) {
      if (cls.endsWith("-")) continue;
      expect(css.includes(`.${cls}`), cls).toBe(true);
    }
    for (const tone of ["ok", "warn", "danger", "accent"]) expect(css).toContain(`.aiiw-tag-${tone}`);
  });

  it("prints as a plain invoice: light tokens, only the accent chrome hidden", () => {
    const css = invoicingWidgetCss();
    const print = css.slice(css.indexOf("@media print"));
    expect(print).toContain(declareTokens(LIGHT_TOKENS));
    expect(print).toContain(".aiiw-no-print { display: none !important; }");
  });
});
