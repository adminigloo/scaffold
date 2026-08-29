import { describe, expect, it } from "vitest";
import {
  definePermissions,
  requirePermission,
  PermissionDeniedError,
  type PermissionSet,
} from "@adminigloo/permissions";
import { stripePermissions } from "@adminigloo/stripe";
import { tenancyPermissions } from "@adminigloo/tenancy";
import {
  allowAll,
  assertCatalogConformance,
  denyAll,
  withPermissions,
} from "../permissions.js";

// The catalog a generated project actually assembles: one call per scope,
// spreading each package's fragment. Testing against the real fragments rather
// than a toy record is the point — the conformance check has to hold for the
// keys that ship.
const tenantCatalog = definePermissions("tenant", {
  ...tenancyPermissions,
  ...stripePermissions,
});

const SYSTEM_TEMPLATES = ["owner", "admin", "member", "viewer"] as const;

const shippedTemplates = SYSTEM_TEMPLATES.map((key) => ({
  key,
  grants: tenantCatalog
    .defaultsFor(key)
    .map((permission) => ({ permission, effect: "allow" as const })),
}));

describe("withPermissions", () => {
  it("hands a router test a resolved set with no database in sight", () => {
    const set = withPermissions(["members.view", "members.invite"]);
    expect(set.can("members.view")).toBe(true);
    expect(set.can("members.remove")).toBe(false);
    expect(set.canAll(["members.view", "members.invite"])).toBe(true);
    expect(set.canAny(["members.remove", "members.view"])).toBe(true);
  });

  it("serialises to the array the browser is handed", () => {
    expect([...withPermissions(["tenant.view"]).toArray()]).toEqual(["tenant.view"]);
  });

  it("drives requirePermission, so the gate under test is the real one", () => {
    const owner = withPermissions(["billing.portal.open"]);
    expect(() =>
      requirePermission(owner, "billing.portal.open", "tenant"),
    ).not.toThrow();
    expect(() =>
      requirePermission(withPermissions([]), "billing.portal.open", "tenant"),
    ).toThrow(PermissionDeniedError);
  });
});

describe("denyAll", () => {
  it("grants nothing", () => {
    expect(denyAll().can("members.view")).toBe(false);
    expect(denyAll().canAny(tenantCatalog.keys)).toBe(false);
    expect(denyAll().toArray()).toEqual([]);
  });
});

describe("allowAll", () => {
  it("grants exactly what the catalog declares", () => {
    const set = allowAll(tenantCatalog);
    for (const key of tenantCatalog.keys) expect(set.can(key)).toBe(true);
  });

  it("still denies a key the catalog never declared", () => {
    // The reason this takes a catalog instead of returning `can: () => true`.
    // A procedure checking a misspelled key must fail even in the
    // everything-is-allowed test, because in production the typo denies.
    const set: PermissionSet = allowAll(tenantCatalog);
    expect(set.can("billing.refund")).toBe(false);
    expect(set.can("members.viewe")).toBe(false);
  });
});

