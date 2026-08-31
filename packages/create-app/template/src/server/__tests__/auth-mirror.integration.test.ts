import { afterEach, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { users } from "__SCOPE__/auth/schema";
import { personalWorkspaceId, personalWorkspaceSlug } from "__SCOPE__/tenancy";
import { tenantMembers, tenants } from "__SCOPE__/tenancy/schema";
import { deterministicId } from "__SCOPE__/testing";
import {
  db,
  describeIntegration,
  pgErrorCode,
  withAppDb,
  withRollback,
  type AppTransaction,
} from "@/test/db";

/**
 * The app's `db`, redirected into the test transaction. See APP_DB_TX_KEY in
 * src/test/db.ts. Without it `currentPrincipal` would mirror a user into the
 * committed staging database and leave the row, its personal workspace and its
 * membership behind for the next run to trip over.
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
 * Clerk keys forced present.
 *
 * `currentPrincipal` returns null immediately when either key is missing, so on
 * a laptop that has not signed up for Clerk every test in this file would pass
 * without executing one line of the mirror.
 */
vi.mock("@/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/env")>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get(target, prop) {
        if (prop === "CLERK_SECRET_KEY") return "sk_test_integration";
        if (prop === "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY") return "pk_test_integration";
        return Reflect.get(target, prop);
      },
    }),
  };
});

/**
 * The fields `mirrorUser` reads off a Clerk user, and nothing else.
 *
 * Clerk is the one dependency here that genuinely cannot be exercised: it is a
 * network identity provider. Everything below it — the insert, the conflict
 * clause, the follow-up select, the workspace — is the real thing against the
 * real database.
 */
interface ClerkUserStub {
  readonly primaryEmailAddress: { readonly emailAddress: string } | null;
  readonly emailAddresses: readonly { readonly emailAddress: string }[];
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly imageUrl: string;
}

/**
 * Hoisted, because `vi.mock` factories are lifted above every import in the
 * file and a plain `const` declared here would still be in its temporal dead
 * zone when the factory body runs.
 */
const clerk = vi.hoisted(() => ({
  externalId: null as string | null,
  user: null as ClerkUserStub | null,
  /**
   * Runs INSIDE `currentUser()`, which is the one point the mirror yields
   * between its SELECT and its INSERT.
   *
   * This is the seam that makes the webhook race reproducible instead of
   * hypothetical. Writing the competing row before calling
   * `currentPrincipal()` proves nothing: the row would be found by the initial
   * `existing` lookup, `mirrorUser` would never run, and a test asserting "the
   * winner's row is adopted" would pass without executing the conflict clause
   * it is named after.
   */
  duringCurrentUser: null as (() => Promise<void>) | null,
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => Promise.resolve({ userId: clerk.externalId }),
  currentUser: async () => {
    if (clerk.duringCurrentUser) await clerk.duringCurrentUser();
    return clerk.user;
  },
}));

const { currentPrincipal } = await import("@/server/auth");

const NS = "itest:auth-mirror";
const EXTERNAL_ID = "user_2itestauthmirror0000000001";
const RACE_EXTERNAL_ID = "user_2itestauthmirror0000000002";
const ids = {
  webhookWinner: deterministicId(NS, 1),
  raceA: deterministicId(NS, 2),
  raceB: deterministicId(NS, 3),
  otherProvider: deterministicId(NS, 4),
} as const;

function clerkUser(overrides: Partial<ClerkUserStub> = {}): ClerkUserStub {
  return {
    primaryEmailAddress: { emailAddress: "Ada@Example.COM" },
    emailAddresses: [{ emailAddress: "Ada@Example.COM" }],
    firstName: "Ada",
    lastName: "Lovelace",
    imageUrl: "https://img.clerk.com/itest",
    ...overrides,
  };
}

afterEach(() => {
  clerk.externalId = null;
  clerk.user = null;
  clerk.duringCurrentUser = null;
});

