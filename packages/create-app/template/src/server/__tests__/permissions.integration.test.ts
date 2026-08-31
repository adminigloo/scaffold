import { expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { FIRM_WIDE } from "__SCOPE__/permissions";
import {
  principalOverride,
  principalRole,
  roleTemplate,
  roleTemplateGrant,
} from "__SCOPE__/permissions/schema";
import { tenantMembers, tenants } from "__SCOPE__/tenancy/schema";
import { deterministicId } from "__SCOPE__/testing";
import { buildPrincipal } from "__SCOPE__/testing/auth";
import {
  describeIntegration,
  pgErrorCode,
  withAppDb,
  type AppTransaction,
} from "@/test/db";
import { loadStaffPermissions, loadTenantPermissions } from "@/server/permissions";

/**
 * Point the app's module-scope `db` at the test's open transaction.
 *
 * `src/server/permissions.ts` imports `db` from "@/db" and there is no seam to
 * inject through. Without this the loaders would query a second pooled
 * connection, see none of the uncommitted fixtures below, and answer NULL for
 * every case — which is the same answer four of these tests assert for a
 * completely different reason. See APP_DB_TX_KEY in src/test/db.ts for why the
 * channel is a global and not an import.
 */
vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  return {
    ...actual,
    db: new Proxy(actual.db as object, {
      get(target, prop) {
        const tx = (globalThis as { __appDbIntegrationTx?: object })
          .__appDbIntegrationTx;
        const source: object = tx ?? target;
        const value: unknown = Reflect.get(source, prop);
        return typeof value === "function"
          ? (value as (...args: never[]) => unknown).bind(source)
          : value;
      },
    }),
  };
});

/**
 * Fixture ids, derived from a seed rather than from the clock.
 *
 * `newId()` embeds `Date.now()`, so a failing assertion would print an id that
 * can never occur again and the run could not be reproduced from the log. The
 * namespace keeps these clear of the seeded demo rows on a shared staging
 * branch, even though every write here is rolled back.
 */
const NS = "itest:permissions";
const ids = {
  tenant: deterministicId(NS, 1),
  member: deterministicId(NS, 2),
  stranger: deterministicId(NS, 3),
  staff: deterministicId(NS, 4),
  tenantTemplate: deterministicId(NS, 5),
  staffTemplate: deterministicId(NS, 6),
  misfiledStaff: deterministicId(NS, 7),
  misfiledTemplate: deterministicId(NS, 8),
} as const;

/**
 * Permission keys invented for this file, NOT keys from the app catalog.
 *
 * `resolveFor` calls `resolvePermissionSet`, which does not validate against a
 * catalog — so these exercise the SQL and the merge without pinning the suite
 * to whichever packages this particular project installed. A test written
 * against `catalog.products.view` starts failing the day someone generates the
 * template without the catalog package, for a reason that has nothing to do
 * with permission resolution.
 */
const ALPHA = "itest.alpha";
const BETA = "itest.beta";
const SEALED = "itest.sealed";

const member = buildPrincipal({ userId: ids.member });
const stranger = buildPrincipal({ userId: ids.stranger });
const staff = buildPrincipal({ userId: ids.staff });

/** A tenant plus an ACTIVE membership for `member`. */
async function seedTenant(tx: AppTransaction): Promise<void> {
  await tx.insert(tenants).values({
    id: ids.tenant,
    kind: "org",
    slug: `itest-permissions-${ids.tenant.slice(0, 8)}`,
    name: "Integration tenant",
  });
  await tx
    .insert(tenantMembers)
    .values({ tenantId: ids.tenant, userId: ids.member, status: "active" });
}

