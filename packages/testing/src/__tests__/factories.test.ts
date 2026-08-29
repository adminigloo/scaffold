import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { users } from "@adminigloo/auth/schema";
import { tenants, tenantMembers } from "@adminigloo/tenancy/schema";
import {
  principalOverride,
  roleTemplate,
  roleTemplateGrant,
  FIRM_WIDE,
} from "@adminigloo/permissions/schema";
import { TENANT_ROLE_TEMPLATES, canManageTemplate } from "@adminigloo/tenancy";
import {
  buildMembership,
  buildOverride,
  buildRoleTemplate,
  buildTemplateGrant,
  buildTenant,
  buildUser,
} from "../factories.js";

/**
 * Column names off a Drizzle table, without importing drizzle-orm.
 *
 * `enableRLS` is a method the table object carries, not a column.
 */
function columnsOf(table: object): string[] {
  return Object.keys(table)
    .filter((key) => key !== "enableRLS")
    .sort();
}

const keysOf = (row: object): string[] => Object.keys(row).sort();

describe("the factories match the shipped tables", () => {
  // The row shapes are declared by hand so that this package never imports a
  // pgTable at runtime. This is the price of that decision: without it, a
  // column added to `users` leaves every fixture silently missing a NOT NULL
  // field, and the failure surfaces as a driver error in an integration test
  // with no hint of where the row came from.
  it("buildUser covers users", () => {
    expect(keysOf(buildUser())).toEqual(columnsOf(users));
  });

  it("buildTenant covers tenants", () => {
    expect(keysOf(buildTenant())).toEqual(columnsOf(tenants));
  });

  it("buildMembership covers tenant_members", () => {
    expect(keysOf(buildMembership())).toEqual(columnsOf(tenantMembers));
  });

  it("buildRoleTemplate covers role_template", () => {
    expect(keysOf(buildRoleTemplate())).toEqual(columnsOf(roleTemplate));
  });

  it("buildTemplateGrant covers role_template_grant", () => {
    expect(keysOf(buildTemplateGrant())).toEqual(columnsOf(roleTemplateGrant));
  });

  it("buildOverride covers principal_override", () => {
    expect(keysOf(buildOverride())).toEqual(columnsOf(principalOverride));
  });

  it("keeps no role on the membership row", () => {
    // tenant_members deliberately has no role column: membership says who is
    // in, permissions say what they may do. A fixture is exactly where a second
    // source of truth gets reintroduced, because it makes tests read nicely.
    expect(Object.keys(buildMembership())).not.toContain("role");
  });
});

describe("determinism", () => {
  it("builds the identical row twice", () => {
    expect(buildUser()).toEqual(buildUser());
    expect(buildTenant({ seed: 4 })).toEqual(buildTenant({ seed: 4 }));
  });

  it("gives different seeds different ids and different unique columns", () => {
    // `users` is UNIQUE (identity_provider, external_id) and `tenants` is
    // UNIQUE (slug) — unqualified by deleted_at. Two fixtures colliding on
    // either turns any test that inserts both into a constraint violation with
    // no obvious cause.
    const a = buildUser({ seed: 1 });
    const b = buildUser({ seed: 2 });
    expect(a.id).not.toBe(b.id);
    expect(a.externalId).not.toBe(b.externalId);
    expect(a.email).not.toBe(b.email);

    expect(buildTenant({ seed: 1 }).slug).not.toBe(buildTenant({ seed: 2 }).slug);
  });

  it("leaves stripeCustomerId null so two tenants can coexist", () => {
    // The unique index tolerates many NULLs and no duplicates. A shared
    // placeholder `cus_test` would make the second tenant in any test fail to
    // insert.
    expect(buildTenant().stripeCustomerId).toBeNull();
  });

  it("pairs a membership with the user and tenant of the same seed", () => {
    const membership = buildMembership({ seed: 3 });
    expect(membership.userId).toBe(buildUser({ seed: 3 }).id);
    expect(membership.tenantId).toBe(buildTenant({ seed: 3 }).id);
  });

  it("pairs a grant with the template of the same seed", () => {
    expect(buildTemplateGrant({ seed: 2 }).templateId).toBe(
      buildRoleTemplate({ seed: 2 }).id,
    );
  });

  it("timestamps every row at the same frozen instant", () => {
    // So a whole-row assertion is possible. If createdAt moved, every such
    // assertion would have to pick the timestamps out by hand, and the field
    // that actually regressed would stop being checked.
    expect(buildUser().createdAt).toEqual(buildTenant().createdAt);
  });
});

