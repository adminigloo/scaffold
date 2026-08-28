import { describe, expect, it } from "vitest";
import type { PermissionMap } from "@adminigloo/permissions";
import { tenancyPermissions } from "../permissions.js";
import { templateRank, TENANT_ROLE_TEMPLATES } from "../templates.js";

/**
 * Compile-time contract, and the view every assertion below reads through.
 *
 * The fragment must stay assignable to PermissionMap or the app's
 * definePermissions() call would reject it at build time. Reading through the
 * widened type is also what makes the runtime assertions meaningful: against
 * the `as const` literals, `defaultFor.includes("admin")` is a *type* error on
 * a readonly ["owner"] tuple, so the check the test intends never runs.
 */
const catalog: PermissionMap = tenancyPermissions;

const entries = Object.entries(catalog);

describe("tenancyPermissions — catalog shape", () => {
  it("declares exactly the tenancy keys", () => {
    expect(Object.keys(catalog).sort()).toEqual([
      "members.invite",
      "members.remove",
      "members.view",
      "tenant.edit",
      "tenant.transfer",
      "tenant.view",
    ]);
  });

  it("labels and categorises every permission — the checklist renders both", () => {
    for (const [key, def] of entries) {
      expect(def.label, key).toBeTruthy();
      expect(def.category, key).toBeTruthy();
      expect(def.description, key).toBeTruthy();
    }
  });

  it("groups into Team, Organisation and Danger", () => {
    const grouped = new Map<string, string[]>();
    for (const [key, def] of entries) {
      const bucket = grouped.get(def.category ?? "General");
      if (bucket) bucket.push(key);
      else grouped.set(def.category ?? "General", [key]);
    }
    expect([...grouped.keys()].sort()).toEqual(["Danger", "Organisation", "Team"]);
    expect(grouped.get("Danger")).toEqual(["tenant.transfer"]);
    expect(grouped.get("Team")?.sort()).toEqual([
      "members.invite",
      "members.remove",
      "members.view",
    ]);
  });

  it("namespaces every key with a dot, so two packages cannot collide on a bare word", () => {
    for (const key of Object.keys(catalog)) {
      // Two OR MORE segments. The repo-wide form is `<area>.<noun>.<verb>`
      // (stripe ships billing.portal.open, billing.invoices.view); pinning this
      // to exactly two segments would codify a shape the rest of the catalog
      // contradicts and fail the moment a key is namespaced properly.
      expect(key, key).toMatch(/^[a-z]+(\.[a-z]+)+$/);
    }
  });
});

describe("tenancyPermissions — sealing", () => {
  it("seals ownership transfer and nothing else", () => {
    const sealed = entries.filter(([, def]) => def.sealed === true).map(([key]) => key);
    expect(sealed).toEqual(["tenant.transfer"]);
  });

  it("gives transfer to the owner template alone", () => {
    expect(catalog["tenant.transfer"]?.defaultFor).toEqual(["owner"]);
  });

  it("owns no billing key — @adminigloo/stripe owns that namespace", () => {
    // definePermissions only rejects byte-identical keys, so a near-duplicate
    // like billing.manage vs billing.portal.open would coexist silently and
    // whichever key a route happened to check would decide the answer.
    expect(Object.keys(catalog).filter((k) => k.startsWith("billing."))).toEqual([]);
  });
});

describe("tenancyPermissions — defaults", () => {
  it("only names role templates this package actually ships", () => {
    // A typo here seeds nothing and fails silently: the template comes up with
    // one permission missing and nobody notices until a customer reports it.
    for (const [key, def] of entries) {
      for (const templateKey of def.defaultFor ?? []) {
        expect(templateRank(templateKey), `${key} -> ${templateKey}`).toBeDefined();
      }
    }
  });

  it("gives every permission to at least one template", () => {
    for (const [key, def] of entries) {
      expect(def.defaultFor?.length ?? 0, key).toBeGreaterThan(0);
    }
  });

  it("is monotonic in rank — a higher template never has less than a lower one", () => {
    // The privilege guard compares ranks, so an admin who holds something the
    // owner lacks would be manageable by someone who cannot do what they do.
    for (const [key, def] of entries) {
      const granted = def.defaultFor ?? [];
      const lowest = Math.min(
        ...granted.map((templateKey) => templateRank(templateKey) ?? Number.NaN),
      );
      for (const template of TENANT_ROLE_TEMPLATES) {
        if (template.rank > lowest) {
          expect(granted.includes(template.key), `${key} -> ${template.key}`).toBe(true);
        }
      }
    }
  });

  it("gives the owner template every permission", () => {
    for (const [key, def] of entries) {
      expect(def.defaultFor?.includes("owner"), key).toBe(true);
    }
  });

  it("gives a viewer read access and nothing that writes", () => {
    const viewerKeys = entries
      .filter(([, def]) => def.defaultFor?.includes("viewer"))
      .map(([key]) => key)
      .sort();
    expect(viewerKeys).toEqual(["members.view", "tenant.view"]);
  });

  it("keeps invite and remove off the member template", () => {
    expect(catalog["members.invite"]?.defaultFor).not.toContain("member");
    expect(catalog["members.remove"]?.defaultFor).not.toContain("member");
  });
});
