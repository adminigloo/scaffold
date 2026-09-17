import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, idColumn } from "@adminigloo/db";

export type FeedbackPriority = "low" | "medium" | "high" | "critical";
export type FeedbackTicketStatus = "open" | "in_progress" | "resolved" | "closed";

/**
 * One row per issued widget key. The row IS the license: issuing a key is how
 * a component sale becomes real, and revoking it is how a lapsed contract
 * stops working — no deploy, no code change on the buyer's side.
 */
export const feedbackClientKeys = pgTable(
  "feedback_client_keys",
  {
    id: idColumn(),
    /**
     * Plain text, no FK: the tenants table lives in @adminigloo/tenancy and a
     * cross-package reference would force every consumer of this schema to
     * install that one too (the same reason stripe_events.tenant_id is bare).
     */
    tenantId: text("tenant_id").notNull(),
    /**
     * SHA-256 hex of the full `aik_…` secret. The plaintext exists exactly
     * once, in the issuance response — a leaked database dump yields no
     * usable keys, and "we can re-show you your key" is a promise this
     * schema is built to make impossible.
     */
    keyHash: text("key_hash").notNull(),
    /** Human name shown wherever keys are listed: "Acme production", "demo". */
    label: text("label").notNull(),
    createdAt: createdAt(),
    /**
     * Set instead of deleting the row. A deleted key cannot explain the 401s
     * in the buyer's logs; a revoked one can, and keeps its audit trail.
     */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("feedback_client_keys_key_hash_idx").on(table.keyHash),
    index("feedback_client_keys_tenant_idx").on(table.tenantId),
  ],
);

/**
 * The board's columns, in order. Rows here ARE the Kanban board: adding one
 * adds a column, reordering sortOrder reorders the board, and the ticket's
 * plain-text `status` points at a `key` here. Seeded lazily with the four
 * defaults on first board read, so installing 0.2.0 needs no seed step.
 */
export const feedbackStatuses = pgTable(
  "feedback_statuses",
  {
    id: idColumn(),
    /** Stable machine name the ticket rows reference: "open", "in_progress". */
    key: text("key").notNull(),
    /** What the column header says: "Open", "In progress". */
    label: text("label").notNull(),
    /** Column accent, any CSS color. Null renders the neutral accent. */
    color: text("color"),
    sortOrder: integer("sort_order").notNull().default(0),
    /**
     * "Work here is finished." What bulk-archive sweeps, what a board may
     * choose to de-emphasise. A flag rather than a naming convention, because
     * a client who renames "closed" to "shipped" has not changed its meaning.
     */
    isTerminal: boolean("is_terminal").notNull().default(false),
    /**
     * How many tickets this column comfortably holds. Null = uncounted. The
     * board renders count/limit and turns the column's header loud past it —
     * a limit, not a lock: kanban WIP limits exist to be seen, not enforced.
     */
    wipLimit: integer("wip_limit"),
    /**
     * Card aging, in hours since the ticket last changed status. Warn is the
     * quiet amber dot, stale the loud one. Both null = this column does not
     * age (a Done column full of old cards is finished, not neglected).
     */
    agingWarnHours: integer("aging_warn_hours"),
    agingStaleHours: integer("aging_stale_hours"),
    /**
     * May an automated agent move tickets INTO this column? Stored now, read
     * by nothing yet: the AI layer that respects it ships later, and adding a
     * boolean today beats migrating a config table under live installs then.
     */
    allowAiTransition: boolean("allow_ai_transition").notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("feedback_statuses_key_idx").on(table.key)],
);

/**
 * What a reporter may call their report — the widget's dropdown, as rows.
 * Same design as feedback_statuses one table up: rows ARE the options, the
 * ticket's plain-text `category` points at `key`, and an admin curates the
 * list without a deploy. `showToCustomer` is the curation: an internal
 * "escalated" category can exist for triage without ever being offered to
 * the person filing a bug.
 *
 * NO SEED ROWS, unlike statuses: a board needs columns to exist at all, but
 * the widget already falls back to the built-in category list when this
 * table is empty — so an empty table means "the defaults", not "no dropdown".
 */
export const feedbackCategories = pgTable(
  "feedback_categories",
  {
    id: idColumn(),
    /** Stable machine name the ticket rows reference: "bug", "billing". */
    key: text("key").notNull(),
    /** What the dropdown says: "Bug report", "Billing question". */
    label: text("label").notNull(),
    /** One line under the label in the widget. Null renders nothing. */
    description: text("description"),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Offered in the widget, or triage-side only. */
    showToCustomer: boolean("show_to_customer").notNull().default(true),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("feedback_categories_key_idx").on(table.key)],
);

