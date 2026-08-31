import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { errorFingerprint, FINGERPRINT_LENGTH } from "./fingerprint.js";
import { consoleLogSink, redactValue, type LogSink } from "./logger.js";

/**
 * The thing that puts rows in `error_log`.
 *
 * Everything downstream of this file already existed and none of it ran: the
 * table, the fingerprinter, the `admin.recentErrors` procedure and the
 * `/admin/errors` page were all written, shipped and permanently empty,
 * because the only code that had ever inserted a row was the demo seed. A
 * viewer that is empty in every deployment is worse than no viewer — it is
 * read once, believed, and taken as evidence that nothing is going wrong.
 *
 * Two properties matter more than anything else here.
 *
 *   1. It deduplicates by fingerprint IN THE DATABASE, with
 *      `INSERT … ON CONFLICT … DO UPDATE`. The obvious alternative — select by
 *      fingerprint, then insert or update — loses rows under exactly the
 *      condition that produces errors worth recording: a bad deploy firing the
 *      same failure from twenty concurrent requests, each of which reads "no
 *      row", each of which then inserts. One request wins on the unique index
 *      and nineteen throw, from inside the error handler.
 *   2. It NEVER throws. A reporter that can take down the request it is
 *      reporting on converts a handled 500 into an unhandled one, and does it
 *      only when the database is already unhappy — which is when the log is
 *      the one thing you still need.
 */

/** What a call site knows about an error it just caught. */
export interface ErrorReport {
  readonly error: unknown;
  readonly source: "react" | "trpc" | "route" | "webhook";
  /** Next's error digest, when React gives us one. */
  readonly digest?: string | undefined;
  readonly url?: string | undefined;
  readonly userId?: string | null | undefined;
  readonly tenantId?: string | null | undefined;
  readonly requestId?: string | null | undefined;
  readonly context?: Record<string, unknown> | undefined;
}

/**
 * The narrowest shape of a Drizzle handle that can run the upsert.
 *
 * One method, and deliberately `execute` rather than the query builder. Using
 * `db.insert(errorLog)` would mean importing the table VALUE, which drags
 * `drizzle-orm/pg-core` into this package's barrel — the exact thing the
 * comment at the bottom of `index.ts` forbids, and for a good reason: tsup
 * does not code-split CJS, so a `require()` consumer would hold two distinct
 * objects for one physical table. Taking `execute` keeps the barrel free of
 * pg-core, admits every Drizzle driver (`neon-serverless`, `neon-http`,
 * `node-postgres`, a transaction handle) with no cast at the call site, and
 * lets a test satisfy it with an object literal.
 *
 * The app's own `db` type is never imported. A package that names
 * `NeonDatabase<typeof schema>` cannot be handed a transaction, a test double
 * or next year's driver.
 */
export interface ErrorReporterDb {
  execute(query: SQL): PromiseLike<unknown>;
}

export interface CreateErrorReporterOptions {
  /**
   * Where the reporter complains when it cannot write.
   *
   * A pino `Logger` satisfies this. Defaults to `console.error`, because the
   * one thing that must not happen is an error that fails to be recorded AND
   * fails to be mentioned.
   */
  readonly logger?: LogSink | undefined;
}

export interface ErrorReporter {
  report(input: ErrorReport): Promise<void>;
}

/**
 * Caps on the three unbounded strings.
 *
 * A `message` is whatever a library felt like throwing — an HTTP error from a
 * provider can carry an entire HTML page — and this row is UPDATED on every
 * subsequent occurrence, so an unbounded value is rewritten thousands of times
 * rather than stored once. The stack is allowed more room because the frames
 * below the first few are the ones that tell two similar failures apart.
 */
const MESSAGE_LIMIT = 2_000;
const STACK_LIMIT = 8_000;
const CONTEXT_LIMIT = 8_000;

/**
 * Record errors against `error_log`, deduplicated by fingerprint.
 *
 * `report` resolves whether or not the write succeeded, and never rejects.
 */
