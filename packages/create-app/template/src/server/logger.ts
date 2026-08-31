import { createLogger } from "__SCOPE__/observability";
import { env } from "@/env";

/**
 * The one logger this application writes through.
 *
 * `createLogger` exists so that nobody constructs a bare `pino()`: the
 * redaction list has to be the DEFAULT state of the logger rather than a step
 * somebody remembers, because the lines that leak a credential are written in
 * error paths nobody reviewed. A second logger built anywhere else in this
 * project would be a second logger with no redaction on it.
 *
 * Constructed once, at module scope, so every line carries the same `base`
 * fields and an aggregator can group by them. Building one per request would
 * also rebuild the fast-redact matcher on every request, which is the
 * expensive part.
 *
 * WITH NOTHING CONFIGURED THIS STILL WRITES. Lines go to stdout, which is what
 * every platform this deploys to collects; `SENTRY_DSN` changes where errors
 * are additionally sent, not whether anything is recorded. There is no
 * "logging disabled" state to reason about.
 */
export const log = createLogger({
  level: env.LOG_LEVEL,
  // Replaces pino's default `{ pid, hostname }`, which is noise on a
  // serverless platform: pid is always 1 and hostname is a container id that
  // lives for one invocation. The two fields below are the ones you actually
  // filter on — which deployment, and which build of it.
  base: {
    service: "__PROJECT_NAME__",
    env: env.NODE_ENV,
  },
});

/**
 * The logger for ONE request, with its id already on every line.
 *
 * This is the join. `proxy.ts` stamps `x-request-id`, `createScaffoldContext`
 * reads it onto `ctx.requestId`, the same value is handed to `reportError`,
 * and a child logger built here puts it on each line in between. So a row on
 * `/admin/errors` is one search away from everything the request logged before
 * it failed — which is the entire reason the column exists.
 *
 * `log.child` rather than passing `{ requestId }` at each call site. A field
 * that has to be remembered is a field that is absent from the lines written
 * by the error paths nobody exercised, and a correlation key present on half
 * the lines correlates nothing.
 */
export function requestLog(requestId: string) {
  return log.child({ requestId });
}