describeIntegration("the lazy user mirror", () => {
  it("creates the local row and the personal workspace on first sight", async () => {
    clerk.externalId = EXTERNAL_ID;
    clerk.user = clerkUser();

    await withAppDb(async (tx) => {
      const principal = await currentPrincipal();

      expect(principal).not.toBeNull();
      expect(principal?.externalId).toBe(EXTERNAL_ID);
      // Lowercased at the boundary, so a later lookup by email is not a
      // case-sensitivity coin flip.
      expect(principal?.email).toBe("ada@example.com");

      const [row] = await tx
        .select()
        .from(users)
        .where(eq(users.externalId, EXTERNAL_ID));
      expect(row?.id).toBe(principal?.userId);
      expect(row?.identityProvider).toBe("clerk");
      expect(row?.displayName).toBe("Ada Lovelace");
      // NOT stamped by the mirror. `provider_updated_at` records the last
      // WEBHOOK applied; stamping it from a session read would make a
      // genuinely newer webhook look stale and be discarded.
      expect(row?.providerUpdatedAt).toBeNull();

      const workspaceId = personalWorkspaceId(principal?.userId ?? "");
      const [workspace] = await tx
        .select()
        .from(tenants)
        .where(eq(tenants.id, workspaceId));
      expect(workspace?.kind).toBe("personal");
      expect(workspace?.slug).toBe(personalWorkspaceSlug(principal?.userId ?? ""));
      expect(workspace?.ownerUserId).toBe(principal?.userId);

      const membership = await tx
        .select()
        .from(tenantMembers)
        .where(eq(tenantMembers.tenantId, workspaceId));
      expect(membership).toHaveLength(1);
      expect(membership[0]?.status).toBe("active");
    });
  });

  it("is idempotent: a second sign-in reuses the row and mints nothing", async () => {
    clerk.externalId = EXTERNAL_ID;
    clerk.user = clerkUser();

    await withAppDb(async (tx) => {
      const first = await currentPrincipal();
      const second = await currentPrincipal();

      expect(second?.userId).toBe(first?.userId);

      const rows = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.externalId, EXTERNAL_ID));
      expect(rows).toHaveLength(1);

      const workspaces = await tx
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.id, personalWorkspaceId(first?.userId ?? "")));
      expect(workspaces).toHaveLength(1);
    });
  });
});

/**
 * The webhook and the session mirror both create the same row, and neither
 * knows about the other. The unique index on (identity_provider, external_id)
 * is the ONLY thing standing between that and two local identities for one
 * person — two `users.id` values, and every foreign key in the database
 * pointing at whichever one won that request.
 */
describeIntegration("racing the webhook", () => {
  it("loses without erroring, and adopts the winner's row", async () => {
    clerk.externalId = EXTERNAL_ID;
    clerk.user = clerkUser();

    await withAppDb(async (tx) => {
      // The webhook arrives AFTER the mirror's `existing` lookup missed and
      // BEFORE its insert — see `duringCurrentUser` above for why the timing
      // has to be this and not "seeded beforehand". Its row carries an id the
      // mirror could not have guessed.
      clerk.duringCurrentUser = async () => {
        await tx.insert(users).values({
          id: ids.webhookWinner,
          externalId: EXTERNAL_ID,
          email: "ada@example.com",
          providerUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
        });
      };

      const principal = await currentPrincipal();

      // `onConflictDoNothing` returned no row, so the mirror fell through to
      // the follow-up SELECT — which is the branch that makes the race safe.
      // Without it `created` is undefined and `currentPrincipal` answers null
      // for a user who is signed in and whose row exists, forever.
      expect(principal?.userId).toBe(ids.webhookWinner);

      const rows = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.externalId, EXTERNAL_ID));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(ids.webhookWinner);

      // And the webhook's own bookkeeping survived the losing insert.
      const [row] = await tx
        .select({ providerUpdatedAt: users.providerUpdatedAt })
        .from(users)
        .where(eq(users.id, ids.webhookWinner));
      expect(row?.providerUpdatedAt).not.toBeNull();
    });
  });

  it("re-running the personal workspace against rows that already exist is a no-op", async () => {
    // The path the previous test takes, one step further. The mirror lost the
    // insert but still calls `ensurePersonalWorkspace` for the adopted row, so
    // both of its writes land on rows that are already there. Bare
    // `onConflictDoNothing()` — no target — is what absorbs that, and it has to
    // absorb BOTH the primary key and the unique slug index: the tenant id and
    // the slug are each derived from the user id, so a target naming only the
    // primary key would still raise 23505 on `tenants_slug_idx`.
    clerk.externalId = EXTERNAL_ID;
    clerk.user = clerkUser();

    await withAppDb(async (tx) => {
      const workspaceId = personalWorkspaceId(ids.webhookWinner);

      // A concurrent first sign-in that got all the way through: user row,
      // workspace, membership. Ours then loses the insert and runs
      // `ensurePersonalWorkspace` over the top of all three.
      clerk.duringCurrentUser = async () => {
        await tx.insert(users).values({
          id: ids.webhookWinner,
          externalId: EXTERNAL_ID,
          email: "ada@example.com",
        });
        await tx.insert(tenants).values({
          id: workspaceId,
          kind: "personal",
          slug: personalWorkspaceSlug(ids.webhookWinner),
          name: "Personal",
          ownerUserId: ids.webhookWinner,
        });
        await tx
          .insert(tenantMembers)
          .values({ tenantId: workspaceId, userId: ids.webhookWinner, status: "active" });
      };

      const principal = await currentPrincipal();

      expect(principal?.userId).toBe(ids.webhookWinner);
      const workspaces = await tx
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.id, workspaceId));
      expect(workspaces).toHaveLength(1);
      const membership = await tx
        .select({ userId: tenantMembers.userId })
        .from(tenantMembers)
        .where(eq(tenantMembers.tenantId, workspaceId));
      expect(membership).toHaveLength(1);
    });
  });
});

/**
 * What the index actually covers, asked of the database rather than read off
 * the schema file. A migration that shipped the index on `external_id` alone,
 * or that never shipped it, leaves every test above green — `onConflictDoNothing`
 * without a working index simply inserts a second row.
 */
