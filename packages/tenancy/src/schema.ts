import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createdAt, deletedAt, idColumn, updatedAt } from "@adminigloo/db";

/**
 * `org` is a real organisation; `personal` is the single-user workspace created
 * on first sign-in.
 *
 * Personal workspaces exist so there is exactly one query path. riddler-go
 * branches on "does this user belong to a company yet" in every read, and the
 * B2C path is the one that keeps growing bugs because it is exercised least.
 * Here a solo user owns a tenant like everybody else and the branch disappears.
 */
export type TenantKind = "org" | "personal";

/** `suspended` keeps the row (and its audit trail) while blocking access. */
export type TenantMemberStatus = "active" | "suspended";

/**
 * Free-form per-tenant blobs.
 *
 * jsonb rather than columns because these keys change with the UI, not with the
 * data model, and a theme tweak must not need a migration. The moment something
 * in here is filtered or joined on, it gets promoted to a real column — jsonb
 * predicates are what turn a tenant list into a sequential scan.
 */
export type TenantJson = Readonly<Record<string, unknown>>;

export const tenants = pgTable(
  "tenants",
  {
    id: idColumn(),
    /**
     * text, not pgEnum: a value added to a Postgres enum can never be removed,
     * so a name chosen badly today is permanent. The union type above gives the
     * compile-time check without the one-way door.
     */
    kind: text("kind").$type<TenantKind>().notNull().default("org"),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    /**
     * NO FOREIGN KEY, DELIBERATELY.
     *
     * Deleting a user must never delete the organisation they happened to
     * create — ownership transfers instead. A cascade here would take the
     * tenant, its members and its billing history with the owner's account
     * closure, and `restrict` would make deleting any founder impossible.
     * Ownership is a pointer that the transfer path rewrites.
     */
    ownerUserId: text("owner_user_id"),
    stripeCustomerId: text("stripe_customer_id"),
    branding: jsonb("branding").$type<TenantJson>().notNull().default({}),
    settings: jsonb("settings").$type<TenantJson>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    /**
     * Unqualified by `deleted_at`, on purpose: a soft-deleted tenant keeps its
     * slug reserved. Freeing it would let a new tenant claim the URL of a
     * deleted one, and every stale bookmark, invitation email and Stripe
     * receipt linking to /t/acme would then land a stranger on someone else's
     * organisation.
     */
    uniqueIndex("tenants_slug_idx").on(t.slug),
    /**
     * One tenant per Stripe customer. Postgres treats NULLs as distinct in a
     * unique index, which is exactly the behaviour wanted here: tenants that
     * have never reached checkout all hold NULL and do not collide.
     */
    uniqueIndex("tenants_stripe_customer_id_idx").on(t.stripeCustomerId),
    index("tenants_owner_idx").on(t.ownerUserId),
  ],
);

/**
 * Who belongs to a tenant.
 *
 * *** THERE IS DELIBERATELY NO ROLE COLUMN HERE. ***
 *
 * Roles live in `principal_role` in @adminigloo/permissions, in one place, for
 * one reason: askLou splits the same fact across `accountCompanies.roleId` and
 * `accountCompanies.companyRoleId`, both holding magic numbers 1-4 that
 * contradict its own seeded role table — and the source file documents the
 * conflict in a comment rather than resolving it. Two columns that disagree
 * mean every read has to pick a winner, and different call sites pick
 * differently. Membership answers "is this person in the tenant"; permissions
 * answers "what may they do". Nothing needs both answers in one row.
 *
 * `userId` is bare text with no foreign key, matching `principal_role`: this
 * package must be installable without the auth schema present, and users are
 * soft-deleted, so a cascade would never fire anyway.
 */
export const tenantMembers = pgTable(
  "tenant_members",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    status: text("status")
      .$type<TenantMemberStatus>()
      .notNull()
      .default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.userId] }),
    /** "Which tenants am I in" runs on every request; the PK cannot serve it. */
    index("tenant_members_user_idx").on(t.userId),
  ],
);

/**
 * Outstanding invitations.
 *
 * The raw token exists in exactly one place — the email that was sent. Only its
 * SHA-256 is stored, so a leaked database dump lets an attacker read who was
 * invited but never lets them join: they cannot reverse a hash into the link.
 */
export const tenantInvitations = pgTable(
  "tenant_invitations",
  {
    id: idColumn(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Lowercased by `normaliseInviteEmail` at the boundary, never here. */
    email: text("email").notNull(),
    /**
     * The role the invite carries, as a `role_template.id`. No foreign key
     * across the package boundary — @adminigloo/permissions owns that table's
     * lifecycle, and a deleted template must surface as "this invite is stale"
     * at accept time rather than as a constraint error on an unrelated write.
     */
    templateId: text("template_id"),
    tokenHash: text("token_hash").notNull(),
    /** NULL means no expiry — a deliberate never-expiring invite, not a gap. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    invitedBy: text("invited_by"),
    /**
     * Who withdrew it, mirroring `invited_by`.
     *
     * The audit log records the same act, and records it better — with a
     * request context and an actor the middleware verified. This column exists
     * because the two answer different questions at different times: an audit
     * row is a searchable event in a table that is periodically archived, and
     * this is a property of the invitation itself, available to anybody holding
     * the row and surviving as long as it does. Withdrawing an invitation is
     * one of the few acts here that is contentious after the fact ("nobody
     * cancelled it, the link just stopped working"), and the answer should not
     * depend on the audit log still holding that week.
     */
    revokedBy: text("revoked_by"),
    createdAt: createdAt(),
  },
  (t) => [
    /**
     * One open invite per (tenant, email).
     *
     * The predicate cannot also exclude expired rows: Postgres requires index
     * predicates to be IMMUTABLE and rejects `expires_at > now()` outright,
     * because an index whose membership changes with the clock could not stay
     * correct. So expired-but-unaccepted rows remain inside the index — which
     * is precisely why issuing an invite must UPSERT on this index (re-issuing
     * rotates the token hash and pushes out `expires_at`) instead of inserting
     * and hitting a unique violation on a row that is already dead.
     */
    uniqueIndex("tenant_invitations_tenant_email_open_idx")
      .on(t.tenantId, t.email)
      .where(sql`${t.acceptedAt} is null and ${t.revokedAt} is null`),
    /**
     * Acceptance looks the invite up by hash alone — the URL carries nothing
     * else — so the hash must resolve to at most one row or acceptance becomes
     * a coin flip between tenants.
     */
    uniqueIndex("tenant_invitations_token_hash_idx").on(t.tokenHash),
    index("tenant_invitations_email_idx").on(t.email),
  ],
);

export const tenancySchema = { tenants, tenantMembers, tenantInvitations };
