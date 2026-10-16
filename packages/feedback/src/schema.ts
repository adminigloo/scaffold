import { sql } from "drizzle-orm";
import { boolean, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, type AnyPgColumn } from "drizzle-orm/pg-core";
import { createdAt, idColumn } from "@adminigloo/db";

export type FeedbackPriority = "low" | "medium" | "high" | "critical";
export type FeedbackTicketStatus = "open" | "in_progress" | "resolved" | "closed";
/** Where a ticket came from (0.11.0). */
export type FeedbackTicketSource = "widget" | "page" | "staff";
/** What one row of a ticket's activity trail records (0.11.0). */
export type FeedbackTicketEventKind =
  | "created"
  | "title"
  | "priority"
  | "category"
  | "assignee"
  | "status"
  | "archived"
  | "unarchived"
  /** Put into an epic, moved to another, or taken out of one (0.12.0). */
  | "epic";

/** Where an epic is in its life (0.12.0). Only `setEpicStatus` changes it, by FEEDBACK_EPIC_TRANSITIONS. */
export type FeedbackEpicStatus = "open" | "in_progress" | "completed" | "archived";

/**
 * The platform's own board (0.10.0): the site's own support queue, fed by the
 * in-app feedback button and worked by the site's staff at /admin/feedback.
 * Not a company — no company id is ever "*". On upgrade, a 0.9 install's
 * columns and categories (there was one board then) become this board.
 */
export const FEEDBACK_PLATFORM_BOARD = "*";

/**
 * One row per issued widget key. The row IS the license: issuing a key is how
 * a component sale becomes real, and revoking it is how a lapsed contract
 * stops working — no deploy, no code change on the buyer's side.
 *
 * 0.10.0: a key is a company's WEBSITE KEY — the widget on that company's own
 * site sends it, and every ticket it submits lands on that company's board.
 * Issued, listed and revoked by the company itself.
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
 * plain-text `status` points at a `key` here. Seeded with the four defaults
 * the first time a company's board is used, so installing needs no seed step.
 */