describeIntegration("the unique index on (identity_provider, external_id)", () => {
  it("rejects a duplicate PAIR", async () => {
    await withAppDb(async (tx) => {
      await tx.insert(users).values({
        id: ids.raceA,
        externalId: RACE_EXTERNAL_ID,
        email: "a@example.com",
      });

      const duplicate = tx.insert(users).values({
        id: ids.raceB,
        externalId: RACE_EXTERNAL_ID,
        email: "b@example.com",
      });

      // 23505 = unique_violation. Last statement in the transaction: the
      // violation aborts it, and anything after would fail with 25P02 instead.
      await expect(duplicate).rejects.toSatisfy(
        (error: unknown) => pgErrorCode(error) === "23505",
      );
    });
  });

  it("allows the same external id under a DIFFERENT provider", async () => {
    // The reason the provider is in the index at all: `external_id` is the
    // provider's namespace, not a global one. Swapping Clerk for WorkOS means
    // both providers' ids coexist during the migration, and a single-column
    // index would reject the second one.
    await withAppDb(async (tx) => {
      await tx.insert(users).values({
        id: ids.raceA,
        externalId: RACE_EXTERNAL_ID,
        email: "a@example.com",
      });
      await tx.insert(users).values({
        id: ids.otherProvider,
        identityProvider: "workos",
        externalId: RACE_EXTERNAL_ID,
        email: "a@example.com",
      });

      const rows = await tx
        .select({ provider: users.identityProvider })
        .from(users)
        .where(eq(users.externalId, RACE_EXTERNAL_ID));
      expect(rows.map((row) => row.provider).sort()).toEqual(["clerk", "workos"]);
    });
  });

  it("makes two CONCURRENT connections wait on each other instead of both inserting", async () => {
    // The property that makes the webhook and the session mirror safe to race
    // FOR REAL: two different processes, two pooled connections, no shared
    // memory. Postgres blocks the second inserter on the first's uncommitted
    // index entry — it cannot decide "conflict or not" until the first
    // transaction ends. Both transactions here roll back, so the second is
    // released by a rollback rather than a commit and the assertion is on the
    // BLOCKING, which is the part that cannot be observed from one connection.
    const inserted = defer();
    const finished = defer();

    const [first, second] = await Promise.all([
      withRollback(db, async (tx) => {
        await tx.insert(users).values({
          id: ids.raceA,
          externalId: RACE_EXTERNAL_ID,
          email: "a@example.com",
        });
        inserted.resolve();
        // Hold the row locked until the other side has had its answer.
        await finished.promise;
        return "inserted" as const;
      }),
      withRollback(db, async (tx) => {
        await inserted.promise;
        // Bounded, so a suite that stops blocking fails in half a second
        // instead of hanging the run until CI kills it.
        await tx.execute(sql`set local lock_timeout = '750ms'`);
        try {
          await tx.insert(users).values({
            id: ids.raceB,
            externalId: RACE_EXTERNAL_ID,
            email: "b@example.com",
          });
          return "inserted-too" as const;
        } catch (error) {
          // 55P03 = lock_not_available: it waited, which is the proof.
          return pgErrorCode(error) ?? "no-sqlstate";
        } finally {
          finished.resolve();
        }
      }),
    ]);

    expect(first).toBe("inserted");
    expect(second).toBe("55P03");

    // Belt and braces: neither transaction committed anything.
    const leftovers = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.externalId, RACE_EXTERNAL_ID));
    expect(leftovers).toEqual([]);
  });
});

describeIntegration("a signed-in stranger", () => {
  it("answers null when Clerk has no session", async () => {
    clerk.externalId = null;

    await withAppDb(async () => {
      expect(await currentPrincipal()).toBeNull();
    });
  });

  it("answers null, and writes nothing, when Clerk cannot produce the user", async () => {
    // `auth()` gave us an id but `currentUser()` came back empty — a revoked
    // session, or a Clerk outage. The mirror must not write a row with no
    // email and no name and call that a user.
    clerk.externalId = "user_2itestauthmirrorghost001";
    clerk.user = null;

    await withAppDb(async (tx: AppTransaction) => {
      expect(await currentPrincipal()).toBeNull();

      const rows = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.externalId, "user_2itestauthmirrorghost001"));
      expect(rows).toEqual([]);
    });
  });

  it("falls back to the first email address when there is no primary", async () => {
    clerk.externalId = EXTERNAL_ID;
    clerk.user = clerkUser({
      primaryEmailAddress: null,
      emailAddresses: [{ emailAddress: "Fallback@Example.com" }],
    });

    await withAppDb(async (tx) => {
      const principal = await currentPrincipal();

      expect(principal?.email).toBe("fallback@example.com");
      const [row] = await tx
        .select({ email: users.email })
        .from(users)
        .where(
          and(eq(users.externalId, EXTERNAL_ID), eq(users.identityProvider, "clerk")),
        );
      expect(row?.email).toBe("fallback@example.com");
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
