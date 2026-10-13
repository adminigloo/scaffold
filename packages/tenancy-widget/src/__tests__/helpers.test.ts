import { describe, expect, it } from "vitest";
import { brandColorReport, contrastRatio, HARD_TO_READ_WARNING, LIGHT_COLOUR_WARNING, normaliseHexColor } from "../color.js";
import { formatRatio, sectionAnchor, wireValue } from "../CompanySettings.js";
import { WIRE_ERROR_CODES } from "../http.js";
import { companyNameProblem, RESERVED_SLUGS, SLUG_MAX, suggestSlug, validateSlug } from "../slug.js";
import { allTimeZones, US_TIME_ZONES, zoneLabel } from "../timezones.js";
import type { SettingsFieldWire } from "../types.js";
import * as words from "../words.js";
import { acceptOutcomeText, codeFallback, DEFAULT_NOUN, errorText, nounOf, nounTitle } from "../words.js";

/**
 * The pure pieces: the widget's copies of the web-address and colour rules
 * (contract 5.1, 5.2), the plain-words table (8.9), and the small helpers the
 * settings page saves through.
 */

/** A seeded generator, so a failure names the input it failed on and reruns the same. */
export function randomNames(count: number, seed = 42): string[] {
  let s = seed;
  const next = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const pieces = ["Summit", "Window", "Co.", "Café", "&", "Ölmühle", "O'Brien's", "  ", "-", "ws", "admin", "Ünïcödé", "東京", "🙂", "A", "b", "123", "Plumbing", "—", "LLC", "t", "_next", "...", "x".repeat(45)];
  return Array.from({ length: count }, () => {
    const n = 1 + Math.floor(next() * 6);
    return Array.from({ length: n }, () => pieces[Math.floor(next() * pieces.length)]).join(next() < 0.7 ? " " : "");
  });
}

describe("web addresses", () => {
  it("suggests a valid address for every name (1 000 generated)", () => {
    for (const name of randomNames(1000)) {
      const slug = suggestSlug(name);
      expect(validateSlug(slug), `${JSON.stringify(name)} → ${slug}`).toBeNull();
    }
  });

  it("folds accents and '&', drops apostrophes, and keeps whole words under the limit", () => {
    expect(suggestSlug("Café & Co.")).toBe("cafe-and-co");
    expect(suggestSlug("O'Brien's Plumbing")).toBe("obriens-plumbing");
    expect(suggestSlug("Summit Window Co.")).toBe("summit-window-co");
    const long = suggestSlug("The Very Long Window Washing Company of Northern Utah County");
    expect(long.length).toBeLessThanOrEqual(SLUG_MAX);
    expect(long).toBe("the-very-long-window-washing-company-of");
  });

  it("short and reserved names get -co; the personal prefix never survives", () => {
    expect(suggestSlug("A")).toBe("a-co");
    expect(suggestSlug("")).toBe("co-co");
    expect(suggestSlug("Admin")).toBe("admin-co");
    expect(suggestSlug("Team")).toBe("team-co");
    expect(validateSlug(suggestSlug("WS Plumbing"))).toBeNull();
  });

  it("validates in a fixed order: too short, too long, invalid, reserved", () => {
    expect(validateSlug("ab")).toBe("too-short");
    expect(validateSlug("a".repeat(41))).toBe("too-long");
    expect(validateSlug("Bad Slug")).toBe("invalid");
    expect(validateSlug("-lead")).toBe("invalid");
    expect(validateSlug("trail-")).toBe("invalid");
    expect(validateSlug("dou--ble")).toBe("invalid");
    expect(validateSlug("ws-abc")).toBe("invalid");
    expect(validateSlug("admin")).toBe("reserved");
    expect(validateSlug("book-visit")).toBe("reserved");
    expect(validateSlug("acme", { reserved: ["acme"] })).toBe("reserved");
    expect(validateSlug("summit-window-co")).toBeNull();
    expect(RESERVED_SLUGS.has("_next")).toBe(true);
  });

  it("company names: at least 2 characters, at most 80, letters or numbers", () => {
    expect(companyNameProblem(" A ")).toBe("too-short");
    expect(companyNameProblem("x".repeat(81))).toBe("too-long");
    expect(companyNameProblem("🙂🙂")).toBe("invalid");
    expect(companyNameProblem("---")).toBe("invalid");
    expect(companyNameProblem("  Summit   Window  ")).toBeNull();
  });
});

describe("brand colour", () => {
  it("measures contrast the WCAG way", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(contrastRatio("#22c55e", "#ffffff")).toBeCloseTo(2.28, 2);
    expect(contrastRatio("#22c55e", "#111111")).toBeCloseTo(8.29, 2);
  });

  it("normalises #abc, abc and #AABBCC; refuses words", () => {
    expect(normaliseHexColor("#ABC")).toBe("#aabbcc");
    expect(normaliseHexColor("abc")).toBe("#aabbcc");
    expect(normaliseHexColor(" #0F766E ")).toBe("#0f766e");
    expect(normaliseHexColor("red")).toBeNull();
    expect(normaliseHexColor("#abcd")).toBeNull();
    expect(brandColorReport("red")).toBeNull();
  });

  it("picks the text colour that reads on it, and warns (never refuses)", () => {
    const teal = brandColorReport("#0f766e")!;
    expect(teal.textOnColor).toBe("#ffffff");
    expect(teal.readable).toBe(true);
    expect(teal.warning).toBeNull();
    const green = brandColorReport("#22c55e")!;
    expect(green.textOnColor).toBe("#111111");
    expect(green.ratioWithDarkText).toBe(8.29);
    expect(green.ratioOnWhitePage).toBe(green.ratioWithWhiteText);
    expect(green.warning).toBe(LIGHT_COLOUR_WARNING);
    // #767676 is the lightest grey white text reads on; #777777 just misses (4.48).
    expect(brandColorReport("#767676")!.readable).toBe(true);
    const grey = brandColorReport("#777777")!;
    expect(grey.readable).toBe(false);
    expect(grey.warning).toBe(HARD_TO_READ_WARNING);
  });
});

