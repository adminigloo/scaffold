import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { FIRM_WIDE } from "__SCOPE__/permissions";
import { principalRole, roleTemplate, roleTemplateGrant } from "__SCOPE__/permissions/schema";
import { users } from "__SCOPE__/auth/schema";
import { deterministicId } from "__SCOPE__/testing";
import {
  db,
  describeIntegration,
  withAppDb,
  withRollback,
  type AppTransaction,
} from "@/test/db";

/**
 * Same redirect as the other integration suites: `src/server/bootstrap.ts`
 * closes over `db` from "@/db" at module scope, so without this the INSERT it
 * runs would land on a second pooled connection, outside the test transaction,
 * and COMMIT a staff:admin grant into the shared staging database. See
 * APP_DB_TX_KEY in src/test/db.ts.
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
 * Make `env.BOOTSTRAP_ADMIN_EMAIL` and the Clerk keys readable at CALL time.
 *
 * `@t3-oss/env-nextjs` parses `process.env` once, at import, and hands back a
 * frozen object — so `vi.stubEnv` on its own changes nothing that
 * `grantBootstrapAdminIfFirst` can see, and the deployed-environment branches
 * below would silently all take the same path. Reading through to
 * `process.env` for the three keys these tests drive is what makes the gate
 * testable; every other variable, DATABASE_URL included, still comes from the
 * real parsed env.
 *
 * The Clerk keys are pinned rather than read because `currentPrincipal` returns
 * null early when they are absent. On a laptop without Clerk configured, the
 * soft-delete test below would otherwise pass without ever reaching the code
 * it is about.
 */
vi.mock("@/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/env")>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get(target, prop) {
        if (prop === "BOOTSTRAP_ADMIN_EMAIL") return process.env.BOOTSTRAP_ADMIN_EMAIL;
        if (prop === "CLERK_SECRET_KEY") return "sk_test_integration";
        if (prop === "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY") return "pk_test_integration";
        return Reflect.get(target, prop);
      },
    }),
  };
});

/**
 * Clerk, replaced wholesale.
 *
 * Only `currentPrincipal` needs it, and only for the soft-delete test. Hoisted
 * state rather than a closure over a `let` declared below, because `vi.mock`
 * factories are lifted above every import and a plain `const` would be in its
 * temporal dead zone when the factory runs.
 */
const clerk = vi.hoisted(() => ({ externalId: null as string | null }));

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => Promise.resolve({ userId: clerk.externalId }),
  // Never reached in this file: every test here starts from a users row that
  // already exists, so `currentPrincipal` returns before it would mirror.
  currentUser: () => Promise.resolve(null),
}));

const { grantBootstrapAdminIfFirst } = await import("@/server/bootstrap");
const { currentPrincipal } = await import("@/server/auth");

const NS = "itest:bootstrap";
const ids = {
  first: deterministicId(NS, 1),
  second: deterministicId(NS, 2),
  deleted: deterministicId(NS, 3),
  raceA: deterministicId(NS, 4),
  raceB: deterministicId(NS, 5),
} as const;

const FIRST_EMAIL = "first@example.com";
const SECOND_EMAIL = "second@example.com";