/** A tenant-scoped role template carrying `grants`, assigned to `principalId`. */
async function seedTenantRole(
  tx: AppTransaction,
  grants: readonly { permission: string; effect: "allow" | "deny" }[],
  principalId: string = ids.member,
): Promise<void> {
  await tx.insert(roleTemplate).values({
    id: ids.tenantTemplate,
    scope: "tenant",
    tenantId: ids.tenant,
    key: "itest-role",
    name: "Integration role",
  });
  if (grants.length > 0) {
    await tx
      .insert(roleTemplateGrant)
      .values(grants.map((grant) => ({ templateId: ids.tenantTemplate, ...grant })));
  }
  await tx.insert(principalRole).values({
    principalId,
    scope: "tenant",
    tenantId: ids.tenant,
    templateId: ids.tenantTemplate,
  });
}

describeIntegration("loadTenantPermissions, against real rows", () => {
  it("resolves what the role template allows", async () => {
    await withAppDb(async (tx) => {
      await seedTenant(tx);
      await seedTenantRole(tx, [
        { permission: ALPHA, effect: "allow" },
        { permission: BETA, effect: "allow" },
      ]);

      const can = await loadTenantPermissions({
        principal: member,
        tenantId: ids.tenant,
      });

      expect(can).not.toBeNull();
      expect(can?.toArray().slice().sort()).toEqual([ALPHA, BETA]);
    });
  });

  it("lets a per-person override deny take a template grant away", async () => {
    // The unit suite proves the merge from rows it built by hand. What is
    // unproven there is that `resolveFor` issues the override query at all,
    // and with all three predicates — principal, scope AND tenant. Delete the
    // query and every template-only test stays green.
    await withAppDb(async (tx) => {
      await seedTenant(tx);
      await seedTenantRole(tx, [
        { permission: ALPHA, effect: "allow" },
        { permission: BETA, effect: "allow" },
      ]);
      await tx.insert(principalOverride).values({
        principalId: ids.member,
        scope: "tenant",
        tenantId: ids.tenant,
        permission: BETA,
        effect: "deny",
        reason: "integration fixture",
      });

      const can = await loadTenantPermissions({
        principal: member,
        tenantId: ids.tenant,
      });

      expect(can?.can(ALPHA)).toBe(true);
      expect(can?.can(BETA)).toBe(false);
    });
  });

  it("keeps a template deny sealed against an override allow", async () => {
    await withAppDb(async (tx) => {
      await seedTenant(tx);
      await seedTenantRole(tx, [
        { permission: ALPHA, effect: "allow" },
        { permission: SEALED, effect: "deny" },
      ]);
      await tx.insert(principalOverride).values({
        principalId: ids.member,
        scope: "tenant",
        tenantId: ids.tenant,
        permission: SEALED,
        effect: "allow",
        reason: "integration fixture",
      });

      const can = await loadTenantPermissions({
        principal: member,
        tenantId: ids.tenant,
      });

      expect(can?.can(SEALED)).toBe(false);
      expect(can?.can(ALPHA)).toBe(true);
    });
  });

  it("does not leak an override written for a DIFFERENT tenant", async () => {
    // Same principal, same permission, different tenant_id. If the override
    // query lost its tenant predicate this deny would follow the user into
    // every tenant they belong to — one customer's decision silently applied
    // to another customer's data.
    await withAppDb(async (tx) => {
      await seedTenant(tx);
      await seedTenantRole(tx, [{ permission: ALPHA, effect: "allow" }]);
      await tx.insert(principalOverride).values({
        principalId: ids.member,
        scope: "tenant",
        tenantId: "itest-some-other-tenant",
        permission: ALPHA,
        effect: "deny",
      });

      const can = await loadTenantPermissions({
        principal: member,
        tenantId: ids.tenant,
      });

      expect(can?.can(ALPHA)).toBe(true);
    });
  });
});

/**
 * NULL and the empty set are DIFFERENT ANSWERS, and this is the only place the
 * difference is checked against the real membership query.
 *
 * The unit suite resolves rows it was handed, so it cannot observe the
 * membership lookup at all. If that lookup were dropped — or written against
 * the wrong column, or without `status = 'active'` — every test above still
 * passes, and `tenantProcedure` starts admitting any signed-in user to any
 * tenant id they can type into a URL.
 */