export const feedbackStatuses = pgTable(
  "feedback_statuses",
  {
    id: idColumn(),
    /**
     * Whose board this column is on (0.10.0). Every company has its own
     * columns: a company that renames "Open" to "New" renames its own and
     * nobody else's. NO DEFAULT, on purpose: an insert that forgets the
     * company fails instead of landing on the platform's own board. (The
     * upgrade from 0.9 fills it with '*' for the columns that already exist,
     * then drops the default it used to do so.)
     */
    tenantId: text("tenant_id").notNull(),
    /** Stable machine name the ticket rows reference: "open", "in_progress". Unique per company. */
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
     * "Work here is waiting on someone else" (0.12.0): the customer, a
     * supplier, another team. Read by nothing but an epic's progress, which
     * counts these tickets as "waiting" — by this flag, never by the column's
     * name (Ask Lou bucketed by name, and tickets went missing every time a
     * column was renamed).
     */
    isWaiting: boolean("is_waiting").notNull().default(false),
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
  // Unique PER COMPANY (0.10.0): two companies may both have an "open" column.
  // 0.9's index on the key alone is dropped by the upgrade.
  (table) => [uniqueIndex("feedback_statuses_tenant_key_idx").on(table.tenantId, table.key)],
);

/**
 * What a reporter may call their report — the widget's dropdown, as rows.
 * Same design as feedback_statuses one table up: rows ARE the options, the
 * ticket's plain-text `category` points at `key`, and an admin curates the
 * list without a deploy. `showToCustomer` is the curation: an internal
 * "escalated" category can exist for triage without ever being offered to
 * the person filing a bug.
 *
 * Seeded with the default list the first time a company's board is used
 * (0.10.0), like the columns, so an owner edits real rows from day one. A
 * company with no rows still offers the built-in list, so an empty table
 * never means "no dropdown".
 */
export const feedbackCategories = pgTable(
  "feedback_categories",
  {
    id: idColumn(),
    /** Whose dropdown this is (0.10.0). No default: see feedback_statuses.tenant_id. */
    tenantId: text("tenant_id").notNull(),
    /** Stable machine name the ticket rows reference: "bug", "billing". Unique per company. */
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
  (table) => [uniqueIndex("feedback_categories_tenant_key_idx").on(table.tenantId, table.key)],
);

/**
 * A submitted feedback report, on the board of the company it was sent to (by
 * its website key, or its public feedback page). Deliberately self-contained:
 * reporter identity is denormalised text because the reporter is a customer
 * of the company, not a person who signs in here.
 */
export const feedbackTickets = pgTable(
  "feedback_tickets",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    /**
     * `FB-00001` style, counted PER COMPANY (0.10.0): each company's first
     * ticket is FB-00001, so a company's customers never learn how many
     * tickets other companies have. A number names a ticket only inside its
     * company, and every lookup by number names the company too.
     */
    ticketNumber: text("ticket_number").notNull(),
    /** First line of the description, capped — set at insert, never recomputed. */
    title: text("title").notNull(),
    description: text("description").notNull(),
    priority: text("priority").$type<FeedbackPriority>().notNull().default("medium"),
    category: text("category"),
    /**
     * Plain text pointing at feedback_statuses.key (of the same company), not
     * $type-narrowed to the default union: statuses are configurable, so a
     * custom column key a company added is a valid value, not a type error.
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
     * The same person as the host's own user id (0.11.0), when they were
     * picked from the company's people (the `listPeople` seam). What the
     * "Assigned to" and "Mine" filters match: two people can share a name,
     * never an id. Null on a ticket assigned by typing a name (0.10 and
     * earlier, or a host without the seam) — those still show their name.
     */
    assigneeId: text("assignee_id"),
    /**
     * Where the ticket came from (0.11.0): "widget" (the feedback button, on
     * a website key), "page" (a company's own feedback page) or "staff" (the
     * team filed it from the board). The board's "From" filter. Every 0.10
     * ticket arrived through the intake, so the upgrade's default is "widget".
     */
    source: text("source").$type<FeedbackTicketSource>().notNull().default("widget"),
    /** Who on the team filed it (the host's user id), for a staff ticket; null otherwise. */
    createdBy: text("created_by"),
    /**
     * The epic this ticket is part of (0.12.0): one of THIS company's
     * feedback_epics, or none. Plain text like every other reference here, and
     * only ever written after the epic was found inside the ticket's company —
     * so a ticket never points at another company's epic. Deleting an epic
     * clears it on every ticket (the tickets stay).
     *
     * A FOREIGN KEY, ON DELETE SET NULL (review L2): whatever runs at the same
     * moment as a delete — on any driver, in a transaction or not — no ticket
     * is ever left pointing at an epic that doesn't exist.
     */
    epicId: text("epic_id").references((): AnyPgColumn => feedbackEpics.id, { onDelete: "set null" }),
    /**
     * Is the reporter emailed when the team replies or moves it (0.11.0)?
     * True for everything the intake takes (the person sent it, and left an
     * address to hear back). A ticket the team files for a customer is only
     * emailed when the team said "tell them": that customer never used the
     * feedback form, so an email they didn't expect, pointing at a form they
     * never filled in, is the wrong surprise.
     */
    notifyReporter: boolean("notify_reporter").notNull().default(true),
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
    // Per company (0.10.0); 0.9's install-wide index on the number alone is
    // dropped by the upgrade.
    uniqueIndex("feedback_tickets_tenant_number_idx").on(table.tenantId, table.ticketNumber),
    index("feedback_tickets_tenant_idx").on(table.tenantId),
    index("feedback_tickets_status_idx").on(table.status),
    index("feedback_tickets_created_idx").on(table.createdAt),
    // The board's default read is WHERE archived_at IS NULL; the eye-toggle
    // read is the complement. Both walk this.
    index("feedback_tickets_archived_idx").on(table.archivedAt),
    // An epic's tickets (its progress, its page) and the board's Epic filter.
    index("feedback_tickets_tenant_epic_idx").on(table.tenantId, table.epicId),
  ],
);

/**
 * A bigger piece of work a company's tickets are grouped under (0.12.0):
 * "New checkout", "Spring price list". A ticket is in one epic or none.
 * Ask Lou's epic, with its rough edges filed off — see epics-data.ts.
 *
 * Company-scoped like everything here: every read and write names the
 * company, and another company's epic, asked for by id, is "not found".
 */
export const feedbackEpics = pgTable(
  "feedback_epics",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").$type<FeedbackEpicStatus>().notNull().default("open"),
    /**
     * Who leads it: one of the company's people (the `listPeople` seam), by
     * the host's user id, with the name shown beside it — like a ticket's
     * assignee. Null: nobody yet. (Ask Lou's "Me (default)" saved no owner
     * while saying it would; here no owner is only ever chosen.)
     */
    ownerId: text("owner_id"),
    ownerName: text("owner_name"),
    /** When it should be done, as a day ("2026-11-30"); null: no date. */
    targetDate: date("target_date", { mode: "string" }),
    /** One of FEEDBACK_EPIC_COLORS ("blue", "teal" …) — a name, so both themes can draw it. */
    color: text("color").notNull().default("blue"),
    /** Set when it was marked completed; cleared when it's reopened. */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Set when it was archived; cleared when it's restored. */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    /** The host's user id of whoever made it. */
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("feedback_epics_tenant_idx").on(table.tenantId, table.status),
    // One epic per NAME per company, as a person reads a name — case and
    // spacing don't count (review L1: two "New epic"s pressed at once made two
    // epics; the check before the insert can't see the other insert, this can).
    uniqueIndex("feedback_epics_tenant_name_idx").on(table.tenantId, sql`lower(regexp_replace(btrim("name"), '\\s+', ' ', 'g'))`),
  ],
);