beforeEach(() => {
  // A successful grant logs one line, and this suite grants several times.
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/**
 * Empty the staff rung inside the transaction.
 *
 * The staging branch is seeded, so `principal_role` already holds staff rows
 * and `WHERE NOT EXISTS (SELECT 1 FROM principal_role WHERE scope = 'staff')`
 * would be false before the test began — every grant test would "pass" by
 * never running the interesting branch. Rolled back with everything else.
 */
async function clearStaffRoles(tx: AppTransaction): Promise<void> {
  await tx.delete(principalRole).where(eq(principalRole.scope, "staff"));
}

async function staffRows(
  tx: AppTransaction,
): Promise<readonly { principalId: string; templateId: string }[]> {
  return tx
    .select({
      principalId: principalRole.principalId,
      templateId: principalRole.templateId,
    })
    .from(principalRole)
    .where(eq(principalRole.scope, "staff"));
}

/** The seeded staff:admin template every grant must point at. */
async function staffAdminTemplateId(tx: AppTransaction): Promise<string> {
  const [row] = await tx
    .select({ id: roleTemplate.id })
    .from(roleTemplate)
    .where(
      and(
        eq(roleTemplate.scope, "staff"),
        eq(roleTemplate.key, "admin"),
        eq(roleTemplate.tenantId, FIRM_WIDE),
      ),
    );
  // Not an assertion inside a test: if `pnpm db:seed` has not run there is
  // nothing to bootstrap TO, and every test in this file is meaningless rather
  // than failing.
  if (!row) throw new Error("role_template staff:admin is missing — run `pnpm db:seed`");
  return row.id;
}

describeIntegration("grantBootstrapAdminIfFirst, on an empty staff rung", () => {
  it("grants staff:admin to the first user", async () => {
    await withAppDb(async (tx) => {
      await clearStaffRoles(tx);
      const templateId = await staffAdminTemplateId(tx);

      const granted = await grantBootstrapAdminIfFirst(ids.first, FIRST_EMAIL);

      expect(granted).toBe(true);
      expect(await staffRows(tx)).toEqual([
        { principalId: ids.first, templateId },
      ]);
    });
  });

  it("no-ops once ANY staff role exists, even a non-admin one", async () => {
    await withAppDb(async (tx) => {
      // Not cleared. The staging branch's seeded staff rows are exactly the
      // "somebody is already inside" state this branch exists for.
      const before = await staffRows(tx);
      expect(before.length).toBeGreaterThan(0);

      const granted = await grantBootstrapAdminIfFirst(ids.first, FIRST_EMAIL);

      expect(granted).toBe(false);
      expect(await staffRows(tx)).toEqual(before);
    });
  });

  it("grants nothing when the staff:admin template has not been seeded", async () => {
    await withAppDb(async (tx) => {
      await clearStaffRoles(tx);
      const templateId = await staffAdminTemplateId(tx);
      // `role_template_grant` cascades; `principal_role` is ON DELETE RESTRICT,
      // which is why the staff assignments had to go first.
      await tx.delete(roleTemplateGrant).where(eq(roleTemplateGrant.templateId, templateId));
      await tx.delete(roleTemplate).where(eq(roleTemplate.id, templateId));

      const granted = await grantBootstrapAdminIfFirst(ids.first, FIRST_EMAIL);

      expect(granted).toBe(false);
      expect(await staffRows(tx)).toEqual([]);
    });
  });

  it("hands admin to exactly one of two sign-ins served by the same connection", async () => {
    // The in-process half of the claim. Both calls go through one pooled
    // connection, so the second statement runs after the first and its
    // `WHERE NOT EXISTS` sees the row the first just wrote — no in-process
    // memory, no "have I already granted?" flag.
    //
    // This is NOT proof that the statement is atomic across connections. See
    // the next describe block: it is not, and that is a finding rather than a
    // gap in this test.
    await withAppDb(async (tx) => {
      await clearStaffRoles(tx);

      const outcomes = await Promise.all([
        grantBootstrapAdminIfFirst(ids.raceA, "a@example.com"),
        grantBootstrapAdminIfFirst(ids.raceB, "b@example.com"),
      ]);

      expect(outcomes.filter(Boolean)).toHaveLength(1);
      const rows = await staffRows(tx);
      expect(rows).toHaveLength(1);
      expect([ids.raceA, ids.raceB]).toContain(rows[0]?.principalId);
    });
  });
});

/**
 * *** FINDING — the `WHERE NOT EXISTS` guard is NOT atomic across connections. ***
 *
 * src/server/bootstrap.ts says "Atomic by construction … two simultaneous first
 * sign-ins cannot both win — the second sees the first's row and inserts
 * nothing." Under READ COMMITTED, which is Postgres's default and what this
 * app runs at, that is false. A plain `SELECT` in the `NOT EXISTS` subquery
 * neither sees nor waits on another transaction's uncommitted INSERT, and
 * `principal_role`'s primary key is (principal_id, scope, tenant_id) — so two
 * DIFFERENT user ids conflict on nothing and both rows commit. Two
 * administrators, which is precisely the outcome the comment promises cannot
 * happen. `ON CONFLICT DO NOTHING` cannot help: there is no unique index
 * spanning "at most one staff row".
 *
 * The test below demonstrates the mechanism on the real table with a
 * namespaced existence predicate, because the real predicate is global and the
 * staging branch is seeded. Both transactions roll back.
 *
 * The fix is a constraint the database can enforce — e.g. a partial unique
 * index making "one staff bootstrap row" representable — not a different
 * spelling of the same read.
 */
describeIntegration("the WHERE NOT EXISTS guard, across two real connections", () => {
  it("lets BOTH concurrent transactions insert", async () => {
    const namespace = "itest-bootstrap-race";
    const inserted = defer();
    const observed = defer();

    const attempt = async (
      principalId: string,
      before: () => Promise<void>,
      after: () => void,
    ): Promise<number> =>
      withRollback(db, async (tx) => {
        // A stuck test must fail, not hang: if a future schema change DID make
        // these serialise, the second one would block here forever otherwise.
        await tx.execute(sql`set local statement_timeout = '5s'`);
        const templateId = await staffAdminTemplateId(tx as AppTransaction);
        await before();
        const result = await tx.execute(sql`
          insert into principal_role (principal_id, scope, tenant_id, template_id)
          select ${principalId}, 'tenant', ${namespace}, ${templateId}
          where not exists (
            select 1 from principal_role where tenant_id = ${namespace}
          )
          on conflict do nothing
          returning principal_id
        `);
        after();
        return result.rows.length;
      });

    const [a, b] = await Promise.all([
      attempt(
        ids.raceA,
        () => Promise.resolve(),
        () => inserted.resolve(),
      ),
      // Starts only after A's INSERT has definitely run and is uncommitted.
      attempt(
        ids.raceB,
        () => inserted.promise,
        () => observed.resolve(),
      ),
    ]);
    await observed.promise;

    // Both. If this ever flips to `[1, 0]` the guard has been given real teeth
    // — delete this test and turn the same assertion into the atomicity proof
    // the comment in src/server/bootstrap.ts already claims.
    expect([a, b]).toEqual([1, 1]);
  });
});

describeIntegration("who qualifies depends on the deployment", () => {
  it("grants the first user on a laptop, with no BOOTSTRAP_ADMIN_EMAIL set", async () => {
    // `resolveAppEnv()` derives "local" from an ABSENT VERCEL_ENV, so this is
    // the default and needs no stub — but stated explicitly, because the test
    // below differs from it by exactly one variable.
    vi.stubEnv("VERCEL_ENV", undefined);
    vi.stubEnv("BOOTSTRAP_ADMIN_EMAIL", undefined);

    await withAppDb(async (tx) => {
      await clearStaffRoles(tx);

      expect(await grantBootstrapAdminIfFirst(ids.first, FIRST_EMAIL)).toBe(true);
      expect(await staffRows(tx)).toHaveLength(1);
    });
  });

  it("grants NOTHING on a deployment with no BOOTSTRAP_ADMIN_EMAIL", async () => {
    // The public-internet case. "Whoever signs in first" on a deployed URL is
    // a race against strangers, and the loss — customer list, audit log,
    // impersonation — is total. With no expected email the correct behaviour is
    // to grant nobody and make the operator write the first row by hand.
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("BOOTSTRAP_ADMIN_EMAIL", undefined);

    await withAppDb(async (tx) => {
      await clearStaffRoles(tx);

      expect(await grantBootstrapAdminIfFirst(ids.first, FIRST_EMAIL)).toBe(false);
      expect(await staffRows(tx)).toEqual([]);
    });
  });

  it("grants on a deployment only to the configured email, case- and space-insensitively", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("BOOTSTRAP_ADMIN_EMAIL", FIRST_EMAIL);

    await withAppDb(async (tx) => {
      await clearStaffRoles(tx);

      expect(await grantBootstrapAdminIfFirst(ids.second, SECOND_EMAIL)).toBe(false);
      expect(await staffRows(tx)).toEqual([]);

      expect(
        await grantBootstrapAdminIfFirst(ids.first, `  ${FIRST_EMAIL.toUpperCase()} `),
      ).toBe(true);
      expect(await staffRows(tx)).toHaveLength(1);
    });
  });

  it("grants nothing to a user with no email on a deployment", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("BOOTSTRAP_ADMIN_EMAIL", FIRST_EMAIL);

    await withAppDb(async (tx) => {
      await clearStaffRoles(tx);

      expect(await grantBootstrapAdminIfFirst(ids.first, null)).toBe(false);
      expect(await staffRows(tx)).toEqual([]);
    });
  });
});

