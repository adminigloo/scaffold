/**
 * Apply committed migrations to one database. This is the deploy-time runner.
 *
 *   pnpm db:migrate         drizzle-kit, reads .env.local, for your laptop
 *   pnpm db:migrate:deploy  THIS file, for CI — the target is stated, not guessed
 *
 * Two things it does that `drizzle-kit migrate` does not:
 *
 *   1. It names the database out loud before it touches it. A migration that
 *      ran against the wrong branch is otherwise only discoverable afterwards,
 *      from the damage; printing the host first means the log line exists
 *      either way.
 *   2. It refuses a production run nobody explicitly authorised, and refuses
 *      ANY run through a pooled connection string. Both refusals live in
 *      `assertMigrationAllowed`, so they are unit-tested without a database and
 *      cannot drift between this script and anything else that migrates.
 *
 * DEPLOYMENT.md has the branch model, and what to do when a migration fails
 * part-way through a release.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { migrate } from "drizzle-orm/neon-serverless/migrator";
// The barrel import also installs the Neon driver's WebSocket constructor as a
// side effect. `ws` is a dependency of __SCOPE__/db and not of this app, so a
// deep import of just the guard would resolve and then fail to open a socket.
import { assertMigrationAllowed } from "__SCOPE__/db";
import { isDeployed, resolveAppEnv, type AppEnv } from "__SCOPE__/env";

/**
 * The one file besides `src/env.ts` that reads `process.env` directly.
 *
 * `src/env.ts` validates the whole application contract — Clerk keys, Stripe
 * keys, the app URL. A migration job holds none of those and must not be made
 * to invent them: importing that module here would mean putting every
 * production credential into the migration job's environment, which is the
 * opposite of what the job needs to hold.
 */
function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
}

/**
 * The same load `drizzle.config.ts` does. tsx does not read `.env.local`, and
 * `--env-file=.env.local` cannot go in the package script because the file does
 * not exist in CI and Node treats a missing `--env-file` as fatal.
 */
try {
  process.loadEnvFile(".env.local");
} catch {
  // No .env.local. In CI that is the normal case, and the checks below still
  // name whatever ends up missing.
}

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

const TARGETS: readonly AppEnv[] = ["local", "staging", "production"];

function fail(message: string): never {
  console.error("");
  console.error("MIGRATION FAILED");
  console.error(message);
  console.error("");
  process.exit(1);
}

/**
 * Which database this run is for.
 *
 * Stated rather than derived, because the derived answer is wrong here.
 * `resolveAppEnv()` reads `VERCEL_ENV`, which GitHub Actions does not set — so
 * every CI run would resolve to "local" and the production guard would never
 * fire once. The deploy workflow states the target; a laptop states nothing and
 * gets "local".
 */
function readTarget(): AppEnv {
  const raw = readEnv("MIGRATION_TARGET");
  if (raw === undefined) return resolveAppEnv();
  const target = TARGETS.find((candidate) => candidate === raw);
  if (target === undefined) {
    fail(`MIGRATION_TARGET is "${raw}". Expected one of: ${TARGETS.join(", ")}.`);
  }
  return target;
}

interface JournalEntry {
  readonly tag: string;
}

function isJournalEntry(value: unknown): value is JournalEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "tag" in value &&
    typeof (value as { tag: unknown }).tag === "string"
  );
}

/**
 * The migrations on disk, oldest first.
 *
 * Printed rather than counted silently: "3 migrations" is the sentence that
 * catches a release built from a branch whose migration file was never
 * committed, at the point where the fix is a `git push` rather than a restore.
 *
 * These are ALL of them, not the pending ones. Drizzle skips the applied ones
 * itself, and asking the database which are pending would mean connecting to it
 * before the guard has decided whether connecting is allowed.
 */
function readMigrationTags(): readonly string[] {
  const journalPath = join(MIGRATIONS_FOLDER, "meta", "_journal.json");
  let raw: string;
  try {
    raw = readFileSync(journalPath, "utf8");
  } catch {
    fail(
      `No migration journal at ${journalPath}.\n` +
        `Nothing has been generated yet. Run \`pnpm db:generate\` and commit the ` +
        `drizzle/ directory — a release with no migrations creates no tables, and ` +
        `that failure surfaces as the first query a customer makes, not here.`,
    );
  }
  const parsed: unknown = JSON.parse(raw);
  const entries =
    typeof parsed === "object" && parsed !== null && "entries" in parsed
      ? (parsed as { entries: unknown }).entries
      : undefined;
  if (!Array.isArray(entries)) return [];
  return entries.filter(isJournalEntry).map((entry) => entry.tag);
}

/** Host and database only — the connection string carries a password. */
function describeDatabase(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `${url.host}${url.pathname}`;
  } catch {
    fail(
      `DATABASE_URL_UNPOOLED is not a URL. Copy the direct connection string ` +
        `from the Neon dashboard — the one WITHOUT "-pooler" in the host.`,
    );
  }
}

async function main(): Promise<void> {
  /**
   * Never from inside a Vercel build.
   *
   * A Vercel build re-runs on every redeploy, promote and rollback. A migration
   * in the build step therefore rolls the schema FORWARD at the exact moment
   * someone is rolling the code back — the one moment the two are already
   * disagreeing. Migrations belong to the release, not to the build.
   */
  if (isDeployed()) {
    fail(
      `VERCEL_ENV is set, so this is running inside a Vercel build. Migrations ` +
        `run from .github/workflows/deploy.yml, before the deploy is created.`,
    );
  }

  const target = readTarget();
  const connectionString = readEnv("DATABASE_URL_UNPOOLED");
  if (connectionString === undefined) {
    fail(
      `DATABASE_URL_UNPOOLED is not set. Migrations need the DIRECT connection ` +
        `string, never the pooled one. Locally it belongs in .env.local; in CI it ` +
        `comes from the "${target}" GitHub Environment.`,
    );
  }

  // A separate variable from the target on purpose. "Which database" and "yes,
  // really, that one" are two different statements, and collapsing them into
  // one would mean naming production was the same act as authorising it.
  const allowProduction = readEnv("ALLOW_PRODUCTION_MIGRATION") === "true";
  const tags = readMigrationTags();

  // Printed before the guard and before the connection, so a run that is about
  // to be refused still leaves a record of what it was aiming at.
  console.log("");
  console.log("Migrating");
  console.log(`  target      ${target}`);
  console.log(`  database    ${describeDatabase(connectionString)}`);
  console.log(`  folder      ${MIGRATIONS_FOLDER}`);
  console.log(`  migrations  ${tags.length}${tags.length > 0 ? ` (${tags.join(", ")})` : ""}`);
  if (target === "production") {
    console.log(`  authorised  ${allowProduction ? "yes" : "NO"}`);
  }
  console.log("");

  try {
    assertMigrationAllowed({ appEnv: target, connectionString, allowProduction });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const pool = new Pool({ connectionString });
  const startedAt = Date.now();
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    // In a `finally`, because a failed migration that leaves the pool open
    // holds the job open until the runner's timeout — turning a legible SQL
    // error into a six-hour hang with the cause scrolled off the top.
    await pool.end();
  }

  console.log(`Applied in ${Date.now() - startedAt}ms. Schema is at ${tags.at(-1) ?? "none"}.`);
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  fail(
    `${detail}\n\n` +
      `The deploy has NOT happened — the workflow stops here by design. Read ` +
      `"When a migration fails mid-deploy" in DEPLOYMENT.md before re-running.`,
  );
});
