import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { brandColorReport, contrastRatio, normaliseHexColor } from "../color.js";
import { defineSetupChecklist, DuplicateChecklistItemError } from "../checklist.js";
import {
  companySettings,
  defineSettingsFragment,
  defineTenantSettings,
  DuplicateSettingsFragmentError,
  InvalidSettingsFragmentError,
  isTimeZone,
  type SettingsValues,
} from "../settings.js";
import {
  companyNameProblem,
  normaliseCompanyName,
  RESERVED_SLUGS,
  suggestSlug,
  validateSlug,
} from "../slug.js";

/** A seeded generator, so a failure names its input. */
function names(count: number, seed: number): string[] {
  let s = seed;
  const next = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const pieces = ["Summit", "Window", "Co.", "Café", "&", "Ölmühle", "O'Brien's", "  ", "-", "ws", "WS", "admin", "東京", "🙂", "A", "123", "—", "LLC", "t", "_next", "x".repeat(45)];
  return Array.from({ length: count }, () =>
    Array.from({ length: 1 + Math.floor(next() * 6) }, () => pieces[Math.floor(next() * pieces.length)]).join(next() < 0.7 ? " " : ""),
  );
}

describe("slugs (5.1)", () => {
  it("suggestSlug never returns an invalid address (1 000 generated names)", () => {
    for (const name of names(1000, 3)) expect(validateSlug(suggestSlug(name)), JSON.stringify(name)).toBeNull();
  });

  it("folds unicode and ampersands: Café & Co. → cafe-and-co", () => {
    expect(suggestSlug("Café & Co.")).toBe("cafe-and-co");
    expect(suggestSlug("O'Brien's Plumbing")).toBe("obriens-plumbing");
  });

  it("reserved and short names get -co", () => {
    expect(suggestSlug("Admin")).toBe("admin-co");
    expect(suggestSlug("A")).toBe("a-co");
  });

  it("a name that would start with the personal prefix is prefixed co- (review T1-02), never left invalid", () => {
    // The contract's first draft appended "-co" — "ws-lawn-services-co" still
    // starts with "ws-" and validateSlug refuses it, so the owner would be told
    // their (suggested, never typed) address was invalid.
    expect(suggestSlug("WS Lawn Services")).toBe("co-ws-lawn-services");
    expect(validateSlug(suggestSlug("WS Lawn Services"))).toBeNull();
    expect(validateSlug("ws-lawn-services-co")).toBe("invalid");
  });

  it("validateSlug: every problem, in its order", () => {
    expect(validateSlug("ab")).toBe("too-short");
    expect(validateSlug("a".repeat(41))).toBe("too-long");
    expect(validateSlug("Bad_Slug")).toBe("invalid");
    expect(validateSlug("-lead")).toBe("invalid");
    expect(validateSlug("double--dash")).toBe("invalid");
    expect(validateSlug("ws-mine")).toBe("invalid");
    expect(validateSlug("admin")).toBe("reserved");
    expect(validateSlug("igloo-back-office", { reserved: ["igloo-back-office"] })).toBe("reserved");
    expect(validateSlug("summit-window-co")).toBeNull();
    // Order: a too-short reserved word is too-short first.
    expect(validateSlug("me")).toBe("too-short");
    expect(RESERVED_SLUGS.has("t")).toBe(true);
  });

  it("company names: normalised, then checked", () => {
    expect(normaliseCompanyName("  Summit   Window  ")).toBe("Summit Window");
    expect(companyNameProblem(" ")).toBe("too-short");
    expect(companyNameProblem("🙂🙂🙂")).toBe("invalid");
    expect(companyNameProblem("x".repeat(81))).toBe("too-long");
    expect(companyNameProblem("Summit Window Co.")).toBeNull();
  });
});

