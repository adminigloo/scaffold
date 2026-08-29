import { createHash } from "node:crypto";
import { isPostgresUrl, pointsAtLocalhost, type AppEnv } from "@adminigloo/env";
import { slugify } from "./deterministic.js";

/**
 * The integration sandbox, re-exported unchanged.
 *
 * NOT reimplemented here. `withRollback` escapes its transaction by throwing a
 * sentinel that carries the return value — the only way to make Drizzle roll
 * back and still hand a result out — and a second copy of that trick living in
 * a testing package would be a second thing to keep correct. The copy that
 * forgot its "did the driver actually roll back?" check would commit test data
 * and nothing would say so.
 */
export { withRollback } from "@adminigloo/db";
export type { Transactable } from "@adminigloo/db";

export interface EphemeralBranchSeed {
  /** The commit under test. `GITHUB_SHA` in a GitHub Actions workflow. */
  readonly sha: string;
  /** `GITHUB_RUN_ATTEMPT`. Defaults to the first attempt. */
  readonly attempt?: number | string;
  /** Defaults to `ci`. Slugified, so a project can namespace by workflow. */
  readonly prefix?: string;
}

/** Neon rejects branch names longer than this. */
const MAX_BRANCH_NAME_LENGTH = 63;

/**
 * The name of the throwaway Neon branch a CI run gets its database from.
 *
 * Pure and deterministic, which is the entire requirement: the job that creates
 * the branch and the cleanup step that deletes it run in different processes,
 * often in different jobs, so the name cannot be handed between them without an
 * artifact. Both compute it from `GITHUB_SHA` and `GITHUB_RUN_ATTEMPT` and get
 * the same string. A random suffix means every failed run leaks a branch, and
 * Neon bills for the ones nobody deleted.
 *
 * `attempt` is in the name on purpose. Re-running a failed job runs against the
 * same commit, and reusing that run's branch would inherit whatever half-
 * truncated tables the failure left behind — the re-run then fails for a reason
 * unrelated to the code, which is the most expensive kind of flake to chase.
 *
 * A `sha` that is not hex gets hashed rather than truncated. Workflows pass
 * `GITHUB_HEAD_REF` here by mistake, and truncating branch names gives
 * `refactor-a` and `refactor-b` the same seven characters — one run then drops
 * the other run's database mid-suite.
 */
export function ephemeralBranchName(seed: EphemeralBranchSeed): string {
  const prefix = slugify(seed.prefix ?? "ci") || "ci";
  const sha = seed.sha.trim().toLowerCase();
  const sha7 = /^[0-9a-f]{7,}$/.test(sha)
    ? sha.slice(0, 7)
    : createHash("sha256").update(sha, "utf8").digest("hex").slice(0, 7);

  // `Number.parseInt`, not `Number(...)`: GitHub hands the attempt over as a
  // string and an unset variable arrives as "", which `Number("")` turns into
  // 0 — naming every first attempt `…-0` and quietly disagreeing with the
  // cleanup step that used the default.
  const parsed = Number.parseInt(String(seed.attempt ?? 1), 10);
  const attempt = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;

  // Truncate the PREFIX, never the composed name. `${…}`.slice(0, 63) throws
  // away the tail, which is where the sha and the attempt live — so a workflow
  // whose prefix is longer than the limit gives every commit and every re-run
  // the SAME branch name, reintroducing exactly the collision this function
  // exists to prevent. The discriminating suffix always survives; the
  // human-readable namespace is the part that can afford to be cut.
  const suffix = `-${sha7}-${attempt}`;
  const room = MAX_BRANCH_NAME_LENGTH - suffix.length;
  // Trailing separators are trimmed because slicing lands mid-word: `e2e-` +
  // `-4f9c1b2-1` would emit a doubled dash, which some Neon tooling rejects.
  const head = room > 0 ? prefix.slice(0, room).replace(/-+$/, "") : "";

  return head === "" ? suffix.slice(1) : `${head}${suffix}`;
}

export class ProductionTargetBlockedError extends Error {
  readonly name = "ProductionTargetBlockedError";
  constructor(reason: string) {
    super(
      `Refusing to point a destructive test suite at this database: ${reason}. ` +
        `A suite that truncates tables has no undo, so this check fails closed — ` +
        `it wants positive evidence that the target is disposable, and "not ` +
        `obviously production" is not evidence.`,
    );
  }
}

export interface DisposableTargetOptions {
  /**
   * Substrings that mark a HOST as disposable — in practice the endpoint id of
   * the branch this run created, e.g. `ep-late-frost-12345678`.
   *
   * The caller has to supply it because a Neon branch endpoint carries no
   * branch identity in its hostname: the `ci-abc1234-1` branch and the
   * production branch both resolve to
   * `ep-<two-words>-<digits>.<region>.aws.neon.tech`, and no pattern can tell
   * them apart from the URL alone. The job that created the branch is the only
   * thing that knows which endpoint is the throwaway.
   */
  readonly disposableHosts?: readonly string[];
  /**
   * Markers that mark a DATABASE NAME as disposable, matched on token
   * boundaries — the name is split on non-alphanumerics and the marker's own
   * tokens must appear as a run of them. A substring match would accept
   * `invoicing` on the "ci" buried inside it.
   */
  readonly disposableDatabases?: readonly string[];
}

/**
 * `neondb` is deliberately absent: it is the default database name on every
 * Neon branch, production included, so accepting it would make this check pass
 * for essentially every Neon project.
 */
