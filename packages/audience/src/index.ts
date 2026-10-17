import { verifyLicense, type LicenseMode } from "@adminigloo/license";
import { createAudienceCore, type CreateAudienceOptions } from "./core/audience.js";
import { createAudienceRegistry } from "./core/registry.js";
import type { SubjectKind } from "./core/labels.js";
import type { AudienceUser } from "./core/types.js";
import {
  countedSubjectSql,
  countedVisitorSql,
  type DrizzleColumnInput,
  type DrizzleCountedOptions,
  type DrizzleCountedVisitorOptions,
} from "./drizzle-sql.js";

/**
 * @adminigloo/audience — keep staff, testers, automation and a named list of
 * people out of an app's numbers, and clean the numbers already polluted.
 *
 * This root entry is `./core` (rules, classifier, `createAudience` over any
 * store) plus what a Drizzle + Postgres app wants: the default store
 * (`createDrizzleAudienceStore`), the anti-join as Drizzle `sql`
 * (`countedVisitorSql`, `countedSubjectSql`), a zod schema for the add-rule
 * form, and the AdminIgloo license gate. Tables live in `./schema`, the admin
 * components in `./ui`, the source guard in `./testing`.
 */

export * from "./core.js";
export { createDrizzleAudienceStore } from "./drizzle-store.js";
export type { AudienceDb } from "./drizzle-store.js";
export { countedSubjectSql, countedVisitorSql, toDrizzleSql } from "./drizzle-sql.js";
export type { DrizzleColumnInput, DrizzleCountedOptions, DrizzleCountedVisitorOptions } from "./drizzle-sql.js";

export interface AudienceLicenseOptions {
  /** ADMINIGLOO_LICENSE_KEY */
  readonly key?: string | undefined;
  /** ADMINIGLOO_LICENSE_PUBLIC_KEY */
  readonly publicKey?: string | undefined;
  /** ADMINIGLOO_LICENSE_MODE — "off" (default) never denies. */
  readonly mode?: LicenseMode | undefined;
}

export interface CreateDrizzleAudienceOptions<TUser extends AudienceUser = AudienceUser>
  extends Omit<CreateAudienceOptions<TUser>, "licenseGate"> {
  /**
   * The AdminIgloo license gate, feature "audience". It guards the CLEANING
   * work (preview, addRule and markVisitor, apply, mark, backfill, maintain)
   * and never intake, reports, remove or unmark: an expired license must not
   * start counting staff again, and must not stop anyone undoing a rule.
   */
  license?: AudienceLicenseOptions;
}

type CountedExtra = Omit<DrizzleCountedOptions, "tenantId" | "marksTable">;
type CountedVisitorExtra = Omit<DrizzleCountedVisitorOptions, "tenantId" | "marksTable">;

/**
 * The one object an app holds. Same as `./core`'s `createAudience`, plus the
 * counted fragments as Drizzle `sql`, bound to this instance's tenant and
 * marks table.
 */
export function createAudience<TUser extends AudienceUser = AudienceUser>(options: CreateDrizzleAudienceOptions<TUser>) {
  const { license, ...rest } = options;
  const core = createAudienceCore<TUser>({
    ...rest,
    ...(license ? { licenseGate: () => verifyLicense({ feature: "audience", ...license }) } : {}),
  });
  return {
    ...core,
    /**
     * `NOT EXISTS (… visitor or session mark …)` as Drizzle sql — true for rows
     * that COUNT. `extra` must name `time` and `session` (`{ time: "s.created_at",
     * session: "s.id" }`), or set either to null on purpose.
     */
    countedVisitorSql: (visitorColumn: DrizzleColumnInput, extra: CountedVisitorExtra) =>
      countedVisitorSql(visitorColumn, { tenantId: core.tenantId, marksTable: core.marksTable, ...extra }),
    /** The same for an org / event / order / user id column. */
    countedSubjectSql: (kind: SubjectKind, subjectColumn: DrizzleColumnInput, extra: CountedExtra = {}) =>
      countedSubjectSql(kind, subjectColumn, { tenantId: core.tenantId, marksTable: core.marksTable, ...extra }),
  };
}

export type Audience<TUser extends AudienceUser = AudienceUser> = ReturnType<typeof createAudience<TUser>>;

export { ruleDraftSchema } from "./draft.js";

// 0.2: one audience per company, its handlers, route table and permission.
export { createAudienceRegistry } from "./core/registry.js";
export type { AudienceRegistry, AudienceRegistryOptions } from "./core/registry.js";
export { AUDIENCE_ADMIN_ROUTES, AUDIENCE_ROUTE_PERMISSIONS } from "./routes.js";
export type { AudienceRoute, AudienceRouteKind } from "./routes.js";
export { audiencePermissions } from "./permissions.js";
export type { AudiencePermission, AudiencePermissionDefinition } from "./permissions.js";
export { COMPANY_DEFAULTS_SUMMARY, COMPANY_RULE_KINDS, createAudienceAdminHandlers } from "./admin-handlers.js";
export type {
  AudienceAdminHandlers,
  AudienceAuthorizeResult,
  AudienceSettingsWire,
  CompanyAudience,
  CreateAudienceAdminHandlersOptions,
} from "./admin-handlers.js";
export type { AudienceErrorCodeWire } from "./http.js";

/** What differs per company: who is internal there, its people, its sessions, its notes. */
export type AudienceTenantOptions<TUser extends AudienceUser = AudienceUser> = Pick<
  CreateDrizzleAudienceOptions<TUser>,
  "isInternal" | "codeRule" | "listUsers" | "getUser" | "sessions" | "annotate" | "productionHosts"
>;

export interface CreateAudiencesOptions<TUser extends AudienceUser = AudienceUser>
  extends Omit<CreateDrizzleAudienceOptions<TUser>, keyof AudienceTenantOptions<TUser> | "tenantId"> {
  /**
   * The company's own facts, asked once when its instance is first built:
   * `isInternal` (its team), `getUser` / `listUsers` (its people), `sessions`
   * (its rows in the analytics table: `audienceSessionsSource({ tenantId })`).
   */
  forTenant: (tenantId: string) => AudienceTenantOptions<TUser>;
  /** Instances kept at once (least recently used first out). Default 500. */
  max?: number;
}

/**
 * ONE AUDIENCE PER COMPANY (0.2), over one store and one secret: each
 * company's rules, marks, links and run history are its own, and
 * `audiences.for(companyId)` is the same instance every time (its rule and
 * user caches are worth keeping).
 *
 *   export const audiences = createAudiences({ store, secret, visitorIds: "rotating", forTenant: (id) => ({ … }) });
 *   createAnalytics({ db, audience: (tenantId) => audiences.for(tenantId) });
 */
export function createAudiences<TUser extends AudienceUser = AudienceUser>(options: CreateAudiencesOptions<TUser>) {
  const { forTenant, max, ...shared } = options;
  if (typeof forTenant !== "function") throw new TypeError("createAudiences needs `forTenant`.");
  return createAudienceRegistry((tenantId) => createAudience<TUser>({ ...shared, ...forTenant(tenantId), tenantId }), max === undefined ? {} : { max });
}

export type Audiences<TUser extends AudienceUser = AudienceUser> = ReturnType<typeof createAudiences<TUser>>;
export type { RuleDraftInput, RuleDraftIssue, RuleDraftParseResult, RuleDraftSchema } from "./draft.js";
