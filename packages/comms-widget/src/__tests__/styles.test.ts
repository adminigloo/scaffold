import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { commsWidgetCss, CONTRAST_PAIRS, contrastRatio, DARK_TOKENS, declareTokens, LIGHT_TOKENS } from "../styles.js";

/**
 * Every colour pair the console prints passes WCAG AA in BOTH themes, every
 * token is declared at zero specificity in light and dark, and every class is
 * `aicw-`-prefixed.
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
    const css = commsWidgetCss();
    expect(css).toContain(`:where(.aicw-root) { ${declareTokens(LIGHT_TOKENS)} }`);
    expect(css).toContain(`:where(.aicw-root:not([data-theme="light"])) { ${declareTokens(DARK_TOKENS)} }`);
    expect(css).toContain(`:where(.aicw-root[data-theme="dark"]) { ${declareTokens(DARK_TOKENS)} }`);
    for (const name of Object.keys(LIGHT_TOKENS).filter((k) => LIGHT_TOKENS[k]!.startsWith("#"))) {
      expect(DARK_TOKENS[name], name).toMatch(/^#/);
    }
  });

  it("prefixes every class aicw-, and uses no colour outside the tokens", () => {
    const css = commsWidgetCss();
    const selectors = css.match(/^[^@{}\n:][^{}\n]*(?=\{)/gm) ?? [];
    for (const selector of selectors) {
      for (const cls of selector.match(/\.[a-z][\w-]*/g) ?? []) expect(cls.startsWith(".aicw-"), `${cls} in "${selector.trim()}"`).toBe(true);
    }
    const bare = css.split("\n").filter((line) => /#[0-9a-f]{3,8}\b/i.test(line) && !line.includes(":where("));
    expect(bare).toEqual([]);
  });

  it("every class the components use is styled or a test hook", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, "../admin/MessagesConsole.tsx"), "utf8") + readFileSync(resolve(here, "../ui.tsx"), "utf8");
    // Class names only: what sits inside a className="…" or className={`…`}
    // (ids like "aicw-how" and data-aicw-* test hooks are not classes).
    const classAttrs = [...source.matchAll(/className=\{?[`"]([^`"]*)[`"]/g)].map((m) => m[1] ?? "").join(" ");
    const used = new Set([...classAttrs.matchAll(/(?<![\w-])aicw-[a-z0-9-]+/g)].map((m) => m[0]));
    expect(used.size).toBeGreaterThan(20);
    const css = commsWidgetCss();
    // Built ones (`aicw-tag-${tone}`, `aicw-notice-${tone}`) are covered by their tones below.
    for (const cls of used) {
      if (cls.endsWith("-") || cls === "aicw-tag-muted") continue;
      expect(css.includes(`.${cls}`), cls).toBe(true);
    }
    for (const tone of ["ok", "warn", "danger"]) expect(css).toContain(`.aicw-tag-${tone}`);
    for (const tone of ["ok", "warn", "error", "info"]) expect(css).toContain(`.aicw-notice-${tone}`);
  });
});
