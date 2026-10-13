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

/**
 * The setup checklist's per-company state (`tenants.setup_state`).
 *
 * `hiddenKeys` records WHICH items were on the list when the owner hid it, so
 * an item a package adds later (Tenancy 2's "Set your hours") brings the list
 * back instead of staying hidden forever (review T1-13). A `hiddenAt` with no
 * `hiddenKeys` (never written by 0.4, kept for hand-edited rows) hides
 * everything.
 */
export interface TenantSetupState {
  readonly dismissed?: readonly string[];
  readonly hiddenAt?: string;
  readonly hiddenKeys?: readonly string[];
}

/** `tenants.branding`, parsed by the server with a schema; anything unparseable reads as `{}`. */
export interface TenantBranding {
  readonly logoUrl?: string;
  /** The storage key, so a replaced logo can be deleted. */
  readonly logoKey?: string;
  /** Normalised "#rrggbb". */
  readonly brandColor?: string;
  /** The text colour that reads on brandColor (brandColorReport().textOnColor). */
  readonly onBrandColor?: "#ffffff" | "#111111";
}

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
     * Ownership is a pointer that `transferOwnership` (the owner handing
     * over) and `assignOwner` (an operator, when the owner's account is gone)
     * rewrite, together with the owner role (decision D4).
     */
    ownerUserId: text("owner_user_id"),
    stripeCustomerId: text("stripe_customer_id"),
    branding: jsonb("branding").$type<TenantJson>().notNull().default({}),
    settings: jsonb("settings").$type<TenantJson>().notNull().default({}),
    /** Who created it. Immutable; the owner pointer moves, this never does. Bare text, no FK (same reason as owner_user_id). */
    createdBy: text("created_by"),
    /**
     * The creating form's one-time key (a UUID minted when the form mounted).
     * (created_by, creation_key) is unique, so a refresh or a double submit
     * replays instead of creating a second company. NULL for rows not made by
     * createCompany (personal workspaces, seeds).
     */
    creationKey: text("creation_key"),
    /** Set by an operator. Non-null = suspended (decision D15). */
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    /** Why, in the operator's words. Shown to staff only, never to the company. */
    suspendedReason: text("suspended_reason"),
    /** The staff user who suspended it. */
    suspendedBy: text("suspended_by"),
    /** Setup checklist state (decision D13): see TenantSetupState. */
    setupState: jsonb("setup_state").$type<TenantSetupState>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    /** A refresh or double submit of one onboarding form finds its company here instead of making a second. */
    uniqueIndex("tenants_creation_key_idx")
      .on(t.createdBy, t.creationKey)
      .where(sql`${t.creationKey} is not null`),
    /** The operator console lists companies newest first, personal workspaces hidden by default. */
    index("tenants_kind_created_idx").on(t.kind, t.createdAt),
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
    /**
     * The hashes of the links this row carried BEFORE each re-send, oldest
     * first (the first email's always kept; at most EARLIER_LINKS_KEPT).
     *
     * Re-sending rotates the token (only a hash is stored, so the old link
     * can't be mailed again). Without these the earlier emails' links died
     * the moment the owner pressed Resend, and the usual support path — "I
     * never got it", Resend, Resend again, then the office manager finds the
     * FIRST email in spam and clicks it — told her the link "may have been
     * used already", which wasn't true (review T1-06; R2 T1BO-02, F7: keeping
     * only the one before the last re-send still killed the first email after
     * two). Accepting honours the current link and every earlier one, on the
     * same row: same address check, same expiry, same single use. Revoking the
     * row kills them all.
     */
    earlierTokenHashes: text("earlier_token_hashes").array().notNull().default(sql`'{}'::text[]`),
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
    /**
     * When this row's link was EMAILED, oldest first, the last day's only
     * (review R3 SEC-T1-B). One company emails one address at most once per
     * `INVITATION_EMAIL_COOLDOWN_MINUTES` for an open invitation, and at most
     * `INVITATION_EMAILS_PER_ADDRESS_PER_DAY` times a day across all its rows
     * for that address — otherwise Resend, Resend, Resend (or withdraw and
     * invite again) was a way to fill a stranger's inbox from our domain. A
     * re-send the limits hold back is still saved; only the email waits, and
     * the inviter gets the link. Kept on the row, not in the audit log, because
     * a host may connect no audit sink and the limits must hold anyway.
     *
     * ONLY EMAILS THE PROVIDER TOOK (review R4 SEC-T1-B): a time goes in here
     * when the mailer answered "sent", never before. The inviter's sentence
     * ("We emailed … 3 minutes ago") is read from here, so it can't describe
     * an email that was skipped, failed or never attempted.
     */
    emailedAt: timestamp("emailed_at", { withTimezone: true }).array().notNull().default(sql`'{}'::timestamptz[]`),
    /**
     * An invitation email on its way: reserved under the company lock before
     * the mailer is called, so two Resends at once can't both email (review R4
     * SEC-T1-B). Cleared when the mailer answers — moved into `emailed_at` if
     * it said "sent", dropped otherwise. One that never comes back (the server
     * stopped mid-send) holds the address for at most
     * `INVITATION_EMAIL_COOLDOWN_MINUTES`, with a sentence that says only that
     * we haven't heard back, and is never counted as emailed.
     */
    emailSendingAt: timestamp("email_sending_at", { withTimezone: true }),
    /**
     * The last time someone pressed Accept on this invitation's link while
     * signed in with a different address, and that address masked the way
     * the invite page masks one ("j•••@gmail.com": enough to recognise)
     * (review R3 T1BO-07). The team page shows it beside the invitation, so
     * the owner learns "they used their Gmail" without a support ticket.
     * Written at most once per `WRONG_ACCOUNT_NOTE_MINUTES`, so a forwarded
     * link pressed in a loop can't churn the row.
     */
    wrongAccountAt: timestamp("wrong_account_at", { withTimezone: true }),
    wrongAccountEmail: text("wrong_account_email"),
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
    /**
     * An earlier link is looked up the same way. A GIN index can't be UNIQUE;
     * a hash is 256 random bits, so two rows never share one.
     */
    index("tenant_invitations_earlier_token_hashes_idx").using("gin", t.earlierTokenHashes),
    index("tenant_invitations_email_idx").on(t.email),
  ],
);

