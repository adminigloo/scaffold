/**
 * Make someone an administrator — the way back in when nobody can open /admin.
 *
 *   pnpm admin:grant you@example.com
 *   pnpm admin:grant you@example.com --id <user id>   (two accounts share it)
 *
 * THE RECOVERY TOOL (PC-V1). The first administrator is made automatically —
 * BOOTSTRAP_ADMIN_EMAIL whenever no administrator exists, or the first person
 * to open /admin on a laptop — but "an administrator exists and it isn't me"
 * (a co-founder removed you, the only admin's account was replaced) had no way
 * out short of SQL. This is that way out.
 *
 * WHICH DATABASE. It uses DATABASE_URL_UNPOOLED (or DATABASE_URL) from the
 * environment, else from .env.local — which on a laptop is your STAGING
 * database. Production's URL is deliberately on nobody's laptop, so for
 * production run the "Admin grant" workflow in GitHub Actions instead
 * (.github/workflows/deploy.yml, run by hand, behind the production
 * environment's reviewer). The host is printed before anything is changed.
 *
 * The person must have signed in once, so there is a row to give the role to.
 * Running it again for someone who already is one changes nothing. The grant
 * is written to the audit log as "Gave someone a staff role", with
 * `{ via: "admin:grant" }`.
 */
import { Pool } from "@neondatabase/serverless";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import "__SCOPE__/db";
import { roleOf, assignRoleTemplate } from "__SCOPE__/permissions/server";
import { describeScriptFailure, seedAuditSink } from "../src/permissions/seed";

try {
  process.loadEnvFile(".env.local");
} catch {
  // No .env.local — the normal case in CI.
}

/** Host and database being changed, once known: a connection failure names it (never the password). */
let target: string | null = null;

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
}

function fail(message: string): never {
  console.error("");
  console.error(message);
  console.error("");
  process.exit(1);
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/** `--id <user id>` or `--id=<user id>`: which of several accounts sharing the address. */
function chosenId(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--id") return args[i + 1]?.trim() || null;
    if (arg.startsWith("--id=")) return arg.slice(5).trim() || null;
  }
  return null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const email = args.find((a) => !a.startsWith("--") && a.includes("@"))?.trim().toLowerCase();
  const pickedId = chosenId(args);
  if (!email || !email.includes("@")) {
    fail("Usage: pnpm admin:grant you@example.com [--id <user id>]");
  }
  const connectionString = readEnv("DATABASE_URL_UNPOOLED") ?? readEnv("DATABASE_URL");
  if (connectionString === undefined) {
    fail("No database: set DATABASE_URL_UNPOOLED (or DATABASE_URL) in .env.local or the environment.");
  }
  let host = "(unreadable URL)";
  try {
    const url = new URL(connectionString);
    host = url.host;
    target = `${url.host}${url.pathname}`;
  } catch {
    // Printed as unreadable; the connection attempt below says what's wrong.
  }
  console.log(`Database: ${host}`);

  const pool = new Pool({ connectionString });
  const db = drizzle(pool);
  try {
    const found = rowsOf(
      await db.execute(
        sql`select id, external_id, created_at from users where lower(email) = ${email} and deleted_at is null order by created_at, id`,
      ),
    );
    if (found.length === 0) {
      fail(`Nobody has signed in with ${email} yet. Sign in once, then run this again.`);
    }
    const ids = found.map((r) => String(r["id"]));
    if (pickedId !== null && !ids.includes(pickedId)) {
      fail(`${pickedId} is not an account using ${email}. The accounts using it: ${ids.join(", ")}.`);
    }
    if (found.length > 1 && pickedId === null) {
      // Review T1-02: never guess between two accounts that share an address.
      // Review R2 SEC-T1-G: and say how to choose, because "delete the other
      // one in Clerk" is no help when the other one is already gone there.
      const listed = found
        .map((r) => `  ${String(r["id"])}   Clerk user ${String(r["external_id"])}, first seen ${String(r["created_at"])}`)
        .join("\n");
      fail(
        `${found.length} accounts use ${email}:\n${listed}\n` +
          "Nothing was changed. Find yours in Clerk (Users: the user id there is the \"Clerk user\" above), then choose it:\n" +
          `  pnpm admin:grant ${email} --id <its id from the first column>\n` +
          "Or delete the one that isn't you in Clerk; the webhook takes it out of this database.",
      );
    }
    const principalId = pickedId ?? ids[0]!;

    const before = await roleOf(db, { principalId, scope: "staff" });
    if (before?.key === "admin") {
      console.log(`${email} is already an administrator.`);
      return;
    }

    await db.transaction(async (tx) => {
      const assignment = await assignRoleTemplate(tx, {
        scope: "staff",
        principalId,
        templateKey: "admin",
        actor: { system: "admin:grant" },
      });
      if (assignment.changed) {
        await seedAuditSink(tx, {
          action: "staff.role.assigned",
          actorUserId: null,
          scope: "staff",
          tenantId: null,
          resourceType: "staff_role",
          resourceId: principalId,
          metadata: { via: "admin:grant", from: before?.key ?? null, to: "admin" },
          request: null,
        });
      }
    });
    console.log(`${email} is now an administrator.`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  // Readable whatever was thrown, and an unreachable database said in words,
  // as db:seed:deploy says it (review R2/R3 TB2-09): the first lookup goes
  // through drizzle, whose "Failed query: select … params: you@example.com"
  // and a stack were all a person saw — never which database it couldn't reach.
  const described = describeScriptFailure(error, target);
  const message = error instanceof Error ? error.message : String(error);
  if (!described.startsWith("Could not reach the database") && /role template|templates/i.test(message)) {
    fail(`${message}\nThe roles aren't installed on this database yet: run pnpm db:seed (or deploy), then try again.`);
  }
  fail(described);
});
