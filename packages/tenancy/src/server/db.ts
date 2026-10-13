import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { TenantBranding, TenantKind, TenantSetupState } from "../schema.js";
import type { CompanyStatus, RoleKey } from "../wire.js";
import type { TenancyDb } from "./types.js";

/**
 * The raw-SQL helpers every lifecycle function shares.
 *
 * WHY RAW SQL FOR THE LOCKS AND THE LIFECYCLE READS. Every statement carries a
 * `/* adminigloo:tenancy/<name> *\/` comment (the 0.3 convention): it shows up
 * in `pg_stat_activity` and slow-query logs, and the tests assert on the query
 * log that the company lock is the FIRST statement of every mutation (D7). The
 * query builder is used where it reads better; `db.query.*` never is — the
 * relational API needs the schema registered on the handle, and a package can't
 * assume the host did that (nor that tsup's CJS copy of a table is the one the
 * host registered).
 */

export type Row = Record<string, unknown>;

export function rowsOf(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  if (typeof result === "object" && result !== null) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Row[];
  }
  throw new Error(
    "The database driver returned a result with no readable rows (expected an array or an object with a `rows` array).",
  );
}

export async function q(db: TenancyDb, statement: SQL): Promise<Row[]> {
  return rowsOf(await db.execute(statement));
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

export function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function num(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return 0;
}

export function dateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof value === "string") {
    // A timestamptz read through a raw `execute` arrives as Postgres text on
    // several drivers (PGlite and neon-http among them): "2026-10-12
    // 15:04:05.71-07", "…+05:30", "…+00". JavaScript's Date only reads the
    // ISO form, so: T for the space, at most milliseconds, and a ±HH:MM offset.
    const iso = value
      .trim()
      .replace(" ", "T")
      .replace(/(\.\d{3})\d+/, "$1")
      .replace(/([+-]\d{2})$/, "$1:00")
      .replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

export function date(value: unknown): Date {
  return dateOrNull(value) ?? new Date(0);
}

export function json(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value ?? {};
}

const brandingSchema = z
  .object({
    logoUrl: z.string().optional(),
    logoKey: z.string().optional(),
    brandColor: z.string().regex(/^#[0-9a-f]{6}$/).optional(),
    onBrandColor: z.enum(["#ffffff", "#111111"]).optional(),
  })
  .catch({});

/** `tenants.branding` → TenantBranding; anything unparseable reads as `{}`. */
export function parseBranding(value: unknown): TenantBranding {
  return brandingSchema.parse(json(value)) as TenantBranding;
}

const setupStateSchema = z
  .object({
    dismissed: z.array(z.string()).optional(),
    hiddenAt: z.string().optional(),
    hiddenKeys: z.array(z.string()).optional(),
  })
  .catch({});

export function parseSetupState(value: unknown): TenantSetupState {
  return setupStateSchema.parse(json(value)) as TenantSetupState;
}

/** One `tenants` row, as the lifecycle functions read it. */
export interface CompanyRow {
  readonly id: string;
  readonly kind: TenantKind;
  readonly slug: string;
  readonly name: string;
  readonly ownerUserId: string | null;
  readonly branding: TenantBranding;
  readonly settings: unknown;
  readonly createdBy: string | null;
  readonly creationKey: string | null;
  readonly suspendedAt: Date | null;
  readonly suspendedReason: string | null;
  readonly suspendedBy: string | null;
  readonly setupState: TenantSetupState;
  readonly createdAt: Date;
  readonly deletedAt: Date | null;
}

export const COMPANY_COLUMNS = sql.raw(
  "t.id, t.kind, t.slug, t.name, t.owner_user_id, t.branding, t.settings, t.created_by, t.creation_key, " +
    "t.suspended_at, t.suspended_reason, t.suspended_by, t.setup_state, t.created_at, t.deleted_at",
);

export function companyRow(row: Row): CompanyRow {
  return {
    id: str(row["id"]),
    kind: row["kind"] === "personal" ? "personal" : "org",
    slug: str(row["slug"]),
    name: str(row["name"]),
    ownerUserId: strOrNull(row["owner_user_id"]),
    branding: parseBranding(row["branding"]),
    settings: json(row["settings"]),
    createdBy: strOrNull(row["created_by"]),
    creationKey: strOrNull(row["creation_key"]),
    suspendedAt: dateOrNull(row["suspended_at"]),
    suspendedReason: strOrNull(row["suspended_reason"]),
    suspendedBy: strOrNull(row["suspended_by"]),
    setupState: parseSetupState(row["setup_state"]),
    createdAt: date(row["created_at"]),
    deletedAt: dateOrNull(row["deleted_at"]),
  };
}

export function statusOf(company: Pick<CompanyRow, "suspendedAt">): CompanyStatus {
  return company.suspendedAt === null ? "active" : "suspended";
}

/**
 * THE COMPANY LOCK (decision D7). `select … for update` on the tenants row,
 * the first statement of every member-lifecycle transaction. Every mutation of
 * one company's roster, roles, invitations, settings and suspension queues
 * here, so the second caller always re-reads what the first one committed.
 *
 * Returns the row even when it's soft-deleted: the caller decides what a
 * deleted company means for its answer (usually the same as "not yours").
 */
export async function lockCompany(tx: TenancyDb, tenantId: string): Promise<CompanyRow | null> {
  const rows = await q(
    tx,
    sql`/* adminigloo:tenancy/lock-company */ select ${COMPANY_COLUMNS} from tenants t where t.id = ${tenantId} for update`,
  );
  return rows[0] ? companyRow(rows[0]) : null;
}

/** The same row, unlocked (reads that don't decide a write). */
export async function readCompany(db: TenancyDb, tenantId: string): Promise<CompanyRow | null> {
  const rows = await q(db, sql`/* adminigloo:tenancy/read-company */ select ${COMPANY_COLUMNS} from tenants t where t.id = ${tenantId}`);
  return rows[0] ? companyRow(rows[0]) : null;
}

export const ROLE_KEYS: readonly RoleKey[] = ["owner", "admin", "member", "viewer"];

export function asRoleKey(value: unknown): RoleKey | null {
  return typeof value === "string" && (ROLE_KEYS as readonly string[]).includes(value) ? (value as RoleKey) : null;
}

/** A user row's facts, or null for a missing or deleted user. */
export async function readUser(
  db: TenancyDb,
  userId: string,
): Promise<{ id: string; email: string | null; name: string | null; activeTenantId: string | null; createdAt: Date } | null> {
  const rows = await q(
    db,
    sql`/* adminigloo:tenancy/read-user */
      select id, email, display_name, active_tenant_id, created_at from users where id = ${userId} and deleted_at is null`,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: str(row["id"]),
    email: strOrNull(row["email"]),
    name: strOrNull(row["display_name"]),
    activeTenantId: strOrNull(row["active_tenant_id"]),
    createdAt: date(row["created_at"]),
  };
}

/** "Sam Lee" or "sam@summit.test", for messages and invitations. */
export function displayOf(person: { readonly name: string | null; readonly email: string | null } | null | undefined): string | null {
  if (!person) return null;
  return person.name ?? person.email ?? null;
}

/** Escape a user's search text for ILIKE: %, _ and \ are literal. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
