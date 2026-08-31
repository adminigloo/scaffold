import { createErrorReporter, type ErrorReport } from "__SCOPE__/observability";
import { db } from "@/db";
import { log } from "./logger";

/**
 * The one way anything in this app records that something broke.
 *
 * Before this existed, nothing reported. An unhandled render error reached the
 * customer as "Application error: a client-side exception has occurred", a
 * failed webhook reached Stripe's retry queue, and neither reached a row anyone
 * could read — so the admin panel's Errors page was a table that never had
 * anything in it and the first anyone heard of a bug was a support ticket.
 *
 * ONE MODULE, because the reporter has to be constructed with the database
 * handle and every producer needs the identical one. Two reporters is two
 * fingerprint schemes waiting to disagree about whether a bug is the same bug.
 *
 * It NEVER THROWS — that is a promise `createErrorReporter` makes, and the
 * reason it can be called from a `catch` without a second `catch` around it. A
 * reporter that can take down the request it is reporting on is worse than no
 * reporter, and with no DATABASE_URL configured that is not hypothetical: the
 * write simply does not happen, and the request it was reporting on still
 * finishes.
 */
const reporter = createErrorReporter(db, {
  // Where the reporter complains when it CANNOT write. Defaults to
  // `console.error`, which on a serverless platform is a line with no service
  // name, no environment and no request id on it — so the one message telling
  // you the error log is broken is the one message you cannot find. Handing it
  // the app's logger puts it in the same stream, with the same base fields, as
  // everything else.
  logger: log,
});

/**
 * Wrapped rather than re-exported as `reporter.report`.
 *
 * A detached method loses its receiver, and whether that matters depends on
 * implementation details of a package this app only consumes. One line of
 * indirection makes the question not worth asking.
 */
export function reportError(input: ErrorReport): Promise<void> {
  return reporter.report(input);
}

export type { ErrorReport };