describeIntegration("membership is checked separately from grants", () => {
  it("answers NULL, not an empty set, for a non-member of a real tenant", async () => {
    await withAppDb(async (tx) => {
      await seedTenant(tx);
      await seedTenantRole(tx, [{ permission: ALPHA, effect: "allow" }]);

      const can = await loadTenantPermissions({
        principal: stranger,
        tenantId: ids.tenant,
      });

      expect(can).toBeNull();
    });
  });

  it("answers NULL for a tenant id that does not exist at all", async () => {
    await withAppDb(async () => {
      const can = await loadTenantPermissions({
        principal: member,
        tenantId: "itest-tenant-that-was-never-created",
      });

      expect(can).toBeNull();
    });
  });

  it("answers NULL for a SUSPENDED member", async () => {
    // `suspended` keeps the row and its audit trail while blocking access, so
    // the membership row exists and only the status predicate stands between a
    // suspended user and the tenant.
    await withAppDb(async (tx) => {
      await seedTenant(tx);
      await seedTenantRole(tx, [{ permission: ALPHA, effect: "allow" }]);
      await tx
        .update(tenantMembers)
        .set({ status: "suspended" })
        .where(
          and(
            eq(tenantMembers.tenantId, ids.tenant),
            eq(tenantMembers.userId, ids.member),
          ),
        );

      const can = await loadTenantPermissions({
        principal: member,
        tenantId: ids.tenant,
      });

      expect(can).toBeNull();
    });
  });

  it("answers an EMPTY SET for a member who holds no role", async () => {
    // The other half of the contract. A member with nothing granted must come
    // back as a usable, empty PermissionSet — if this returned NULL as well the
    // two states would be indistinguishable in the other direction, and the
    // tenant rung could not tell "not yours" from "nothing yet".
    await withAppDb(async (tx) => {
      await seedTenant(tx);

      const can = await loadTenantPermissions({
        principal: member,
        tenantId: ids.tenant,
      });

      expect(can).not.toBeNull();
      expect(can?.toArray()).toEqual([]);
      expect(can?.can(ALPHA)).toBe(false);
    });
  });
});

/**
 * The `'*'` sentinel, and why `principal_role.tenant_id` is NOT NULL.
 *
 * Staff rows are firm-wide, so they need a tenant_id meaning "no tenant". The
 * schema comment justifies the sentinel by unique-index semantics; the
 * consequence that bites at RUNTIME is simpler and is what these tests pin.
 * `resolveFor` matches with `tenant_id = '*'`, and `NULL = '*'` is UNKNOWN — so
 * a nullable column would make every staff grant silently invisible to the
 * resolver, with no error anywhere.
 */
