/**
 * Install the roles on a DEPLOYED database. Run by the deploy, after the
 * migrations, on every release:
 *
 *   pnpm db:seed:deploy   (.github/workflows/deploy.yml, staging and production)
 *
 * WHY IT EXISTS (PC-09, TB-DEPLOY-01). `pnpm db:seed` reads .env.local, which
 * a deploy job doesn't have, and DEPLOYMENT.md keeps the production database
 * URL off every laptop on purpose — so nothing documented ever seeded
 * production. Production never got its roles, BOOTSTRAP_ADMIN_EMAIL was never
 * made an administrator, and /admin stayed locked. Now every deploy seeds,
 * right after `pnpm db:migrate:deploy`, so a permission key a new feature adds
 * reaches production's roles in the same release.
 *
 * Built like scripts/migrate.ts, and for the same reasons:
 *
 *   - It NEVER imports `@/env` or `src/db`. The app's environment contract
 *     needs Clerk keys, Stripe keys and the app URL; a seed job holds none of
 *     them and must not be made to.
 *   - It names the database out loud before touching it.
 *   - It refuses a pooled connection string: DATABASE_URL_UNPOOLED only.
 *
 * Safe to run any number of times (see src/permissions/seed.ts).
 */
import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
// The barrel import also installs the Neon driver's WebSocket constructor as a
// side effect, which a Node job needs to open a socket at all.
import "__SCOPE__/db";
import { describeScriptFailure, seedPermissions } from "../src/permissions/seed";

/**
 * The same load drizzle.config.ts and scripts/migrate.ts do. In CI there is no
 * .env.local and the workflow's environment is the whole story.
 */
try {
  process.loadEnvFile(".env.local");
} catch {
  // No .env.local — the normal case in CI.
}

/** Host and database being seeded, once known: a connection failure names it. */
let target: string | null = null;

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
}

function fail(message: string): never {
  console.error("");
  console.error("SEED FAILED");
  console.error(message);
  console.error("");
  process.exit(1);
}

/** Host and database only — the connection string carries a password. */
function describeDatabase(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `${url.host}${url.pathname}`;
  } catch {
    fail(
      "DATABASE_URL_UNPOOLED is not a URL. Copy the direct connection string from the " +
        'Neon dashboard — the one WITHOUT "-pooler" in the host.',
    );
  }
}

async function main(): Promise<void> {
  const connectionString = readEnv("DATABASE_URL_UNPOOLED");
  if (connectionString === undefined) {
    fail(
      "DATABASE_URL_UNPOOLED is not set. The seed needs the DIRECT connection string. " +
        'In CI it comes from the GitHub Environment the job runs in ("staging" or "production").',
    );
  }
  const where = describeDatabase(connectionString);
  target = where;
  if (where.includes("-pooler")) {
    fail(
      `${where} is a POOLED host. The seed takes an advisory lock for its transaction, ` +
        "which a pooler can hand to another client mid-way. Use the direct string (no -pooler).",
    );
  }

  console.log("");
  console.log("Seeding roles");
  console.log(`  database    ${where}`);
  console.log(`  first admin ${readEnv("BOOTSTRAP_ADMIN_EMAIL") ?? "(BOOTSTRAP_ADMIN_EMAIL not set)"}`);
  console.log("");

  const pool = new Pool({ connectionString });
  try {
    await seedPermissions(drizzle(pool), {
      bootstrapEmail: readEnv("BOOTSTRAP_ADMIN_EMAIL") ?? null,
      log: (line) => console.log(`  ${line}`),
    });
  } finally {
    // In a `finally`: a failed seed that leaves the pool open holds the job
    // open until the runner's timeout, with the real error scrolled away.
    await pool.end();
  }
  console.log("");
  console.log("Seeded.");
}

main().catch((error: unknown) => {
  // Readable whatever was thrown (review R2 TB2-09): a failed connection is an
  // ErrorEvent, not an Error, and used to print "[object Object]".
  fail(describeScriptFailure(error, target));
});