describe("assertCatalogConformance — a conforming project", () => {
  it("passes with the shipped fragments and templates", () => {
    const result = assertCatalogConformance({
      catalog: tenantCatalog,
      referenced: tenantCatalog.keys,
      templates: shippedTemplates,
      // Sealed, no defaultFor: refunds are granted per deployment, by hand.
      deliberatelyUnreachable: ["billing.refund.issue"],
    });

    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("skips the reachability check when no templates were supplied", () => {
    // A unit test that only has the referenced list must not be told every key
    // in the catalog is unreachable.
    const result = assertCatalogConformance({
      catalog: tenantCatalog,
      referenced: ["members.view"],
    });
    expect(result.ok).toBe(true);
  });
});

describe("assertCatalogConformance — the three failures", () => {
  it("1. reports a key the code checks and the catalog does not declare", () => {
    const result = assertCatalogConformance({
      catalog: tenantCatalog,
      referenced: [
        { permission: "billing.manage", where: "billing.portal.open procedure" },
      ],
      templates: shippedTemplates,
      deliberatelyUnreachable: ["billing.refund.issue"],
    });

    expect(result.ok).toBe(false);
    const problem = result.problems.find((p) => p.kind === "unknown-reference");
    expect(problem?.permission).toBe("billing.manage");
    expect(problem?.where).toBe("billing.portal.open procedure");
    // The message has to say what happens, because the symptom in production is
    // a 403 with nothing in the logs.
    expect(problem?.reason).toMatch(/resolves to denied/);
  });

  it("2. reports a declared key no template can reach", () => {
    const catalog = definePermissions("tenant", {
      ...tenancyPermissions,
      "reports.export": { label: "Export reports" },
    });

    const result = assertCatalogConformance({
      catalog,
      templates: [
        { key: "owner", grants: catalog.defaultsFor("owner").map(allow) },
        { key: "member", grants: catalog.defaultsFor("member").map(allow) },
      ],
    });

    expect(result.problems.map((p) => p.permission)).toContain("reports.export");
    expect(result.problems.find((p) => p.kind === "unreachable")?.reason).toMatch(
      /no template grants it/,
    );
  });

  it("2. does not count a deny grant as reach", () => {
    // A key that appears only as a seal is granted by nobody. In a grep it
    // looks covered, which is exactly why the check has to be about `allow`.
    const catalog = definePermissions("tenant", {
      "tenant.transfer": { label: "Transfer ownership", sealed: true },
    });

    const result = assertCatalogConformance({
      catalog,
      templates: [
        { key: "admin", grants: [{ permission: "tenant.transfer", effect: "deny" }] },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.problems[0]?.kind).toBe("unreachable");
  });

  it("2. accepts a key the project has declared deliberately unreachable", () => {
    const catalog = definePermissions("tenant", {
      "billing.refund.issue": { label: "Issue a refund", sealed: true },
    });

    expect(
      assertCatalogConformance({
        catalog,
        templates: [{ key: "owner", grants: [] }],
        deliberatelyUnreachable: ["billing.refund.issue"],
      }).ok,
    ).toBe(true);
  });

  it("3. reports a template grant for a key the catalog dropped", () => {
    const result = assertCatalogConformance({
      catalog: tenantCatalog,
      templates: [
        ...shippedTemplates,
        { key: "legacy-admin", grants: [allow("billing.manage")] },
      ],
      deliberatelyUnreachable: ["billing.refund.issue"],
    });

    const problem = result.problems.find((p) => p.kind === "stale-template-grant");
    expect(problem?.permission).toBe("billing.manage");
    expect(problem?.where).toBe('template "legacy-admin"');
    // resolveAgainstCatalog throws on this row, so the consequence is not a
    // quiet denial — it is every request by that role failing.
    expect(problem?.reason).toMatch(/resolveAgainstCatalog throws/);
  });

  it("3. reports a stored override no code search would ever find", () => {
    const result = assertCatalogConformance({
      catalog: tenantCatalog,
      overrides: [{ permission: "billing.manage", principalId: "usr_17" }],
    });

    const problem = result.problems.find((p) => p.kind === "stale-override");
    expect(problem?.where).toBe("principal_override for usr_17");
    expect(problem?.reason).toMatch(/needs a migration/);
  });

  it("reports all three classes in one run instead of stopping at the first", () => {
    // THE REASON THIS RETURNS PROBLEMS RATHER THAN THROWING. Renaming a key
    // breaks the code reference, the template grant and the stored override at
    // once; a check that threw would hand back a third of the work per CI
    // cycle.
    const result = assertCatalogConformance({
      catalog: tenantCatalog,
      referenced: ["billing.manage"],
      templates: [
        ...shippedTemplates,
        { key: "legacy-admin", grants: [allow("billing.manage")] },
      ],
      overrides: [{ permission: "billing.manage", principalId: "usr_17" }],
      deliberatelyUnreachable: [],
    });

    expect(result.ok).toBe(false);
    expect(new Set(result.problems.map((p) => p.kind))).toEqual(
      new Set([
        "unknown-reference",
        "unreachable",
        "stale-template-grant",
        "stale-override",
      ]),
    );
    // Ordered by check, so the report reads in the order the fixes happen.
    expect(result.problems[0]?.kind).toBe("unknown-reference");
  });

  it("names the same missing key once per place it is referenced from", () => {
    // Deduplicating would hide the second call site, and the second call site
    // is the one somebody forgets to change.
    const result = assertCatalogConformance({
      catalog: tenantCatalog,
      referenced: [
        { permission: "billing.manage", where: "portal procedure" },
        { permission: "billing.manage", where: "invoice list component" },
      ],
    });

    expect(result.problems.map((p) => p.where)).toEqual([
      "portal procedure",
      "invoice list component",
    ]);
  });
});

function allow(permission: string) {
  return { permission, effect: "allow" as const };
}