export function createErrorReporter(
  db: ErrorReporterDb,
  options: CreateErrorReporterOptions = {},
): ErrorReporter {
  const logger = options.logger ?? consoleLogSink;

  return {
    async report(input: ErrorReport): Promise<void> {
      try {
        await db.execute(errorLogUpsert(input));
      } catch (cause) {
        // Both errors, deliberately. Logging only the write failure loses the
        // error that was being reported — the reporter would then be a device
        // for turning application errors into database errors.
        safely(() => {
          logger.error(
            {
              err: describeForLog(cause),
              reported: describeForLog(input.error),
              source: input.source,
              requestId: input.requestId ?? null,
            },
            "error reporter could not write to error_log",
          );
        });
      }
    },
  };
}

/**
 * The statement, written out.
 *
 * This is the SQL quoted verbatim in the block comment above `errorLog` in
 * `schema.ts`; the drift test in `__tests__/reporter.test.ts` renders it
 * through Drizzle's own dialect and checks every column name against
 * `getTableColumns(errorLog)`, so a rename in the schema fails the build here
 * rather than at 3am in production.
 *
 * `ON CONFLICT ("fingerprint")` infers the unique index
 * `error_log_fingerprint_idx`, which `schema.ts` already declares. No
 * migration is needed and none is added: an `ON CONFLICT` naming a column with
 * no unique index behind it is not slow, it is rejected outright by Postgres,
 * so this either works everywhere or fails on the first write in development.
 *
 * WHAT THE UPDATE TOUCHES, and why:
 *
 *   occurrences   incremented in the database, never read-modify-written in
 *                 the application. Concurrent reporters would otherwise both
 *                 read 9 and both write 10.
 *   last_seen_at  `now()`, the database's clock rather than the instance's. A
 *                 fleet whose members disagree by a few seconds would
 *                 otherwise produce a `last_seen_at` that moves backwards.
 *   message,
 *   stack,
 *   source,
 *   tenant_id,
 *   user_id,
 *   context       refreshed from the newest occurrence. The row means "this
 *                 bug, N times, most recently like THIS" — a request id from
 *                 three weeks ago points at log lines that have long since
 *                 been rotated out, which defeats the entire point of carrying
 *                 one. The cost is that the tenant and user shown are the last
 *                 to hit it rather than the first; one row per bug cannot name
 *                 every tenant anyway, and the recent one is the one still
 *                 reproducible.
 *   resolved_at   CLEARED. A bug someone ticked off last month that has just
 *                 fired again is not resolved, and leaving the stamp in place
 *                 hides a regression behind the checkbox: the row sorts below
 *                 the unresolved ones on `/admin/errors` and nobody sees it
 *                 again. Re-opening is the loud option, and a re-opened row
 *                 keeps its cumulative count, so the history of the first
 *                 outbreak is still attached to the second.
 *
 * `id` and `first_seen_at` are the two columns the update deliberately does
 * NOT touch. `first_seen_at` is the only record of when the bug entered the
 * codebase and refreshing it would make every error look new.
 */
function errorLogUpsert(input: ErrorReport): SQL {
  const described = describeForLog(input.error);

  const fingerprint = reportFingerprint(input);
  const message = truncate(redactString(described.message), MESSAGE_LIMIT);
  const stack =
    described.stack === null
      ? null
      : truncate(redactString(described.stack), STACK_LIMIT);
  const context = serialiseContext(reportContext(input));

  return sql`
    insert into "error_log"
      ("fingerprint", "message", "stack", "source", "tenant_id", "user_id", "context")
    values (
      ${fingerprint},
      ${message},
      ${stack},
      ${input.source},
      ${input.tenantId ?? null},
      ${input.userId ?? null},
      ${context}::jsonb
    )
    on conflict ("fingerprint") do update set
      "occurrences"  = "error_log"."occurrences" + 1,
      "last_seen_at" = now(),
      "message"      = excluded."message",
      "stack"        = excluded."stack",
      "source"       = excluded."source",
      "tenant_id"    = excluded."tenant_id",
      "user_id"      = excluded."user_id",
      "context"      = excluded."context",
      "resolved_at"  = null
  `;
}

/**
 * The fingerprint for a report, with Next's digest folded in when there is one.
 *
 * This is not decoration. In a production Next build a client error boundary
 * receives an Error whose message is the fixed string "An error occurred in
 * the Server Components render. The specific message is omitted…" and whose
 * only distinguishing feature is `digest`. Fingerprinting that error alone
 * collapses EVERY server error in the application into a single row with an
 * enormous count and one useless message — the exact failure `fingerprint.ts`
 * warns about, where the table looks healthy and the bugs merged into it are
 * never seen again.
 *
 * Mixed in by hashing rather than by appending to the message, because the
 * message is normalised before hashing and a digest is a run of digits or hex:
 * `<n>` and `<hex>` are what would survive, which is to say nothing.
 */
