import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, idColumn, updatedAt } from "@adminigloo/db";

/**
 * THE CUSTOMER LIST (customers 0.1). Every table carries a plain-text
 * `tenant_id` — the company — and every query in this package filters on it:
 * the same email in two companies is two customers, and neither company can
 * reach the other's. No FK to a tenants table (it lives in
 * @adminigloo/tenancy and an install may not have it). Fixed table names,
 * like every other package's.
 *
 * ONE PERSON, ONE ROW, EVEN WHEN TWO REQUESTS RACE. A customer's first email
 * and first phone are kept as match keys in their own columns, unique per
 * company among the customers that weren't merged away (the partial indexes
 * below). Two requests creating "the same" customer at once both try to
 * insert; one wins, the other's insert does nothing, and it reads the winner
 * back (`findOrCreateCustomer`'s retry).
 */
export const customers = pgTable(
  "customers",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    companyName: text("company_name"),
    /** Every email the customer has used, lower case, the first one first. */
    emails: jsonb("emails").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** Every phone, E.164, the first one first. */
    phones: jsonb("phones").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** Every email and phone as it is matched ("e:…", "p:…"): Gmail's dots and +tags folded. */
    matchKeys: jsonb("match_keys").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** The first email's match key: unique per company (the double-create guard). */
    emailKey: text("email_key"),
    /** The first phone's match key: unique per company. */
    phoneKey: text("phone_key"),
    notes: text("notes"),
    tags: jsonb("tags").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** Where the customer first came from: "estimate", "visit", …, "staff", "import", "backfill". */
    createdFrom: text("created_from").notNull().default("staff"),
    /** Set when this customer was merged into another: the one kept. Merged customers are never matched. */
    mergedInto: text("merged_into"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("customers_tenant_email_key_uidx").on(t.tenantId, t.emailKey).where(sql`${t.emailKey} is not null and ${t.mergedInto} is null`),
    uniqueIndex("customers_tenant_phone_key_uidx").on(t.tenantId, t.phoneKey).where(sql`${t.phoneKey} is not null and ${t.mergedInto} is null`),
    index("customers_tenant_activity_idx").on(t.tenantId, t.lastActivityAt),
    index("customers_tenant_name_idx").on(t.tenantId, t.name),
  ],
);

/** A customer's addresses: where the job is, where the invoice goes. */
export const customerAddresses = pgTable(
  "customer_addresses",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    /** "Home", "Rental on 5th", … Optional. */
    label: text("label"),
    /** The address on one line, as given. */
    text: text("text").notNull(),
    /** Lower case, punctuation folded: the same address twice is one row. */
    matchKey: text("match_key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("customer_addresses_customer_key_uidx").on(t.tenantId, t.customerId, t.matchKey),
    index("customer_addresses_tenant_idx").on(t.tenantId),
  ],
);

/**
 * What is a customer's: one row per thing that happened to one record of one
 * feature — a quote submitted, a visit booked, an invoice raised and later
 * paid. `(kind, ref_id, action)` happens once per company, so the same event
 * told twice (a retry, a backfill run again) is one row, and a record belongs
 * to one customer.
 */
export const customerLinks = pgTable(
  "customer_links",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    /** "estimate", "visit", "invoice", "booking", "order" or "message". */
    kind: text("kind").notNull(),
    /** The record's id in its own feature. */
    refId: text("ref_id").notNull(),
    /** What happened: "submitted", "booked", "raised", "paid", "sent", … */
    action: text("action").notNull().default("linked"),
    /**
     * Which time it happened, from the event ("" for things that happen once):
     * a visit moved twice is two rows (its sequence after each move), an
     * invoice paid, reversed and paid again is two (each paid time). The same
     * event told again has the same key, so it stays one row.
     */
    occurrence: text("occurrence").notNull().default(""),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /** One line the timeline shows: "Quote Q-0012 · $480". */
    summary: text("summary").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("customer_links_ref_uidx").on(t.tenantId, t.kind, t.refId, t.action, t.occurrence),
    index("customer_links_timeline_idx").on(t.tenantId, t.customerId, t.occurredAt),
  ],
);

/** Every merge, kept: who folded which customer into which, and the merged one as it was. */
export const customerMerges = pgTable(
  "customer_merges",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    keptId: text("kept_id").notNull(),
    mergedId: text("merged_id").notNull(),
    mergedBy: text("merged_by"),
    /** The merged customer's row before the merge. */
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    linksMoved: integer("links_moved").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("customer_merges_tenant_idx").on(t.tenantId, t.keptId)],
);

/** What a notice on a customer's record is about. */
export type CustomerNoticeKind = "new-details" | "possible-duplicate" | "shared-key";

/** Contact details a form brought that the customer didn't have (or the one detail another customer holds). */
export interface CustomerNoticeDetails {
  readonly emails?: readonly string[];
  readonly phones?: readonly string[];
  readonly addresses?: readonly string[];
  readonly companyName?: string | null;
}

/**
 * THINGS ON A CUSTOMER'S RECORD FOR STAFF TO DECIDE. A public form (an
 * estimate request, a booking, a store order) never changes a customer it
 * matched: what it brought that they didn't have waits here.
 *
 *   new-details         "New details from a form (Quote Q-0012): phone …" — Add or Ignore
 *   possible-duplicate  "Might be the same person as Mrs Lee" (a form matched
 *                       only by phone, so a new customer was made) — Merge or
 *                       Not the same; on both records
 *   shared-key          "Mr Kim also has this phone" — a detail that wasn't
 *                       added because another customer has it
 *
 * One notice per thing (`dedupe_key`); an ignored one isn't asked again.
 */
export const customerNotices = pgTable(
  "customer_notices",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    kind: text("kind").$type<CustomerNoticeKind>().notNull(),
    /** The other customer (a possible duplicate, or who also has the detail). */
    otherCustomerId: text("other_customer_id"),
    details: jsonb("details").$type<CustomerNoticeDetails>().notNull().default(sql`'{}'::jsonb`),
    /** Where it came from, in words: "Quote Q-0012 asked for online". */
    sourceLabel: text("source_label"),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: createdAt(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** "added", "ignored", "merged", "dismissed". */
    resolution: text("resolution"),
    resolvedBy: text("resolved_by"),
  },
  (t) => [
    uniqueIndex("customer_notices_dedupe_uidx").on(t.tenantId, t.customerId, t.dedupeKey),
    index("customer_notices_open_idx").on(t.tenantId, t.customerId, t.resolvedAt),
  ],
);

export const customersSchema = {
  customers,
  customerAddresses,
  customerLinks,
  customerMerges,
  customerNotices,
};

export type CustomerRow = typeof customers.$inferSelect;
export type CustomerAddressRow = typeof customerAddresses.$inferSelect;
export type CustomerLinkRow = typeof customerLinks.$inferSelect;
export type CustomerNoticeRow = typeof customerNotices.$inferSelect;