/**
 * Web addresses a company used before (decision D14).
 *
 * WHY KEEP THEM. A renamed company's old links, invitation emails and
 * receipts keep pointing at its old address. If that address were freed, the
 * next company to claim it would receive every one of them. So the old slug
 * is kept here, counts as taken, and `resolveCompanyBySlug` follows it to the
 * company that retired it (Tenancy 2 answers with a redirect).
 *
 * BOUNDED (review T1-07). Unlimited retirements let one free account rename
 * over and over and lock up thousands of business names as permanent
 * redirects to itself. So a company keeps only its last few old addresses
 * (`RETIRED_SLUGS_KEPT`), changes its address at most a few times a day, and
 * an operator can release a company's old addresses from the console.
 */
export const tenantRetiredSlugs = pgTable(
  "tenant_retired_slugs",
  {
    /** Globally unique: a retired slug belongs to the company that retired it. */
    slug: text("slug").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    // Named explicitly: `createdAt()` would name the column `created_at`, and
    // the upgrade SQL (and every query) says `retired_at`.
    retiredAt: timestamp("retired_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tenant_retired_slugs_tenant_idx").on(t.tenantId)],
);

/**
 * Every web-address change, one row each (review R2 F6, SEC-T1-C).
 *
 * WHY A LOG AND NOT A COUNT OF RETIRED ADDRESSES. "Three changes a day" used
 * to be counted from `tenant_retired_slugs`, but switching back to an old
 * address deletes its retired row and the cap deletes older ones, so a
 * company switching a → b → a → b… was never stopped. It was also per company
 * only, so one person with several companies multiplied it. These rows are
 * never deleted by a change, so the day's count is the day's count: per
 * company (`SLUG_CHANGES_PER_DAY`) and per person
 * (`SLUG_CHANGES_PER_PERSON_PER_DAY`). It doubles as the address history.
 */
export const tenantSlugChanges = pgTable(
  "tenant_slug_changes",
  {
    id: idColumn(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    fromSlug: text("from_slug").notNull(),
    toSlug: text("to_slug").notNull(),
    /** Who changed it (null: staff freeing a squatted address, or another system act). */
    changedBy: text("changed_by"),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("tenant_slug_changes_tenant_idx").on(t.tenantId, t.changedAt),
    index("tenant_slug_changes_by_idx").on(t.changedBy, t.changedAt),
  ],
);

export const tenancySchema = { tenants, tenantMembers, tenantInvitations, tenantRetiredSlugs, tenantSlugChanges };