/**
 * A submitted feedback report, scoped to the tenant whose key submitted it.
 * Deliberately self-contained: reporter identity is denormalised text because
 * the reporter is an end user of the BUYER's app, not a principal in ours.
 */
export const feedbackTickets = pgTable(
  "feedback_tickets",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    /** `FB-00001` style, globally unique so a number alone identifies a ticket in conversation. */
    ticketNumber: text("ticket_number").notNull(),
    /** First line of the description, capped — set at insert, never recomputed. */
    title: text("title").notNull(),
    description: text("description").notNull(),
    priority: text("priority").$type<FeedbackPriority>().notNull().default("medium"),
    category: text("category"),
    /**
     * Plain text pointing at feedback_statuses.key, not $type-narrowed to the
     * default union: 0.2.0 made statuses configurable, so a custom column key
     * a client added is a valid value, not a type error.
     */
    status: text("status").notNull().default("open"),
    screenshotUrl: text("screenshot_url"),
    annotatedScreenshotUrl: text("annotated_screenshot_url"),
    reporterName: text("reporter_name"),
    reporterEmail: text("reporter_email"),
    /**
     * Who on staff owns this ticket — display name or email, plain text.
     * Not an FK: staff identity lives in the consuming platform's user
     * system, and the board only needs a name to show on the card.
     */
    assignee: text("assignee"),
    /**
     * SHA-256 hex of the per-ticket reporter token (0.4.0). The plaintext is
     * returned exactly once, in the submit response, and lives only in the
     * reporter's own browser — a capability, not an account. It is what lets
     * an anonymous end user read staff replies and answer them without ever
     * having an identity here, which is the same reason reporter_name above
     * is denormalised text. Null on tickets submitted before 0.4: those
     * reporters hold no token, so their thread is staff-side only.
     */
    reporterTokenHash: text("reporter_token_hash"),
    /**
     * When ANY staff member last opened this ticket's workspace (0.5.0).
     * Ticket-level rather than per-viewer, deliberately: staff identity lives
     * in the consuming platform, not here, and the question triage actually
     * asks is "has the team seen the reporter's latest reply", not "has
     * Dallin". A reporter message newer than this timestamp is what lights
     * the unread mark on the board card.
     */
    lastStaffReadAt: timestamp("last_staff_read_at", { withTimezone: true }),
    /**
     * When this ticket last changed column (0.7.0). Null on tickets that
     * predate the column and on tickets never moved — readers fall back to
     * createdAt, so "how long has this sat here" is always answerable and
     * never lies older than the ticket itself.
     */
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
    /**
     * Soft archive (0.7.0). Archived tickets leave the board and the queue by
     * default and keep every message and receipt — the Done column stays
     * readable in month three without anything being deleted. `archivedBy` is
     * display text like `assignee`, because staff identity lives in the
     * consuming platform.
     */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedBy: text("archived_by"),
    /** Denormalised from clientMetadata so the triage list can filter without unpacking JSON. */
    pagePathname: text("page_pathname"),
    /** Browser, OS, viewport, URL, click trail, session id — the widget's whole context object. */
    clientMetadata: jsonb("client_metadata"),
    /** Browser-side errors from the widget's session recorder, newest last. */
    recentErrors: jsonb("recent_errors"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("feedback_tickets_number_idx").on(table.ticketNumber),
    index("feedback_tickets_tenant_idx").on(table.tenantId),
    index("feedback_tickets_status_idx").on(table.status),
    index("feedback_tickets_created_idx").on(table.createdAt),
    // The board's default read is WHERE archived_at IS NULL; the eye-toggle
    // read is the complement. Both walk this.
    index("feedback_tickets_archived_idx").on(table.archivedAt),
  ],
);

/**
 * The conversation on a ticket — staff notes and, later, reporter replies.
 * `senderType` is what renders differently; `senderName` is display text
 * because neither side's identity system belongs to this schema (staff live
 * in the platform's user tables, reporters in the buyer's app).
 */
export const feedbackMessages = pgTable(
  "feedback_messages",
  {
    id: idColumn(),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => feedbackTickets.id, { onDelete: "cascade" }),
    senderType: text("sender_type").$type<"staff" | "reporter" | "system">().notNull(),
    senderName: text("sender_name").notNull(),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("feedback_messages_ticket_idx").on(table.ticketId, table.createdAt)],
);
