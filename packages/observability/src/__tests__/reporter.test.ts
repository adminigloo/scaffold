import { describe, expect, it, vi } from "vitest";
import { getTableColumns, getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { createErrorReporter, type ErrorReport, type ErrorReporterDb } from "../reporter.js";
import { errorFingerprint } from "../fingerprint.js";
import { REDACTED } from "../logger.js";
import { errorLog } from "../schema.js";

const dialect = new PgDialect();

interface Captured {
  readonly text: string;
  readonly params: readonly unknown[];
}

/**
 * A database that records the statement instead of running it.
 *
 * The reporter's whole job is one statement, so the statement is what gets
 * asserted. Rendered through Drizzle's own dialect rather than by inspecting
 * the template chunks, because the dialect is what the driver would use and a
 * hand-rolled renderer would be asserting against a second implementation.
 */
function recordingDb(): { db: ErrorReporterDb; calls: Captured[] } {
  const calls: Captured[] = [];
  return {
    calls,
    db: {
      execute(query: SQL) {
        const { sql, params } = dialect.sqlToQuery(query);
        calls.push({ text: sql, params });
        return Promise.resolve(undefined);
      },
    },
  };
}

function only(calls: Captured[]): Captured {
  expect(calls).toHaveLength(1);
  const first = calls[0];
  if (first === undefined) throw new Error("no statement was executed");
  return first;
}

const baseReport: ErrorReport = { error: new Error("boom"), source: "trpc" };

describe("the statement matches the schema", () => {
  // The reporter writes column names as literal SQL rather than going through
  // the query builder, which buys a barrel with no `drizzle-orm/pg-core` in it
  // and costs the compiler's rename check. This test is the replacement: it
  // reads the real table and fails if the two drift.
  it("names the real table", async () => {
    const { db, calls } = recordingDb();
    await createErrorReporter(db).report(baseReport);
    expect(only(calls).text).toContain(`"${getTableName(errorLog)}"`);
  });

  it("mentions every column of error_log except the two it must not touch", async () => {
    const { db, calls } = recordingDb();
    await createErrorReporter(db).report(baseReport);
    const { text } = only(calls);

    // `id` is generated. `first_seen_at` is the only record of when the bug
    // entered the codebase — refreshing it would make every error look new.
    const untouched = new Set(["id", "first_seen_at"]);

    for (const column of Object.values(getTableColumns(errorLog))) {
      const name = column.name;
      if (untouched.has(name)) {
        expect(text, `${name} must not appear in the upsert`).not.toContain(`"${name}"`);
        continue;
      }
      expect(text, `${name} is missing from the upsert`).toContain(`"${name}"`);
    }
  });

  it("conflicts on fingerprint, which is the column the unique index covers", async () => {
    const { db, calls } = recordingDb();
    await createErrorReporter(db).report(baseReport);
    // `ON CONFLICT` with no unique index behind it is rejected by Postgres
    // outright, so the target and the index in schema.ts have to agree.
    expect(only(calls).text.toLowerCase()).toContain('on conflict ("fingerprint")');
  });
});

describe("deduplication", () => {
  it("bumps the count in the database rather than reading it first", async () => {
    const { db, calls } = recordingDb();
    await createErrorReporter(db).report(baseReport);
    // Read-modify-write is the version that loses rows: twenty concurrent
    // reporters all read 9 and all write 10.
    expect(only(calls).text).toContain(`"occurrences"  = "error_log"."occurrences" + 1`);
  });

  it("re-opens a resolved error", async () => {
    const { db, calls } = recordingDb();
    await createErrorReporter(db).report(baseReport);
    // A bug ticked off last month that has fired again is not resolved, and a
    // stale stamp sorts the row below the unresolved ones where nobody sees it.
    expect(only(calls).text).toContain(`"resolved_at"  = null`);
  });

  it("gives two occurrences of one bug the same fingerprint", async () => {
    const { db, calls } = recordingDb();
    const reporter = createErrorReporter(db);
    // Both raised before either is reported: an `await` between them would
    // change the synchronous stack, which is a property of this test harness
    // rather than of the fingerprinter.
    const [first, second] = [failIn("alpha"), failIn("alpha")];
    await reporter.report({ error: first, source: "route" });
    await reporter.report({ error: second, source: "route" });
    expect(calls[0]?.params[0]).toBe(calls[1]?.params[0]);
  });

  it("gives two different bugs different fingerprints", async () => {
    const { db, calls } = recordingDb();
    const reporter = createErrorReporter(db);
    const [first, second] = [failIn("alpha"), new RangeError("something else")];
    await reporter.report({ error: first, source: "route" });
    await reporter.report({ error: second, source: "route" });
    expect(calls[0]?.params[0]).not.toBe(calls[1]?.params[0]);
  });
});

describe("Next's digest", () => {
  // In a production build a client error boundary sees one fixed message for
  // every server error in the application; the digest is the only thing that
  // tells them apart. Fingerprinting the error alone collapses the lot into a
  // single row with a huge count and one useless message.
  const opaque = new Error(
    "An error occurred in the Server Components render. The specific message is " +
      "omitted in production builds to avoid leaking sensitive details.",
  );

  it("keeps two digests apart", async () => {
    const { db, calls } = recordingDb();
    const reporter = createErrorReporter(db);
    await reporter.report({ error: opaque, source: "react", digest: "1234567890" });
    await reporter.report({ error: opaque, source: "react", digest: "9876543210" });
    expect(calls[0]?.params[0]).not.toBe(calls[1]?.params[0]);
  });

  it("keeps one digest together", async () => {
    const { db, calls } = recordingDb();
    const reporter = createErrorReporter(db);
    await reporter.report({ error: opaque, source: "react", digest: "1234567890" });
    await reporter.report({ error: opaque, source: "react", digest: "1234567890" });
    expect(calls[0]?.params[0]).toBe(calls[1]?.params[0]);
  });

  it("leaves the fingerprint alone when there is no digest", async () => {
    const { db, calls } = recordingDb();
    await createErrorReporter(db).report({ error: opaque, source: "react" });
    expect(only(calls).params[0]).toBe(errorFingerprint(opaque));
  });
});

describe("the context column", () => {
  function context(captured: Captured): Record<string, unknown> {
    const raw = captured.params[6];
    if (typeof raw !== "string") throw new Error("context was not serialised");
    return JSON.parse(raw) as Record<string, unknown>;
  }

  it("lifts the request id to a top-level key", async () => {
    const { db, calls } = recordingDb();
    await createErrorReporter(db).report({
      ...baseReport,
      requestId: "req_abc",
      url: "https://example.test/checkout",
    });
    // `context->>'requestId'` is what joins this row to the log lines around it.
    expect(context(only(calls))).toMatchObject({
      requestId: "req_abc",
      url: "https://example.test/checkout",
    });
  });

  it("cannot be overwritten by a caller using the same key", async () => {
    const { db, calls } = recordingDb();
    await createErrorReporter(db).report({
      ...baseReport,
      requestId: "req_real",
      context: { requestId: "req_spoofed" },
    });
    expect(context(only(calls))["requestId"]).toBe("req_real");
  });

  it("redacts credentials the caller passed in", async () => {
    const { db, calls } = recordingDb();
    await createErrorReporter(db).report({
      ...baseReport,
      context: { note: "retried with sk_live_abcdefgh12345678 and it still failed" },
    });
    // The row is kept until somebody deletes it and nothing redacts on read.
    const note = context(only(calls))["note"];
    expect(note).toContain(REDACTED);
    expect(note).not.toContain("sk_live_abcdefgh12345678");
  });

  it("survives a value JSON cannot serialise", async () => {
    const { db, calls } = recordingDb();
    await createErrorReporter(db).report({
      ...baseReport,
      context: { size: BigInt(9) },
    });
    // The row is worth more than the context.
    expect(context(only(calls))).toEqual({ unserialisable: true });
  });

  it("drops an oversized context rather than truncating it into invalid JSON", async () => {
    const { db, calls } = recordingDb();
    await createErrorReporter(db).report({
      ...baseReport,
      context: { body: "x".repeat(20_000) },
    });
    const parsed = context(only(calls));
    expect(parsed["truncated"]).toBe(true);
    expect(parsed["body"]).toBeUndefined();
  });

  it("is null when there is nothing to record", async () => {
    const { db, calls } = recordingDb();
    await createErrorReporter(db).report(baseReport);
    expect(only(calls).params[6]).toBeNull();
  });
});

describe("the message and the stack", () => {
  it("redacts a connection string interpolated into the message", async () => {
    const { db, calls } = recordingDb();
    await createErrorReporter(db).report({
      error: new Error(
        "connect ECONNREFUSED postgresql://neondb_owner:npg_secret@ep-x.neon.tech/neondb",
      ),
      source: "route",
    });
    const message = only(calls).params[1];
    expect(message).not.toContain("npg_secret");
    // The host survives: "which database refused us" is the question being asked.
    expect(message).toContain("ep-x.neon.tech");
  });

  it("caps a message that carries an entire error page", async () => {
    const { db, calls } = recordingDb();
    await createErrorReporter(db).report({
      error: new Error("y".repeat(50_000)),
      source: "webhook",
    });
    const message = only(calls).params[1];
    // The row is UPDATED on every subsequent occurrence, so an unbounded value
    // is rewritten thousands of times rather than stored once.
    expect(typeof message === "string" && message.length).toBeLessThan(2_100);
  });
});

describe("it never throws", () => {
  // A reporter that can take down the request it is reporting on converts a
  // handled 500 into an unhandled one, and does it only when the database is
  // already unhappy.
  const logger = () => ({ warn: vi.fn(), error: vi.fn() });

  it("swallows a rejected write and logs both errors", async () => {
    const log = logger();
    const db: ErrorReporterDb = {
      execute: () => Promise.reject(new Error("connection terminated")),
    };
    await expect(
      createErrorReporter(db, { logger: log }).report({
        error: new Error("the original problem"),
        source: "trpc",
        requestId: "req_1",
      }),
    ).resolves.toBeUndefined();

    expect(log.error).toHaveBeenCalledTimes(1);
    const [details] = log.error.mock.calls[0] as [Record<string, unknown>, string];
    // Logging only the write failure would lose the error being reported, which
    // would make the reporter a device for turning application errors into
    // database errors.
    expect(details["err"]).toMatchObject({ message: "connection terminated" });
    expect(details["reported"]).toMatchObject({ message: "the original problem" });
    expect(details["requestId"]).toBe("req_1");
  });

  it("swallows a handle that throws synchronously", async () => {
    // What `createUnconfiguredDb` does: the proxy throws on apply, before any
    // promise exists. An app with no DATABASE_URL still boots and still runs.
    const db: ErrorReporterDb = {
      execute: () => {
        throw new Error("DatabaseNotConfiguredError");
      },
    };
    const log = logger();
    await expect(
      createErrorReporter(db, { logger: log }).report(baseReport),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it("swallows a logger that itself throws", async () => {
    const db: ErrorReporterDb = { execute: () => Promise.reject(new Error("down")) };
    const broken = {
      warn: () => undefined,
      error: () => {
        throw new Error("destination stream closed");
      },
    };
    await expect(
      createErrorReporter(db, { logger: broken }).report(baseReport),
    ).resolves.toBeUndefined();
  });

  it("records a thrown non-Error without putting its payload in the message", async () => {
    const { db, calls } = recordingDb();
    await createErrorReporter(db).report({
      error: { code: 500, apiKey: "sk_live_abcdefgh12345678" },
      source: "webhook",
    });
    const message = only(calls).params[1];
    expect(message).toBe("[object Object]");
  });
});

/** A stack from a named frame, so two calls produce identical frames. */
function failIn(label: string): Error {
  return new Error(`failed while handling ${label}`);
}
