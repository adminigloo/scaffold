import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { alertsWidgetCss, CONTRAST_PAIRS, contrastRatio, DARK_TOKENS, declareTokens, LIGHT_TOKENS } from "../styles.js";

/**
 * Every colour pair the screens print passes WCAG AA in BOTH themes, every
 * token is declared at zero specificity in light and dark, every class is
 * `ainw-`-prefixed, every class the components use is styled, and phones get
 * 44 px targets.
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
    const css = alertsWidgetCss();
    expect(css).toContain(`:where(.ainw-root) { ${declareTokens(LIGHT_TOKENS)} }`);
    expect(css).toContain(`:where(.ainw-root:not([data-theme="light"])) { ${declareTokens(DARK_TOKENS)} }`);
    expect(css).toContain(`:where(.ainw-root[data-theme="dark"]) { ${declareTokens(DARK_TOKENS)} }`);
    for (const name of Object.keys(LIGHT_TOKENS).filter((k) => LIGHT_TOKENS[k]!.startsWith("#"))) {
      expect(DARK_TOKENS[name], name).toMatch(/^#/);
    }
  });

  it("prefixes every class ainw-, and uses no colour outside the tokens", () => {
    const css = alertsWidgetCss();
    const selectors = css.match(/^[^@{}\n:][^{}\n]*(?=\{)/gm) ?? [];
    for (const selector of selectors) {
      for (const cls of selector.match(/\.[a-z][\w-]*/g) ?? []) expect(cls.startsWith(".ainw-"), `${cls} in "${selector.trim()}"`).toBe(true);
    }
    const bare = css.split("\n").filter((line) => /#[0-9a-f]{3,8}\b/i.test(line) && !line.includes(":where("));
    expect(bare).toEqual([]);
  });

  it("every class the components use is styled", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = ["../admin/AlertsBell.tsx", "../admin/AlertsInbox.tsx", "../admin/AlertSettings.tsx", "../ui.tsx"]
      .map((file) => readFileSync(resolve(here, file), "utf8"))
      .join("\n");
    const classAttrs = [...source.matchAll(/className=\{?[`"]([^`"]*)[`"]/g)].map((m) => m[1] ?? "").join(" ");
    const used = new Set([...classAttrs.matchAll(/(?<![\w-])ainw-[a-z0-9-]+/g)].map((m) => m[0]));
    expect(used.size).toBeGreaterThan(30);
    const css = alertsWidgetCss();
    for (const cls of used) {
      if (cls.endsWith("-")) continue;
      expect(css.includes(`.${cls}`), cls).toBe(true);
    }
    for (const tone of ["ok", "warn", "error", "info"]) expect(css).toContain(`.ainw-notice-${tone}`);
  });

  it("gives every control a 44 px target under 640 px, and the bell 44 px always", () => {
    const css = alertsWidgetCss();
    expect(css).toMatch(/\.ainw-bell \{[^}]*width: 44px; height: 44px;/);
    expect(css).toMatch(/@media \(max-width: 639px\) \{\s*\.ainw-btn, \.ainw-link \{ min-height: 44px; \}/);
    expect(css).toMatch(/\.ainw-close \{[^}]*width: 44px; height: 44px;/);
    expect(css).toMatch(/\.ainw-input \{[^}]*min-height: 44px/);
  });

  it("opens the bell's list as a full-width sheet on a phone and a 360 px popover on a desktop", () => {
    const css = alertsWidgetCss();
    expect(css).toMatch(/\.ainw-panel \{[^}]*width: 360px; max-width: calc\(100vw - 16px\)/);
    expect(css).toMatch(/\.ainw-panel\[data-ainw-mode="sheet"\] \{[^}]*position: fixed; top: 0; left: 0; right: 0; width: 100%/);
    expect(css).toContain("overflow-x: hidden");
  });
});
