import type { BootstrapPolicy, Catalog } from "@adminigloo/permissions";
import {
  createDrizzlePermissionLoaders,
  listRoleTemplates,
  resolvePermissionsFor,
  type DrizzlePermissionLoaders,
} from "@adminigloo/permissions/server";
import { sql } from "drizzle-orm";
import type { SetupChecklist } from "../checklist.js";
import { RESERVED_SLUGS } from "../slug.js";
import type { TenantSettingsRegistry } from "../settings.js";
import { TENANT_ROLE_TEMPLATES } from "../templates.js";
import type { RoleKey, RoleOptionWire } from "../wire.js";
import { asRoleKey, q, str, type CompanyRow } from "./db.js";
import { failWith, type TenancyError } from "./errors.js";
import { tenancyMembershipGate } from "./gate.js";
import type {
  LogoStore,
  RequestFacts,
  SeatLimitSource,
  TenancyAuditEvent,
  TenancyAuditSink,
  TenancyDb,
  TenancyEvent,
  TenancyMode,
  TenancyNoun,
} from "./types.js";

/** Live companies one account may own unless the host says otherwise (review R2 SEC-T1-B/C). */
export const DEFAULT_COMPANIES_PER_ACCOUNT = 10;

/** Everything the lifecycle modules share, built once by `createTenancyService`. */
export interface Ctx {
  readonly db: TenancyDb;
  readonly mode: TenancyMode;
  readonly noun: TenancyNoun;
  readonly tenantCatalog: Catalog;
  readonly bootstrap: BootstrapPolicy;
  readonly settings: TenantSettingsRegistry;
  readonly checklist: SetupChecklist;
  readonly seats: SeatLimitSource | undefined;
  readonly logos: LogoStore | undefined;
  readonly reserved: ReadonlySet<string>;
  readonly invitationExpiryHours: number | undefined;
  readonly requireMatchingEmail: boolean;
  /** Live companies one account may own; null = no limit (review R2 SEC-T1-B/C). */
  readonly companiesPerAccount: number | null;
  readonly now: () => Date;
  readonly fail: (code: TenancyError["code"], details?: TenancyError["details"], message?: string) => TenancyError;
  /** The permission loaders on THIS handle (a transaction gets its own: D7, read-your-writes). */
  loaders(on: TenancyDb): DrizzlePermissionLoaders;
  /** Write one audit row inside the transaction (D17). No sink → nothing. */
  audit(tx: TenancyDb, event: Omit<TenancyAuditEvent, "request"> & { readonly request?: RequestFacts | null }): Promise<void>;
  /** After commit: tell `onEvent`, swallowing and reporting its failures. */
  emit(event: TenancyEvent): void;
  /** Report a problem that must not fail the request (a parse fallback, a best-effort delete). */
  report(error: unknown, where: string): void;
}

export function createCtx(options: {
  db: TenancyDb;
  mode: TenancyMode;
  noun: TenancyNoun;
  tenantCatalog: Catalog;
  bootstrap: BootstrapPolicy;
  settings: TenantSettingsRegistry;
  checklist: SetupChecklist;
  seats?: SeatLimitSource;
  logos?: LogoStore;
  reservedSlugs?: Iterable<string>;
  invitations?: { readonly expiresInHours?: number; readonly requireMatchingEmail?: boolean };
  companiesPerAccount?: number | null;
  audit?: TenancyAuditSink;
  onEvent?: (event: TenancyEvent) => void | Promise<void>;
  onEventError?: (error: unknown, event: TenancyEvent | { readonly type: string }) => void;
  now?: () => Date;
}): Ctx {
  const reserved = new Set<string>(RESERVED_SLUGS);
  for (const word of options.reservedSlugs ?? []) {
    const w = String(word).trim().toLowerCase();
    if (w) reserved.add(w);
  }
  const report = (error: unknown, where: string) => {
    try {
      options.onEventError?.(error, { type: where });
    } catch {
      /* a broken reporter must not fail the request it reports on */
    }
  };
  return {
    db: options.db,
    mode: options.mode,
    noun: options.noun,
    tenantCatalog: options.tenantCatalog,
    bootstrap: options.bootstrap,
    settings: options.settings,
    checklist: options.checklist,
    seats: options.seats,
    logos: options.logos,
    reserved,
    invitationExpiryHours: options.invitations?.expiresInHours,
    requireMatchingEmail: options.invitations?.requireMatchingEmail ?? true,
    companiesPerAccount:
      options.companiesPerAccount === null
        ? null
        : typeof options.companiesPerAccount === "number" && Number.isFinite(options.companiesPerAccount) && options.companiesPerAccount >= 1
          ? Math.floor(options.companiesPerAccount)
          : DEFAULT_COMPANIES_PER_ACCOUNT,
    now: options.now ?? (() => new Date()),
    fail: failWith(options.noun),
    loaders: (on) => createDrizzlePermissionLoaders(on, { membership: tenancyMembershipGate }),
    async audit(tx, event) {
      if (!options.audit) return;
      await options.audit(tx, { ...event, request: event.request ?? null });
    },
    emit(event) {
      if (!options.onEvent) return;
      // After commit, never awaited by the request: a slow or failing listener
      // (an email, a webhook) must not fail or delay the act it reports on.
      void Promise.resolve()
        .then(() => options.onEvent?.(event))
        .catch((error) => {
          try {
            options.onEventError?.(error, event);
          } catch {
            /* swallowed on purpose */
          }
        });
    },
    report,
  };
}

