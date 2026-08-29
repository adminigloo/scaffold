import type { Effect, Scope } from "@adminigloo/permissions";
import { templateRank } from "@adminigloo/tenancy";
import { deterministicId, fixedTime, type Seeded } from "./deterministic.js";

export { deterministicId, fixedTime, FIXED_NOW } from "./deterministic.js";
export type { Seeded } from "./deterministic.js";

/**
 * Row builders for the shipped schemas.
 *
 * DETERMINISTIC BY DEFAULT, AND THERE IS NO RANDOM MODE. A factory that reaches
 * for faker gives every run different ids, names and emails, so the failure
 * that shows up once in fifty runs cannot be reproduced from the log — the
 * seeded value that broke it is gone by the time anyone reads the output. Every
 * value here is a pure function of `(kind, seed)`; the same seed gives the same
 * row on every machine and in every re-run.
 *
 * Overrides merge SHALLOWLY, on purpose. `branding` and `settings` are jsonb
 * blobs, and a deep merge would make `{ branding: { logo: null } }` mean
 * "override the logo" in one call and "replace branding" in another depending
 * on what the default happened to contain. Shallow is the rule that reads the
 * same every time.
 *
 * The shapes are declared here rather than derived from `typeof users.$inferInsert`
 * so that nothing in this package imports a `pgTable`. A drizzle table pulled
 * into `@adminigloo/testing/factories` would drag drizzle-orm/pg-core into
 * every consumer of it, and — because tsup does not code-split CJS — a CJS
 * consumer would hold a second copy of each table object, which is exactly the
 * reference-equality failure the schema subpaths exist to prevent. The column
 * lists are checked against the real tables by the conformance test in
 * `__tests__/factories.test.ts`.
 */

/**
 * The firm-wide tenant sentinel, declared here rather than imported.
 *
 * @adminigloo/permissions is the source of truth for this value, but its ROOT
 * BARREL re-exports it from schema.ts — and schema.ts calls `pgTable` at module
 * scope. A value import here would therefore load drizzle-orm/pg-core into
 * every consumer of `@adminigloo/testing/factories`, which is precisely what
 * the comment above claims this module does not do. `Effect` and `Scope` are
 * still imported from the barrel because types erase at build time.
 *
 * Drift is caught by the test in `__tests__/factories.test.ts`, which compares
 * this against the published constant — a test file is not shipped, so it may
 * import the schema subpath.
 */
const FIRM_WIDE = "*";

