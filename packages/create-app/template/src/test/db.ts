import { describe, it } from "vitest";
import { withRollback as rollback } from "__SCOPE__/db";
import { db, type Db } from "@/db";

/**
 * The integration sandbox.
 *
 *   import { db, describeIntegration, withRollback } from "@/test/db";
 *
 *   describeIntegration("member invitations", () => {
 *     it("marks the invitation accepted", async () => {
 *       await withRollback(db, async (tx) => {
 *         await tx.insert(tenants).values(buildTenant());
 *         // ...assert here; the transaction is rolled back either way
 *       });
 *     });
 *   });
 */

/**
 * Re-exported, not reimplemented.
 *
 * `withRollback` escapes its transaction by throwing a sentinel that carries
 * the return value, and it checks that the driver really did roll back. A
 * local copy that dropped that check would commit test rows into a shared
 * database and nothing would say so.
 *
 * Because every write is rolled back, this sandbox does not need
 * `assertNotProduction`. A suite that TRUNCATEs instead of rolling back does —
 * import it from __SCOPE__/testing/db and call it before the first statement.
 *
 * A re-export STATEMENT, and it has to stay one — `export { rollback as
 * withRollback }` over the local import above does NOT work. Vite's SSR
 * transform, which is what Vitest runs test files through, rewrites an
 * imported binding into a property read on the source module's namespace
 * object, and re-exporting that local name emits a snapshot instead of a live
 * binding. The symptom is confusing enough to be worth naming: `withAppDb`
 * keeps working, because it calls the local name, while every importer of
 * "@/test/db" gets `undefined` and fails with "withRollback is not a function".
 */
export { withRollback } from "__SCOPE__/db";
export type { Transactable } from "__SCOPE__/db";

/**
 * The app's own handle, so an integration test exercises the same pool,
 * schema and Drizzle config the request path uses. A second handle built here
 * would let a test pass against a schema the app never loads.
 *
 * `export … from`, for the same reason as `withRollback` above: written as
 * `export { db }` over the local import, every consumer of "@/test/db" reads
 * `undefined` and fails with "Cannot read properties of undefined (reading
 * 'transaction')" from inside `withRollback` — pointing at the sandbox rather
 * than at the export that produced it.
 */
export { db } from "@/db";

/**
 * Read after src/test/setup.ts has run — setup files are evaluated before any
 * test module is imported, so .env.local has already been applied here.
 */
export const hasDatabase = Boolean(process.env.DATABASE_URL);

/**
 * Whether this run is one that is REQUIRED to have a database.
 *
 * Set `REQUIRE_DATABASE=1` in any pipeline whose job it is to exercise these
 * suites. It converts "no DATABASE_URL" from a silent skip into a failure, and
 * that conversion is the entire point of the variable: a pipeline that meant to
 * run the integration tests and did not must not be able to report success.
 */
const requireDatabase = process.env.REQUIRE_DATABASE === "1";

/** Thrown as a test failure when a run that demanded a database has none. */
export class IntegrationDatabaseMissingError extends Error {
  readonly name = "IntegrationDatabaseMissingError";
  constructor(suite: string) {
    super(
      `REQUIRE_DATABASE=1 is set and DATABASE_URL is not, so "${suite}" could ` +
        `not run. This run asked for the integration suites; skipping them ` +
        `quietly would report a pass for tests that never executed. Either ` +
        `give the run a database — DATABASE_URL, or DATABASE_WS_PROXY in front ` +
        `of a local Postgres, see src/db/index.ts — or stop setting ` +
        `REQUIRE_DATABASE.`,
    );
  }
}

type IntegrationDescribe = (name: string, suite: () => void) => void;

/**
 * `describe` when a database is configured, and something LOUD when it is not.
 *
 * WRAP EVERY DATABASE TEST IN THIS. vitest.config.ts separates the integration
 * project from the unit one, but it does not decide whether the tests run —
 * this does, per suite, so a file still typechecks, still appears in the
 * output, and reports as SKIPPED rather than erroring on a connection nobody
 * asked it to make.
 *
 * A red suite that a developer cannot turn green without credentials is one
 * they stop reading, and then the unit failure two lines below it goes unread
 * as well. That reasoning is still right and it is also how two tests in this
 * project contradicted the code they tested from the day they were committed:
 * nothing set DATABASE_URL, every run printed a tidy green "skipped", and a
 * skip that costs nothing to ignore is ignored.
 *
 * So the skip is no longer free. It names itself on the way past, and under
 * `REQUIRE_DATABASE=1` it is not a skip at all — the suite is replaced by a
 * single failing test that says which suite did not run and why. A pipeline
 * that intends to cover these can no longer pass by not covering them.
 */
export const describeIntegration: IntegrationDescribe = hasDatabase
  ? describe
  : requireDatabase
    ? (name) => {
        describe(name, () => {
          it("has the database this suite exists to talk to", () => {
            throw new IntegrationDatabaseMissingError(name);
          });
        });
      }
    : (name, suite) => {
        // THE REASON GOES IN THE TITLE, not into a console line beside it.
        // Vitest buffers console output written during collection and its
        // default reporter never prints it, so a warning here would be as
        // silent as the skip it was warning about. A title is carried by every
        // reporter, every editor gutter and every CI annotation — and
        // "54 skipped" with no explanation anywhere is exactly how two of
        // these tests contradicted the shipped code for a release.
        describe.skip(`${name} — SKIPPED, no DATABASE_URL`, suite);
        announceOnce();
      };