describe("plain words (contract 8.9)", () => {
  const NOUN = DEFAULT_NOUN;

  /** Every sentence the module can produce, with sample arguments. */
  function everySentence(): string[] {
    const out: string[] = [];
    const visit = (value: unknown) => {
      if (typeof value === "string") out.push(value);
      else if (typeof value === "function") {
        // Each sentence builder takes a noun first, or names, or numbers: try
        // each shape and keep the answers whose arguments fitted (a noun
        // object passed where a name belongs prints "[object Object]").
        const shapes = [
          Array.from({ length: value.length }, (_, i) => (i === 0 ? NOUN : "Summit Window Co.")),
          Array.from({ length: value.length }, () => "Summit Window Co."),
          Array.from({ length: value.length }, (_, i) => (i === value.length - 1 ? NOUN : "Summit Window Co.")),
          Array.from({ length: value.length }, (_, i) => [26, 50, 230][i] ?? 1),
          Array.from({ length: value.length }, () => true),
        ];
        const results: string[] = [];
        for (const args of shapes) {
          try {
            const result = (value as (...a: unknown[]) => unknown)(...args);
            if (typeof result === "string") results.push(result);
          } catch {
            /* a shape that doesn't fit */
          }
        }
        // The fitting shape is the one that left no hole; if none did, the
        // first answer goes in as it is, and fails below.
        const fitted = results.filter((r) => !/\[object Object\]|undefined/.test(r));
        out.push(...(fitted.length > 0 ? fitted : results.slice(0, 1)));
      } else if (value && typeof value === "object") for (const v of Object.values(value)) visit(v);
    };
    for (const [name, value] of Object.entries(words)) {
      if (["nounTitle", "nounOf", "aNoun", "codeFallback", "errorText", "acceptOutcomeText"].includes(name)) continue;
      visit(value);
    }
    for (const code of [...WIRE_ERROR_CODES, "network", "bad_response"] as const) out.push(codeFallback(code, NOUN));
    for (const status of ["accepted", "already-a-member", "expired", "revoked", "wrong-email", "unknown", "company-unavailable", "seats-full"] as const) {
      out.push(acceptOutcomeText({ status, company: { id: "t", name: "Summit" }, message: null }, NOUN));
    }
    return out;
  }

  it("never says slug, tenant, an id, a code, or a programmer's word", () => {
    const sentences = everySentence();
    expect(sentences.length).toBeGreaterThan(150);
    for (const sentence of sentences) {
      expect(sentence, sentence).not.toMatch(/\bslug\b|\btenant|\bid\b|\buuid\b|undefined|null|NaN|\[object|_/i);
    }
  });

  it("every error code has a sentence, and the server's message always wins over ours", () => {
    for (const code of WIRE_ERROR_CODES) {
      const sentence = codeFallback(code);
      expect(sentence).toMatch(/[.!?]$/);
      expect(sentence).not.toContain(code);
    }
    expect(errorText({ code: "forbidden", message: "Server words." })).toBe("Server words.");
    expect(errorText({ code: "forbidden", message: "" }, { singular: "shop", plural: "shops" })).toContain("this shop");
  });

  it("nouns: lowercase in sentences, capitalised by one helper", () => {
    expect(nounTitle("company")).toBe("Company");
    expect(nounOf({ singular: "Shop", plural: "Shops" })).toEqual({ singular: "shop", plural: "shops" });
    expect(nounOf({ singular: "Practice", plural: "" })).toEqual({ singular: "practice", plural: "practices" });
    expect(nounOf(undefined)).toEqual(DEFAULT_NOUN);
  });
});

describe("settings helpers", () => {
  const field = (kind: SettingsFieldWire["kind"]): SettingsFieldWire => ({
    key: "k", label: "K", help: null, kind, options: null, placeholder: null, autoComplete: null, width: "full", required: false, min: null, max: null, step: null,
  });

  it("sends empty boxes as null, numbers as numbers, toggles as booleans", () => {
    expect(wireValue(field("text"), "  ")).toBeNull();
    expect(wireValue(field("email"), " a@b.co ")).toBe("a@b.co");
    expect(wireValue(field("number"), "12")).toBe(12);
    expect(wireValue(field("number"), "")).toBeNull();
    expect(wireValue(field("toggle"), true)).toBe(true);
    expect(wireValue(field("toggle"), null)).toBe(false);
    expect(wireValue(field("timezone"), "")).toBeNull();
  });

  it("the company section answers to #details; ratios read the way people write them", () => {
    expect(sectionAnchor("company")).toBe("details");
    expect(sectionAnchor("scheduling")).toBe("scheduling");
    expect(formatRatio(21)).toBe("21");
    expect(formatRatio(4.5)).toBe("4.5");
    expect(formatRatio(4.4799)).toBe("4.48");
  });

  it("time zones: US by name first; anything else reads as a place (review R2 T1BO-10)", () => {
    expect(US_TIME_ZONES[2]).toEqual({ zone: "America/Denver", label: "Mountain Time (Denver)" });
    expect(zoneLabel("America/Denver")).toBe("Mountain Time (Denver)");
    expect(zoneLabel("America/Argentina/Buenos_Aires")).toMatch(/^Buenos Aires, Argentina/);
    expect(allTimeZones().length).toBeGreaterThan(5);
  });
});