/** What the caller may do in one company, re-resolved on the handle given. */
export interface ActorFacts {
  readonly can: ReadonlySet<string>;
  readonly role: { readonly key: string; readonly rank: number } | null;
}

/**
 * The caller's standing in a company, decided on `tx` (D7: under the lock,
 * the authority; before it, a hint). A non-member, a missing company and a
 * deleted one all answer `not_a_member` — the same answer for "not yours" and
 * "doesn't exist", so a company id can't be probed. A suspended company
 * answers `company_suspended` unless the caller allows it (leaving does).
 */
export async function requireActor(
  ctx: Ctx,
  tx: TenancyDb,
  input: { readonly userId: string; readonly tenantId: string },
  options: { readonly permission?: string; readonly allowSuspended?: boolean } = {},
): Promise<ActorFacts> {
  const verdict = await tenancyMembershipGate(tx, input);
  if (verdict === "not-a-member") throw ctx.fail("not_a_member");
  if (verdict === "company-suspended" && !options.allowSuspended) throw ctx.fail("company_suspended");
  const set = await resolvePermissionsFor(tx, { principalId: input.userId, scope: "tenant", tenantId: input.tenantId });
  const can = new Set(set.toArray());
  if (options.permission && !can.has(options.permission)) throw ctx.fail("forbidden");
  const role = await roleIn(tx, input.tenantId, input.userId);
  return { can, role };
}

/**
 * Does this person hold `permission` in this company right now? False for a
 * non-member and for a suspended company. A HINT, read without the company
 * lock: the handlers use it to decide who may spend a company's rate budget
 * (review R2 SEC-T1-D); every mutation still decides under the lock (D7).
 */
export async function holdsPermission(
  db: TenancyDb,
  input: { readonly userId: string; readonly tenantId: string; readonly permission: string },
): Promise<boolean> {
  if ((await tenancyMembershipGate(db, input)) !== "member") return false;
  const set = await resolvePermissionsFor(db, { principalId: input.userId, scope: "tenant", tenantId: input.tenantId });
  return set.toArray().includes(input.permission);
}

/** One person's company role and its rank (from `role_template.rank`), or null. */
export async function roleIn(
  tx: TenancyDb,
  tenantId: string,
  userId: string,
): Promise<{ key: string; rank: number; name: string } | null> {
  const rows = await q(
    tx,
    sql`/* adminigloo:tenancy/role-of */
      select rt.key, rt.rank, rt.name from principal_role pr join role_template rt on rt.id = pr.template_id
      where pr.principal_id = ${userId} and pr.scope = 'tenant' and pr.tenant_id = ${tenantId} limit 1`,
  );
  const row = rows[0];
  return row ? { key: str(row["key"]), rank: Number(row["rank"]), name: str(row["name"]) } : null;
}

/**
 * The company role options (owner, admin, member, viewer), highest first, with
 * the names, descriptions and ranks the database holds (a renamed system
 * template reads as renamed), falling back to the shipped ones.
 */
export async function roleOptions(tx: TenancyDb, tenantId: string): Promise<RoleOptionWire[]> {
  const rows = await listRoleTemplates(tx, { scope: "tenant", tenantId });
  return TENANT_ROLE_TEMPLATES.map((shipped) => {
    const row = rows.find((r) => r.key === shipped.key);
    return {
      key: shipped.key,
      name: row?.name ?? shipped.name,
      description: row?.description ?? shipped.description,
      rank: row?.rank ?? shipped.rank,
    };
  }).sort((a, b) => b.rank - a.rank);
}

export function rankOf(options: readonly RoleOptionWire[], key: string | null): number {
  if (key === null) return 0;
  return options.find((o) => o.key === key)?.rank ?? 0;
}

export function roleNameOf(options: readonly RoleOptionWire[], key: string | null): string {
  if (key === null) return "No role";
  return options.find((o) => o.key === key)?.name ?? key;
}

export function roleKeyOf(value: string | null | undefined): RoleKey | null {
  return asRoleKey(value);
}

/** Refuse a company that is gone. Same answer as "not yours". */
export function requireLive(ctx: Ctx, company: CompanyRow | null): CompanyRow {
  if (!company || company.deletedAt !== null) throw ctx.fail("not_a_member");
  return company;
}