describe("brand colour (5.2): warn, never block", () => {
  it("known pairs", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    const green = brandColorReport("#22c55e")!;
    expect(green.ratioWithWhiteText).toBeCloseTo(2.28, 2);
    expect(green.ratioWithDarkText).toBeCloseTo(8.29, 1);
    expect(green.textOnColor).toBe("#111111");
  });

  it("chooses white text on a dark colour and reports it readable", () => {
    const teal = brandColorReport("#0f766e")!;
    expect(teal.textOnColor).toBe("#ffffff");
    expect(teal.readable).toBe(true);
    expect(teal.warning).toBeNull();
  });

  it("warns for a light colour on a white page, and for an unreadable one", () => {
    expect(brandColorReport("#fde68a")!.warning).toMatch(/light/);
    // A mid-grey that no text colour reads well on.
    const report = brandColorReport("#808080")!;
    expect(report.readable).toBe(report.ratioWithDarkText >= 4.5 || report.ratioWithWhiteText >= 4.5);
  });

  it("normaliseHexColor accepts #abc and rejects red", () => {
    expect(normaliseHexColor("#ABC")).toBe("#aabbcc");
    expect(normaliseHexColor("red")).toBeNull();
    expect(brandColorReport("red")).toBeNull();
  });
});

describe("the settings registry (5.3)", () => {
  const extra = defineSettingsFragment({
    key: "schedule",
    label: "Scheduling",
    order: 20,
    schema: z.object({ bufferMinutes: z.number().int().min(0).max(120).default(15) }),
    fields: [{ key: "bufferMinutes", kind: "number", label: "Minutes between visits", min: 0, max: 120 }],
  });

  it("refuses a duplicate key, a __ key, a field not in the schema, and a schema with no defaults", () => {
    expect(() => defineTenantSettings([companySettings, companySettings])).toThrow(DuplicateSettingsFragmentError);
    expect(() =>
      defineSettingsFragment({ key: "__secret", label: "x", schema: z.object({ a: z.string().default("") }), fields: [] }),
    ).toThrow(InvalidSettingsFragmentError);
    expect(() =>
      defineSettingsFragment({
        key: "oops",
        label: "x",
        schema: z.object({ a: z.string().default("") }),
        fields: [{ key: "b", kind: "text", label: "B" }],
      }),
    ).toThrow(InvalidSettingsFragmentError);
    expect(() =>
      defineSettingsFragment({ key: "nodefault", label: "x", schema: z.object({ a: z.string() }), fields: [{ key: "a", kind: "text", label: "A" }] }),
    ).toThrow(InvalidSettingsFragmentError);
  });

  it("an invalid stored value falls back to its default, field by field, and is reported", () => {
    const registry = defineTenantSettings([companySettings, extra]);
    const { values, problems } = registry.parse({
      company: { timeZone: "Mars/Olympus", contactEmail: "office@summit.test" },
      schedule: { bufferMinutes: 30 },
    });
    expect(values.company.timeZone).toBeNull();
    expect(values.company.contactEmail).toBe("office@summit.test");
    expect(values.schedule.bufferMinutes).toBe(30);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.fragment).toBe("company");
  });

  it("orders fragments by order, then key; defaults() parses {}", () => {
    const registry = defineTenantSettings([extra, companySettings]);
    expect(registry.fragments.map((f) => f.key)).toEqual(["company", "schedule"]);
    expect(registry.defaults().schedule.bufferMinutes).toBe(15);
    expect(registry.defaults().company.contactPhone).toBeNull();
  });

  it("SettingsValues is typed per fragment", () => {
    const registry = defineTenantSettings([companySettings, extra]);
    type V = SettingsValues<typeof registry.fragments>;
    expectTypeOf<V["schedule"]["bufferMinutes"]>().toEqualTypeOf<number>();
    expectTypeOf<V["company"]["timeZone"]>().toEqualTypeOf<string | null>();
  });

  it("the company fragment: empty strings are null, emails are lowercased, time zones checked", () => {
    const parsed = companySettings.schema.parse({ timeZone: "America/Denver", contactEmail: " Office@Summit.TEST ", contactPhone: "" });
    expect(parsed).toMatchObject({ timeZone: "America/Denver", contactEmail: "office@summit.test", contactPhone: null });
    expect(companySettings.schema.safeParse({ contactEmail: "nope" }).success).toBe(false);
    expect(isTimeZone("America/Denver")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
  });
});

describe("defineSetupChecklist (5.4)", () => {
  it("refuses a duplicate key, and sorts by order then key", () => {
    const item = (key: string, order: number) => ({ key, order, title: key, description: "", actionLabel: "Go", href: "/", isDone: () => false });
    expect(() => defineSetupChecklist([item("a.b", 1), item("a.b", 2)])).toThrow(DuplicateChecklistItemError);
    expect(defineSetupChecklist([item("z.z", 1), item("a.a", 1), item("m.m", 0)]).items.map((i) => i.key)).toEqual(["m.m", "a.a", "z.z"]);
  });
});