/**
 * A soft-deleted user must not be bootstrapped back to life.
 *
 * The guard is NOT in `grantBootstrapAdminIfFirst` — it takes a user id and an
 * email and asks the database nothing about either. It lives one level up, in
 * `currentPrincipal`, which returns null on `deletedAt` BEFORE the mirror path
 * that would call the grant. Both halves are asserted here so that moving the
 * check, or deleting it, fails something.
 */
describeIntegration("a soft-deleted user", () => {
  it("never reaches the grant, because currentPrincipal stops first", async () => {
    clerk.externalId = "user_2itestbootstrapdeleted";

    await withAppDb(async (tx) => {
      await clearStaffRoles(tx);
      await tx.insert(users).values({
        id: ids.deleted,
        externalId: clerk.externalId ?? "",
        email: "deleted@example.com",
        deletedAt: new Date("2026-01-01T00:00:00.000Z"),
      });

      expect(await currentPrincipal()).toBeNull();
      expect(await staffRows(tx)).toEqual([]);
    });
  });

  it("WOULD be granted if something called the bootstrap directly", async () => {
    // Documents where the boundary actually is. `grantBootstrapAdminIfFirst`
    // has no soft-delete check of its own, so a second caller added elsewhere —
    // a webhook, an admin action, a CLI — does not inherit the protection above
    // and has to repeat it. If a `deleted_at` check is ever added to the
    // bootstrap itself, this expectation flips to `false` and this comment
    // stops being true.
    await withAppDb(async (tx) => {
      await clearStaffRoles(tx);
      await tx.insert(users).values({
        id: ids.deleted,
        externalId: "user_2itestbootstrapdeleted2",
        email: "deleted@example.com",
        deletedAt: new Date("2026-01-01T00:00:00.000Z"),
      });

      expect(await grantBootstrapAdminIfFirst(ids.deleted, "deleted@example.com")).toBe(
        true,
      );
    });
  });
});

/** A promise plus its resolver, for ordering two live transactions. */
function defer(): { readonly promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
