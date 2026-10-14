import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { loadSampleCatalog } from "../sample.js";
import {
  DEFAULT_ESTIMATOR_SETTINGS,
  effectiveTaxRateBp,
  getEstimatorSettings,
  toSettingsWire,
  updateEstimatorSettings,
} from "../settings.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/** A business's settings (2.1, 6.1): one row per tenant, every limit a sentence on its field. */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

async function issue(promise: Promise<unknown>): Promise<{ path: unknown[]; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ZodError) return { path: error.issues[0]!.path, message: error.issues[0]!.message };
    throw error;
  }
  throw new Error("expected a ZodError");
}

describe("estimator settings", () => {
  it("reads the defaults without a row, and never writes", async () => {
    const tenantId = tenant();
    const settings = await getEstimatorSettings(t.db, tenantId);
    expect(settings).toMatchObject({ ...DEFAULT_ESTIMATOR_SETTINGS, tenantId, saved: false, sampleLoadedAt: null, updatedAt: null });
    expect(settings.taxRateBp).toBe(825);
    expect(settings.timeZone).toBe("UTC");
    expect((await t.client.query("select count(*)::int as n from estimator_settings where tenant_id = $1", [tenantId])).rows[0]).toEqual({ n: 0 });
  });

  it("upserts; a patch changes only its keys; every save stamps saved", async () => {
    const tenantId = tenant();
    const first = await updateEstimatorSettings(t.db, tenantId, { businessName: "Summit Ramps", taxRateBp: 725 });
    expect(first).toMatchObject({ businessName: "Summit Ramps", taxRateBp: 725, saved: true, quoteValidDays: 30 });
    const second = await updateEstimatorSettings(t.db, tenantId, { quoteValidDays: 14, currency: "cad", brandColor: "#0D6B64", contactEmail: "  " });
    expect(second).toMatchObject({ businessName: "Summit Ramps", taxRateBp: 725, quoteValidDays: 14, currency: "CAD", brandColor: "#0d6b64", contactEmail: null });
    expect((await getEstimatorSettings(t.db, tenantId)).quoteValidDays).toBe(14);
    // Another tenant is untouched.
    expect((await getEstimatorSettings(t.db, tenant())).businessName).toBe("");
  });

  it("refuses each out-of-range value with its path and a plain sentence", async () => {
    const tenantId = tenant();
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ contactEmail: "nope" }, "contactEmail", "Enter an email address."],
      [{ leadNotifyEmails: ["a@x.test", "b@x.test", "c@x.test", "d@x.test", "e@x.test", "f@x.test"] }, "leadNotifyEmails", "Up to 5 addresses."],
      [{ leadNotifyEmails: ["office"] }, "leadNotifyEmails", "Enter an email address."],
      [{ currency: "dollars" }, "currency", "Use a three-letter currency code, like USD."],
      [{ brandColor: "teal" }, "brandColor", "Use a colour like #0d6b64."],
      [{ taxRateBp: 3001 }, "taxRateBp", "Enter a rate from 0% to 30%."],
      [{ taxRateBp: -1 }, "taxRateBp", "Enter a rate from 0% to 30%."],
      [{ timeZone: "Mars/Olympus" }, "timeZone", "Pick a time zone from the list."],
      [{ locale: "not a tag!" }, "locale", "Use a language tag, like en-US."],
      [{ quoteValidDays: 0 }, "quoteValidDays", "Use 1 to 365 days."],
      [{ followUpDays: 61 }, "followUpDays", "Use 0 to 60 days (0 = no follow-up)."],
      [{ contingencyBp: 5001 }, "contingencyBp", "Use 0% to 50%."],
      [{ businessName: "x".repeat(121) }, "businessName", "Keep it to 120 characters."],
      [{ contactPhone: "555\n0143" }, "contactPhone", "Keep this on one line."],
    ];
    for (const [patch, path, message] of cases) {
      expect(await issue(updateEstimatorSettings(t.db, tenantId, patch))).toEqual({ path: [path, ...(path === "leadNotifyEmails" && message.startsWith("Enter") ? [0] : [])], message });
    }
    expect((await getEstimatorSettings(t.db, tenantId)).saved).toBe(false); // nothing was written
  });

  it("saved means saved: loading the sample catalog creates the row without saving it", async () => {
    const tenantId = tenant();
    await loadSampleCatalog(t.db, tenantId);
    const settings = await getEstimatorSettings(t.db, tenantId);
    expect(settings.saved).toBe(false);
    expect(settings.sampleLoadedAt).toBeInstanceOf(Date);
    expect(toSettingsWire(settings)).toMatchObject({ saved: false, sampleLoadedAt: expect.any(String), taxRateBp: 825 });
  });

  it("the tax rate's precedence: saved settings, then the handler's old option, then 8.25%", async () => {
    const tenantId = tenant();
    const unsaved = await getEstimatorSettings(t.db, tenantId);
    expect(effectiveTaxRateBp(unsaved)).toBe(825);
    expect(effectiveTaxRateBp(unsaved, 600)).toBe(600);
    const saved = await updateEstimatorSettings(t.db, tenantId, { taxRateBp: 0 });
    expect(effectiveTaxRateBp(saved, 600)).toBe(0);
  });

  it("the wire carries every value, and instants as ISO strings", async () => {
    const tenantId = tenant();
    const saved = await updateEstimatorSettings(t.db, tenantId, { businessName: "Summit", leadNotifyEmails: ["office@summit.test"] });
    const wire = toSettingsWire(saved);
    // 0.4 (Tenancy 2a, 7.9) adds managedByCompany and aiBudgetCeilingCents.
    expect(Object.keys(wire).sort()).toEqual(
      [
        "aiBudgetCeilingCents",
        "aiDailyBudgetCents",
        "aiPerRequesterDaily",
        "brandColor",
        "businessName",
        "contactEmail",
        "contactPhone",
        "contingencyBp",
        "currency",
        "defaultLaborRateCents",
        "followUpDays",
        "instantEstimatesEnabled",
        "leadNotifyEmails",
        "locale",
        "managedByCompany",
        "photosEnabled",
        "quoteFooter",
        "quoteValidDays",
        "sampleLoadedAt",
        "saved",
        "taxRateBp",
        "timeZone",
        "updatedAt",
      ].sort(),
    );
    expect(wire.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