describe("overrides", () => {
  it("merge shallowly and win over the default", () => {
    const tenant = buildTenant({ slug: "acme", branding: { logo: "acme.svg" } });
    expect(tenant.slug).toBe("acme");
    expect(tenant.branding).toEqual({ logo: "acme.svg" });
    expect(tenant.name).toBe("Acme Inc");
  });

  it("accept null where the column is nullable", () => {
    expect(buildUser({ email: null, displayName: null }).email).toBeNull();
    expect(buildTenant({ ownerUserId: null }).ownerUserId).toBeNull();
  });

  it("do not leak the seed into the row", () => {
    // `seed` is a factory argument, not a column. A row carrying it would fail
    // an insert against the real table.
    expect(Object.keys(buildUser({ seed: 2 }))).not.toContain("seed");
  });

  it("compose with the seed", () => {
    const user = buildUser({ seed: 5, displayName: "Grace Hopper" });
    expect(user.id).toBe(buildUser({ seed: 5 }).id);
    expect(user.displayName).toBe("Grace Hopper");
  });
});

describe("buildRoleTemplate", () => {
  it("takes the rank from the shipped table rather than a literal", () => {
    // The escalation guard is a `>` between two ranks. A fixture that hard-coded
    // admin as 20 while the shipped table says 30 would prove the opposite of
    // the rule it is named after — and keep proving it after a renumbering.
    for (const shipped of TENANT_ROLE_TEMPLATES) {
      expect(buildRoleTemplate({ key: shipped.key }).rank).toBe(shipped.rank);
    }
  });

  it("produces ranks the escalation guard agrees with", () => {
    const owner = buildRoleTemplate({ key: "owner" });
    const admin = buildRoleTemplate({ key: "admin" });
    expect(canManageTemplate(owner.rank, admin.rank)).toBe(true);
    expect(canManageTemplate(admin.rank, owner.rank)).toBe(false);
    expect(canManageTemplate(admin.rank, admin.rank)).toBe(false);
  });

  it("gives different keys different ids at the same seed", () => {
    expect(buildRoleTemplate({ key: "owner" }).id).not.toBe(
      buildRoleTemplate({ key: "admin" }).id,
    );
  });

  it("ranks an unknown key at zero rather than inventing authority", () => {
    // rank 0 loses every `>` comparison, which is the direction that fails
    // closed for a template nobody has defined yet.
    expect(buildRoleTemplate({ key: "not-a-shipped-template" }).rank).toBe(0);
  });

  it("uses the FIRM_WIDE sentinel, never null or an empty string", () => {
    // UNIQUE (scope, tenant_id, key) only deduplicates when tenant_id is NOT
    // NULL — Postgres treats NULLs as distinct.
    expect(buildRoleTemplate().tenantId).toBe(FIRM_WIDE);
    expect(buildOverride().tenantId).toBe(FIRM_WIDE);
  });
});

describe("factories.ts imports no pgTable", () => {
  // The header comment on factories.ts promises the row shapes are declared by
  // hand so nothing in the shipped module reaches a drizzle table. These two
  // tests are what hold it to that.
  const source = readFileSync(new URL("../factories.ts", import.meta.url), "utf8");

  it("takes only types from the @adminigloo/permissions barrel", () => {
    // The barrel re-exports FIRM_WIDE from schema.ts, which calls pgTable at
    // module scope — so a VALUE import here drags drizzle-orm/pg-core into
    // every consumer of @adminigloo/testing/factories, and (tsup does not
    // code-split CJS) gives a CJS consumer a second copy of every table.
    // Asserted on the source because vitest externalises workspace packages: a
    // vi.mock of pg-core never reaches the import inside @adminigloo/permissions
    // and passes whether or not the bug is present.
    const statements =
      source.match(/^import[\s\S]*?from "@adminigloo\/permissions";$/gm) ?? [];
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement.startsWith("import type ")).toBe(true);
    }
  });

  it("keeps the local sentinel equal to the published one", () => {
    // The copy is deliberate; the drift is not. This test may import the
    // schema subpath because a test file is never shipped.
    expect(buildRoleTemplate().tenantId).toBe(FIRM_WIDE);
    expect(FIRM_WIDE).toBe("*");
    expect(source).toContain('const FIRM_WIDE = "*";');
  });
});

describe("buildTemplateGrant and buildOverride", () => {
  it("default to allow, because deny on a template SEALS", () => {
    // A `deny` default would make half a suite's fixtures unoverridable, and
    // the override tests would fail somewhere else entirely.
    expect(buildTemplateGrant().effect).toBe("allow");
    expect(buildOverride().effect).toBe("allow");
  });

  it("can still express a seal", () => {
    expect(buildTemplateGrant({ permission: "tenant.transfer", effect: "deny" })).toEqual({
      templateId: buildRoleTemplate().id,
      permission: "tenant.transfer",
      effect: "deny",
    });
  });

  it("carries provenance on an override", () => {
    // grantedBy and reason are what make an override auditable. A factory that
    // left them null would make "no provenance" the shape every test asserts
    // against, after which the code that forgets to write them passes review.
    const override = buildOverride();
    expect(override.grantedBy).not.toBeNull();
    expect(override.reason).not.toBeNull();
  });
});
