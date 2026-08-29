import { describe, expect, it } from "vitest";
import type { PermissionMap } from "@adminigloo/permissions";
import { billingPermissions } from "../permissions.js";

/**
 * Compile-time contract, and the view every assertion reads through.
 *
 * The fragment must stay assignable to PermissionMap or the app's
 * definePermissions() call rejects it at build time. Reading through the
 * widened type is also what makes the runtime assertions meaningful: against
 * the `as const` literals, `defaultFor.includes("admin")` is a *type* error on
 * a readonly ["owner"] tuple, so the check the test intends never runs.
 */
const catalog: PermissionMap = billingPermissions;
const entries = Object.entries(catalog);

/**
 * TENANT_ROLE_TEMPLATES from @adminigloo/tenancy, by rank.
 *
 * Copied rather than imported: this package does not depend on tenancy, and
 * taking a dependency to read four numbers would invert the direction those
 * packages compose in. If tenancy ever renames a template, the "only names
 * templates that exist" assertion below fails here rather than seeding nothing
 * in silence.
 */
const TEMPLATE_RANKS: Readonly<Record<string, number>> = {
  owner: 40,
  admin: 30,
  member: 20,
  viewer: 10,
};

describe("billingPermissions — catalog shape", () => {
  it("declares exactly the plan and subscription keys", () => {
    expect(Object.keys(catalog).sort()).toEqual([
      "plans.manage",
      "plans.view",
      "subscriptions.manage",
      "subscriptions.view",
    ]);
  });

  it("labels, describes and categorises every permission — the checklist renders all three", () => {
    for (const [key, def] of entries) {
      expect(def.label, key).toBeTruthy();
      expect(def.description, key).toBeTruthy();
      expect(def.category, key).toBe("Plans");
    }
  });

  it("namespaces every key with a dot, so two packages cannot collide on a bare word", () => {
    for (const key of Object.keys(catalog)) {
      expect(key, key).toMatch(/^[a-z]+(\.[a-z]+)+$/);
    }
  });
});

describe("billingPermissions — namespaces this package does not own", () => {
  it("declares no billing.* key — @adminigloo/stripe owns that namespace", () => {
    // definePermissions only rejects byte-identical keys, so a near-duplicate
    // like billing.manage against stripe's billing.portal.open would coexist
    // happily and whichever key a route happened to check would decide the
    // answer. That has already happened in this repo, between tenancy and
    // stripe: a seeded owner was told they could manage billing and then
    // refused by the portal route.
    expect(Object.keys(catalog).filter((k) => k.startsWith("billing."))).toEqual([]);
  });

  it("declares no members.* or tenant.* key — @adminigloo/tenancy owns those", () => {
    expect(
      Object.keys(catalog).filter((k) => k.startsWith("members.") || k.startsWith("tenant.")),
    ).toEqual([]);
  });

  it("names its keys after the tables this package actually owns", () => {
    for (const key of Object.keys(catalog)) {
      expect(key.split(".")[0], key).toMatch(/^(plans|subscriptions)$/);
    }
  });
});

describe("billingPermissions — defaults", () => {
  it("only names role templates tenancy actually ships", () => {
    // A typo seeds nothing and fails silently: the template comes up with one
    // permission missing and nobody notices until a customer reports it.
    for (const [key, def] of entries) {
      for (const templateKey of def.defaultFor ?? []) {
        expect(TEMPLATE_RANKS[templateKey], `${key} -> ${templateKey}`).toBeDefined();
      }
    }
  });

  it("gives every permission to at least one template", () => {
    // A permission no template holds is unreachable until somebody hand-edits a
    // template, which is how a feature ships switched off for everyone.
    for (const [key, def] of entries) {
      expect(def.defaultFor?.length ?? 0, key).toBeGreaterThan(0);
    }
  });

  it("gives the owner template every permission", () => {
    for (const [key, def] of entries) {
      expect(def.defaultFor?.includes("owner"), key).toBe(true);
    }
  });

  it("is monotonic in rank — a higher template never holds less than a lower one", () => {
    // The privilege guard compares ranks, so an admin holding something the
    // owner lacks would be manageable by someone who cannot do what they do.
    for (const [key, def] of entries) {
      const granted = def.defaultFor ?? [];
      const lowest = Math.min(...granted.map((t) => TEMPLATE_RANKS[t] ?? Number.NaN));
      for (const [template, rank] of Object.entries(TEMPLATE_RANKS)) {
        if (rank > lowest) {
          expect(granted.includes(template), `${key} -> ${template}`).toBe(true);
        }
      }
    }
  });

  it("shows the catalog to everyone, including viewers", () => {
    // The upgrade prompt renders for whoever hit the limit. Hiding the plan
    // list from members turns "you have used all 5 seats" into a dead end with
    // no next step on the screen.
    expect(catalog["plans.view"]?.defaultFor).toEqual(["owner", "admin", "member", "viewer"]);
  });

  it("keeps both manage keys on the owner alone", () => {
    // Repricing the catalog sets what customers are charged, and changing a
    // subscription changes the bill. An admin who can reprice can set a plan to
    // zero and move onto it.
    expect(catalog["plans.manage"]?.defaultFor).toEqual(["owner"]);
    expect(catalog["subscriptions.manage"]?.defaultFor).toEqual(["owner"]);
  });

  it("keeps what the organisation pays off the member and viewer templates", () => {
    expect(catalog["subscriptions.view"]?.defaultFor).toEqual(["owner", "admin"]);
  });
});

describe("billingPermissions — sealing", () => {
  it("seals nothing, deliberately", () => {
    // Sealing means a template's `deny` cannot be reopened per user. It is for
    // capabilities that must never be handed out ad hoc — stripe seals
    // billing.refund.issue because a refund moves money out of the account and
    // cannot be taken back. Nothing here does: a bad price or a wrong plan is
    // visible on the next invoice and reversible, so sealing would only stop a
    // client delegating catalog work to whoever runs their pricing.
    expect(entries.filter(([, def]) => def.sealed === true)).toEqual([]);
  });
});