export interface UserRow {
  readonly id: string;
  readonly identityProvider: string;
  readonly externalId: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly imageUrl: string | null;
  readonly activeTenantId: string | null;
  readonly providerUpdatedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

export function buildUser(
  overrides: Partial<UserRow> & Seeded = {},
): UserRow {
  const { seed = 0, ...rest } = overrides;
  return {
    id: deterministicId("user", seed),
    identityProvider: "clerk",
    // Distinct per seed: `users` carries UNIQUE (identity_provider, external_id),
    // so two fixtures sharing one external id turn any test that inserts both
    // into a constraint violation with no obvious cause.
    externalId: `user_2test${String(seed).padStart(20, "0")}`,
    email: `user-${seed}@example.com`,
    displayName: "Ada Lovelace",
    imageUrl: null,
    activeTenantId: null,
    providerUpdatedAt: fixedTime(),
    createdAt: fixedTime(),
    updatedAt: fixedTime(),
    deletedAt: null,
    ...rest,
  };
}

export type TenantKind = "org" | "personal";

export interface TenantRow {
  readonly id: string;
  readonly kind: TenantKind;
  readonly slug: string;
  readonly name: string;
  readonly ownerUserId: string | null;
  readonly stripeCustomerId: string | null;
  readonly branding: Readonly<Record<string, unknown>>;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

export function buildTenant(
  overrides: Partial<TenantRow> & Seeded = {},
): TenantRow {
  const { seed = 0, ...rest } = overrides;
  return {
    id: deterministicId("tenant", seed),
    kind: "org",
    // `tenants_slug_idx` is unique and is NOT qualified by `deleted_at`, so the
    // slug has to vary with the seed or the second tenant in a test collides
    // with the first — including with one the test soft-deleted.
    slug: `acme-${seed}`,
    name: "Acme Inc",
    ownerUserId: null,
    // Null, not a `cus_…` literal. `tenants_stripe_customer_id_idx` is unique
    // and NULLs do not collide there; a shared placeholder would make the
    // second tenant in any test fail to insert.
    stripeCustomerId: null,
    branding: {},
    settings: {},
    createdAt: fixedTime(),
    updatedAt: fixedTime(),
    deletedAt: null,
    ...rest,
  };
}

export type TenantMemberStatus = "active" | "suspended";

export interface MembershipRow {
  readonly tenantId: string;
  readonly userId: string;
  readonly status: TenantMemberStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * A `tenant_members` row.
 *
 * No role field, matching the table: membership answers "is this person in the
 * tenant", and @adminigloo/permissions answers "what may they do". A `role`
 * here would be the second source of truth that table's comment exists to
 * refuse — and a fixture is exactly where such a field gets reintroduced,
 * because it makes the test read nicely.
 */
export function buildMembership(
  overrides: Partial<MembershipRow> & Seeded = {},
): MembershipRow {
  const { seed = 0, ...rest } = overrides;
  return {
    tenantId: deterministicId("tenant", seed),
    userId: deterministicId("user", seed),
    status: "active",
    createdAt: fixedTime(),
    updatedAt: fixedTime(),
    ...rest,
  };
}

export interface RoleTemplateRow {
  readonly id: string;
  readonly scope: Scope;
  readonly tenantId: string;
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly rank: number;
  readonly isSystem: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

/**
 * A `role_template` row.
 *
 * The rank comes from `templateRank`, not from a literal. The escalation guard
 * is a `>` between two ranks, so a fixture that hard-codes admin as 20 while
 * the shipped table says 30 produces a test that proves the opposite of the
 * rule it is named after — and it keeps proving it after someone renumbers the
 * real templates.
 */
export function buildRoleTemplate(
  overrides: Partial<RoleTemplateRow> & Seeded = {},
): RoleTemplateRow {
  const { seed = 0, ...rest } = overrides;
  const key = rest.key ?? "member";
  return {
    id: deterministicId(`role-template:${key}`, seed),
    scope: "tenant",
    // The FIRM_WIDE sentinel, never null and never "": it is what makes
    // `UNIQUE (scope, tenant_id, key)` enforceable, since Postgres treats NULLs
    // as distinct and would accept two firm-wide templates with the same key.
    tenantId: FIRM_WIDE,
    key,
    name: key.charAt(0).toUpperCase() + key.slice(1),
    description: null,
    rank: templateRank(key) ?? 0,
    isSystem: true,
    createdAt: fixedTime(),
    updatedAt: fixedTime(),
    deletedAt: null,
    ...rest,
  };
}

export interface TemplateGrantRow {
  readonly templateId: string;
  readonly permission: string;
  readonly effect: Effect;
}

/**
 * A `role_template_grant` row.
 *
 * Defaults to `allow`. `deny` on a template SEALS the key against every
 * per-user override, so it is never a neutral default — a factory that emitted
 * `deny` for the unspecified case would quietly make half a suite's fixtures
 * unoverridable and the override tests would fail somewhere else entirely.
 *
 * The default `templateId` is `buildRoleTemplate`'s id for the same seed, so
 * grants and their template line up without the caller wiring ids by hand. The
 * same pairing holds between `buildMembership`, `buildTenant` and `buildUser`.
 */
export function buildTemplateGrant(
  overrides: Partial<TemplateGrantRow> & Seeded = {},
): TemplateGrantRow {
  const { seed = 0, ...rest } = overrides;
  return {
    templateId: deterministicId("role-template:member", seed),
    permission: "members.view",
    effect: "allow",
    ...rest,
  };
}

export interface OverrideRow {
  readonly principalId: string;
  readonly scope: Scope;
  readonly tenantId: string;
  readonly permission: string;
  readonly effect: Effect;
  readonly grantedBy: string | null;
  readonly reason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * A `principal_override` row.
 *
 * `grantedBy` and `reason` are populated rather than null. They are the
 * provenance the table exists to keep, and a factory that left them empty would
 * make "an override with no provenance" the shape every test asserts against —
 * after which the code that forgets to write them passes review.
 */
export function buildOverride(
  overrides: Partial<OverrideRow> & Seeded = {},
): OverrideRow {
  const { seed = 0, ...rest } = overrides;
  return {
    principalId: deterministicId("user", seed),
    scope: "tenant",
    tenantId: FIRM_WIDE,
    permission: "members.invite",
    effect: "allow",
    grantedBy: deterministicId("staff", 0),
    reason: "Granted by a fixture",
    createdAt: fixedTime(),
    updatedAt: fixedTime(),
    ...rest,
  };
}
