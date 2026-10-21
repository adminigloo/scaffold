import type { BootstrapPolicy, Catalog } from "@adminigloo/permissions";
import {
  createDrizzlePermissionLoaders,
  listRoleTemplates,
  resolvePermissionsFor,
  type DrizzlePermissionLoaders,
} from "@adminigloo/permissions/server";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { SetupChecklist } from "../checklist.js";
import type { TenancyEventInput, TenancyEventPerson } from "../events.js";
import { RESERVED_SLUGS } from "../slug.js";
import type { TenantSettingsRegistry } from "../settings.js";
import { DEFAULT_TENANT_ROLES, type TenantRoleSet } from "../roles.js";
import type { RoleKey, RoleOptionWire } from "../wire.js";
import { asRoleKey, q, str, strOrNull, type CompanyRow } from "./db.js";
import { failWith, type TenancyError } from "./errors.js";
import { tenancyMembershipGate } from "./gate.js";
import type {
  CompanyDeletion,
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

/** How long `settleEvents` waits for the listeners pending now, unless told otherwise (Tenancy 2b-1, 8.1). */
export const DEFAULT_SETTLE_EVENTS_MS = 5000;
/** The longest `settleEvents` will wait, whatever it is asked: a handler must answer. */
const MAX_SETTLE_EVENTS_MS = 60_000;

/** Everything the lifecycle modules share, built once by `createTenancyService`. */
export interface Ctx {
  readonly db: TenancyDb;
  readonly mode: TenancyMode;
  readonly noun: TenancyNoun;
  readonly tenantCatalog: Catalog;
  readonly bootstrap: BootstrapPolicy;
  readonly settings: TenantSettingsRegistry;
  readonly checklist: SetupChecklist;
  /** The project's company roles (Tenancy 2a, D9): the core four plus its extras (Crew). */
  readonly roles: TenantRoleSet;
  readonly seats: SeatLimitSource | undefined;
  readonly logos: LogoStore | undefined;
  /** Delete a company (0.8): the project's forget step; undefined → no deleting. */
  readonly deletion: CompanyDeletion | undefined;
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
  /**
   * After commit: tell `onEvent`, swallowing and reporting its failures.
   * Tenancy 2b-1: stamps `id` and `occurredAt` (the one place they are made)
   * and keeps the listener's promise until it settles, for `settle`.
   */
  emit(event: TenancyEventInput): void;
  /** Tenancy 2b-1: wait (bounded, never throwing) for the listeners pending now. */
  settle(timeoutMs?: number): Promise<void>;
  /**
   * Tenancy 2b-1: who a member event is about, and the role they hold now in
   * words, in ONE query (`users` by id, its role in this company). A deleted
   * user gives `{ name: null, email: null }`. With no `onEvent` there is
   * nobody to tell, so nothing is read. Never throws: a failed read is
   * reported and the event still goes, naming nobody.
   */
  memberFacts(tenantId: string, userId: string): Promise<{ readonly person: TenancyEventPerson; readonly roleName: string }>;
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
  roles?: TenantRoleSet;
  seats?: SeatLimitSource;
  logos?: LogoStore;
  deletion?: CompanyDeletion;
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
  const now = options.now ?? (() => new Date());
  const roles = options.roles ?? DEFAULT_TENANT_ROLES;
  // The listeners still running (Tenancy 2b-1, 8.1). Each removes itself when
  // it settles, so the set holds only what is pending NOW.
  const pending = new Set<Promise<void>>();
  return {
    db: options.db,
    mode: options.mode,
    noun: options.noun,
    tenantCatalog: options.tenantCatalog,
    bootstrap: options.bootstrap,
    settings: options.settings,
    checklist: options.checklist,
    roles,
    seats: options.seats,
    logos: options.logos,
    deletion: options.deletion,
    reserved,
    invitationExpiryHours: options.invitations?.expiresInHours,
    requireMatchingEmail: options.invitations?.requireMatchingEmail ?? true,
    companiesPerAccount:
      options.companiesPerAccount === null
        ? null
        : typeof options.companiesPerAccount === "number" && Number.isFinite(options.companiesPerAccount) && options.companiesPerAccount >= 1
          ? Math.floor(options.companiesPerAccount)
          : DEFAULT_COMPANIES_PER_ACCOUNT,
    now,
    fail: failWith(options.noun),
    loaders: (on) => createDrizzlePermissionLoaders(on, { membership: tenancyMembershipGate }),
    async audit(tx, event) {
      if (!options.audit) return;
      await options.audit(tx, { ...event, request: event.request ?? null });
    },
    emit(input) {
      if (!options.onEvent) return;
      // The stamp (Tenancy 2b-1, 8.1): an id unique per event (a member
      // event's alert is keyed on it, 2b-1 D7) and the service's own clock.
      const event = { ...input, id: uuidv7(), occurredAt: now().toISOString() } as TenancyEvent;
      // After commit, never awaited by the request: a slow or failing listener
      // (an email, a webhook) must not fail or delay the act it reports on.
      // The HTTP handlers wait for it, bounded, through `settle`.
      const running: Promise<void> = Promise.resolve()
        .then(() => options.onEvent?.(event))
        .then(
          () => undefined,
          (error: unknown) => {
            try {
              options.onEventError?.(error, event);
            } catch {
              /* swallowed on purpose */
            }
          },
        )
        .finally(() => {
          pending.delete(running);
        });
      pending.add(running);
    },
    async settle(timeoutMs) {
      const bound =
        typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs >= 0
          ? Math.min(timeoutMs, MAX_SETTLE_EVENTS_MS)
          : DEFAULT_SETTLE_EVENTS_MS;
      // A snapshot: the listeners pending NOW. One that starts while we wait
      // (another request's) is that request's to wait for.
      const waiting = [...pending];
      if (waiting.length === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          // Each `running` already swallows its listener's failure; allSettled
          // is belt and braces, so this can never reject.
          Promise.allSettled(waiting),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, bound);
          }),
        ]);
      } catch {
        /* never throws (8.1) */
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    async memberFacts(tenantId, userId) {
      const nobody = { person: { name: null, email: null }, roleName: "a member" };
      if (!options.onEvent) return nobody;
      try {
        const rows = await q(
          options.db,
          sql`/* adminigloo:tenancy/event-person */
            select u.display_name, u.email, rt.key as role_key, rt.name as role_name
            from (select 1) as one
            left join users u on u.id = ${userId} and u.deleted_at is null
            left join principal_role pr on pr.principal_id = ${userId} and pr.scope = 'tenant' and pr.tenant_id = ${tenantId}
            left join role_template rt on rt.id = pr.template_id`,
        );
        const row = rows[0];
        const name = strOrNull(row?.["display_name"])?.trim() || null;
        const email = strOrNull(row?.["email"])?.trim() || null;
        const roleKey = strOrNull(row?.["role_key"]);
        // The name the database holds (a renamed template reads as renamed),
        // else the project's own, else "a member" (a role-less join).
        const roleName =
          strOrNull(row?.["role_name"])?.trim() ||
          (roleKey ? roles.templates.find((t) => t.key === roleKey)?.name ?? roleKey : null) ||
          "a member";
        return { person: { name, email }, roleName };
      } catch (error) {
        report(error, "event.person");
        return nobody;
      }
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
 * The company role options, highest first: the project's role set (Tenancy
 * 2a: the core four plus extras like Crew), with the names, descriptions and
 * ranks the database holds (a renamed system template reads as renamed),
 * falling back to the set's own.
 */
export async function roleOptions(tx: TenancyDb, tenantId: string, roles: TenantRoleSet = DEFAULT_TENANT_ROLES): Promise<RoleOptionWire[]> {
  const rows = await listRoleTemplates(tx, { scope: "tenant", tenantId });
  return roles.templates.map((shipped) => {
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