/**
 * Which companies' boards have been set up (0.11.0): one row, written the
 * first time a board is used, after its default columns and categories. The
 * defaults come ONCE: a company that deletes every category gets an empty
 * list, not the six defaults back on the next page load (0.10 re-seeded
 * whenever a list was empty). The upgrade marks every board that already has
 * columns or categories.
 */
export const feedbackBoards = pgTable("feedback_boards", {
  tenantId: text("tenant_id").primaryKey(),
  createdAt: createdAt(),
});

/**
 * What changed on a ticket, and who changed it (0.11.0): the panel's activity
 * trail. One row per field per change — "Priority: medium → high, by Ada" —
 * written by the same call that made the change, so the trail can't drift
 * from the ticket.
 *
 * Unlike feedback_messages this table CARRIES THE COMPANY: the trail is read
 * as a list of its own, and a list whose company lives one join away is the
 * list that leaks the day the join is forgotten. Every read names both the
 * company and the ticket.
 *
 * Values are what a person reads, not keys: a column's label, a category's
 * label, a person's name, as they were at the time — renaming a column later
 * doesn't rewrite history.
 */
export const feedbackTicketEvents = pgTable(
  "feedback_ticket_events",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => feedbackTickets.id, { onDelete: "cascade" }),
    kind: text("kind").$type<FeedbackTicketEventKind>().notNull(),
    fromValue: text("from_value"),
    toValue: text("to_value"),
    /** The host's user id of whoever made the change; null for the intake or a sweep. */
    actorId: text("actor_id"),
    /** Their name as the trail shows it ("Ada", or the business's name). */
    actorName: text("actor_name").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("feedback_ticket_events_ticket_idx").on(table.tenantId, table.ticketId, table.createdAt)],
);

/**
 * The conversation on a ticket — staff replies, reporter replies, and the
 * board's own notes ("Assigned to …"). `senderType` is what renders
 * differently; `senderName` is display text because neither side's identity
 * system belongs to this schema.
 *
 * NO tenant_id of its own (0.10.0), on purpose: a message belongs to its
 * ticket, and every read and write in this package reaches a message THROUGH
 * its ticket, with the ticket's company in the WHERE (a join, or the ticket
 * looked up inside its company first).
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

/**
 * Every screenshot the intake took (0.10.0), so that a report can only point
 * at a picture THIS board's upload route stored — never at an address someone
 * typed — and so a picture nobody sent a report with is deleted: the upload
 * comes before the report, and a person who closes the form leaves one
 * behind. `ticket_id` is set when the report that uses it arrives; a row
 * still without one after a day is swept (`sweepFeedbackUploads`), the
 * stored file with it.
 */
export const feedbackUploads = pgTable(
  "feedback_uploads",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    /** What the report will carry: the stored file's address (public) or its signed-in route (private). */
    url: text("url").notNull(),
    /** The file's id in the host's file storage, when it keeps one (private screenshots). */
    fileId: text("file_id"),
    /** "screenshot" | "annotated" */
    kind: text("kind").notNull(),
    /** From the bytes, never from what the browser said. */
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    ticketId: text("ticket_id"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("feedback_uploads_tenant_url_idx").on(table.tenantId, table.url),
    index("feedback_uploads_created_idx").on(table.createdAt),
  ],
);