const DEFAULT_DISPOSABLE_DATABASES = [
  "test",
  "ci",
  "shadow",
  "scratch",
  "tmp",
] as const;

/** Any of these anywhere in host or database vetoes, whatever else matched. */
const PRODUCTION_MARKERS = ["prod", "live"] as const;

/**
 * Refuse anything that is not clearly disposable.
 *
 * AN INTEGRATION SUITE THAT TRUNCATES TABLES MUST NEVER BE ONE MISTYPED ENV VAR
 * AWAY FROM PROD. `DATABASE_URL` and `DATABASE_URL_TEST` differ by five
 * characters in a workflow file, the wrong one is a green diff in review, and
 * the first `TRUNCATE … CASCADE` looks exactly like a normal passing run right
 * up until support calls.
 *
 * Distinct from `assertMigrationAllowed`, which asks "may I migrate this?" and
 * can legitimately be answered yes for production by the deploy workflow. There
 * is no corresponding yes here, so this takes no `allowProduction` escape
 * hatch: migrating production is sometimes correct, wiping it never is.
 *
 * Evidence accepted, in descending order of how much it proves:
 *   1. the URL points at localhost;
 *   2. the host contains a caller-declared disposable marker;
 *   3. the database name carries a disposable marker as a WHOLE TOKEN.
 */
export function assertNotProduction(
  connectionString: string,
  appEnv: AppEnv,
  options: DisposableTargetOptions = {},
): void {
  if (appEnv === "production") {
    throw new ProductionTargetBlockedError(
      `the app environment is "production". VERCEL_ENV is set by the platform ` +
        `and cannot be forged from the dashboard, so this is a real production ` +
        `process whatever the connection string points at`,
    );
  }

  if (!isPostgresUrl(connectionString)) {
    // An unset variable arrives here as "" or the string "undefined". Reading
    // an unparseable value as "not production, therefore fine" would let the
    // suite run against whatever the driver falls back to — on a developer
    // machine that is usually a database with real data in it.
    throw new ProductionTargetBlockedError(
      `"${redact(connectionString)}" is not a postgres:// URL — the variable is ` +
        `unset, misspelled, or holds a dashboard link rather than a connection ` +
        `string`,
    );
  }

  const url = new URL(connectionString);
  const database = url.pathname.replace(/^\//, "").toLowerCase();
  const host = url.hostname.toLowerCase();

  // `postgres:/user:pw@host/db` — one slash short — parses happily, with the
  // whole thing landing in the path and no host at all. Rejecting it here keeps
  // a mistyped string from being judged on a "database name" that is really the
  // credentials, and keeps those credentials out of the message below.
  if (host === "") {
    throw new ProductionTargetBlockedError(
      `"${redact(connectionString)}" has a postgres: scheme but no host — it is ` +
        `missing a slash, or it is not a connection string at all`,
    );
  }

  // The veto runs BEFORE the evidence, not after. The markers below are OR'd,
  // so without this a host named `prod-ci-1` sails through on the "ci" it
  // happens to contain.
  const veto = PRODUCTION_MARKERS.find(
    (marker) => host.includes(marker) || database.includes(marker),
  );
  if (veto !== undefined) {
    throw new ProductionTargetBlockedError(
      `the target carries "${veto}" (host "${host}", database "${database}")`,
    );
  }

  if (pointsAtLocalhost(connectionString)) return;

  const hostMarkers = options.disposableHosts ?? [];
  if (hostMarkers.some((marker) => marker.length > 0 && host.includes(marker))) return;

  // TOKENS, NOT SUBSTRINGS. "ci" is two characters and lives inside ordinary
  // production database names — `invoicing`, `pricing`, `precision`,
  // `specifics` — so a substring match hands a truncating suite positive
  // evidence that a real production database is disposable. Splitting on
  // non-alphanumerics keeps `acme_test` and `ci-run-42` accepted, which is the
  // shape every disposable name actually has.
  const databaseTokens = tokenize(database);
  const databaseMarkers = options.disposableDatabases ?? DEFAULT_DISPOSABLE_DATABASES;
  if (databaseMarkers.some((marker) => containsTokenRun(databaseTokens, tokenize(marker)))) {
    return;
  }

  throw new ProductionTargetBlockedError(
    `nothing about host "${host}" or database "${database}" says it is ` +
      `disposable. Pass the endpoint id of the branch this run created as ` +
      `{ disposableHosts: ["ep-…"] }, or point the suite at localhost`,
  );
}

/** Whole words of a database name: `ci-run-42` → ["ci", "run", "42"]. */
function tokenize(value: string): readonly string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 0);
}

/**
 * Does `needle` appear in `haystack` as a contiguous run of whole tokens?
 *
 * A run rather than a single token because a caller-supplied marker is often
 * multi-word — `{ disposableDatabases: ["pr-1234"] }` for a per-PR database.
 * Comparing it as one opaque token would silently never match, and the suite
 * would be refused for a target that really is disposable.
 */
function containsTokenRun(
  haystack: readonly string[],
  needle: readonly string[],
): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  return haystack.some((_, start) =>
    needle.every((token, offset) => haystack[start + offset] === token),
  );
}

/**
 * Connection strings carry a password, and this message lands in a CI log.
 *
 * Masks everything before an `@` rather than matching `://…@`, because the
 * value that reaches this branch is by definition the one that failed to parse
 * — `postgres:/u:hunter2@host` has credentials and no `://` for a tidier
 * pattern to anchor on.
 */
function redact(connectionString: string): string {
  return connectionString.replace(/[^\s/@]*@/g, "***@").slice(0, 80);
}
