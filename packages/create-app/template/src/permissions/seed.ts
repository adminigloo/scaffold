import type { PgDatabase } from "drizzle-orm/pg-core";
import { auditEntry, defineAuditedActions } from "__SCOPE__/observability";
import { auditLog } from "__SCOPE__/observability/schema";
import { STAFF_ROLE_TEMPLATES } from "__SCOPE__/permissions";
import { seedPermissionCatalog, type SeedReport } from "__SCOPE__/permissions/server";
import { backfillTenantOwnerRoles, tenancyAuditedActions } from "__SCOPE__/tenancy";
import {
  ensureBootstrapAdminForEmail,
  type TenancyAuditSink,
} from "__SCOPE__/tenancy/server";
import { staffCatalog, tenantCatalog } from "./catalog";
import { TENANT_ROLES } from "./roles";

/**
 * Install the roles and what each one may do — the ONE seed, run three ways:
 *
 *   pnpm db:seed          on your laptop (scripts/seed-roles.ts)
 *   pnpm db:seed:deploy   on EVERY deploy, right after the migrations
 *                         (scripts/seed-deploy.ts, from deploy.yml)
 *   the PGlite tests      src/server/__tests__/*.test.ts
 *
 * WHY EVERY DEPLOY (PC-09). A permission key a new feature adds reaches the
 * roles in production only when the catalog is seeded there. It used to be a
 * command somebody had to remember, against a production database nobody's
 * laptop is allowed to reach — so production never had its roles, the first
 * administrator was never made, and /admin stayed locked.
 *
 * Safe to run any number of times: @__SCOPE_NAME__/permissions' seed is one
 * transaction under a lock, insert-only, and never touches a role somebody
 * customised. Then the owner-role backfill (every company owner holds the
 * owner role), then — when an address is given — the first administrator.
 *
 * IMPORTS NO ENV AND NO APP DATABASE. A deploy job has the database URL and
 * BOOTSTRAP_ADMIN_EMAIL and none of the app's other credentials, and the
 * app's own audit registry (src/server/audit.ts) imports routers that import
 * the app's database and its environment. So this file takes the database it
 * is given and keeps a LOCAL audit registry of the company lifecycle's
 * actions — the same keys the app's registry spreads, so the rows read back
 * with their labels in /admin/audit.
 */
// Any drizzle Postgres driver: Neon in a script, PGlite in a test.
export type SeedDb = PgDatabase<any, any, any>;

const seedAuditRegistry = defineAuditedActions(tenancyAuditedActions);

/** Writes the company lifecycle's audit rows from a script, on the transaction it is handed. */
export const seedAuditSink: TenancyAuditSink = async (tx, event) => {
  await tx.insert(auditLog).values(
    auditEntry(seedAuditRegistry, {
      action: event.action,
      actor: event.actorUserId ? { userId: event.actorUserId } : null,
      scope: event.scope,
      tenantId: event.tenantId,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      request: event.request,
      metadata: { ...event.metadata },
    }),
  );
};

export interface SeedPermissionsOptions {
  /** Make this address the first administrator, if nobody is one yet. */
  readonly bootstrapEmail?: string | null;
  /** Where the plain report goes. Default `console.log`. */
  readonly log?: (line: string) => void;
}

export async function seedPermissions(db: SeedDb, options: SeedPermissionsOptions = {}): Promise<SeedReport> {
  const log = options.log ?? ((line: string) => console.log(line));

  const report = await seedPermissionCatalog(db, {
    staff: { catalog: staffCatalog, templates: STAFF_ROLE_TEMPLATES },
    // The project's own company roles (src/permissions/roles.ts): tenancy's
    // four, plus any a feature adds — Crew, with scheduling in a companies
    // project — so a new role reaches production with the deploy that adds it.
    tenant: { catalog: tenantCatalog, templates: TENANT_ROLES.templates },
  });
  log(
    report.created.length === 0
      ? "Roles: all already installed."
      : `Roles: installed ${report.created.join(", ")}.`,
  );
  log(`Permissions: ${report.grantsAdded} granted, ${report.sealsAdded} sealed, ${report.sealsLifted} unsealed.`);
  for (const skipped of report.skippedCustomised) {
    log(`  left alone: ${skipped} (customised, so this seed doesn't touch it)`);
  }
  if (report.ungrantedKeys.length > 0) {
    log(
      `  nobody holds: ${report.ungrantedKeys.map((k) => `${k.scope}/${k.key}`).join(", ")} ` +
        "(give them to a role in the catalog's defaultFor, or on /admin/roles)",
    );
  }

  // AFTER the templates exist: the backfill looks the owner template up by key
  // and writes nothing without it. It repairs owners from before owners were
  // given their role when the company was made.
  const owners = await backfillTenantOwnerRoles(db);
  log(
    owners === 0
      ? "Owners: every owner already holds the owner role."
      : `Owners: ${owners} given the owner role.`,
  );

  const email = options.bootstrapEmail?.trim();
  if (email) {
    const outcome = await ensureBootstrapAdminForEmail(db, { email, audit: seedAuditSink });
    if (outcome.granted) {
      log(`First administrator: ${email}.`);
    } else if (outcome.ambiguous) {
      log(
        `First administrator: NOT granted — ${outcome.ambiguous.length} accounts use ${email} ` +
          `(${outcome.ambiguous.join(", ")}). Use pnpm admin:grant once one of them is gone.`,
      );
    } else if (outcome.reason === "admin-exists") {
      log("First administrator: there already is one.");
    } else {
      log(`First administrator: nobody has signed in with ${email} yet. They become one the first time they do.`);
    }
  }
  return report;
}