describeIntegration("loadStaffPermissions and the '*' sentinel", () => {
  it("resolves a staff assignment stored at tenant_id = '*'", async () => {
    await withAppDb(async (tx) => {
      await tx.insert(roleTemplate).values({
        id: ids.staffTemplate,
        scope: "staff",
        tenantId: FIRM_WIDE,
        key: "itest-staff-role",
        name: "Integration staff role",
      });
      await tx
        .insert(roleTemplateGrant)
        .values({ templateId: ids.staffTemplate, permission: ALPHA, effect: "allow" });
      await tx.insert(principalRole).values({
        principalId: ids.staff,
        scope: "staff",
        tenantId: FIRM_WIDE,
        templateId: ids.staffTemplate,
      });

      const can = await loadStaffPermissions({ principal: staff });

      expect(can?.toArray()).toEqual([ALPHA]);

      // The stored value really is the sentinel, not a default the test never
      // saw written. `FIRM_WIDE` and the column default must not drift apart.
      const [row] = await tx
        .select({ tenantId: principalRole.tenantId })
        .from(principalRole)
        .where(
          and(
            eq(principalRole.principalId, ids.staff),
            eq(principalRole.scope, "staff"),
          ),
        );
      expect(row?.tenantId).toBe("*");
      expect(FIRM_WIDE).toBe("*");
    });
  });

  it("would lose the row entirely if tenant_id were NULL, because NULL = '*' is UNKNOWN", async () => {
    // The reason the NOT NULL matters at RUNTIME, asked of the same server the
    // resolver runs on rather than asserted from memory of the SQL standard.
    // `resolveFor` filters with `tenant_id = '*'`; a NULL would make that
    // comparison UNKNOWN, the WHERE would drop the row, and the staff grant
    // would vanish with no error and no log line anywhere.
    await withAppDb(async (tx) => {
      // Read straight off `Record<string, unknown>` rather than casting the
      // rows into a shape. `execute()` is genuinely untyped, and a cast here
      // would be an unchecked claim about a result the test is supposed to be
      // interrogating.
      const [logic] = (
        await tx.execute(sql`
          select (null::text = '*') is null as comparison_is_unknown,
                 count(*)::int as rows_a_null_would_match
          from (select null::text as tenant_id) candidate
          where candidate.tenant_id = '*'
        `)
      ).rows;

      expect(logic?.comparison_is_unknown).toBe(true);
      expect(logic?.rows_a_null_would_match).toBe(0);
    });
  });

  it("rejects a NULL tenant_id at the database", async () => {
    // LAST STATEMENT IN ITS TRANSACTION, deliberately. A constraint violation
    // puts Postgres into "current transaction is aborted, commands ignored
    // until end of transaction block" (25P02), so anything after it fails with
    // an error that has nothing to do with what it was testing.
    await withAppDb(async (tx) => {
      await tx.insert(roleTemplate).values({
        id: ids.staffTemplate,
        scope: "staff",
        tenantId: FIRM_WIDE,
        key: "itest-staff-role",
        name: "Integration staff role",
      });

      const attempt = tx.execute(sql`
        insert into principal_role (principal_id, scope, tenant_id, template_id)
        values (${ids.staff}, 'staff', null, ${ids.staffTemplate})
      `);

      // 23502 = not_null_violation. Matched on SQLSTATE rather than on the
      // message, which would also match a typo in the fixture above.
      await expect(attempt).rejects.toSatisfy(
        (error: unknown) => pgErrorCode(error) === "23502",
      );
    });
  });

  it("resolves a staff assignment filed under any other tenant id to an EMPTY set, not NULL", async () => {
    // A real seam in `loadStaffPermissions`, worth pinning: the gate query
    // matches `scope = 'staff'` with NO tenant predicate, while `resolveFor`
    // then re-queries pinned to '*'. A staff row written with a tenant id —
    // which the schema permits, the column is plain text — therefore passes the
    // gate and resolves to nothing. The caller is told "staff with zero
    // permissions", never "not staff", so the two queries have to agree about
    // the sentinel or the row becomes unreachable while still granting entry.
    await withAppDb(async (tx) => {
      await tx.insert(roleTemplate).values({
        id: ids.misfiledTemplate,
        scope: "staff",
        tenantId: FIRM_WIDE,
        key: "itest-misfiled-role",
        name: "Integration misfiled staff role",
      });
      await tx.insert(roleTemplateGrant).values({
        templateId: ids.misfiledTemplate,
        permission: ALPHA,
        effect: "allow",
      });
      await tx.insert(principalRole).values({
        principalId: ids.misfiledStaff,
        scope: "staff",
        tenantId: "itest-not-the-sentinel",
        templateId: ids.misfiledTemplate,
      });

      const can = await loadStaffPermissions({
        principal: buildPrincipal({ userId: ids.misfiledStaff }),
      });

      expect(can).not.toBeNull();
      expect(can?.toArray()).toEqual([]);
    });
  });

  it("answers NULL for a principal holding no staff role", async () => {
    await withAppDb(async () => {
      const can = await loadStaffPermissions({
        principal: buildPrincipal({ userId: deterministicId(NS, 99) }),
      });

      expect(can).toBeNull();
    });
  });
});