/**
 * One line for the whole run, written straight to stderr.
 *
 * `console.warn` does not survive collection — Vitest captures it per task and
 * there is no task yet — so this goes to the descriptor the runner inherits.
 * Belt and braces beside the titles above: whichever of the two a given
 * reporter shows, the run says out loud that the database suites did not run.
 */
let announced = false;
function announceOnce(): void {
  if (announced) return;
  announced = true;
  process.stderr.write(
    "[integration] DATABASE_URL is not set — every suite in this project is " +
      "SKIPPED, not passing. src/db/index.ts says how to point it at a local " +
      "Postgres; REQUIRE_DATABASE=1 turns this into a failure.\n",
  );
}

// ---------------------------------------------------------------------------
// Running the APP's code inside the sandbox
// ---------------------------------------------------------------------------

/**
 * The name of the `globalThis` slot that carries the currently open test
 * transaction.
 *
 * WHY THIS EXISTS AT ALL. Every server module — `src/server/permissions.ts`,
 * `src/server/auth.ts`, `src/server/bootstrap.ts` — closes over `db` from
 * "@/db" at module scope. It is not injectable, and that is a deliberate
 * design choice everywhere except in a test: `withRollback` runs on ONE pooled
 * connection, `db` hands out a DIFFERENT one, and READ COMMITTED means rows
 * written by the test transaction are invisible to `db` until commit — which
 * never happens here. Without a redirect, `loadTenantPermissions` called from
 * an integration test reads the committed database and silently ignores every
 * fixture the test just wrote.
 *
 * WHY A GLOBAL AND NOT AN IMPORT. The redirect is installed per file with
 * `vi.mock("@/db", …)`, and a mock factory CANNOT import this module: "@/test/db"
 * imports "@/db", so the factory would await a module that is itself waiting
 * on the factory, and the run hangs with no output. `globalThis` is the one
 * channel between the two with no import edge — which is why each integration
 * file repeats the key as a string literal instead of importing this constant.
 * Keep them spelled the same.
 */
export const APP_DB_TX_KEY = "__appDbIntegrationTx";

declare global {
  // eslint-disable-next-line no-var
  var __appDbIntegrationTx: object | undefined;
}

type TransactionCallback = Parameters<Db["transaction"]>[0];

/** The handle `withAppDb` hands out: a Drizzle transaction on the app schema. */
export type AppTransaction = Parameters<TransactionCallback>[0];

/**
 * Open a rolled-back transaction AND point the app's `db` at it.
 *
 * Use this whenever the assertion runs the app's own code —
 * `loadTenantPermissions`, `currentPrincipal`, `grantBootstrapAdminIfFirst`.
 * Use plain `withRollback` when the test issues its own SQL and nothing under
 * test reads "@/db".
 *
 * Only works in a file that installed the mock:
 *
 *   vi.mock("@/db", async (importOriginal) => {
 *     const actual = await importOriginal<typeof import("@/db")>();
 *     return {
 *       ...actual,
 *       db: new Proxy(actual.db as object, {
 *         get(target, prop) {
 *           const tx = (globalThis as { __appDbIntegrationTx?: object })
 *             .__appDbIntegrationTx;
 *           const source: object = tx ?? target;
 *           const value: unknown = Reflect.get(source, prop);
 *           return typeof value === "function"
 *             ? (value as (...args: never[]) => unknown).bind(source)
 *             : value;
 *         },
 *       }),
 *     };
 *   });
 *
 * A Proxy over every property rather than a patch of the four methods the code
 * happens to call today: `db.$count` or a `db.with(...)` added next month would
 * slip past an allowlist and read the committed database, and the test would go
 * green against rows the fixture never wrote.
 */
export async function withAppDb<T>(
  fn: (tx: AppTransaction) => Promise<T>,
): Promise<T> {
  return rollback(db, async (tx) => {
    globalThis.__appDbIntegrationTx = tx as object;
    try {
      return await fn(tx);
    } finally {
      // `finally`, not "after fn": a failed assertion throws, and a transaction
      // left installed here would be reused by the NEXT test on a connection
      // that has already rolled back and gone back to the pool.
      globalThis.__appDbIntegrationTx = undefined;
    }
  });
}

/**
 * The five-character SQLSTATE of a driver error, or undefined if it is not one.
 *
 * Lives here because three suites need it and each hand-rolled copy would get
 * the unwrapping wrong in the same way. Drizzle wraps every failure in a
 * `DrizzleQueryError` whose message is the query text, so `err.code` on the
 * thrown object is `undefined` and the real `23505` is one or more `cause`
 * links down. A test that matched on the message instead would pass for a
 * syntax error in the fixture just as happily as for the constraint violation
 * it meant to prove.
 */
export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  // Bounded: `cause` chains can be cyclic, and an unbounded walk turns a bad
  // error object into a hung test rather than a failed one.
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
    const code: unknown = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