function reportFingerprint(input: ErrorReport): string {
  const base = errorFingerprint(input.error);
  const digest = input.digest?.trim();
  if (digest === undefined || digest.length === 0) return base;
  return createHash("sha256")
    .update(`${base}\ndigest:${digest}`, "utf8")
    .digest("hex")
    .slice(0, FINGERPRINT_LENGTH);
}

/**
 * What lands in the `context` column.
 *
 * `requestId`, `url` and `digest` are lifted to top-level keys so the join
 * back to the logs is one expression — `context->>'requestId'` — rather than a
 * path nobody can remember. They are written AFTER the caller's own context,
 * so a caller who happens to use the same key cannot overwrite the one thing
 * this column exists to carry.
 */
function reportContext(input: ErrorReport): Record<string, unknown> | null {
  const out: Record<string, unknown> = { ...input.context };
  if (input.requestId !== null && input.requestId !== undefined) {
    out["requestId"] = input.requestId;
  }
  if (input.url !== undefined) out["url"] = input.url;
  if (input.digest !== undefined) out["digest"] = input.digest;
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * Serialise the context, redacted, and never fail.
 *
 * `redactValue` first, always. The context is caller-supplied, it lands in a
 * `jsonb` column that no reader redacts, and the row is kept until somebody
 * deletes it — a Stripe key echoed back inside a provider's error body would
 * otherwise sit in `error_log` forever.
 *
 * Oversized payloads are REPLACED rather than truncated: half a JSON document
 * is not JSON, and Postgres would reject the cast, losing the whole row over a
 * field somebody dumped a response body into.
 */
function serialiseContext(value: Record<string, unknown> | null): string | null {
  if (value === null) return null;
  try {
    const json = JSON.stringify(redactValue(value));
    // `undefined` comes back for a value JSON.stringify has nothing to say
    // about; treat it as no context rather than as the string "undefined".
    if (typeof json !== "string") return null;
    if (json.length <= CONTEXT_LIMIT) return json;
    return JSON.stringify({
      truncated: true,
      bytes: json.length,
      note: "context exceeded the reporter's size cap and was dropped",
    });
  } catch {
    // A BigInt or a toJSON that throws. The row is worth more than the context.
    return JSON.stringify({ unserialisable: true });
  }
}

interface DescribedError {
  readonly name: string;
  readonly message: string;
  readonly stack: string | null;
}

/**
 * Duck-typed for the same reason `fingerprint.ts` duck-types: `instanceof
 * Error` is false for an error that crossed a worker, a vm context or a
 * structured clone, and those are thrown by background jobs where this log is
 * the only record.
 */
function describeForLog(error: unknown): DescribedError {
  if (typeof error === "string") {
    return { name: "Error", message: error, stack: null };
  }
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    const e = error as { name?: unknown; message: string; stack?: unknown };
    return {
      name: typeof e.name === "string" && e.name.length > 0 ? e.name : "Error",
      message: e.message,
      stack: typeof e.stack === "string" ? e.stack : null,
    };
  }
  // `throw 42`, `throw null`, `throw { code: 500 }`. `Object.prototype
  // .toString` rather than `JSON.stringify`, so an arbitrary thrown object
  // cannot put whatever it was carrying into a column kept for a year.
  return {
    name: "NonError",
    message: Object.prototype.toString.call(error),
    stack: null,
  };
}

function redactString(value: string): string {
  const redacted = redactValue(value);
  return typeof redacted === "string" ? redacted : value;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}… [truncated]`;
}

/**
 * Run the failure log without letting it become the failure.
 *
 * The contract is that `report` never throws, and a caller-supplied logger is
 * caller-supplied code: a pino instance whose destination stream has closed
 * throws from `.error()`. Swallowing here is the one place in this package
 * where an empty catch is correct, because there is by definition nowhere left
 * to report to.
 */
function safely(write: () => void): void {
  try {
    write();
  } catch {
    /* nowhere left to write */
  }
}