/** One thrown thing as text: an Error's stack, a driver event's message, anything else readable. */
function describeOne(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  if (typeof error === "object" && error !== null) {
    const e = error as { message?: unknown; type?: unknown; error?: unknown; code?: unknown };
    const parts = [
      e.error instanceof Error ? e.error.message : typeof e.message === "string" && e.message ? e.message : null,
      typeof e.code === "string" ? `(${e.code})` : null,
      typeof e.type === "string" ? `(${/^[aeiou]/i.test(e.type) ? "an" : "a"} ${e.type} event from the database connection)` : null,
    ].filter((p): p is string => p !== null);
    if (parts.length > 0) return parts.join(" ");
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

/**
 * The codes a driver gives a database it couldn't REACH (review R4 TB2-09).
 * Read off the errors themselves, never matched in their words: a reachable
 * database's own refusal can say "connect" (a table called connect_tokens, an
 * address like connect@acme.test, a stack through pg/lib/connection.js), and
 * that is a failed query, not a missing database.
 */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  // Node's sockets and DNS: pg's own TCP socket, and the ws socket under Neon's driver.
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNABORTED",
  "EPIPE",
  // undici, under fetch — Neon's HTTP driver.
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  // Postgres: class 08 (the connection itself failed) and 57P01–03 (the
  // server is shutting down, crashed, or isn't accepting connections yet).
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "57P01",
  "57P02",
  "57P03",
]);

/** Everything a thrown thing carries underneath it: `cause`, an ErrorEvent's `error`, Neon's `sourceError`, an AggregateError's `errors`. */
function causesOf(error: unknown): unknown[] {
  const seen = new Set<unknown>();
  const out: unknown[] = [];
  const queue: unknown[] = [error];
  while (queue.length > 0 && out.length < 24) {
    const e = queue.shift();
    if (e === undefined || e === null || seen.has(e)) continue;
    seen.add(e);
    out.push(e);
    if (typeof e !== "object") continue;
    const o = e as { cause?: unknown; error?: unknown; sourceError?: unknown; errors?: unknown };
    queue.push(o.cause, o.error, o.sourceError);
    if (Array.isArray(o.errors)) queue.push(...o.errors);
  }
  return out;
}

function codeOf(error: unknown): string | null {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : null;
}

/** drizzle's wrapper around a failed statement: it carries the statement and its parameters. */
function isFailedQuery(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const e = error as Error & { query?: unknown; params?: unknown };
  return (typeof e.query === "string" && Array.isArray(e.params)) || e.message.startsWith("Failed query:");
}

/**
 * Anything a seed or a grant can throw, as a sentence a deploy log can show
 * (review R2 TB2-09). An unreachable database makes the Neon driver reject
 * with a WebSocket ErrorEvent, not an Error, and `String(event)` printed
 * "SEED FAILED [object Object]" — the only line a buyer sees in GitHub
 * Actions. Given where the script was connecting (host and database, never the
 * password), a connection failure says so.
 *
 * THE CAUSE CHAIN IS READ, not only the outer error (review R3 TB2-09). A
 * statement run through drizzle — admin:grant's first lookup — doesn't throw
 * the driver's event: it throws "Failed query: select … params: you@example.com"
 * with the event as its `cause`.
 *
 * "COULD NOT REACH" ONLY BY CODE (review R4 TB2-09): a network error's code
 * anywhere underneath (ECONNREFUSED, ENOTFOUND, ETIMEDOUT, EAI_AGAIN,
 * ECONNRESET…, undici's, Postgres's connection class). Words are never
 * matched, so a database that answered — and refused a statement whose
 * parameter was connect@acme.test — is reported as the query failure it is:
 * the database's reason, without the statement or what it was asked about.
 * Anything else keeps its own text, with what caused it underneath.
 */
export function describeScriptFailure(error: unknown, where: string | null = null): string {
  const all = causesOf(error);
  const unreachable = all.find((e) => {
    const code = codeOf(e);
    return code !== null && UNREACHABLE_CODES.has(code);
  });
  if (unreachable !== undefined) {
    // The network error's own words only: the failed statement (and the
    // address it was given) says nothing about why the database couldn't be reached.
    const words = unreachable instanceof Error ? unreachable.message : describeOne(unreachable);
    const code = codeOf(unreachable)!;
    return (
      `Could not reach the database${where ? ` at ${where}` : ""}. Check the connection string (the DIRECT one, without -pooler) and that the database is running.\n` +
      `${words.includes(code) ? words : `${words} (${code})`}`
    );
  }
  const failedQuery = all.find(isFailedQuery);
  if (failedQuery !== undefined) {
    // The database answered and refused the statement. Its reason, and its
    // code — never the statement or its parameters (an address, a name).
    const reason = (failedQuery as { cause?: unknown }).cause;
    const why = reason === undefined || reason === null ? "the database gave no reason" : (reason instanceof Error ? reason.message : describeOne(reason)).split("\n")[0]!;
    const code = codeOf(reason);
    return `A query on the database${where ? ` at ${where}` : ""} failed: ${why}${code && !why.includes(code) ? ` (${code})` : ""}`;
  }
  const chain: unknown[] = [];
  for (let e: unknown = error; e !== undefined && e !== null && chain.length < 6; e = (e as { cause?: unknown }).cause) {
    chain.push(e);
    if (typeof e !== "object") break;
  }
  const [first, ...causes] = chain.map(describeOne);
  return [first ?? String(error), ...causes.map((text) => `Caused by: ${text.split("\n")[0]}`)].join("\n");
}
